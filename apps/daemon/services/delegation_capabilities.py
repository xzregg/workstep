"""Project-scoped evidence for explicit delegation engine/model selection.

Only the two-turn live probe writes evidence. Catalog names and legacy engine
verification flags are never promoted. All synchronous calls belong in a worker.
"""
import asyncio
from contextlib import aclosing, suppress
from datetime import datetime, timezone
import hashlib
import inspect
import json
from pathlib import Path
import secrets
import threading

from engines.core.registry import create_engine
from services.config import config_store

_KEY = 'delegation_verified_combinations'
_LOCK = threading.RLock()
_PROTOCOL = 1
_ACTIVE = {}


class _ProbeFailure(ValueError):
    pass


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def fingerprint(project, adapter, provider_id):
    resolver = getattr(adapter, 'resolve_provider_catalog', None)
    catalog = resolver(provider_id=provider_id) if callable(resolver) else None
    values = dict(adapter.get_full_config_values())
    for field in adapter.full_config_schema():
        if field.sensitive or field.type == 'password':
            values[field.key] = adapter.reveal_config_value(field.key)
    provider = config_store.get_provider(catalog[0]) if catalog else None
    sources = {inspect.getsourcefile(cls) for cls in type(adapter).__mro__ if cls.__module__ != 'builtins'}
    source_hashes = {source: hashlib.sha256(Path(source).read_bytes()).hexdigest() for source in sources if source}
    return _digest({'protocol': _PROTOCOL, 'project': project.id, 'path': str(project.path),
                    'engine': adapter.ENGINE_ID, 'model_catalog': (config_store.get('engine_models', {}).get(adapter.ENGINE_ID) or {}).get('models'),
                    'version': adapter.get_version(), 'capabilities': vars(adapter.capabilities),
                    'values': values, 'provider': provider,
                    'catalog': catalog, 'provider_models': config_store.get_provider_models(*catalog).get('models') if catalog else None,
                    'source': source_hashes})


def _identity(project_id, engine_id, model, provider_id):
    return _digest([project_id, engine_id, model, provider_id])


def _remove(project, adapter, model, provider_id):
    with _LOCK:
        records = dict(config_store.get(_KEY, {}))
        records.pop(_identity(project.id, adapter.ENGINE_ID, model, provider_id), None)
        config_store.set(_KEY, records)


def is_verified(project, adapter, model, provider_id):
    record = config_store.get(_KEY, {}).get(_identity(project.id, adapter.ENGINE_ID, model, provider_id))
    return bool(record and adapter.capabilities.supports_coordinator and adapter.capabilities.supports_tool_disable
                and record.get('checks') == ['create', 'followup']
                and record.get('fingerprint') == fingerprint(project, adapter, provider_id))


def options(project, *, current_engine='', current_provider_id=''):
    result = []
    for record in config_store.get(_KEY, {}).values():
        if record.get('project_id') != project.id:
            continue
        engine_id = record['engine']
        expected_provider = current_provider_id if engine_id == current_engine else ''
        if record.get('provider_id') != expected_provider:
            continue
        if engine_id != current_engine and not config_store.is_engine_enabled(engine_id):
            continue
        try:
            adapter = create_engine(engine_id)
            if adapter is None or not adapter.capabilities.supports_coordinator or not adapter.capabilities.supports_tool_disable:
                continue
            catalog = adapter.resolve_provider_catalog(provider_id=record['provider_id'])
            if not catalog and not adapter.is_configured():
                continue
            if is_verified(project, adapter, record['model'], record['provider_id']):
                result.append({key: record[key] for key in ('engine', 'model', 'provider_id', 'verified_at', 'checks')})
        except (ValueError, OSError):
            continue
    return result


