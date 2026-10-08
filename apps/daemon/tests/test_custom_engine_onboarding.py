import asyncio
from types import SimpleNamespace
from unittest.mock import Mock
import pytest

@pytest.mark.asyncio
async def test_onboarding_creates_normal_chat_in_workspace(tmp_path, monkeypatch):
    from services import custom_engine_onboarding as onboarding
    module = SimpleNamespace(_resolve_engine_models=lambda: ("codex_sdk", None, None),
                             create_session=Mock(return_value={"id": "session"}))
    monkeypatch.setattr(onboarding, "chat_module", lambda: module)
    monkeypatch.setattr(onboarding, "workspace_parent", lambda: tmp_path)
    project = SimpleNamespace(id="project", name="引擎接入")
    monkeypatch.setattr(onboarding.project_manager, "init_project", lambda *a, **kw: project)
    async def run_db(project_id, operation): return operation(project)
    monkeypatch.setattr(onboarding.project_manager, "run_db", run_db)
    monkeypatch.setattr(onboarding.skill_center, "runtime_selection", lambda root: None)
    result = await onboarding.create_onboarding()
    assert result["session_id"] == "session"
    assert result["project_id"] == "project"
    assert "$custom-engine" not in result["prompt"]
    assert "workstep-cli" in result["prompt"]
    assert "custom-engine.md" in result["prompt"]
    assert result["workspace_path"] in result["prompt"]
    assert "重启" in result["prompt"]
    module.create_session.assert_called_once()

@pytest.mark.asyncio
async def test_onboarding_resolves_engine_before_creating_project(monkeypatch):
    from services import custom_engine_onboarding as onboarding
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
    from services import custom_engine_onboarding as onboarding
    from services.project import ProjectManager
    from agent_assistants.chat_session import ChatSessionModule
    from streaming.bus import EventBus
    from api.custom_engine import router, authorize
    manager = ProjectManager(); bus = EventBus(); module = ChatSessionModule(bus, manager)
    monkeypatch.setattr(onboarding, "project_manager", manager)
    monkeypatch.setattr(onboarding, "chat_module", lambda: module)
    monkeypatch.setattr(onboarding, "workspace_parent", lambda: tmp_path / "runtime" / "engine-workspaces")
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
            pending = asyncio.create_task(client.post("/custom/onboarding"))
            await asyncio.sleep(.05)
            assert (await asyncio.wait_for(client.get("/health"), .1)).json()["ok"]
            response = await pending
            assert response.status_code == 200, response.text
            result = response.json()
            detail = await manager.run_db(result["project_id"], lambda current: module.get_session(result["project_id"], result["session_id"]))
            assert detail["title"] == "自定义引擎接入"
    finally:
        await module.shutdown(); await bus.close(); await asyncio.to_thread(manager.close_all)


@pytest.mark.parametrize("sandbox", [False, True])
def test_workspace_parent_uses_current_runtime_boundary(tmp_path, monkeypatch, sandbox):
    from services.custom_engine_onboarding import workspace_parent
    from services import config
    monkeypatch.setattr(config, "CONFIG_DIR", tmp_path / "config")
    if sandbox:
        monkeypatch.setenv("WORKSTEP_PROJECTS_ROOT", str(tmp_path / "projects"))
        assert workspace_parent() == tmp_path / "projects" / "workstep-engine-workspaces"
    else:
        monkeypatch.delenv("WORKSTEP_PROJECTS_ROOT", raising=False)
        assert workspace_parent() == tmp_path / "config" / "runtime" / "engine-workspaces"
