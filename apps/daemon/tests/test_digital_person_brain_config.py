"""Brain settings update only the bound main conversation."""
import asyncio
import threading

import pytest
from httpx import ASGITransport, AsyncClient

import main
from models.chat_session import ChatMessage, ChatSession
from models.fields import utc_now
from tests.test_chat_session import chat_module, _wait_turn
from tests.test_digital_person_runtime import runtime


@pytest.fixture
async def brain_client(runtime, monkeypatch, tmp_path):
    current, project, _ = runtime
    import api.assistant as api
    from tests.test_chat_session import FakeEngine
    from agent_assistants import channel_chat  # Registers the real digital-person config.
    from tests.test_assistant_api import _config_store
    store = _config_store(tmp_path, monkeypatch)
    store.set_execution_default_engine('claude')
    store.set_user_name('测试用户')
    store.set('digital_person', {'enabled': True})
    for target in ('api.assistant', 'services.config', 'services.project', 'services.digital_person',
                   'agent_assistants.base', 'agent_assistants.chat_session'):
        monkeypatch.setattr(f'{target}.config_store', store)
    monkeypatch.setattr(api, 'create_engine', lambda _: FakeEngine())
    monkeypatch.setattr('agent_assistants.chat_session_transitions.create_engine', lambda _: FakeEngine())
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    monkeypatch.setattr(main, 'project_manager', current.projects)
    monkeypatch.setattr(main, 'chat_session_module', current.chats)
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
        yield client, current, project, store


async def test_save_brain_updates_bound_session_and_broadcasts(brain_client, monkeypatch):
    client, current, project, store = brain_client
    sid = (await current.main_session())['id']
    other = await current.projects.run_db(project.id, lambda _: current.chats.create_session(project.id, model='other'))
    queue = current.bus.subscribe()
    captured = []
    async def invoke(engine_id, model, *args, **kwargs):
        captured.append(model)
        return 'reply', [], 'native-thread'
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    response = await client.put('/api/assistant/digital_person/config', json={
        'engine': 'claude', 'model': 'new-main', 'fast_model': 'new-fast', 'vision_model': 'new-vision',
    })
    assert response.status_code == 200, response.text
    event = await asyncio.wait_for(queue.get(), .5)
    assert event['name'] == 'workstep.chat_execution_config'
    assert event['session_id'] == sid
    assert event['value']['model'] == 'new-main'
    assert event['value']['vision_model'] == 'new-vision'
    config = (await client.get(f'/api/chat-sessions/{sid}/execution-config', params={'project_id': project.id})).json()
    assert config['fast_model'] == 'new-fast'
    assert config['execution_config_revision'] > 0
    assert (await current.main_session())['id'] == sid
    unchanged = await current.projects.run_db(project.id, lambda _: current.chats.get_session(project.id, other['id']))
    assert unchanged['model'] == 'other'
    sent = await client.post(f'/api/chat-sessions/{sid}/chat', headers={'Idempotency-Key': 'brain-sync'}, json={
        'project_id': project.id, 'content': 'hello', 'model': 'stale-model',
    })
    assert sent.status_code == 200, sent.text
    assert await _wait_turn(current.chats, sent.json()['turn_id']) == 'completed'
    assert captured == ['new-main']
    from pathlib import Path
    upload = Path(project.workstep_dir) / 'uploads' / 'scene.png'
    upload.parent.mkdir(parents=True, exist_ok=True)
    upload.write_bytes(b'test-image')
    sent = await client.post(f'/api/chat-sessions/{sid}/chat', headers={'Idempotency-Key': 'brain-image'}, json={
        'project_id': project.id, 'content': 'look\n\n![scene](.workstep/uploads/scene.png)',
    })
    assert sent.status_code == 200, sent.text
    assert await _wait_turn(current.chats, sent.json()['turn_id']) == 'completed'
    assert captured == ['new-main', 'new-vision']


@pytest.mark.parametrize('busy', ['running', 'queued'])
async def test_busy_main_rejects_brain_save_without_changing_defaults(brain_client, busy):
    client, current, project, store = brain_client
    sid = (await current.main_session())['id']
    before = store.get_assistant_config('digital_person').copy()
    if busy == 'running':
        await current.projects.run_db(project.id, lambda _: ChatMessage.create(
            id='busy', session=sid, role='assistant', status='running', content='', created_at=utc_now()))
    else:
        current.chats._turn_states['busy'] = {'session_id': sid, 'status': 'queued'}
    response = await client.put('/api/assistant/digital_person/config', json={'engine': 'claude', 'model': 'new-main'})
    assert response.status_code == 409, response.text
    assert store.get_assistant_config('digital_person') == before
    config = await current.projects.run_db(project.id, lambda _: current.chats.get_execution_config(project.id, sid))
    assert config['model'] != 'new-main'


async def test_save_before_main_exists_does_not_create_a_conversation(brain_client):
    client, current, project, store = brain_client
    response = await client.put('/api/assistant/digital_person/config', json={'engine': 'claude', 'vision_model': 'new-vision'})
    assert response.status_code == 200, response.text
    assert await current.projects.run_db(project.id, lambda _: ChatSession.select().count()) == 0
    assert (await current.main_session())['vision_model'] == 'new-vision'


