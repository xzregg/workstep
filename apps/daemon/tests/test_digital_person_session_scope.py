from types import SimpleNamespace

import pytest

from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime


async def test_identity_only_in_main_reflection_and_channel(runtime):
    current, project, store = runtime
    module = current.chats
    main = (await current.main_session())['id']

    def check(_):
        ordinary = module.create_session(project.id, title='自定义引擎接入')['id']
        reflection = module.create_session(project.id, title='主动思考')['id']
        from services.digital_person_runtime import read_state, write_state
        state = read_state(project.id)
        state['check_session_id'] = reflection
        write_state(project.id, state)
        for sid, expected in [(main, True), (reflection, True), (ordinary, False)]:
            session = SimpleNamespace(project_id=project.id, session_id=sid, extra={})
            assert bool(module._digital_person_prompt_parts(session)) is expected
        store.set('channel_bots', {'sessions': {'bot:single:peer': ordinary}})
        assert module._digital_person_prompt_parts(SimpleNamespace(project_id=project.id, session_id=ordinary, extra={}))

    await current.projects.run_db(project.id, check)


@pytest.mark.parametrize('action', ['archive', 'delete'])
async def test_system_conversations_cannot_be_removed(runtime, action):
    current, project, _ = runtime
    main = (await current.main_session())['id']

    def check(_):
        module = current.chats
        reflection = module.create_session(project.id, title='主动思考')['id']
        ordinary = module.create_session(project.id, title='主动思考')['id']
        from services.digital_person_runtime import read_state, write_state
        state = read_state(project.id)
        state['check_session_id'] = reflection
        write_state(project.id, state)
        for sid in [main, reflection]:
            assert module.get_session(project.id, sid)['lifecycle_protected'] is True
            with pytest.raises(ValueError, match='cannot be archived or deleted'):
                if action == 'archive':
                    module.set_archived(project.id, sid, True)
                else:
                    module.delete_session(project.id, sid)
        assert module.get_session(project.id, ordinary)['lifecycle_protected'] is False
        module.delete_session(project.id, ordinary)

    await current.projects.run_db(project.id, check)


async def test_protected_api_slow_lookup_keeps_health_responsive(runtime, monkeypatch):
    import asyncio
    import threading
    import time
    import main
    from httpx import ASGITransport, AsyncClient

    current, project, _ = runtime
    main_row = await current.main_session()
    assert main_row['lifecycle_protected'] is True
    sid = main_row['id']
    monkeypatch.setattr(main, 'project_manager', current.projects)
    monkeypatch.setattr(main, 'chat_session_module', current.chats)
    original = current.chats._digital_person_session_kind
    entered = threading.Event()

    def slow(*args):
        entered.set()
        time.sleep(0.2)
        return original(*args)

    monkeypatch.setattr(current.chats, '_digital_person_session_kind', slow)
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
        for action in ['archive', 'delete']:
            entered.clear()
            url = f'/api/chat-sessions/{sid}'
            request = asyncio.create_task(
                client.patch(url + '/archive', json={'project_id': project.id, 'archived': True})
                if action == 'archive' else client.delete(url, params={'project_id': project.id}))
            assert await asyncio.to_thread(entered.wait, 2)
            health = await asyncio.wait_for(client.get('/api/health'), 0.15)
            assert health.status_code == 200
            response = await request
            assert response.status_code == 400
            assert 'cannot be archived or deleted' in response.json()['detail']
