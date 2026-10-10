"""Portable custom engine lifecycle, contracts and failure isolation."""
import asyncio
import json
from pathlib import Path
import zipfile

import pytest


ADAPTER = '''from engines.core.custom_sdk import CustomEngineBase
from engines.core.events import InternalEvent, agent_message_chunk
from engines.core.schema import EngineConfigField
from engines.core.base import EngineInstallResult
class ExampleEngine(CustomEngineBase):
    ENGINE_ID = "example_custom"
    acp_events = frozenset({"agent_message_chunk", "status", "session_started", "error"})
    @staticmethod
    def is_installed(): return True
    @staticmethod
    def get_version(): return "1.0"
    @staticmethod
    def resolve_binary(): return None
    @classmethod
    def config_schema(cls): return [EngineConfigField(key="token", label="Token", sensitive=True, type="password")]
    async def install(self):
        (self.install_context.target_dir / "installed.txt").write_text("installed")
        return EngineInstallResult(True, "installed")
    async def spawn(self, prompt, cwd, **kwargs):
        yield InternalEvent("status", {"status": "running"})
        yield agent_message_chunk("WORKSTEP_ENGINE_OK")
        yield InternalEvent("status", {"status": "done"})
    async def stop(self): pass
'''


@pytest.fixture
def custom_environment(tmp_path, monkeypatch):
    import services.config as config
    import engines.core.registry as registry
    # Registration refreshes in-memory catalogs: isolate them as well as files.
    monkeypatch.setattr(registry, "_ALL_ENGINES", dict(registry._ALL_ENGINES))
    monkeypatch.setattr(registry, "ENGINE_REGISTRY", dict(registry.ENGINE_REGISTRY))
    monkeypatch.setattr(registry, "COORDINATOR_FALLBACK_ORDER", list(registry.COORDINATOR_FALLBACK_ORDER))
    monkeypatch.setattr(registry, "_SCAN_CACHE", None)
    monkeypatch.setattr(registry, "_SCAN_GENERATION", registry._SCAN_GENERATION)
    monkeypatch.setattr(config, "CONFIG_DIR", tmp_path / "config")
    monkeypatch.setattr(config, "CONFIG_FILE", tmp_path / "config" / "config.json")
    monkeypatch.setattr(config.config_store, "_cache", {})
    monkeypatch.setenv("WORKSTEP_CONFIG_DIR", str(tmp_path / "config"))
    source = tmp_path / "source"
    source.mkdir()
    (source / "engine.py").write_text(ADAPTER)
    (source / "manifest.json").write_text(json.dumps({
        "api_version": 1, "id": "example_custom", "name": "Example custom",
        "description": "test adapter", "mode": "sdk", "entry": "engine.py",
        "class_name": "ExampleEngine", "files": ["engine.py"],
    }))
    (source / "tests").mkdir()
    (source / "tests" / "test_adapter.py").write_text("import unittest\nfrom workstep_user_adapter import ExampleEngine\nclass Contract(unittest.TestCase):\n    def test_id(self): self.assertEqual(ExampleEngine.ENGINE_ID, 'example_custom')\n")
    manifest = json.loads((source / "manifest.json").read_text())
    manifest["files"].append("tests/test_adapter.py")
    (source / "manifest.json").write_text(json.dumps(manifest))
    return source


@pytest.mark.asyncio
async def test_inspect_install_validate_register_and_export(custom_environment):
    from services.custom_engines import custom_engine_manager as manager
    source = custom_environment
    info = await manager.inspect(str(source))
    assert info["engine"]["id"] == "example_custom"
    assert info["engine"]["config"]["fields"][0]["sensitive"] is True
    assert not info["registered"]
    install = await manager.run_operation("install", str(source))
    assert install["ok"] is True
    assert (source / "dependencies" / "installed.txt").exists()
    report = await manager.run_operation("validate", str(source))
    assert report["ok"] is True, report
    registered = await manager.register(str(source))
    assert registered["restart_required"] is False
    assert (manager.root() / "example_custom" / "engine.py").exists()
    blob = await manager.export("example_custom")
    import io
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        assert "engine.py" in archive.namelist()
        assert "manifest.json" in archive.namelist()
        assert not any(name.startswith(("dependencies/", "cache/")) for name in archive.namelist())


