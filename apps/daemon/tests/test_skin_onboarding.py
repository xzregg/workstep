from pathlib import Path
import asyncio
from types import SimpleNamespace
from unittest.mock import Mock
import pytest

@pytest.mark.asyncio
async def test_onboarding_creates_normal_chat_in_workspace(tmp_path, monkeypatch):
    from services import skin_onboarding as onboarding
    module = SimpleNamespace(_resolve_engine_models=lambda: ("codex_sdk", None, None),
                             create_session=Mock(return_value={"id": "session"}))
    monkeypatch.setattr(onboarding, "chat_module", lambda: module)
    monkeypatch.setattr(onboarding, "design_session", lambda project, chat: {**chat.create_session(project.id, title="自定义皮肤设计"), "created": True})
    monkeypatch.setattr(onboarding, "workspace_parent", lambda: tmp_path)
    project = SimpleNamespace(id="project", name="runtime", path=tmp_path)
    monkeypatch.setattr(onboarding.project_manager, "init_project", lambda *a, **kw: project)
    async def run_db(project_id, operation): return operation(project)
    monkeypatch.setattr(onboarding.project_manager, "run_db", run_db)
    monkeypatch.setattr(onboarding.skill_center, "runtime_selection", lambda root: None)
    result = await onboarding.create_onboarding()
    assert result["session_id"] == "session"
    assert result["project_id"] == "project"
    assert "$custom-engine" not in result["prompt"]
    assert (Path(result["package_path"]).parent / "skin-contract.json").is_file()
    assert "workstep-cli" in result["prompt"]
    assert "custom-skin.md" in result["prompt"]
    assert result["workspace_path"] in result["prompt"]
    assert "无需重启" in result["prompt"]
    assert (Path(result['workspace_path']) / 'language-contract.json').is_file()
    assert '语言包' in result['prompt']
    assert 'workstep language validate' in result['prompt']
    module.create_session.assert_called_once()

@pytest.mark.asyncio
async def test_onboarding_resolves_engine_before_creating_project(monkeypatch):
    from services import skin_onboarding as onboarding
    def unavailable(): raise ValueError("先配置聊天引擎")
    monkeypatch.setattr(onboarding, "chat_module", lambda: SimpleNamespace(_resolve_engine_models=unavailable))
    init = Mock()
    monkeypatch.setattr(onboarding.project_manager, "init_project", init)
    with pytest.raises(ValueError): await onboarding.create_onboarding()
    init.assert_not_called()


@pytest.mark.asyncio
async def test_onboarding_api_uses_real_db_without_blocking_event_loop(tmp_path, monkeypatch):
    import time
    from fastapi import FastAPI
    from httpx import AsyncClient, ASGITransport
    from services import skin_onboarding as onboarding
    from services.project import ProjectManager
    from agent_assistants.chat_session import ChatSessionModule
    from streaming.bus import EventBus
    from api.skins import router, authorize
    manager = ProjectManager(); bus = EventBus(); module = ChatSessionModule(bus, manager)
    monkeypatch.setattr(onboarding, "project_manager", manager)
    monkeypatch.setattr(onboarding, "chat_module", lambda: module)
    monkeypatch.setattr(onboarding, "workspace_parent", lambda: tmp_path / "runtime" / "skin-workspaces")
    monkeypatch.setattr(onboarding.skill_center, "runtime_selection", lambda root: None)
    monkeypatch.setattr(module, "_resolve_engine_models", lambda: ("codex_sdk", None, None))
    create = module.create_session
    def slow_create(*args, **kwargs):
        time.sleep(.2)
        return create(*args, **kwargs)
    monkeypatch.setattr(module, "create_session", slow_create)
    app = FastAPI(); app.include_router(router); app.dependency_overrides[authorize] = lambda: None
    @app.get("/health")
    async def health(): return {"ok": True}
    try:
        async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
            pending = asyncio.create_task(client.post("/api/skins/onboarding"))
            await asyncio.sleep(.05)
            assert (await asyncio.wait_for(client.get("/health"), .1)).json()["ok"]
            response = await pending
            assert response.status_code == 200, response.text
            result = response.json()
            detail = await manager.run_db(result["project_id"], lambda current: module.get_session(result["project_id"], result["session_id"]))
            assert detail["title"] == "自定义皮肤设计"
            from models.chat_session import ChatSession, ChatMessage
            from models.fields import utc_now
            def write_history(current):
                ChatSession.update(title='我的蓝色皮肤').where(ChatSession.id == result['session_id']).execute()
                ChatMessage.create(id='history-message', session=result['session_id'], role='user', content='请改成蓝色', created_at=utc_now())
            await manager.run_db(result['project_id'], write_history)
            again = await client.post("/api/skins/onboarding")
            assert again.json()["session_id"] == result["session_id"]
            assert again.json()["created"] is False
            assert len(await manager.run_db(result["project_id"], lambda current: module.list_sessions(result["project_id"]))) == 1
            restored = await manager.run_db(result['project_id'], lambda current: module.get_session(result['project_id'], again.json()['session_id']))
            assert restored['title'] == '我的蓝色皮肤'
            assert restored['messages'][0]['content'] == '请改成蓝色'
            concurrent = await asyncio.gather(client.post('/api/skins/onboarding'), client.post('/api/skins/onboarding'))
            assert all(response.json()['session_id'] == result['session_id'] for response in concurrent)
    finally:
        await module.shutdown(); await bus.close(); await asyncio.to_thread(manager.close_all)


@pytest.mark.parametrize("sandbox", [False, True])
def test_workspace_parent_uses_current_runtime_boundary(tmp_path, monkeypatch, sandbox):
    from services.skin_onboarding import workspace_parent
    from services import config
    monkeypatch.setattr(config, "CONFIG_DIR", tmp_path / "config")
    if sandbox:
        monkeypatch.setenv("WORKSTEP_PROJECTS_ROOT", str(tmp_path / "projects"))
        assert workspace_parent() == tmp_path / "projects" / "runtime"
    else:
        monkeypatch.delenv("WORKSTEP_PROJECTS_ROOT", raising=False)
        assert workspace_parent() == tmp_path / "config" / "runtime" / "workspace"
