"""Independent reflection defaults and their registered persistent conversation."""
import asyncio
import threading

import pytest

from models.chat_session import ChatMessage, ChatSession
from models.fields import utc_now
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime
from tests.test_digital_person_brain_config import brain_client

ENDPOINT = '/api/assistant/digital_person_reflection/config'


async def register_check(current, project):
    row = await current.projects.run_db(project.id, lambda _: current.chats.create_session(
        project.id, title='主动思考', model='old-reflection'))
    await current.mutate(lambda state: state.update(check_session_id=row['id'], check_sessions=[row['id']]))
    return row['id']


async def test_save_reflection_syncs_only_registered_check_and_next_turn(brain_client, monkeypatch):
    client, current, project, store = brain_client
    main_id = (await current.main_session())['id']
    sid = await register_check(current, project)
    lookalike = await current.projects.run_db(project.id, lambda _: current.chats.create_session(
        project.id, title='主动思考', model='unrelated'))
    before_main = await current.projects.run_db(project.id, lambda _: current.chats.get_execution_config(project.id, main_id))
    queue = current.bus.subscribe()
    response = await client.put(ENDPOINT, json={
        'engine': 'codex_sdk', 'model': 'reflection-new', 'fast_model': 'reflection-fast',
        'vision_model': 'reflection-vision', 'thinking_effort': 'low',
    })
    assert response.status_code == 200, response.text
    event = await asyncio.wait_for(queue.get(), .5)
    assert event['name'] == 'workstep.chat_execution_config'
    assert event['session_id'] == sid
    assert event['value']['model'] == 'reflection-new'
    config = await current.projects.run_db(project.id, lambda _: current.chats.get_execution_config(project.id, sid))
    assert config['engine'] == 'codex_sdk'
    assert config['fast_model'] == 'reflection-fast'
    assert config['vision_model'] == 'reflection-vision'
    assert config['thinking_effort'] == 'low'
    assert await current.projects.run_db(project.id, lambda _: current.chats.get_execution_config(project.id, main_id)) == before_main
    assert await current.projects.run_db(project.id, lambda _: ChatSession.get_by_id(lookalike['id']).model) == 'unrelated'
    calls = []
    async def invoke(engine, model, *args, **kwargs):
        calls.append((engine, model, kwargs.get('thinking_effort')))
        return '{"decision":"silent","summary":"done","source_ids":[]}', [], 'reflection-thread'
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    await current._decide({})
    assert calls == [('codex_sdk', 'reflection-new', 'low')]
    assert (await current.state())['check_session_id'] == sid
    assert store.get_assistant_config('digital_person')['model'] == ''


async def test_reflection_defaults_inherit_brain_until_first_independent_save(brain_client):
    client, current, project, store = brain_client
    store.set_assistant_defaults('digital_person', engine='claude', model='brain-current', vision_model='brain-image')
    assert store.get_assistant_config('digital_person_reflection')['model'] == 'brain-current'
    assert store.get_assistant_defaults('digital_person_reflection')['vision_model'] == 'brain-image'
    response = await client.put(ENDPOINT, json={'engine': 'claude', 'model': 'reflection-only'})
    assert response.status_code == 200, response.text
    assert await current.projects.run_db(project.id, lambda _: ChatSession.select().count()) == 0
    store.set_assistant_defaults('digital_person', engine='claude', model='brain-changed')
    assert store.get_assistant_defaults('digital_person_reflection')['model'] == 'reflection-only'
    response = await client.put(ENDPOINT, json={})
    assert response.status_code == 200, response.text
    assert store.get_assistant_defaults('digital_person_reflection')['model'] == ''


@pytest.mark.parametrize('busy', ['persisted', 'assessment'])
async def test_thinking_in_progress_rejects_config_without_partial_save(brain_client, busy):
    client, current, project, store = brain_client
    sid = await register_check(current, project)
    before = store.get_assistant_config('digital_person_reflection')
    if busy == 'persisted':
        await current.projects.run_db(project.id, lambda _: ChatMessage.create(
            id='busy-reflection', session=sid, role='assistant', status='running', content='', created_at=utc_now()))
    else:
        await current._check_lock.acquire()
    try:
        response = await client.put(ENDPOINT, json={'engine': 'claude', 'model': 'new'})
        assert response.status_code == 409, response.text
        assert store.get_assistant_config('digital_person_reflection') == before
        assert await current.projects.run_db(project.id, lambda _: ChatSession.get_by_id(sid).model) == 'old-reflection'
    finally:
        if busy == 'assessment':
            current._check_lock.release()


async def test_legacy_check_pointer_is_used_but_main_pointer_is_never_modified(brain_client):
    client, current, project, _ = brain_client
    sid = await register_check(current, project)
    main_id = (await current.main_session())['id']
    await current.mutate(lambda state: state.update(check_session_id='', check_sessions_by_scope={'local': sid}))
    response = await client.put(ENDPOINT, json={'engine': 'claude', 'model': 'legacy-new'})
    assert response.status_code == 200, response.text
    assert await current.projects.run_db(project.id, lambda _: ChatSession.get_by_id(sid).model) == 'legacy-new'
    await current.mutate(lambda state: state.update(check_session_id=main_id))
    response = await client.put(ENDPOINT, json={'engine': 'claude', 'model': 'do-not-touch-main'})
    assert response.status_code == 200, response.text
    assert await current.projects.run_db(project.id, lambda _: ChatSession.get_by_id(main_id).model) != 'do-not-touch-main'


async def test_slow_reflection_config_sql_keeps_health_responsive(brain_client, monkeypatch):
    client, current, project, _ = brain_client
    await register_check(current, project)
    execute = project.db.execute_sql
    entered, release = threading.Event(), threading.Event()
    def slow(sql, params=None, commit=None):
        if not entered.is_set() and sql.startswith('UPDATE "chat_sessions"'):
            entered.set()
            release.wait(2)
        return execute(sql, params)
    monkeypatch.setattr(project.db, 'execute_sql', slow)
    pending = asyncio.create_task(client.put(ENDPOINT, json={'engine': 'claude', 'model': 'new'}))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        assert (await asyncio.wait_for(client.get('/api/health'), .2)).status_code == 200
    finally:
        release.set()
    assert (await pending).status_code == 200


async def test_project_identity_cannot_save_reflection_model(brain_client):
    from services.remote_access import ActorSnapshot, actor_context
    client, current, project, store = brain_client
    before = store.get_assistant_config('digital_person_reflection')
    with actor_context(ActorSnapshot(actor_id='project', user_name='Project user', device_id='test',
                                    device_name='Test', source='managed', project_id=project.id, access_level='edit')):
        response = await client.put(ENDPOINT, json={'model': 'forbidden'})
    assert response.status_code == 403
    assert store.get_assistant_config('digital_person_reflection') == before
