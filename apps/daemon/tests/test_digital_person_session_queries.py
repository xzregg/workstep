"""Host session readouts retain project isolation and never block the event loop."""
import asyncio
import threading

import pytest
from httpx import ASGITransport, AsyncClient

from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime


@pytest.mark.parametrize('endpoint', ['memory', 'affect'])
async def test_session_query_uses_executor_and_preserves_not_found(runtime, monkeypatch, endpoint):
    import main
    current, project, _ = runtime
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    sid = (await current.main_session())['id']
    entered, release = threading.Event(), threading.Event()
    original = project.db.execute_sql

    def slow(sql, *args, **kwargs):
        if sql.startswith('SELECT') and 'chat_sessions' in sql and not entered.is_set():
            entered.set()
            assert release.wait(2)
        return original(sql, *args, **kwargs)

    monkeypatch.setattr(project.db, 'execute_sql', slow)
    async with AsyncClient(transport=ASGITransport(main.app), base_url='http://test') as client:
        request = asyncio.create_task(client.get(f'/api/digital-person/{endpoint}',
            params={'project_id': project.id, 'session_id': sid}))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            assert not request.done()
            assert (await asyncio.wait_for(client.get('/api/health'), .3)).status_code == 200
        finally:
            release.set()
        response = await request
        assert response.status_code == 200, response.text
        if endpoint == 'memory':
            assert response.json() == {'items': []}
        else:
            assert response.json()['state']['person_id'] == 'local:owner'
        for params in ({'project_id': 'missing', 'session_id': sid},
                       {'project_id': project.id, 'session_id': 'missing'}):
            assert (await client.get(f'/api/digital-person/{endpoint}', params=params)).status_code == 404


@pytest.mark.parametrize('endpoint', ['memory', 'affect'])
async def test_session_query_cannot_resolve_another_projects_session(runtime, monkeypatch, tmp_path, endpoint):
    import main
    current, project, _ = runtime
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    sid = (await current.main_session())['id']
    other = await asyncio.to_thread(current.projects.init_project, tmp_path / 'other')
    async with AsyncClient(transport=ASGITransport(main.app), base_url='http://test') as client:
        result = await client.get(f'/api/digital-person/{endpoint}',
            params={'project_id': other.id, 'session_id': sid})
        assert result.status_code == 404


@pytest.mark.parametrize('endpoint', ['memory', 'affect'])
async def test_project_actor_cannot_query_host_session_readouts(runtime, monkeypatch, endpoint):
    import main
    from services.remote_access import ActorSnapshot, actor_context
    current, project, _ = runtime
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    sid = (await current.main_session())['id']
    actor = ActorSnapshot(actor_id='u', user_name='u', device_id='d', device_name='d',
                          source='remote_project', project_id=project.id, access_level='edit')
    async with AsyncClient(transport=ASGITransport(main.app), base_url='http://test') as client:
        with actor_context(actor):
            result = await client.get(f'/api/digital-person/{endpoint}',
                params={'project_id': project.id, 'session_id': sid})
            assert result.status_code == 403
