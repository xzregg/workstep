import asyncio
import uuid
from types import SimpleNamespace

from httpx import ASGITransport, AsyncClient
import pytest

from tests.test_chat_session import chat_module, _wait_turn
from tests.test_digital_person_runtime import runtime


@pytest.fixture
async def retained_chat(runtime, monkeypatch):
    import main
    from engines.codex_sdk import CodexSDKEngine
    from engines.core.events import InternalEvent
    from engines.core.session_pool import SessionClientPool

    current, project, store = runtime
    pool = SessionClientPool(idle_seconds=.01, max_idle=1)
    calls = []

    class Client:
        closed = False

        async def close(self):
            self.closed = True

    class Engine(CodexSDKEngine):
        async def spawn(self, prompt, cwd, model=None, session_id=None, **kwargs):
            assert 'session_retention_key' not in kwargs  # host policy, not native protocol
            sid = session_id or f'native-{len(calls)}'
            entry = await pool.acquire(cwd, sid, 'same', Client)
            pool.bind(entry, sid, SimpleNamespace(id=sid))
            calls.append({'sid': sid, 'entry': entry, 'prompt': prompt})
            try:
                yield InternalEvent(type='session_started', data={'session_id': sid})
                if prompt.strip() == '/compact':
                    yield InternalEvent(type='compacted', data={})
                yield InternalEvent(type='agent_message_chunk', data={'content': {'type': 'text', 'text': 'OK'}})
            finally:
                await pool.release(entry, reusable=True)

    monkeypatch.setattr('agent_assistants.chat_session.create_engine', lambda _: Engine())
    monkeypatch.setattr('agent_assistants.base.create_engine', lambda _: Engine())
    monkeypatch.setattr(main, 'project_manager', current.projects)
    monkeypatch.setattr(main, 'chat_session_module', current.chats)
    store.set('assistant_defaults', {'digital_person': {'engine': 'codex_sdk'}})
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as api:
        async def send(sid, content):
            response = await api.post(f'/api/chat-sessions/{sid}/chat',
                                     headers={'Idempotency-Key': str(uuid.uuid4())},
                                     json={'project_id': project.id, 'content': content})
            assert response.status_code == 200, response.text
            assert await _wait_turn(current.chats, response.json()['turn_id']) == 'completed'
        try:
            yield SimpleNamespace(current=current, project=project, pool=pool, calls=calls, api=api, send=send)
        finally:
            await pool.close()


async def test_only_current_data_center_main_is_retained_across_ttl_and_other_chats(retained_chat):
    f = retained_chat
    main = (await f.current.main_session())['id']
    await f.send(main, 'main-private-history')
    lease = f.calls[-1]['entry']
    assert lease.retention_owner
    other = await f.current.projects.run_db(f.project.id, lambda _: f.current.chats.create_session(f.project.id)['id'])
    await f.send(other, 'ordinary')
    assert f.calls[-1]['entry'].retention_owner is None
    await asyncio.sleep(.05)
    assert not lease.client.closed
    await f.send(main, 'continue')
    assert f.calls[-1]['entry'] is lease


async def test_new_and_clear_release_old_protection_and_create_clean_native_context(retained_chat):
    f = retained_chat
    main = (await f.current.main_session())['id']
    for command in ('/new', '/clear'):
        await f.send(main, 'old-private-history')
        old = f.calls[-1]
        count = len(f.calls)
        await f.send(main, command)
        assert len(f.calls) == count
        assert old['entry'].retention_owner is None
        await f.send(main, 'fresh-request')
        new = f.calls[-1]
        assert new['sid'] != old['sid']
        assert new['entry'].retention_owner
        assert 'old-private-history' not in new['prompt']


async def test_archive_replacement_moves_protection_to_new_data_center_session(retained_chat):
    f = retained_chat
    old_sid = (await f.current.main_session())['id']
    await f.send(old_sid, 'before archive')
    old = f.calls[-1]['entry']
    response = await f.api.patch(f'/api/chat-sessions/{old_sid}/archive',
                               json={'project_id': f.project.id, 'archived': True})
    assert response.status_code == 200, response.text
    assert old.retention_owner is None
    new_sid = (await f.current.main_session())['id']
    assert new_sid != old_sid
    await f.send(new_sid, 'after archive')
    assert f.calls[-1]['entry'].retention_owner


async def test_engine_handoff_releases_idle_protection(retained_chat):
    f = retained_chat
    sid = (await f.current.main_session())['id']
    await f.send(sid, 'before handoff')
    old = f.calls[-1]['entry']
    response = await f.api.post(f'/api/chat-sessions/{sid}/handoff', json={
        'project_id': f.project.id, 'engine': 'claude_agent_sdk', 'context_mode': 'none',
    })
    assert response.status_code == 200, response.text
    assert old.retention_owner is None
    await f.send(sid, 'after handoff')
    assert f.calls[-1]['entry'].retention_owner


@pytest.mark.parametrize('command', ['/new fresh-request', '/clear fresh-request'])
async def test_reset_with_followup_moves_protection_in_same_turn(retained_chat, command):
    f = retained_chat
    sid = (await f.current.main_session())['id']
    await f.send(sid, 'old-private-history')
    old = f.calls[-1]
    await f.send(sid, command)
    new = f.calls[-1]
    assert new['sid'] != old['sid']
    assert old['entry'].retention_owner is None and new['entry'].retention_owner
    assert 'old-private-history' not in new['prompt']


async def test_compact_keeps_current_main_protection(retained_chat):
    f = retained_chat
    sid = (await f.current.main_session())['id']
    await f.send(sid, 'first')
    entry = f.calls[-1]['entry']
    await f.send(sid, '/compact')
    assert f.calls[-1]['entry'] is entry and entry.retention_owner


@pytest.mark.parametrize('bulk', [False, True])
async def test_deletion_releases_main_protection(retained_chat, bulk):
    f = retained_chat
    sid = (await f.current.main_session())['id']
    await f.send(sid, 'before deletion')
    old = f.calls[-1]['entry']
    if bulk:
        response = await f.api.post('/api/chat-sessions/bulk-delete', params={'project_id': f.project.id},
                                    json={'session_ids': [sid]})
    else:
        response = await f.api.delete(f'/api/chat-sessions/{sid}', params={'project_id': f.project.id})
    assert response.status_code == 200, response.text
    assert old.retention_owner is None
