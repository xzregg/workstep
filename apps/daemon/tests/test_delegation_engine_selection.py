import asyncio
from types import SimpleNamespace

import pytest
from httpx import ASGITransport

from tests.test_digital_person_runtime import chat_module, runtime


@pytest.fixture(autouse=True)
def verified_selection_seam(monkeypatch):
    # These tests isolate configuration admission/application. The real evidence
    # ledger, probe and denial paths are exercised in test_delegation_capabilities.
    monkeypatch.setattr('services.delegation_capabilities.is_verified', lambda *args: True)


@pytest.mark.parametrize('target_kind', ['continue', 'session', 'untracked'])
@pytest.mark.parametrize('creation_flags', [[], ['--engine', 'claude'], ['--model', 'model-a'], ['--engine', 'claude', '--model', 'model-a']])
async def test_cli_selection_reaches_saved_session_and_actual_turn(runtime, monkeypatch, tmp_path, target_kind, creation_flags):
    import main
    from fastapi import FastAPI
    from api.digital_person import router
    from cli import build_parser, dispatch
    from models.chat_session import ChatMessage
    from services.tool_registry import WorkstepClient
    from services import delegation_execution as selection

    current, _, store = runtime
    store.set('digital_person', {'enabled': True})
    store.values['engine_default_models'] = {'claude': 'model-a'}
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    monkeypatch.setattr(selection, 'config_store', SimpleNamespace(
        get_assistant_defaults=store.get_assistant_defaults, get_assistant_config=store.get_assistant_config,
        is_engine_enabled=lambda _: True,
        get_engine_models=lambda _: {'models': [{'id': 'model-a'}, {'id': 'model-b'}]},
        get_engine_default_model=lambda _: 'model-a',
    ))
    adapter = SimpleNamespace(capabilities=SimpleNamespace(supports_coordinator=True), is_configured=lambda: True)
    monkeypatch.setattr(selection, 'create_engine', lambda _: adapter)
    calls = []
    async def invoke(engine_id, model, *args, **kwargs):
        calls.append((engine_id, model))
        return 'Done', [], 'native'
    monkeypatch.setattr(current.chats, '_invoke', invoke)
    target = await asyncio.to_thread(current.projects.init_project, tmp_path / 'execution')
    origin = (await current.main_session())['id']
    app = FastAPI()
    app.include_router(router)
    client = WorkstepClient(base_url='http://test', transport=ASGITransport(app))
    async def call(key, *flags):
        return await dispatch(build_parser().parse_args([
            'digital-hub', 'delegate', '--project', target.id, '--session', origin,
            '--instruction', key, '--idempotency-key', key, *flags]), client)
    first = await call('create', *creation_flags)
    assert 'ok' not in first, first
    await current.chats.await_turn(first['turn_id'], timeout=2)
    if target_kind == 'untracked':
        first['session_id'] = await current.projects.run_db(target.id, lambda _: current.chats.create_session(
            target.id, engine='claude', model='model-a')['id'])
    flags = ['--continue-from', first['id']] if target_kind == 'continue' else ['--target-session', first['session_id']]
    second = await call('follow', *flags, '--model', 'model-b')
    assert 'ok' not in second, second
    await current.chats.await_turn(second['turn_id'], timeout=2)
    config = await current.projects.run_db(target.id, lambda _: current.chats.get_execution_config(target.id, first['session_id']))
    message = await current.projects.run_db(target.id, lambda _: ChatMessage.get_by_id(second['message_id']).model)
    assert config['model'] == message == second['model'] == 'model-b'
    assert second['engine'] == 'claude'
    assert calls[-1] == ('claude', 'model-b')
    replay = await call('follow', *flags, '--model', 'model-b')
    assert replay['execution_id'] == second['execution_id']
    conflict = await call('follow', *flags, '--model', 'model-a')
    assert conflict['ok'] is False and 'identifier' in conflict['error']
    inherited = await call('inherit', *flags)
    await current.chats.await_turn(inherited['turn_id'], timeout=2)
    assert inherited['model'] == 'model-b'
    rejected = await call('invalid', *flags, '--model', 'unknown')
    assert rejected['ok'] is False and 'engine models' in rejected['error']
    assert await current.projects.run_db(target.id, lambda _: current.chats.get_execution_config(target.id, first['session_id'])) == config