async def test_workspace_chat_uses_ordinary_defaults_while_main_uses_brain(brain_client):
    client, current, project, store = brain_client
    store.set_assistant_defaults('chat_session', engine='codex_sdk', model='ordinary-model', fast_model='ordinary-fast', vision_model='ordinary-vision')
    store.set_assistant_defaults('digital_person', engine='claude', model='brain-model', fast_model='brain-fast', vision_model='brain-vision', thinking_effort='high')
    response = await client.post('/api/chat-sessions', json={'project_id': project.id})
    assert response.status_code == 200, response.text
    ordinary = response.json()
    assert (ordinary['engine'], ordinary['model'], ordinary['fast_model'], ordinary['vision_model']) == ('codex_sdk', 'ordinary-model', 'ordinary-fast', 'ordinary-vision')
    main = await current.main_session()
    assert (main['engine'], main['model'], main['fast_model'], main['vision_model']) == ('claude', 'brain-model', 'brain-fast', 'brain-vision')
    assert main['thinking_effort'] == 'high'
    store.set_assistant_defaults('digital_person', engine='claude', model='brain-changed')
    saved = await current.projects.run_db(project.id, lambda _: current.chats.get_session(project.id, ordinary['id']))
    assert saved['model'] == 'ordinary-model'


async def test_slow_brain_session_write_keeps_health_responsive(brain_client, monkeypatch):
    client, current, project, _ = brain_client
    await current.main_session()
    original = project.db.execute_sql
    entered, release = threading.Event(), threading.Event()
    def slow_write(sql, params=None, commit=None):
        if not entered.is_set() and sql.startswith('UPDATE "chat_sessions"'):
            entered.set()
            release.wait(2)
        return original(sql, params)
    monkeypatch.setattr(project.db, 'execute_sql', slow_write)
    pending = asyncio.create_task(client.put('/api/assistant/digital_person/config', json={'engine': 'claude', 'model': 'new-main'}))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        assert (await asyncio.wait_for(client.get('/api/health'), .2)).status_code == 200
    finally:
        release.set()
    assert (await pending).status_code == 200


async def test_brain_inherits_engine_and_can_clear_model_overrides(brain_client):
    client, current, project, store = brain_client
    sid = (await current.main_session())['id']
    response = await client.put('/api/assistant/digital_person/config', json={
        'model': 'gm', 'vision_model': 'gv', 'fast_model': 'gf',
    })
    assert response.status_code == 200, response.text
    assert response.json()['configured']['engine'] == ''
    assert response.json()['resolved']['engine'] == 'claude'
    response = await client.put('/api/assistant/digital_person/config', json={})
    assert response.status_code == 200, response.text
    config = await current.projects.run_db(project.id, lambda _: current.chats.get_execution_config(project.id, sid))
    assert config['model'] is None
    assert config['vision_model'] is None
    assert config['fast_model'] is None


async def test_engine_change_reuses_main_id_and_preserves_history(brain_client):
    client, current, project, _ = brain_client
    sid = (await current.main_session())['id']
    await current.projects.run_db(project.id, lambda _: ChatMessage.create(
        id='old-message', session=sid, role='user', content='keep history', status='completed', created_at=utc_now()))
    response = await client.put('/api/assistant/digital_person/config', json={
        'engine': 'codex_sdk', 'model': 'new-main', 'vision_model': 'new-vision', 'thinking_effort': 'low',
    })
    assert response.status_code == 200, response.text
    config = await current.projects.run_db(project.id, lambda _: current.chats.get_execution_config(project.id, sid))
    assert config['engine'] == 'codex_sdk'
    assert config['model'] == 'new-main'
    assert config['vision_model'] == 'new-vision'
    assert config['thinking_effort'] == 'low'
    assert (await current.main_session())['id'] == sid
    assert await current.projects.run_db(project.id, lambda _: ChatMessage.get_by_id('old-message').content) == 'keep history'


async def test_archived_main_is_not_changed_or_recreated_on_save(brain_client):
    client, current, project, _ = brain_client
    sid = (await current.main_session())['id']
    await current.projects.run_db(project.id, lambda _: ChatSession.update(archived=True).where(ChatSession.id == sid).execute())
    response = await client.put('/api/assistant/digital_person/config', json={'engine': 'claude', 'model': 'new-main'})
    assert response.status_code == 200, response.text
    assert await current.projects.run_db(project.id, lambda _: ChatSession.select().count()) == 1
    assert await current.projects.run_db(project.id, lambda _: ChatSession.get_by_id(sid).model) != 'new-main'
    assert (await current.main_session())['model'] == 'new-main'


async def test_project_identity_cannot_change_host_brain(brain_client):
    from services.remote_access import ActorSnapshot, actor_context
    client, current, project, store = brain_client
    before = store.get_assistant_config('digital_person')
    with actor_context(ActorSnapshot(actor_id='project', user_name='Project user', device_id='test',
                                    device_name='Test', source='managed', project_id=project.id, access_level='edit')):
        response = await client.put('/api/assistant/digital_person/config', json={'model': 'forbidden'})
    assert response.status_code == 403
    assert store.get_assistant_config('digital_person') == before


async def test_failed_defaults_save_rolls_back_session(brain_client, monkeypatch):
    client, current, project, store = brain_client
    sid = (await current.main_session())['id']
    before = await current.projects.run_db(project.id, lambda _: current.chats.get_execution_config(project.id, sid))
    def fail(*args, **kwargs):
        raise OSError('disk unavailable')
    monkeypatch.setattr(store, 'set_assistant_defaults', fail)
    response = await client.put('/api/assistant/digital_person/config', json={'engine': 'codex_sdk', 'model': 'new-main'})
    assert response.status_code == 503
    after = await current.projects.run_db(project.id, lambda _: current.chats.get_execution_config(project.id, sid))
    assert after == before
