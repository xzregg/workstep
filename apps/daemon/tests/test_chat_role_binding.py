"""Chat bindings are references; injection checkpoints belong to engine contexts."""
import asyncio
import json
import sqlite3
import threading
import time

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from tests.test_chat_session import chat_module, FakeEngine, _wait_turn
from agent_assistants.chat_session import ChatSessionModule
from engines.core.events import InternalEvent
from models.chat_session import ChatSession
from schemas.role_center import RoleWrite, TeamWrite
from services.role_center import RoleCenter


@pytest.fixture
def role_library(tmp_path, monkeypatch):
    library = RoleCenter(tmp_path / 'roles')
    a = library.save_role(RoleWrite(name='架构专家', category='engineering', prompt='ARCHITECT ORIGINAL'))
    b = library.save_role(RoleWrite(name='安全专家', category='security', prompt='SECURITY ORIGINAL'))
    monkeypatch.setattr('agent_assistants.chat_roles.role_center', library)
    return library, a, b


def install_engine(module, monkeypatch, *, resume=True):
    monkeypatch.setattr(FakeEngine, 'supports_resume', resume)
    calls, behavior = [], {'fail': False, 'compact': False, 'thread': 'engine-context-A'}

    async def invoke(session, turn, callback, engine, model, cwd, prompt, session_id, **kwargs):
        calls.append(prompt)
        await callback(InternalEvent('prompt_input', {'prompt': prompt}))
        if behavior['fail']:
            raise RuntimeError('模拟引擎失败')
        events = []
        if behavior['compact']:
            event = InternalEvent('compacted', {})
            await callback(event)
            events.append(event.to_dict())
        return '完成', events, behavior['thread'] if resume else None

    monkeypatch.setattr(module, '_invoke_with_idle_watchdog', invoke)
    return calls, behavior


async def send(module, project, sid, key):
    accepted = await project_send(module, project, sid, key)
    return await _wait_turn(module, accepted.turn_id)


async def project_send(module, project, sid, key):
    accepted = await module._project_manager.run_db(project.id, lambda _: module.submit_message(
        project.id, sid, '用户问题 ' + key, key, schedule=False,
    ))
    module.start_queued_turn(accepted.turn_id)
    return accepted


async def bind(module, project, sid, value):
    return await module._project_manager.run_db(project.id, lambda _: module.set_role_binding(project.id, sid, value))


async def test_role_binding_restores_and_only_reinjects_when_content_or_context_changes(chat_module, role_library, monkeypatch):
    module, bus, manager, project, _ = chat_module
    library, a, b = role_library
    sid = module.create_session(project.id)['id']
    calls, behavior = install_engine(module, monkeypatch)
    ref = {'kind': 'role', 'id': a['id']}
    await bind(module, project, sid, ref)
    assert module.get_session(project.id, sid)['role_binding'] == ref
    assert await send(module, project, sid, 'first') == 'completed'
    assert 'ARCHITECT ORIGINAL' in calls[-1]
    assert await send(module, project, sid, 'second') == 'completed'
    assert 'ARCHITECT ORIGINAL' not in calls[-1]
    # Editing another asset must not invalidate the selected role.
    library.save_role(RoleWrite(name=b['name'], category=b['category'], prompt='OTHER UPDATED', expected_revision=b['revision']), b['id'])
    await send(module, project, sid, 'unrelated')
    assert 'ARCHITECT ORIGINAL' not in calls[-1]
    library.save_role(RoleWrite(name='架构专家改名', category=a['category'], prompt='ARCHITECT UPDATED', expected_revision=a['revision']), a['id'])
    await send(module, project, sid, 'edited')
    assert 'ARCHITECT UPDATED' in calls[-1]
    with manager.activate_project(project.path):
        row = ChatSession.get_by_id(sid)
        assert json.loads(row.role_binding_json) == ref
        assert 'ARCHITECT' not in row.role_checkpoint_json
    await module.shutdown()
    restored = ChatSessionModule(bus, manager)
    calls, _ = install_engine(restored, monkeypatch)
    try:
        assert restored.get_session(project.id, sid)['role_binding'] == ref
        await send(restored, project, sid, 'restored')
        assert 'ARCHITECT UPDATED' not in calls[-1]
        await bind(restored, project, sid, None)
        await send(restored, project, sid, 'removed')
        assert 'no longer apply' in calls[-1]
        await send(restored, project, sid, 'removed-again')
        assert 'no longer apply' not in calls[-1]
    finally:
        await restored.shutdown()


