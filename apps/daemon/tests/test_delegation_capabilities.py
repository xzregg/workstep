import asyncio
from types import SimpleNamespace

import pytest

from engines.core.events import InternalEvent
from tests.test_digital_person_runtime import chat_module, runtime


class Store:
    def __init__(self):
        self.values = {}
    def get(self, key, default=None):
        return self.values.get(key, default)
    def set(self, key, value):
        self.values[key] = value
    def get_provider_models(self, *args):
        return {'models': []}
    def get_provider(self, provider_id):
        return {"id": provider_id}
    def is_engine_enabled(self, engine):
        return True


class Adapter:
    ENGINE_ID = 'tested-engine'
    supports_resume = True
    supports_message_history = False
    capabilities = SimpleNamespace(supports_coordinator=True, supports_tool_disable=True)
    def __init__(self):
        self.calls = []
        self.config = {'setting': 'original'}
        self.version = '1'
        self.fail = False
        self.closed = []
    def is_configured(self):
        return True
    def get_full_config_values(self):
        return self.config
    def full_config_schema(self):
        return []
    def get_version(self):
        return self.version
    def resolve_provider_catalog(self, provider_id=''):
        return None
    async def spawn_coordinator(self, **kwargs):
        self.calls.append(kwargs)
        token = kwargs['prompt'].split()[-1]
        yield InternalEvent(type='session_started', data={'session_id': 'native', 'model': kwargs['model']})
        yield InternalEvent(type='agent_message_chunk', data={'content': {'text': 'wrong' if self.fail else token}})
        yield InternalEvent(type='status', data={'status': 'done'})
    async def close_session(self, session_id, cwd):
        self.closed.append(session_id)
    async def stop(self):
        pass


@pytest.mark.parametrize('change', ['model', 'project', 'config', 'version', 'provider'])
async def test_verified_list_requires_real_two_round_evidence_and_exact_context(tmp_path, monkeypatch, change):
    from services import delegation_capabilities as capabilities
    store, adapter = Store(), Adapter()
    monkeypatch.setattr(capabilities, 'config_store', store)
    monkeypatch.setattr(capabilities, 'create_engine', lambda _: adapter)
    project = SimpleNamespace(id='project', path=tmp_path)
    assert capabilities.options(project) == []
    assert await capabilities.verify(project, adapter, 'model', '')
    assert [(call['model'], call.get('session_id')) for call in adapter.calls] == [('model', None), ('model', 'native')]
    assert capabilities.options(project)[0]['model'] == 'model'
    if change == 'config':
        adapter.config['setting'] = 'changed'
    elif change == 'version':
        adapter.version = '2'
    elif change == 'provider':
        adapter.resolve_provider_catalog = lambda **kwargs: ('new-provider', 'openai')
    checked_project = SimpleNamespace(id='other', path=tmp_path) if change == 'project' else project
    assert not capabilities.is_verified(checked_project, adapter, 'different' if change == 'model' else 'model', '')


async def test_failed_verification_revokes_only_that_combination(tmp_path, monkeypatch):
    from services import delegation_capabilities as capabilities
    store, adapter = Store(), Adapter()
    monkeypatch.setattr(capabilities, 'config_store', store)
    monkeypatch.setattr(capabilities, 'create_engine', lambda _: adapter)
    project = SimpleNamespace(id='project', path=tmp_path)
    await capabilities.verify(project, adapter, 'good', '')
    await capabilities.verify(project, adapter, 'other', '')
    adapter.fail = True
    with pytest.raises(ValueError, match='暂不支持'):
        await capabilities.verify(project, adapter, 'good', '')
    assert [item['model'] for item in capabilities.options(project)] == ['other']


async def test_wrong_actual_model_is_never_verified(tmp_path, monkeypatch):
    from services import delegation_capabilities as capabilities
    store, adapter = Store(), Adapter()
    monkeypatch.setattr(capabilities, 'config_store', store)
    async def wrong(**kwargs):
        yield InternalEvent(type='usage_update', data={'model': 'fallback'})
        yield InternalEvent(type='agent_message_chunk', data={'content': {'text': kwargs['prompt'].split()[-1]}})
        yield InternalEvent(type='status', data={'status': 'done'})
    adapter.spawn_coordinator = wrong
    project = SimpleNamespace(id='project', path=tmp_path)
    with pytest.raises(ValueError, match='暂不支持'):
        await capabilities.verify(project, adapter, 'requested', '')
    assert capabilities.options(project) == []