async def verify(project, adapter, model, provider_id, *, timeout=60):
    """Exercise the real coordinator seam twice with a pinned model and no tools."""
    if not adapter.capabilities.supports_coordinator or not adapter.capabilities.supports_tool_disable:
        raise ValueError('暂不支持：该引擎尚不支持经过验证的无工具委派测试。')
    identity = _identity(project.id, adapter.ENGINE_ID, model, provider_id)
    token = object()
    if _ACTIVE.setdefault(identity, token) is not token:
        raise ValueError('暂不支持：该组合正在验证，请等待当前测试完成后重试。')
    sessions = set()
    session_id = None
    history = []
    try:
        await asyncio.to_thread(_remove, project, adapter, model, provider_id)
        before = await asyncio.to_thread(fingerprint, project, adapter, provider_id)
        async with asyncio.timeout(timeout):
            for _ in range(2):
                token = 'WORKSTEP_DELEGATION_' + secrets.token_hex(12)
                text, completed, confirmed_model = [], False, False
                kwargs = dict(prompt='Do not use tools or modify files. Reply with exactly ' + token,
                              cwd=str(project.path), model=model, session_id=session_id,
                              config_overrides={'provider_id': provider_id} if provider_id else {},
                              workstep_tools=False)
                if adapter.supports_message_history:
                    kwargs['message_history'] = list(history)
                async with aclosing(adapter.spawn_coordinator(**kwargs)) as events:
                    async for event in events:
                        if event.type in {'error', 'tool_call', 'tool_call_update', 'interaction_request'}:
                            raise _ProbeFailure('引擎报错或尝试调用工具，无工具测试未通过')
                        if event.type in {'usage_update', 'session_started'} and event.data.get('model'):
                            if event.data['model'] != model:
                                raise _ProbeFailure('引擎报告的实际模型与指定模型不一致')
                            confirmed_model = True
                        if event.type == 'agent_message_chunk':
                            text.append(str((event.data.get('content') or {}).get('text') or ''))
                        if event.type == 'status' and event.data.get('status') == 'done':
                            completed = True
                        if event.type == 'session_started':
                            native_id = event.data.get('session_id')
                            if native_id:
                                sessions.add(native_id)
                                if adapter.supports_resume:
                                    session_id = native_id
                if not confirmed_model:
                    raise _ProbeFailure('引擎未报告实际模型，不能证明指定模型已生效')
                if not completed or ''.join(text).strip() != token:
                    raise _ProbeFailure('引擎未完成测试回执')
                if adapter.supports_resume and not session_id:
                    raise _ProbeFailure('未取得原生会话，无法验证跟进')
                history.extend([{'role': 'user', 'content': kwargs['prompt']}, {'role': 'assistant', 'content': token}])
        def commit():
            if fingerprint(project, adapter, provider_id) != before:
                raise _ProbeFailure('验证期间配置发生变化，请重新验证')
            record = {'project_id': project.id, 'engine': adapter.ENGINE_ID, 'model': model,
                      'provider_id': provider_id, 'fingerprint': before, 'checks': ['create', 'followup'],
                      'verified_at': datetime.now(timezone.utc).isoformat()}
            with _LOCK:
                records = dict(config_store.get(_KEY, {}))
                records[_identity(project.id, adapter.ENGINE_ID, model, provider_id)] = record
                config_store.set(_KEY, records)
            return {key: record[key] for key in ('engine', 'model', 'provider_id', 'verified_at', 'checks')}
        return await asyncio.to_thread(commit)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        reason = str(exc) if isinstance(exc, _ProbeFailure) else '测试超时' if isinstance(exc, TimeoutError) else '引擎测试或证据保存失败，请检查认证与模型配置'
        raise ValueError(f'暂不支持：{reason}；该组合未加入可选清单。使用 digital-hub delegate-options --project {project.id} --json 查询已验证选项。') from exc
    finally:
        _ACTIVE.pop(identity, None)
        with suppress(Exception):
            await asyncio.wait_for(adapter.stop(), 5)
        for native_id in sessions:
            with suppress(Exception):
                await asyncio.wait_for(adapter.close_session(native_id, str(project.path)), 5)