async def test_team_resolves_every_member_and_detects_member_edits(chat_module, role_library, monkeypatch):
    module, _, manager, project, _ = chat_module
    library, a, b = role_library
    team = library.save_team(TeamWrite(name='评审团', prompt='TEAM RULE', members=[
        {'role_id': a['id'], 'duty': 'DESIGN FIRST'}, {'role_id': b['id'], 'duty': 'REVIEW NEXT'},
    ]))
    sid = module.create_session(project.id)['id']
    calls, _ = install_engine(module, monkeypatch)
    await bind(module, project, sid, {'kind': 'team', 'id': team['id']})
    await send(module, project, sid, 'team-first')
    assert all(part in calls[-1] for part in ['TEAM RULE', 'ARCHITECT ORIGINAL', 'SECURITY ORIGINAL', 'DESIGN FIRST', 'REVIEW NEXT'])
    await send(module, project, sid, 'team-second')
    assert 'TEAM RULE' not in calls[-1]
    library.save_role(RoleWrite(name=b['name'], category=b['category'], prompt='SECURITY UPDATED', expected_revision=b['revision']), b['id'])
    await send(module, project, sid, 'team-member-edited')
    assert 'SECURITY UPDATED' in calls[-1]
    # A missing member is an error, never silently skipped.
    (library.root / 'roles' / (a['id'] + '.json')).unlink()
    count = len(calls)
    assert await send(module, project, sid, 'missing-member') == 'error'
    assert len(calls) == count


async def test_failure_compaction_and_context_replacement_require_reinjection(chat_module, role_library, monkeypatch):
    module, _, _, project, _ = chat_module
    _, a, _ = role_library
    sid = module.create_session(project.id)['id']
    calls, behavior = install_engine(module, monkeypatch)
    await bind(module, project, sid, {'kind': 'role', 'id': a['id']})
    behavior['fail'] = True
    assert await send(module, project, sid, 'failure') == 'error'
    behavior['fail'] = False
    await send(module, project, sid, 'retry')
    assert 'ARCHITECT ORIGINAL' in calls[-1]
    behavior['compact'] = True
    await send(module, project, sid, 'compact')
    behavior['compact'] = False
    await send(module, project, sid, 'after-compact')
    assert 'ARCHITECT ORIGINAL' in calls[-1]
    session = module._sessions[module._session_identity(project.id, sid)[0]]
    session.resolved_session_id = 'replacement-context'
    await send(module, project, sid, 'replacement')
    assert 'ARCHITECT ORIGINAL' in calls[-1]


async def test_stateless_engine_always_receives_bound_prompt(chat_module, role_library, monkeypatch):
    module, _, _, project, _ = chat_module
    _, a, _ = role_library
    sid = module.create_session(project.id)['id']
    calls, _ = install_engine(module, monkeypatch, resume=False)
    await bind(module, project, sid, {'kind': 'role', 'id': a['id']})
    for index in range(2):
        await send(module, project, sid, f'stateless-{index}')
        assert 'ARCHITECT ORIGINAL' in calls[-1]


async def test_removal_after_first_failed_injection_still_sends_clear_notice(chat_module, role_library, monkeypatch):
    module, _, _, project, _ = chat_module
    _, a, _ = role_library
    sid = module.create_session(project.id)['id']
    calls, behavior = install_engine(module, monkeypatch)
    await bind(module, project, sid, {'kind': 'role', 'id': a['id']})
    behavior['fail'] = True
    await send(module, project, sid, 'first-failed')
    behavior['fail'] = False
    await bind(module, project, sid, None)
    await send(module, project, sid, 'clear-failed-role')
    assert 'no longer apply' in calls[-1]


async def test_binding_api_validation_isolation_and_slow_io_canary(chat_module, role_library, monkeypatch):
    from api import chat_roles
    import main
    module, _, _, project, _ = chat_module
    library, a, _ = role_library
    monkeypatch.setattr(main, 'chat_session_module', module)
    monkeypatch.setattr(main, 'project_manager', module._project_manager)
    sid = module.create_session(project.id)['id']
    other = module.create_session(project.id)['id']
    app = FastAPI()
    app.include_router(chat_roles.router)
    from api.chat_session import router as chat_router
    app.include_router(chat_router)
    app.dependency_overrides[chat_roles.authorize] = lambda: None

    @app.get('/health')
    async def health():
        return {'ok': True}

    original = library.get_role
    def slow(role_id):
        time.sleep(.25)
        return original(role_id)
    monkeypatch.setattr(library, 'get_role', slow)
    url = f'/api/chat-sessions/{sid}/role-binding'
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        pending = asyncio.create_task(client.put(url, json={'project_id': project.id, 'binding': {'kind': 'role', 'id': a['id']}}))
        await asyncio.sleep(.04)
        start = time.monotonic()
        assert (await client.get('/health')).status_code == 200
        assert time.monotonic() - start < .15
        result = await pending
        assert result.status_code == 200
        assert result.json()['name'] == a['name']
        restored = await client.get(url, params={'project_id': project.id})
        assert restored.json()['binding'] == {'kind': 'role', 'id': a['id']}
        calls, _ = install_engine(module, monkeypatch)
        response = await client.post(f'/api/chat-sessions/{sid}/chat', headers={'Idempotency-Key': 'api-role-turn'},
                                     json={'project_id': project.id, 'content': '真实 API 注入'})
        assert response.status_code == 200
        assert await _wait_turn(module, response.json()['turn_id']) == 'completed'
        assert 'ARCHITECT ORIGINAL' in calls[-1]
        detail = (await client.get(f'/api/chat-sessions/{sid}', params={'project_id': project.id})).json()
        assert detail['messages'][0]['content'] == '真实 API 注入'
        assert 'ARCHITECT ORIGINAL' in detail['messages'][-1]['prompt']
        assert module.get_session(project.id, other)['role_binding'] is None
        assert (await client.put(url, json={'project_id': project.id, 'binding': {'kind': 'role', 'id': '../escape'}})).status_code == 422
        assert (await client.put(url, json={'project_id': project.id, 'binding': {'kind': 'role', 'id': 'missing'}})).status_code == 404
        assert (await client.put(url, json={'project_id': project.id, 'binding': None})).status_code == 200
        from services.remote_access import ActorSnapshot, actor_context
        actor = ActorSnapshot(actor_id='editor', user_name='editor', device_id='d', device_name='d',
                              source='remote', project_id='another-project', access_level='edit')
        with actor_context(actor):
            assert (await client.get(url, params={'project_id': project.id})).status_code == 403
        app.dependency_overrides.clear()
        actor = ActorSnapshot(actor_id='editor', user_name='editor', device_id='d', device_name='d',
                              source='remote', project_id=project.id, access_level='edit')
        with actor_context(actor):
            assert (await client.get(url, params={'project_id': project.id})).status_code == 403