async def test_configured_names_and_legacy_verified_flag_cannot_bypass_project_ledger(runtime, monkeypatch, tmp_path):
    import main
    from fastapi import FastAPI
    from httpx import ASGITransport
    from api.digital_person import router
    from cli import build_parser, dispatch
    from services.tool_registry import WorkstepClient
    from services import delegation_capabilities as capabilities, delegation_execution as selection
    current, _, store = runtime
    store.set('digital_person', {'enabled': True})
    store.set('verified_engines', {'claude': True})
    store.set('engine_models', {'claude': {'models': [{'id': 'candidate'}, {'id': 'other'}]}})
    monkeypatch.setattr(store, 'is_engine_enabled', lambda _: True, raising=False)
    monkeypatch.setattr(store, 'get_engine_models', lambda engine: store.get('engine_models')[engine], raising=False)
    monkeypatch.setattr(capabilities, 'config_store', store)
    monkeypatch.setattr(selection, 'config_store', store)
    adapter = Adapter()
    adapter.ENGINE_ID = 'claude'
    monkeypatch.setattr(capabilities, 'create_engine', lambda _: adapter)
    monkeypatch.setattr(selection, 'create_engine', lambda _: adapter)
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    target = await asyncio.to_thread(current.projects.init_project, tmp_path / 'verified')
    origin = (await current.main_session())['id']
    app = FastAPI()
    app.include_router(router)
    client = WorkstepClient(base_url='http://test', transport=ASGITransport(app))
    async def call(action, *flags):
        return await dispatch(build_parser().parse_args(['digital-hub', action, '--project', target.id, *flags]), client)
    async def delegate(key, *flags):
        return await call('delegate', '--session', origin, '--instruction', key, '--idempotency-key', key, *flags)
    assert (await call('delegate-options'))['items'] == []
    rejected = await delegate('new-unverified', '--engine', 'claude', '--model', 'candidate')
    assert rejected['ok'] is False and '暂不支持' in rejected['error'] and '暂无已验证' in rejected['error']
    from models.chat_session import ChatSession, ChatMessage
    assert await current.projects.run_db(target.id, lambda _: ChatSession.select().count()) == 0
    verified = await call('delegate-verify', '--engine', 'claude', '--model', 'candidate')
    assert verified['verified'] is True
    assert (await call('delegate-options'))['items'][0]['model'] == 'candidate'
    # The verification route uses actual adapter turns, never the legacy boolean.
    assert len(adapter.calls) == 2
    captured = []
    async def invoke(engine_id, model, *args, **kwargs):
        captured.append((engine_id, model))
        return 'Done', [], 'actual-session'
    monkeypatch.setattr(current.chats, '_invoke', invoke)
    first = await delegate('new-verified', '--engine', 'claude', '--model', 'candidate')
    await current.chats.await_turn(first['turn_id'], timeout=2)
    assert captured[-1] == ('claude', 'candidate')
    before = await current.projects.run_db(target.id, lambda _: ChatMessage.select().count())
    for selector, value in [('--continue-from', first['id']), ('--target-session', first['session_id'])]:
        result = await delegate('follow-unverified-' + selector, selector, value, '--model', 'other')
        assert result['ok'] is False and '暂不支持' in result['error'] and 'claude / candidate' in result['error']
        assert await current.projects.run_db(target.id, lambda _: ChatMessage.select().count()) == before
    second = await delegate('follow-verified', '--continue-from', first['id'], '--model', 'candidate')
    await current.chats.await_turn(second['turn_id'], timeout=2)
    assert captured[-1] == ('claude', 'candidate')
    adapter.version = 'changed'
    assert (await call('delegate-options'))['items'] == []
    result = await delegate('stale', '--target-session', first['session_id'], '--model', 'candidate')
    assert result['ok'] is False and '暂不支持' in result['error']
    # Omitted selection preserves the prior default behavior even without evidence.
    inherited = await delegate('no-overrides', '--continue-from', first['id'])
    await current.chats.await_turn(inherited['turn_id'], timeout=2)
    assert inherited['model'] == 'candidate'