@pytest.mark.asyncio
async def test_worker_stream_config_and_stop(custom_environment):
    from services.custom_engines import custom_engine_manager as manager
    from engines.core.custom_proxy import make_custom_engine
    info = (await manager.inspect(str(custom_environment)))["engine"]
    cls = make_custom_engine(custom_environment, info)
    engine = cls()
    await engine.save_config_values({"token": "secret-value"})
    assert engine.get_config_values()["token"] == ""
    assert engine.get_config_secrets()["token"] is True
    assert engine.reveal_config_value("token") == "secret-value"
    events = [event async for event in engine.spawn("hello", str(custom_environment))]
    assert any(event.type == "agent_message_chunk" for event in events)
    await engine.stop()
    await engine.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_code", ["raise RuntimeError('broken import')", "import os; os._exit(9)", "import time; time.sleep(60)"])
async def test_broken_import_isolated_and_health_canary(custom_environment, bad_code):
    from services.custom_engines import custom_engine_manager as manager
    (custom_environment / "engine.py").write_text(bad_code)
    task = asyncio.create_task(manager.inspect(str(custom_environment), timeout=.3))
    await asyncio.sleep(.05)
    assert await asyncio.wait_for(asyncio.sleep(0, result="alive"), .1) == "alive"
    with pytest.raises((ValueError, RuntimeError, TimeoutError)):
        await task


@pytest.mark.asyncio
async def test_registration_rejects_stale_or_missing_validation(custom_environment):
    from services.custom_engines import custom_engine_manager as manager
    with pytest.raises(ValueError, match="验收"):
        await manager.register(str(custom_environment))
    await manager.run_operation("validate", str(custom_environment))
    with (custom_environment / "engine.py").open("a") as file:
        file.write("\n# changed\n")
    with pytest.raises(ValueError, match="验收"):
        await manager.register(str(custom_environment))


def test_manifest_scan_never_imports_user_code(custom_environment):
    from engines.core.custom_proxy import discover_custom_engines
    from services.custom_engines import custom_engine_manager as manager
    root = manager.root()
    target = root / "example_custom"
    target.mkdir(parents=True)
    (target / "engine.py").write_text("raise SystemExit('must not execute')")
    manifest = json.loads((custom_environment / "manifest.json").read_text())
    manifest["files"] = ["engine.py"]
    (target / "manifest.json").write_text(json.dumps(manifest))
    classes = discover_custom_engines()
    assert "example_custom" in classes
    assert classes["example_custom"].is_installed() is False


@pytest.mark.asyncio
async def test_rejects_unsafe_export_paths(custom_environment):
    from services.custom_engines import custom_engine_manager as manager
    manifest = json.loads((custom_environment / "manifest.json").read_text())
    manifest["files"] = ["../secret.txt"]
    (custom_environment / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError):
        await manager.inspect(str(custom_environment))


@pytest.mark.asyncio
async def test_failed_install_preserves_previous_dependencies(custom_environment):
    from services.custom_engines import custom_engine_manager as manager
    source = custom_environment
    (source / "dependencies").mkdir()
    (source / "dependencies" / "keep.txt").write_text("previous")
    code = (source / "engine.py").read_text().replace('return EngineInstallResult(True, "installed")', 'return EngineInstallResult(False, "failed")')
    (source / "engine.py").write_text(code)
    with pytest.raises(ValueError): await manager.run_operation("install", str(source))
    assert (source / "dependencies" / "keep.txt").read_text() == "previous"
    assert not (source / "dependencies" / "installed.txt").exists()