async def test_engine_model_discovery_cli_and_native_schema():
    import httpx
    from cli import build_parser, dispatch
    from services.tool_registry import WorkstepClient
    def handler(request):
        assert request.url.path == '/api/engine/claude/models'
        assert dict(request.url.params) == {'project_id': 'p', 'provider_id': 'provider', 'refresh': 'true'}
        return httpx.Response(200, json={'models': [{'id': 'discovered'}]})
    args = build_parser().parse_args(['engine', 'models', '--engine', 'claude', '--project', 'p',
                                     '--provider', 'provider', '--refresh', '--json'])
    assert await dispatch(args, WorkstepClient(transport=httpx.MockTransport(handler))) == {'models': [{'id': 'discovered'}]}


async def test_switch_busy_rejection_and_admission_failure_rollback(runtime, monkeypatch, tmp_path):
    from services import delegation_execution as selection
    from models.chat_session import ChatMessage, ChatSession
    current, _, store = runtime
    store.set('digital_person', {'enabled': True})
    monkeypatch.setattr(selection, 'config_store', SimpleNamespace(
        is_engine_enabled=lambda _: True, get_engine_default_model=lambda _: 'target-default',
        get_engine_models=lambda _: {'models': [{'id': 'target-default'}]}))
    monkeypatch.setattr(selection, 'create_engine', lambda _: SimpleNamespace(is_configured=lambda: True))
    monkeypatch.setattr(current.chats, '_validate_engine', lambda _: None)
    target = await asyncio.to_thread(current.projects.init_project, tmp_path / 'switch')
    origin = (await current.main_session())['id']
    calls = []
    async def invoke(engine_id, model, *args, **kwargs):
        calls.append((engine_id, model))
        return 'Done', [], 'native'
    monkeypatch.setattr(current.chats, '_invoke', invoke)
    first = await current.delegate(target.id, 'first', origin, 'first')
    await current.chats.await_turn(first['turn_id'], timeout=2)
    def seed_busy(_):
        from models.fields import utc_now
        ChatMessage.create(id='queued', session=first['session_id'], role='assistant', status='queued', created_at=utc_now())
    await current.projects.run_db(target.id, seed_busy)
    with pytest.raises(ValueError, match='busy'):
        await current.delegate(target.id, 'busy', origin, 'busy', first['id'], engine='codex')
    await current.projects.run_db(target.id, lambda _: ChatMessage.delete().where(ChatMessage.id == 'queued').execute())
    switched = await current.delegate(target.id, 'switch', origin, 'switch', first['id'], engine='codex')
    await current.chats.await_turn(switched['turn_id'], timeout=2)
    assert switched['engine'] == 'codex' and switched['model'] == 'target-default'
    assert calls[-1] == ('codex', 'target-default')
    def snapshot(_):
        row = ChatSession.get_by_id(first['session_id'])
        msg = ChatMessage.get_by_id(switched['message_id'])
        assert (msg.engine, msg.model) == ('codex', 'target-default')
        return row.engine, row.model, row.execution_config_revision, ChatMessage.select().count()
    before = await current.projects.run_db(target.id, snapshot)
    def fail(*args, **kwargs):
        raise ValueError('admission failed')
    monkeypatch.setattr(current.chats, 'submit_message', fail)
    with pytest.raises(ValueError, match='admission failed'):
        await current.delegate(target.id, 'rollback', origin, 'rollback', first['id'], engine='claude')
    assert await current.projects.run_db(target.id, snapshot) == before
    session = current.chats._sessions[current.chats._session_identity(target.id, first['session_id'])[0]]
    assert session.engine == 'codex'


@pytest.mark.parametrize('failure', ['unavailable', 'hidden', 'model', 'empty', 'provider'])
def test_selection_rejects_invalid_engine_or_model(monkeypatch, failure):
    from services import delegation_execution as selection
    adapter = SimpleNamespace(is_configured=lambda: True)
    if failure == 'provider':
        adapter.resolve_provider_catalog = lambda **kwargs: ('provider', 'openai')
        monkeypatch.setattr('services.providers.saved_models', lambda *args: [SimpleNamespace(id='provider-only')])
    monkeypatch.setattr(selection, 'create_engine', lambda _: None if failure == 'unavailable' else adapter)
    monkeypatch.setattr(selection, 'config_store', SimpleNamespace(
        is_engine_enabled=lambda _: failure != 'hidden',
        get_engine_models=lambda _: {'models': [{'id': 'native-only'}]}))
    chats = SimpleNamespace(_validate_engine=lambda _: None,
                            _project_manager=SimpleNamespace(get_project_by_id=lambda _: SimpleNamespace(id='p')))
    with pytest.raises(ValueError):
        selection.validate_selection(chats, 'p', 'new', '' if failure == 'empty' else 'native-only' if failure == 'provider' else 'unknown', {'engine': 'old'})