async def test_probe_without_actual_model_confirmation_never_enters_options(tmp_path, monkeypatch):
    from services import delegation_capabilities as capabilities
    store, adapter = Store(), Adapter()
    monkeypatch.setattr(capabilities, 'config_store', store)
    async def ignores_model(**kwargs):
        yield InternalEvent(type='agent_message_chunk', data={'content': {'text': kwargs['prompt'].split()[-1]}})
        yield InternalEvent(type='status', data={'status': 'done'})
    adapter.spawn_coordinator = ignores_model
    project = SimpleNamespace(id='project', path=tmp_path)
    with pytest.raises(ValueError, match='暂不支持'):
        await capabilities.verify(project, adapter, 'requested', '')
    assert capabilities.options(project) == []


@pytest.mark.parametrize('failure', ['followup', 'configuration', 'timeout'])
async def test_partial_or_stale_verification_is_not_a_supported_combination(tmp_path, monkeypatch, failure):
    from services import delegation_capabilities as capabilities
    store, adapter = Store(), Adapter()
    monkeypatch.setattr(capabilities, 'config_store', store)
    original = adapter.spawn_coordinator
    async def probe(**kwargs):
        if failure == 'timeout':
            await asyncio.sleep(.1)
        if adapter.calls:
            if failure == 'followup':
                adapter.fail = True
            if failure == 'configuration':
                adapter.config['setting'] = 'changed'
        async for event in original(**kwargs):
            yield event
    adapter.spawn_coordinator = probe
    project = SimpleNamespace(id='project', path=tmp_path)
    with pytest.raises(ValueError, match='暂不支持'):
        await capabilities.verify(project, adapter, 'model', '', timeout=.01 if failure == 'timeout' else 1)
    assert capabilities.options(project) == []


async def test_slow_verification_fingerprint_keeps_options_api_responsive(runtime, monkeypatch, tmp_path):
    import main
    import threading
    import time
    from fastapi import FastAPI
    from httpx import AsyncClient, ASGITransport
    from api.digital_person import router
    from services import delegation_capabilities as capabilities
    current, _, _ = runtime
    store, adapter = Store(), Adapter()
    monkeypatch.setattr(capabilities, 'config_store', store)
    monkeypatch.setattr(capabilities, 'create_engine', lambda _: adapter)
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    project = await asyncio.to_thread(current.projects.init_project, tmp_path / 'slow-catalog')
    await capabilities.verify(project, adapter, 'model', '')
    entered = threading.Event()
    def slow_version():
        entered.set()
        time.sleep(.25)
        return adapter.version
    adapter.get_version = slow_version
    app = FastAPI()
    app.include_router(router)
    @app.get('/health')
    async def health():
        return {'ok': True}
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        pending = asyncio.create_task(client.get('/api/digital-person/delegation-options', params={'project_id': project.id}))
        async with asyncio.timeout(1):
            while not entered.is_set():
                await asyncio.sleep(.005)
        assert (await asyncio.wait_for(client.get('/health'), .1)).status_code == 200
        response = await pending
        assert response.status_code == 200 and response.json()['items'][0]['model'] == 'model'


async def test_concurrent_verification_is_explicitly_rejected_and_does_not_block_loop(tmp_path, monkeypatch):
    from services import delegation_capabilities as capabilities
    store, adapter = Store(), Adapter()
    monkeypatch.setattr(capabilities, 'config_store', store)
    entered, release = asyncio.Event(), asyncio.Event()
    original = adapter.spawn_coordinator
    async def blocked(**kwargs):
        entered.set()
        await release.wait()
        async for event in original(**kwargs):
            yield event
    adapter.spawn_coordinator = blocked
    project = SimpleNamespace(id='project', path=tmp_path)
    task = asyncio.create_task(capabilities.verify(project, adapter, 'model', ''))
    await asyncio.wait_for(entered.wait(), 1)
    try:
        with pytest.raises(ValueError, match='正在验证'):
            await capabilities.verify(project, adapter, 'model', '')
    finally:
        release.set()
        await task