@pytest.mark.asyncio
async def test_report_tamper_and_config_change_require_revalidation(custom_environment):
    from services.custom_engines import custom_engine_manager as manager
    source = custom_environment
    await manager.run_operation("validate", str(source))
    file = source / "validation.json"
    original = file.read_text()
    report = json.loads(original); report["version"] = "forged"; file.write_text(json.dumps(report))
    with pytest.raises(ValueError, match="签名"): await manager.register(str(source))
    file.write_text(original)
    await manager.configure(str(source), {"token": "secret"})
    with pytest.raises(ValueError, match="失效"): await manager.register(str(source))

@pytest.mark.asyncio
async def test_unlisted_tests_cannot_be_validated(custom_environment):
    from services.custom_engines import custom_engine_manager as manager
    source = custom_environment
    file = source / "manifest.json"
    manifest = json.loads(file.read_text()); manifest["files"] = ["engine.py"]
    file.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="files"): await manager.run_operation("validate", str(source))

@pytest.mark.asyncio
async def test_dependency_relative_links_are_portable_and_external_links_rejected(custom_environment, tmp_path):
    from engines.core.custom_package import digest, load_manifest
    source = custom_environment
    deps = source / "dependencies"; deps.mkdir()
    (deps / "real").write_text("node binary")
    (deps / "bin").symlink_to("real")
    assert digest(source, load_manifest(source), dependencies=True)
    (deps / "outside").symlink_to(tmp_path / "secret")
    with pytest.raises(ValueError): digest(source, load_manifest(source), dependencies=True)

@pytest.mark.asyncio
async def test_live_queue_is_ready_before_first_event(custom_environment):
    from services.custom_engines import custom_engine_manager as manager
    from engines.core.custom_proxy import make_custom_engine
    source = custom_environment
    code = (source / "engine.py").read_text().replace('yield InternalEvent("status", {"status": "running"})', 'item = await kwargs["live_message_queue"].get()\n        yield agent_message_chunk(str(item))')
    (source / "engine.py").write_text(code)
    info = await manager.inspect(str(source))
    engine = make_custom_engine(source, info["engine"])()
    queue = asyncio.Queue(); await queue.put("queued first")
    events = await asyncio.wait_for(_collect(engine.spawn("test", str(source), live_message_queue=queue)), 5)
    assert any(item.type == "agent_message_chunk" and item.data["content"]["text"] == "queued first" for item in events)

async def _collect(stream): return [event async for event in stream]


@pytest.mark.asyncio
async def test_custom_api_lifecycle_remains_responsive(custom_environment, monkeypatch):
    from fastapi import FastAPI
    from httpx import AsyncClient, ASGITransport
    from api.custom_engine import router, authorize
    from services.custom_engines import custom_engine_manager as manager
    app = FastAPI(); app.include_router(router)
    app.dependency_overrides[authorize] = lambda: None
    @app.get("/health")
    async def health(): return {"ok": True}
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        response = await client.post("/custom/operations", json={"action": "validate", "path": str(custom_environment)})
        assert response.status_code == 202
        key = response.json()["id"]
        while True:
            assert (await asyncio.wait_for(client.get("/health"), .5)).json()["ok"]
            operation = (await client.get(f"/custom/operations/{key}")).json()
            if operation["status"] != "running": break
            await asyncio.sleep(.05)
        assert operation["result"]["ok"]
        response = await client.post("/custom/register", json={"path": str(custom_environment)})
        assert response.status_code == 200, response.text
        assert (await client.get("/custom/example_custom/export")).headers["content-type"] == "application/zip"
        response = await client.post("/custom/disable", json={"engine_id": "example_custom"})
        assert response.json()["disabled"]
    await manager.shutdown()

