"""Digital hub identity queries use live statistics and host authorization."""
import asyncio
import threading

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime


@pytest.mark.parametrize('policy_state', ['missing', 'denied'])
async def test_managed_host_can_query_identity_without_retired_capabilities(runtime, monkeypatch, policy_state):
    import main
    from types import SimpleNamespace
    from api.digital_person import router
    from services.gateway_client.policy import ManagedPolicyCache, verify_policy_snapshot
    from services.remote_access import ActorSnapshot, actor_context
    from tests.test_gateway_policy import _signed_policy
    current, _, _ = runtime
    cache = ManagedPolicyCache()
    if policy_state == 'denied':
        token, pem, fingerprint = _signed_policy(engine_install=False, allow_local_providers=False)
        cache.apply(verify_policy_snapshot(token, pem, fingerprint, 'gateway-test', 'device-1', 'user-1'))
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    monkeypatch.setattr(main, 'gateway_client', SimpleNamespace(managed_config=object(), policy_cache=cache))
    monkeypatch.setattr('services.digital_person_statistics.enabled_skills', lambda _: [])
    app = FastAPI()
    app.include_router(router)
    with actor_context(ActorSnapshot('user-1', 'Alice', 'device-1', 'PC', 'managed')):
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
            response = await client.get('/api/digital-person/info')
    assert response.status_code == 200
    assert response.json()['level'] == 1


@pytest.mark.parametrize('enabled', [True, False])
async def test_cli_reads_live_digital_hub_identity(runtime, monkeypatch, enabled):
    import main
    from api.digital_person import router
    from cli import build_parser, dispatch
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    from services.tool_registry import WorkstepClient

    current, project, store = runtime
    sid = (await current.main_session())['id']
    store.set('digital_person', {'enabled': enabled, 'name': '测试中枢', 'role': '研发伙伴'})
    def seed(_):
        ChatMessage.create(id='question', session=sid, role='user', status='completed', content='你好', created_at=utc_now())
        for index in range(11):
            ChatMessage.create(id=f'answer-{index}', session=sid, role='assistant', status='completed', content='private answer', created_at=utc_now())
    await current.projects.run_db(project.id, seed)
    await current.mutate(lambda state: state.update(feedback={'answer-0': -1}, delegations=[{'id': 'task', 'status': 'completed'}]))
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    monkeypatch.setattr('services.digital_person_statistics.enabled_skills', lambda _: [{'id': 'workstep-cli', 'name': 'workstep-cli'}])
    app = FastAPI()
    app.include_router(router)
    result = await dispatch(build_parser().parse_args(['digital-hub', 'info', '--json']),
                            WorkstepClient(transport=ASGITransport(app=app)))
    assert result == {
        'name': '测试中枢', 'role': '研发伙伴', 'enabled': enabled,
        'level': 2, 'experience': 11, 'next_level_experience': 40,
        'session_count': 1, 'reply_count': 11, 'task_count': 1, 'completed_task_count': 1,
        'skills': [{'id': 'workstep-cli', 'name': 'workstep-cli'}],
    }


@pytest.mark.parametrize('slow_source', ['sql', 'skills', 'profile'])
async def test_identity_query_keeps_health_responsive(runtime, monkeypatch, slow_source):
    import main
    from api.digital_person import router
    from services import digital_person
    current, project, _ = runtime
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    entered, release = threading.Event(), threading.Event()
    def pause():
        entered.set()
        assert release.wait(3)
    if slow_source == 'sql':
        original = project.db.execute_sql
        def slow_sql(sql, *args, **kwargs):
            if sql.startswith('SELECT') and not release.is_set():
                pause()
            return original(sql, *args, **kwargs)
        monkeypatch.setattr(project.db, 'execute_sql', slow_sql)
    elif slow_source == 'skills':
        def slow_skills(_):
            pause()
            return []
        monkeypatch.setattr('services.digital_person_statistics.enabled_skills', slow_skills)
    else:
        original = digital_person.get_profile
        def slow_profile():
            pause()
            return original()
        monkeypatch.setattr(digital_person, 'get_profile', slow_profile)
    app = FastAPI()
    app.include_router(router)
    @app.get('/health')
    async def health():
        return {'ok': True}
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        pending = asyncio.create_task(client.get('/api/digital-person/info'))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            assert (await asyncio.wait_for(client.get('/health'), .3)).status_code == 200
        finally:
            release.set()
        assert (await pending).status_code == 200
