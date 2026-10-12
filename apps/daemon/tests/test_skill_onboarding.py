import asyncio
import time

import pytest
from fastapi import FastAPI
from httpx import AsyncClient, ASGITransport


@pytest.mark.asyncio
async def test_skill_creation_api_uses_shared_db_off_loop_and_rejects_project_actors(tmp_path, monkeypatch):
    from services import skill_onboarding as onboarding
    from services.project import ProjectManager
    from services.remote_access import ActorSnapshot, actor_context
    from agent_assistants.chat_session import ChatSessionModule
    from streaming.bus import EventBus
    from api.skills import router, authorize_onboarding
    manager = ProjectManager(); bus = EventBus(); module = ChatSessionModule(bus, manager)
    monkeypatch.setattr(onboarding, 'project_manager', manager)
    monkeypatch.setattr(onboarding, 'chat_module', lambda: module)
    monkeypatch.setattr(onboarding, 'workspace_parent', lambda: tmp_path / 'runtime')
    monkeypatch.setattr(onboarding.skill_center, 'runtime_selection', lambda root: None)
    monkeypatch.setattr(module, '_resolve_engine_models', lambda: ('codex_sdk', None, None))
    create = module.create_session
    def slow_create(*args, **kwargs):
        time.sleep(.2)
        return create(*args, **kwargs)
    monkeypatch.setattr(module, 'create_session', slow_create)
    app = FastAPI(); app.include_router(router); app.dependency_overrides[authorize_onboarding] = lambda: None
    @app.get('/health')
    async def health(): return {'ok': True}
    try:
        async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
            pending = asyncio.create_task(client.post('/api/skills/onboarding'))
            await asyncio.sleep(.05)
            assert (await asyncio.wait_for(client.get('/health'), .1)).json()['ok']
            response = await pending
            assert response.status_code == 200, response.text
            result = response.json()
            again = (await client.post('/api/skills/onboarding')).json()
            assert again['project_id'] == result['project_id']
            assert again['workspace_path'] == result['workspace_path']
            assert again['package_path'] == result['package_path']
            assert again['session_id'] != result['session_id']
            detail = await manager.run_db(result['project_id'], lambda current: module.get_session(result['project_id'], result['session_id']))
            assert detail['title'] == '自定义技能制作'
            app.dependency_overrides.clear()
            for level in ('read', 'edit'):
                with actor_context(ActorSnapshot(actor_id='viewer', user_name='viewer', device_id='device', device_name='device', source='remote', project_id=result['project_id'], access_level=level)):
                    assert (await client.post('/api/skills/onboarding')).status_code == 403
    finally:
        await module.shutdown(); await bus.close(); await asyncio.to_thread(manager.close_all)
