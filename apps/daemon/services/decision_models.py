"""Host-scoped decision model settings and explicit tests; no business consumers."""
import asyncio
import json
import math
import os
import platform
import time
import threading
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from cryptography.fernet import Fernet

from services.config import CONFIG_DIR
from services.decision_resources import DecisionResources
from services.decision_runtime import DecisionRuntime
from services.decision_environment import probe, read_facts
from services.decision_catalog import DEFAULT_MODEL, MODELS, model_entry, public_catalog, resource_entry

TEST_PAYLOAD = {'state': 'WorkStep connection test. The service is ready.',
                'questions': {'ready': {'type': 'noul', 'instructions': 'Does the state say the service is ready?'}}}


def validate_settings(value):
    mode = value.get('mode', 'managed')
    if mode not in ('managed', 'local', 'remote'):
        raise ValueError('不支持的决策运行方式')
    url = str(value.get('base_url') or '').strip().rstrip('/')
    model = str(value.get('model') or '').strip()
    key = value.get('api_key')
    if key is not None and any(c in key for c in '\r\n\x00'):
        raise ValueError('认证信息无效')
    if mode != 'managed':
        parts = urlsplit(url)
        try:
            _ = parts.port
        except ValueError as exc:
            raise ValueError('服务端口无效') from exc
        if (parts.scheme not in ('http', 'https') or not parts.hostname or parts.username is not None
                or parts.password is not None or parts.query or parts.fragment or not model):
            raise ValueError('请填写有效服务地址和模型，认证信息请使用密钥字段')
    return {'mode': mode, 'base_url': url, 'model': model, 'api_key': key}


def validate_result(result):
    try:
        value = result['answers']['ready']['noul']
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError('服务未返回有效的 Jev 决策结果') from exc


