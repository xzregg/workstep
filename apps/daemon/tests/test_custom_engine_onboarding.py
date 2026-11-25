import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
import pytest

@pytest.fixture(autouse=True)
def daemon_cli_url(monkeypatch):
    monkeypatch.setenv('WORKSTEP_DAEMON_URL', 'http://127.0.0.1:8765')


@pytest.mark.asyncio
async def test_onboarding_creates_normal_chat_in_workspace(tmp_path, monkeypatch):
    from services import custom_engine_onboarding as onboarding
    module = SimpleNamespace(_resolve_engine_models=lambda: ("codex_sdk", None, None),
                             create_session=Mock(return_value={"id": "session"}))
    monkeypatch.setattr(onboarding, "chat_module", lambda: module)
    monkeypatch.setattr(onboarding, "workspace_parent", lambda: tmp_path)
    project = SimpleNamespace(id="project", name="runtime", path=tmp_path)
    monkeypatch.setattr(onboarding.project_manager, "init_project", lambda *a, **kw: project)
    async def run_db(project_id, operation): return operation(project)
    monkeypatch.setattr(onboarding.project_manager, "run_db", run_db)
    skill_dir = tmp_path / 'project skill'
    (skill_dir / 'references').mkdir(parents=True)
    (skill_dir / 'SKILL.md').write_text('CLI entry')
    for name in ('custom-engine.md', 'custom-engine-contract.md', 'custom-engine-testing.md'):
        (skill_dir / 'references' / name).write_text('guide')
    monkeypatch.setattr(onboarding.skill_center, "runtime_selection", lambda root: SimpleNamespace(
        enabled=(SimpleNamespace(name='workstep-cli', runtime_path=skill_dir),)))
    result = await onboarding.create_onboarding()
    skill_path = Path(result['skill_path'])
    assert skill_path == skill_dir / 'SKILL.md'
    assert skill_path.name == 'SKILL.md'
    assert skill_path.is_absolute() and skill_path.is_file()
    assert (skill_path.parent / 'references/custom-engine-contract.md').is_file()
    assert str(skill_path) in result['prompt']
    assert result['cli_command'] in result['prompt']
    assert 'WORKSTEP_CONFIG_DIR' in result['cli_command']
    assert '--url' in result['cli_command']
    assert result["session_id"] == "session"
    assert result["project_id"] == "project"
    assert "$custom-engine" not in result["prompt"]
    assert "workstep-cli" in result["prompt"]
    assert "custom-engine.md" in result["prompt"]
    assert "custom-engine-contract.md" in result["prompt"]
    assert "custom-engine-testing.md" in result["prompt"]
    assert "engine validate" in result["prompt"]
    assert "engine register" in result["prompt"]
    assert result["workspace_path"] in result["prompt"]
    assert "no restart is needed" in result["prompt"]
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
@pytest.mark.parametrize('imported', [False, True])
async def test_onboarding_api_uses_real_db_without_blocking_event_loop(tmp_path, monkeypatch, imported):
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
            if imported:
                from tests.test_custom_engine_import import package
                pending = asyncio.create_task(client.post('/custom/import?title=Imported%20engine', content=package()))
            else:
                pending = asyncio.create_task(client.post("/custom/onboarding"))
            await asyncio.sleep(.05)
            assert (await asyncio.wait_for(client.get("/health"), .1)).json()["ok"]
            response = await pending
            assert response.status_code == 200, response.text
            result = response.json()
            detail = await manager.run_db(result["project_id"], lambda current: module.get_session(result["project_id"], result["session_id"]))
            assert detail["title"] == ("Imported engine" if imported else "自定义引擎接入")
            for guide in ('custom-engine.md', 'custom-engine-contract.md', 'custom-engine-testing.md'):
                assert guide in result['prompt']
            assert 'no restart is needed' in result['prompt']
            if imported:
                assert result['package_path'] in result['prompt']
                assert 'engine validate' in result['prompt']
                assert 'same engine ID' in result['prompt']
                assert 'do not recreate the adapter' in result['prompt']
    finally:
        await module.shutdown(); await bus.close(); await asyncio.to_thread(manager.close_all)


@pytest.mark.parametrize("sandbox", [False, True])
def test_workspace_parent_uses_current_runtime_boundary(tmp_path, monkeypatch, sandbox):
    from services.custom_engine_onboarding import workspace_parent
    from services import config
    monkeypatch.setattr(config, "CONFIG_DIR", tmp_path / "config")
    if sandbox:
        monkeypatch.setenv("WORKSTEP_PROJECTS_ROOT", str(tmp_path / "projects"))
        assert workspace_parent() == tmp_path / "projects" / "runtime"
    else:
        monkeypatch.delenv("WORKSTEP_PROJECTS_ROOT", raising=False)
        assert workspace_parent() == tmp_path / "config" / "runtime" / "workspace"


def test_cli_command_quotes_runtime_paths_without_embedding_credentials(tmp_path, monkeypatch):
    import os
    import shlex
    import sys
    from services import config
    from services.custom_engine_onboarding import cli_invocation
    directory = tmp_path / "config with 'quotes' and $dollars"
    monkeypatch.setattr(config, 'CONFIG_DIR', directory)
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'private-runtime-token')
    command = cli_invocation()
    assert 'private-runtime-token' not in command
    if os.name != 'nt':
        args = shlex.split(command)
        assert args[:3] == ['env', f'WORKSTEP_CONFIG_DIR={directory}', sys.executable]
        assert args[-2:] == ['--url', 'http://127.0.0.1:8765']
    else:
        assert command.startswith('$env:WORKSTEP_CONFIG_DIR=')
        assert "''quotes''" in command


def test_cli_command_rejects_missing_live_runtime_url(monkeypatch):
    from services.custom_engine_onboarding import cli_invocation
    monkeypatch.delenv('WORKSTEP_DAEMON_URL')
    with pytest.raises(ValueError, match='runtime is unavailable'):
        cli_invocation()