async def test_selection_database_and_catalog_work_does_not_block_api(runtime, monkeypatch, tmp_path):
    import main
    import threading
    import time
    from fastapi import FastAPI
    from httpx import AsyncClient
    from api.digital_person import router
    from services import delegation_execution as selection
    current, _, store = runtime
    store.set('digital_person', {'enabled': True})
    target = await asyncio.to_thread(current.projects.init_project, tmp_path / 'slow')
    origin = (await current.main_session())['id']
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    entered = threading.Event()
    def slow(*args, **kwargs):
        entered.set()
        time.sleep(.25)
        raise ValueError('slow unavailable engine')
    monkeypatch.setattr(selection, 'validate_selection', slow)
    app = FastAPI()
    app.include_router(router)
    @app.get('/health')
    async def health():
        return {'ok': True}
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        request = asyncio.create_task(client.post('/api/digital-person/delegate', json={
            'project_id': target.id, 'origin_session_id': origin, 'instruction': 'slow', 'request_id': 'slow', 'engine': 'codex'}))
        while not entered.is_set():
            await asyncio.sleep(.005)
        assert (await asyncio.wait_for(client.get('/health'), timeout=.1)).status_code == 200
        assert (await request).status_code == 400


@pytest.mark.parametrize('access,project', [('read', 'target'), ('edit', 'other')])
async def test_runtime_selection_cannot_cross_project_grants(runtime, access, project):
    from services.remote_access import ActorSnapshot, actor_context
    current, _, store = runtime
    store.set('digital_person', {'enabled': True})
    actor = ActorSnapshot(actor_id='u', user_name='u', device_id='d', device_name='d',
                          source='remote_project', project_id=project, access_level=access)
    with actor_context(actor), pytest.raises(ValueError, match='edit permission'):
        await current.delegate('target', 'denied', 'origin', 'denied', engine='codex', model='model')


async def test_host_api_rejects_project_identity_with_explicit_selection(runtime, monkeypatch):
    import main
    from fastapi import FastAPI
    from httpx import AsyncClient
    from api.digital_person import router
    from services.remote_access import ActorSnapshot, actor_context
    current, _, _ = runtime
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    app = FastAPI()
    app.include_router(router)
    actor = ActorSnapshot(actor_id='u', user_name='u', device_id='d', device_name='d',
                          source='remote_project', project_id='target', access_level='edit')
    with actor_context(actor):
        async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
            for route, extra in [('/delegate', {}), ('/delegate/existing', {'target_session_id': 'session'})]:
                response = await client.post('/api/digital-person' + route, json={
                    'project_id': 'target', 'origin_session_id': 'origin', 'instruction': 'denied',
                    'request_id': 'denied', 'engine': 'codex', 'model': 'model', **extra})
                assert response.status_code == 403


def test_provider_override_uses_its_saved_catalog_even_without_engine_default(monkeypatch):
    from services import delegation_execution as selection
    seen = []
    def resolve(provider_id):
        seen.append(provider_id)
        return ('provider', 'openai')
    adapter = SimpleNamespace(is_configured=lambda: False, resolve_provider_catalog=resolve)
    monkeypatch.setattr(selection, 'create_engine', lambda _: adapter)
    monkeypatch.setattr('services.providers.saved_models', lambda *args: [SimpleNamespace(id='provider-model')])
    monkeypatch.setattr(selection, 'config_store', SimpleNamespace(
        get_assistant_defaults=lambda _: {'engine': 'engine'},
        get_assistant_config=lambda _: {'provider_id': 'provider'}))
    chats = SimpleNamespace(_validate_engine=lambda _: None, _execution_settings_name=lambda _: 'chat',
                            _project_manager=SimpleNamespace(get_project_by_id=lambda _: SimpleNamespace(id='p')),
                            _resolve_project_engine_models=lambda _: ('engine', None, None))
    assert selection.validate_selection(chats, 'p', None, 'provider-model') == {
        'engine': 'engine', 'model': 'provider-model', 'provider_id': 'provider'}
    assert seen == ['provider']