class DecisionModelService:
    def __init__(self, root=None):
        self.root = Path(root) if root else CONFIG_DIR / 'decision-models'
        self.resources = DecisionResources(self.root)
        self.runtime = DecisionRuntime()
        self.transport = None
        self.remote_access = None
        self.lock = asyncio.Lock()
        self._settings_cache = None
        self._settings_lock = threading.RLock()

    def _settings(self):
        with self._settings_lock:
            if self._settings_cache is None:
                self._settings_cache = self._read_settings()
            return dict(self._settings_cache)

    def _read_settings(self):
        try:
            data = json.loads((self.root / 'settings.json').read_text())
            data['api_key'] = (Fernet((self.root / 'vault.key').read_bytes()).decrypt(data['api_key'].encode()).decode()
                               if data.get('api_key') else '')
            return data
        except FileNotFoundError:
            return {'mode': 'managed', 'base_url': '', 'model': '', 'api_key': ''}

    @staticmethod
    def public(settings):
        return {k: v for k, v in settings.items() if k != 'api_key'} | {'has_api_key': bool(settings.get('api_key'))}

    def _resolve(self, value):
        current = self._settings()
        result = validate_settings(value)
        if result['api_key'] is None:
            result['api_key'] = (current.get('api_key', '') if
                (current.get('mode'), current.get('base_url')) == (result['mode'], result['base_url']) else '')
        result['managed_model'] = value.get('managed_model') or current.get('managed_model', DEFAULT_MODEL)
        model_entry(result['managed_model'])
        result['proxy_enabled'] = bool(current.get('proxy_enabled', False) if value.get('proxy_enabled') is None else value['proxy_enabled'])
        return result

    def _save(self, value):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        data = dict(value)
        key_file = self.root / 'vault.key'
        if data.get('api_key'):
            try:
                fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                pass
            else:
                with os.fdopen(fd, 'wb') as out:
                    out.write(Fernet.generate_key())
            data['api_key'] = Fernet(key_file.read_bytes()).encrypt(data['api_key'].encode()).decode()
        stage = self.root / f'.settings-{uuid.uuid4().hex}.tmp'
        try:
            fd = os.open(stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as out:
                json.dump(data, out)
            stage.replace(self.root / 'settings.json')
            with self._settings_lock:
                self._settings_cache = dict(value)
        finally:
            stage.unlink(missing_ok=True)

    def _environment(self, model_id=None, facts=None):
        try:
            model = model_entry(model_id or self._settings().get('managed_model', DEFAULT_MODEL))
            runtime_kind = model.get('runtime_kind', 'runtime')
            installed = all(self.resources.installed(k) for k in (runtime_kind, model['resource_kind']))
            loaded = (self.runtime.process is not None and self.runtime.process.returncode is None
                      and self.runtime.model_path == self.resources.path(model['resource_kind']))
            return probe(self.root, installed=installed, loaded=loaded, model=model, facts=facts)
        except Exception:
            return {'supported': False, 'reasons': ['无法检测后台配置，请检查资源目录和系统权限']}

    async def _require_environment(self, model_id=None):
        environment = await asyncio.to_thread(self._environment, model_id) if model_id else await asyncio.to_thread(self._environment)
        if not environment['supported']:
            raise ValueError('配置不够：' + '；'.join(environment['reasons']))

    def _catalog_status(self):
        try:
            facts = read_facts(self.root)
        except Exception:
            facts = None
        models = public_catalog()
        for model in models:
            model['environment'] = self._environment(model['id'], facts)
        return models

    async def snapshot(self):
        settings, resources, models = await asyncio.gather(asyncio.to_thread(self._settings),
            asyncio.to_thread(self.resources.snapshot), asyncio.to_thread(self._catalog_status))
        environment = next((m['environment'] for m in models if m['id'] == settings.get('managed_model', DEFAULT_MODEL)),
                           {'supported': False, 'reasons': ['未知模型']})
        return {'models': models, 'settings': self.public(settings), 'root': str(self.root), 'resources': resources,
                'platform': f'{platform.system()} · {platform.machine()}', 'environment': environment,
                'worker': self.runtime.state, 'proxy': await asyncio.to_thread(self._proxy_status, settings)}

    def _proxy_status(self, settings):
        remote = self.remote_access.settings() if self.remote_access else {}
        suffix = '/api/decision-models/v1'
        from settings import settings as daemon_settings
        port = self.remote_access._daemon_port if self.remote_access else daemon_settings.port
        return {'model': settings.get('managed_model', DEFAULT_MODEL), 'enabled': bool(settings.get('proxy_enabled') and settings['mode'] == 'managed'),
                'access_key_set': bool(remote.get('access_password_set')),
                'local_url': f'http://127.0.0.1:{port}{suffix}',
                'lan_url': str(remote.get('internal_base_url') or '').rstrip('/') + suffix if remote.get('internal_base_url') else '',
                'remote_url': str(remote.get('external_base_url') or '').rstrip('/') + suffix if remote.get('external_base_url') else ''}

    async def infer(self, payload):
        # No waiting queue: settings/tests/downloads and inference share one owner.
        if self.lock.locked():
            raise BlockingIOError('本地推理繁忙，请稍后重试')
        async with self.lock:
            settings = await asyncio.to_thread(self._settings)
            if settings.get('mode') != 'managed' or not settings.get('proxy_enabled'):
                raise ValueError('本地代理未启用')
            selected = settings.get('managed_model', DEFAULT_MODEL)
            requested = payload.get('model', selected)
            if requested != selected:
                raise LookupError('请求模型与当前启用模型不一致')
            return await self._managed(selected, {k:v for k,v in payload.items() if k != 'model'})

    async def _managed(self, selected, payload):
        entry = model_entry(selected)
        kind = entry['resource_kind']
        runtime_kind = entry.get('runtime_kind', 'runtime')
        if self.resources.task and not self.resources.task.done():
            raise ValueError('请等待下载完成')
        path = self.resources.path(kind)
        if (self.runtime.process is None or self.runtime.process.returncode is not None
                or self.runtime.model_path != path):
            await self._require_environment(selected)
            ready = await asyncio.to_thread(lambda: all(self.resources.installed(k) for k in (runtime_kind, kind)))
            if not ready:
                raise ValueError('请先下载运行组件和所选模型')
            await asyncio.to_thread(self.resources.verify_model, kind)
        if entry.get('backend') == 'gguf':
            return await self.runtime.test_gguf(self.resources.path(runtime_kind), path, entry['files'][0][0], payload)
        return await self.runtime.test(self.resources.path(runtime_kind), path, payload)

    async def configure(self, value):
        async with self.lock:
            resolved = await asyncio.to_thread(self._resolve, value)
            if resolved.get('proxy_enabled') and resolved['mode'] == 'managed':
                await self._require_environment(resolved['managed_model'])
                def ensure_key():
                    if self.remote_access is None:
                        raise ValueError('远程访问服务未就绪')
                    if not self.remote_access.access_password_required():
                        key = str(value.get('access_key') or '').strip()
                        if not key or any(c in key for c in '\r\n\x00'):
                            raise ValueError('请先配置访问密钥')
                        self.remote_access.set_access_password(key)
                await asyncio.to_thread(ensure_key)
            await asyncio.to_thread(self._save, resolved)
            await self.runtime.close()
        return await self.snapshot()

    async def search_catalog(self, query):
        from services.decision_discovery import search_models
        candidates = search_models(query)
        catalog = await asyncio.to_thread(self._catalog_status)
        eligible = {model['id'] for model in catalog if model['environment']['supported']}
        candidates['models'] = [model for model in candidates['models'] if model['managed_model'] in eligible]
        return candidates

    async def available_models(self, value):
        if value.get('mode') not in ('local', 'remote'):
            raise ValueError('请先选择本地服务或远程服务')
        # Listing does not require a selected model and never persists the draft.
        resolved = await asyncio.to_thread(self._resolve, {**value, 'model': '__models__'})
        from services.decision_external import available_models
        return await available_models(resolved, self.transport)

    async def test(self, value):
        async with self.lock:
            resolved = await asyncio.to_thread(self._resolve, value)
            if resolved['mode'] == 'managed':
                await self._require_environment(resolved['managed_model'])
            started = time.monotonic()
            try:
                if resolved['mode'] == 'managed':
                    result = await self._managed(resolved['managed_model'], TEST_PAYLOAD)
                else:
                    headers = {'Authorization': f"Bearer {resolved['api_key']}"} if resolved['api_key'] else {}
                    base = resolved['base_url']
                    url = base + ('/systemone' if base.endswith('/v1') else '/v1/systemone')
                    async with asyncio.timeout(20), httpx.AsyncClient(headers=headers, transport=self.transport, timeout=15, follow_redirects=False) as client:
                        async with client.stream('POST', url, json={'model': resolved['model'], **TEST_PAYLOAD}) as response:
                            response.raise_for_status()
                            data = bytearray()
                            async for chunk in response.aiter_bytes():
                                data.extend(chunk)
                                if len(data) > 1024 * 1024:
                                    raise ValueError('响应过大')
                            result = json.loads(data)
                validate_result(result)
            except asyncio.CancelledError:
                raise
            except ValueError:
                if resolved['mode'] == 'managed':
                    raise ValueError('本地推理未就绪，请检查资源状态或重试测试') from None
                raise ValueError('服务未返回有效的 Jev 决策结果') from None
            except Exception:
                raise ValueError('决策连接测试失败，请检查地址、模型、认证及运行环境') from None
        return {'success': True, 'elapsed_ms': round((time.monotonic() - started) * 1000), 'mode': resolved['mode']}

    async def download(self, kind):
        if kind == 'runtime-gguf':
            selected = next(m['id'] for m in MODELS if m.get('backend') == 'gguf')
        elif kind == 'runtime':
            selected = DEFAULT_MODEL
        else:
            selected = resource_entry(kind)['id']
        await self._require_environment(selected)
        async with self.lock:
            await self.runtime.close()
            await self.resources.download(kind)
        return await self.snapshot()

    async def delete(self, kind):
        async with self.lock:
            await self.runtime.close()
            await self.resources.delete(kind)
        return await self.snapshot()

    async def close(self):
        await self.resources.close()
        await self.runtime.close()


service = DecisionModelService()