async def test_locked_binding_write_keeps_api_health_responsive(chat_module, role_library, monkeypatch):
    from api import chat_roles
    import main
    module, _, manager, project, _ = chat_module
    _, a, _ = role_library
    sid = module.create_session(project.id)['id']
    monkeypatch.setattr(main, 'chat_session_module', module)
    monkeypatch.setattr(main, 'project_manager', manager)
    app = FastAPI()
    app.include_router(chat_roles.router)
    app.dependency_overrides[chat_roles.authorize] = lambda: None
    @app.get('/health')
    async def health():
        return {'ok': True}
    locked, release = threading.Event(), threading.Event()
    def hold_lock():
        connection = sqlite3.connect(project.workstep_dir / 'workstep.db')
        try:
            connection.execute('BEGIN IMMEDIATE')
            locked.set()
            release.wait(3)
            connection.rollback()
        finally:
            connection.close()
    holder = asyncio.create_task(asyncio.to_thread(hold_lock))
    assert await asyncio.to_thread(locked.wait, 1)
    try:
        async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
            pending = asyncio.create_task(client.put(f'/api/chat-sessions/{sid}/role-binding',
                json={'project_id': project.id, 'binding': {'kind': 'role', 'id': a['id']}}))
            await asyncio.sleep(.05)
            assert not pending.done()
            assert (await asyncio.wait_for(client.get('/health'), .15)).status_code == 200
            release.set()
            assert (await pending).status_code == 200
    finally:
        release.set()
        await holder


def test_existing_chat_database_adds_nullable_reference_and_checkpoint_without_losing_rows(tmp_path):
    from models import init_db
    from models.fields import utc_now
    path = str(tmp_path / 'existing.db')
    database = init_db(path)
    now = utc_now()
    ChatSession.create(id='existing', project_id='p', workflow_id='', engine='claude', title='原有会话', created_at=now, updated_at=now)
    database.execute_sql('ALTER TABLE chat_sessions DROP COLUMN role_binding_json')
    database.execute_sql('ALTER TABLE chat_sessions DROP COLUMN role_checkpoint_json')
    database.close()
    database = init_db(path)
    try:
        row = ChatSession.get_by_id('existing')
        assert row.title == '原有会话'
        assert row.role_binding_json is None and row.role_checkpoint_json is None
    finally:
        database.close()


async def test_missing_rollout_rebuild_reinjects_and_busy_binding_is_rejected(chat_module, role_library, monkeypatch):
    module, _, _, project, _ = chat_module
    _, a, _ = role_library
    sid = module.create_session(project.id)['id']
    calls, behavior = install_engine(module, monkeypatch)
    await bind(module, project, sid, {'kind': 'role', 'id': a['id']})
    await send(module, project, sid, 'before-rebuild')
    session = module._sessions[module._session_identity(project.id, sid)[0]]
    rebuilt = await asyncio.to_thread(module._build_rebuild_prompt, session)
    assert 'ARCHITECT ORIGINAL' in rebuilt
    entered, release = asyncio.Event(), asyncio.Event()
    invoke = module._invoke_with_idle_watchdog
    async def slow(*args, **kwargs):
        entered.set()
        await release.wait()
        return await invoke(*args, **kwargs)
    monkeypatch.setattr(module, '_invoke_with_idle_watchdog', slow)
    accepted = await project_send(module, project, sid, 'busy')
    await entered.wait()
    try:
        with pytest.raises(ValueError, match='running'):
            await bind(module, project, sid, None)
    finally:
        release.set()
        await _wait_turn(module, accepted.turn_id)