@pytest.mark.asyncio
async def test_custom_api_rejects_remote_scope(monkeypatch):
    from fastapi import FastAPI
    from httpx import AsyncClient, ASGITransport
    import api.custom_engine as api
    def denied(*args): raise PermissionError("只允许宿主机操作")
    monkeypatch.setattr(api, "require_catalog_project", denied)
    app = FastAPI(); app.include_router(api.router)
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        assert (await client.post("/custom/inspect", json={"path": "/somewhere"})).status_code == 403

@pytest.mark.asyncio
async def test_registry_rediscovers_registered_adapter_in_fresh_process(custom_environment):
    import os, sys
    from services.custom_engines import custom_engine_manager as manager
    source = custom_environment
    await manager.run_operation("validate", str(source)); await manager.register(str(source))
    process = await asyncio.create_subprocess_exec(sys.executable, "-c",
        "from engines.core.registry import create_engine; engine=create_engine('example_custom'); assert engine is not None; assert engine.is_installed(); print(engine.ENGINE_ID)",
        env=dict(os.environ), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await asyncio.wait_for(process.communicate(), 10)
    assert process.returncode == 0, err.decode()
    assert out.strip() == b"example_custom"


@pytest.mark.asyncio
async def test_session_setup_preserves_worker_instance_for_spawn(custom_environment):
    from services.custom_engines import custom_engine_manager as manager
    from engines.core.custom_proxy import make_custom_engine
    source = custom_environment
    code = (source / "engine.py").read_text().replace('yield InternalEvent("status", {"status": "running"})', 'assert self.session_ready\n        yield InternalEvent("status", {"status": "running"})')
    code += "\n    async def create_session(self, cwd, **kwargs):\n        self.session_ready = True\n        return 'actual-session'\n"
    (source / "engine.py").write_text(code)
    info = await manager.inspect(str(source)); engine = make_custom_engine(source, info["engine"])()
    assert await engine.create_session(str(source)) == "actual-session"
    try:
        events = await _collect(engine.spawn("test", str(source), session_id="actual-session"))
        assert not any(item.type == "error" for item in events)
    finally: await engine.stop()


@pytest.mark.asyncio
async def test_unlisted_python_module_rejected(custom_environment):
    from services.custom_engines import custom_engine_manager as manager
    (custom_environment / "mapping.py").write_text("EVENT_MAP = {}")
    with pytest.raises(ValueError, match="files"): await manager.inspect(str(custom_environment))

@pytest.mark.asyncio
async def test_worker_timeout_kills_descendant_process(custom_environment):
    import sys, os
    if os.name == "nt": pytest.skip("POSIX process-group canary")
    from services.custom_engines import custom_engine_manager as manager
    source = custom_environment
    code = "import subprocess, sys, time\nfrom pathlib import Path\nchild = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\nPath(__file__).with_name('child.pid').write_text(str(child.pid))\ntime.sleep(60)\n"
    (source / "engine.py").write_text(code)
    with pytest.raises(TimeoutError): await manager.inspect(str(source), timeout=10)
    pid_file = source / "child.pid"
    assert pid_file.exists()
    pid = int(pid_file.read_text())
    def alive():
        try: os.kill(pid, 0); return True
        except ProcessLookupError: return False
    for _ in range(50):
        if not alive(): break
        await asyncio.sleep(.02)
    assert not alive()


@pytest.mark.asyncio
async def test_dependency_switch_failure_restores_previous_environment(custom_environment, monkeypatch):
    from services.custom_engines import custom_engine_manager as manager
    source = custom_environment
    deps = source / "dependencies"; deps.mkdir()
    (deps / "keep.txt").write_text("previous")
    rename = Path.rename
    def broken_switch(self, target):
        if self.name.startswith(".dependencies-") and not self.name.startswith(".dependencies-backup-") and Path(target).name == "dependencies":
            raise OSError("simulated atomic switch failure")
        return rename(self, target)
    monkeypatch.setattr(Path, "rename", broken_switch)
    with pytest.raises(OSError): await manager.run_operation("install", str(source))
    assert (deps / "keep.txt").read_text() == "previous"


@pytest.mark.asyncio
async def test_goal_events_keep_acp_and_workstep_extension_boundaries(custom_environment):
    from services.custom_engines import custom_engine_manager as manager
    from engines.core.custom_proxy import make_custom_engine
    source = custom_environment
    code = (source / "engine.py").read_text().replace('    ENGINE_ID =', '    workstep_events = frozenset({"goal_update"})\n    ENGINE_ID =').replace('yield InternalEvent("status", {"status": "running"})', 'yield InternalEvent("goal_update", {"objective": "test", "status": "active"})')
    (source / "engine.py").write_text(code)
    info = await manager.inspect(str(source)); engine = make_custom_engine(source, info["engine"])()
    events = await _collect(engine.spawn("test", str(source)))
    assert any(item.type == "goal_update" for item in events)
    assert "goal_update" not in engine.acp_events


@pytest.mark.asyncio
async def test_acceptance_rejects_engine_that_cannot_stop_live_stream(custom_environment):
    from services.custom_engines import custom_engine_manager as manager
    source = custom_environment
    code = (source / "engine.py").read_text().replace('from engines.core.custom_sdk', 'import asyncio\nfrom engines.core.custom_sdk').replace('yield InternalEvent("status", {"status": "done"})', 'if "WORKSTEP_STOP_PROBE" in prompt: await asyncio.Event().wait()\n        yield InternalEvent("status", {"status": "done"})')
    (source / "engine.py").write_text(code)
    report = await manager.run_operation("validate", str(source))
    assert not report["ok"]
    assert next(item for item in report["checks"] if item["name"] == "stop_and_idempotency")["status"] == "failed"


@pytest.mark.asyncio
async def test_python_sdk_install_uses_isolated_directory_without_pip(custom_environment, tmp_path):
    import importlib.util
    from services.custom_engines import custom_engine_manager as manager
    source = custom_environment
    wheel = tmp_path / "workstep_fixture_sdk-1.0-py3-none-any.whl"
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr("workstep_fixture_sdk.py", "VALUE = 'installed'\n")
        archive.writestr("workstep_fixture_sdk-1.0.dist-info/METADATA", "Metadata-Version: 2.1\nName: workstep-fixture-sdk\nVersion: 1.0\n")
        archive.writestr("workstep_fixture_sdk-1.0.dist-info/WHEEL", "Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
        archive.writestr("workstep_fixture_sdk-1.0.dist-info/RECORD", "")
    code = (source / "engine.py").read_text().replace('def is_installed(): return True', 'def is_installed():\n        import importlib.util\n        return importlib.util.find_spec("workstep_fixture_sdk") is not None')
    start = code.index('    async def install(self):'); end = code.index('    async def spawn', start)
    code = code[:start] + '    async def install(self):\n        return await self.install_python_dependencies("--no-index", ' + repr(str(wheel)) + ')\n' + code[end:]
    (source / "engine.py").write_text(code)
    assert (await manager.run_operation("install", str(source)))["ok"]
    assert (source / "dependencies" / "python" / "workstep_fixture_sdk.py").is_file()
    assert importlib.util.find_spec("workstep_fixture_sdk") is None



@pytest.mark.asyncio
async def test_registered_engine_executes_real_downstream_pipeline_after_restart(custom_environment, tmp_path):
    import os, sys
    from services.custom_engines import custom_engine_manager as engines
    await engines.run_operation("validate", str(custom_environment))
    await engines.register(str(custom_environment))
    script = r"""
import asyncio, sys, json
from pathlib import Path
from services.project import ProjectManager
from services.task_runner import TaskRunner
from streaming.bus import EventBus
from models import Task
from models.fields import utc_now
async def run():
    manager = ProjectManager(); bus = EventBus()
    project = await asyncio.to_thread(manager.init_project, Path(sys.argv[1]))
    task = await manager.run_db(project.id, lambda current: Task.create(id="custom-pipeline", title="引擎集成测试", cwd=str(project.path), engine="example_custom", created_at=utc_now(), updated_at=utc_now()))
    runner = TaskRunner(bus, database_executor=project.database_executor)
    queue = bus.subscribe()
    try:
        await asyncio.wait_for(runner.run_pipeline(task, {"steps": [
            {"key": "execute", "label": "执行", "engine": "example_custom", "prompt": "test"},
            {"key": "downstream", "label": "下游", "engine": "example_custom", "prompt": "test", "dependsOn": ["execute"]},
        ]}, project.workstep_dir / "artifacts"), 15)
        events = []
        while not queue.empty(): events.append(queue.get_nowait())
        assert not any(item.get("type") == "RUN_ERROR" for item in events), json.dumps(events)
        assert {item.get("step_key") for item in events if item.get("type") == "TEXT_MESSAGE_CHUNK"} == {"execute", "downstream"}, json.dumps(events)
    finally:
        await runner.close(); await bus.close(); await asyncio.to_thread(manager.close_all)
asyncio.run(run())
"""
    process = await asyncio.create_subprocess_exec(sys.executable, "-c", script, str(tmp_path / "pipeline-project"),
        env=dict(os.environ), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    output, errors = await asyncio.wait_for(process.communicate(), 20)
    assert process.returncode == 0, errors.decode()


@pytest.mark.asyncio
async def test_refresh_discovers_new_custom_engine_without_restart(custom_environment, monkeypatch):
    import threading
    import time
    from fastapi import FastAPI
    from httpx import AsyncClient, ASGITransport
    from api.engine import router
    import engines.core.registry as registry
    from services.custom_engines import custom_engine_manager as manager
    monkeypatch.setattr(registry, "_ALL_ENGINES", dict(registry._ALL_ENGINES))
    monkeypatch.setattr(registry, "ENGINE_REGISTRY", dict(registry.ENGINE_REGISTRY))
    monkeypatch.setattr(registry, "COORDINATOR_FALLBACK_ORDER", list(registry.COORDINATOR_FALLBACK_ORDER))
    monkeypatch.setattr(registry, "_SCAN_CACHE", None)
    monkeypatch.setattr(registry, "_SCAN_GENERATION", registry._SCAN_GENERATION)
    registry._ALL_ENGINES.pop("example_custom", None)
    registry.ENGINE_REGISTRY.pop("example_custom", None)
    assert await asyncio.to_thread(registry.create_engine, "example_custom") is None
    report = await manager.run_operation("validate", str(custom_environment))
    assert report["ok"], report
    app = FastAPI()
    app.include_router(router)
    @app.get("/health")
    async def health(): return {"ok": True}
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        registered = await client.post("/api/engine/custom/register", json={"path": str(custom_environment)})
        assert registered.status_code == 200, registered.text
        assert registered.json()["restart_required"] is False
        discover = registry._discover_engine_classes
        started = threading.Event()
        def slow_discover():
            started.set()
            time.sleep(.3)
            return discover()
        monkeypatch.setattr(registry, "_discover_engine_classes", slow_discover)
        refresh = asyncio.create_task(client.post("/api/engine/refresh"))
        assert await asyncio.to_thread(started.wait, 2)
        assert (await asyncio.wait_for(client.get("/health"), .15)).json()["ok"]
        response = await refresh
        assert response.status_code == 200, response.text
        assert any(item["id"] == "example_custom" and item["installed"] for item in response.json()["engines"])
        listed = await client.get("/api/engine/list")
        assert any(item["id"] == "example_custom" for item in listed.json()["engines"])
        assert "example_custom" in registry.COORDINATOR_FALLBACK_ORDER
        engine = await asyncio.to_thread(registry.create_engine, "example_custom")
        assert engine is not None
        events = [event async for event in engine.spawn("hello", str(custom_environment))]
        assert any(event.type == "agent_message_chunk" for event in events)
        await engine.stop()
