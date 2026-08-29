"""HTTP contract tests for user-visible daemon features."""

from contextlib import AsyncExitStack
import asyncio
import sqlite3
import threading
import time
import json
import uuid
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from engines.core.events import InternalEvent
from engines.core.registry import ENGINE_REGISTRY
from services.project import ProjectManager
from services.task import TaskService
from services.workflow_runtime import WorkflowRuntime
from agent_assistants.coordinator import CoordinatorModule
from streaming.bus import EventBus


class MemoryConfigStore:
    """In-memory project registry used at the filesystem boundary."""

    def __init__(self):
        self.values = {}

    def get(self, key, default=None):
        return self.values.get(key, default)

    def set(self, key, value):
        self.values[key] = value

    def is_engine_verified(self, engine_id):
        return self.values.get("verified_engines", {}).get(engine_id) is True

    def set_engine_verified(self, engine_id, verified):
        values = dict(self.values.get("verified_engines", {}))
        if verified:
            values[engine_id] = True
        else:
            values.pop(engine_id, None)
        self.values["verified_engines"] = values

    def get_engine_default_model(self, engine_id):
        return self.values.get("engine_default_models", {}).get(engine_id, "")

    def set_engine_default_model(self, engine_id, model):
        values = dict(self.values.get("engine_default_models", {}))
        values[engine_id] = model
        self.values["engine_default_models"] = values

    def get_engine_binary_path(self, engine_id):
        return self.values.get("engine_binary_paths", {}).get(engine_id, "")

    def set_engine_binary_path(self, engine_id, path):
        values = dict(self.values.get("engine_binary_paths", {}))
        values[engine_id] = path
        self.values["engine_binary_paths"] = values

    def get_claude_permission_mode(self):
        return self.values.get("claude_permission_mode", "")

    def set_claude_permission_mode(self, mode):
        self.values["claude_permission_mode"] = mode


@pytest.fixture
async def api_context(tmp_path, monkeypatch):
    """Run the real FastAPI routes against isolated project databases."""
    import api.history as history_api
    import api.engine as engine_api
    import api.project as project_api
    import api.search as search_api
    import api.templates as templates_api
    import api.workflow as workflow_api
    import main
    import services.project as project_service

    config_store = MemoryConfigStore()
    manager = ProjectManager()
    bus = EventBus()
    task_service = TaskService(bus)
    runtime = WorkflowRuntime(bus, manager)
    coordinator = CoordinatorModule(bus, manager, runtime)

    monkeypatch.setattr(project_service, "config_store", config_store)
    monkeypatch.setattr(engine_api, "config_store", config_store)
    monkeypatch.setattr(project_api, "project_manager", manager)
    monkeypatch.setattr(history_api, "project_manager", manager)
    monkeypatch.setattr(search_api, "project_manager", manager)
    monkeypatch.setattr(workflow_api, "project_manager", manager)
    monkeypatch.setattr(templates_api, "GLOBAL_TEMPLATES_DIR", tmp_path / "templates")
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "task_service", task_service)
    monkeypatch.setattr(main, "workflow_runtime", runtime)
    monkeypatch.setattr(main, "coordinator_module", coordinator)

    transport = ASGITransport(app=main.app)
    async with AsyncExitStack() as stack:
        client = await stack.enter_async_context(
            AsyncClient(transport=transport, base_url="http://test")
        )
        yield client, tmp_path

    await coordinator.shutdown()
    await runtime.shutdown()
    await bus.close()
    manager.close_all()


@pytest.mark.anyio
async def test_task_creation_binds_selected_workflow(api_context, monkeypatch):
    import api.task as task_api

    monkeypatch.setattr(
        task_api.config_store,
        "get_execution_default_engine",
        lambda: "",
    )
    client, tmp_path = api_context
    project_dir = tmp_path / "selected-workflow-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]
    workflow = await client.post(
        f"/api/workflow/create?project_id={project_id}",
        json={
            "name": "SelectedWorkflow",
            "steps": {
                "nodes": [
                    {
                        "id": "selected",
                        "title": "Selected",
                        "engine": "claude",
                        "inputs": [],
                        "outputs": [],
                    }
                ],
                "connections": [],
            },
        },
    )
    workflow_id = workflow.json()["id"]

    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Selected task",
            "cwd": str(project_dir),
            "workflow_id": workflow_id,
        },
    )

    assert created.status_code == 200
    assert created.json()["engine"] == "pydantic_ai"
    assert created.json()["workflow_id"] == workflow_id
    assert [step["step_key"] for step in created.json()["steps"]] == ["selected"]


@pytest.mark.anyio
async def test_sqlite_write_lock_does_not_block_health_check(api_context):
    """A busy project writer must not stall unrelated FastAPI requests."""
    client, tmp_path = api_context
    project_dir = tmp_path / "nonblocking-project-writer"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]
    database_path = project_dir / ".workstep" / "workstep.db"

    locked = threading.Event()

    def hold_write_lock() -> None:
        connection = sqlite3.connect(database_path, timeout=1)
        try:
            connection.execute("BEGIN IMMEDIATE")
            locked.set()
            time.sleep(0.35)
            connection.commit()
        finally:
            connection.close()

    locker = threading.Thread(target=hold_write_lock)
    locker.start()
    assert locked.wait(1)

    started_at = time.perf_counter()

    async def health_canary():
        await asyncio.sleep(0.05)
        response = await client.get("/api/health")
        return response, time.perf_counter() - started_at

    canary_task = asyncio.create_task(health_canary())
    await asyncio.sleep(0)
    create_task = asyncio.create_task(client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Writer lock probe",
            "cwd": str(project_dir),
            "auto_start": False,
        },
    ))

    health, health_completed_at = await canary_task
    created = await create_task
    locker.join(timeout=1)

    assert health.status_code == 200
    assert health_completed_at < 0.2
    assert created.status_code == 200


@pytest.mark.anyio
async def test_workflow_start_write_lock_does_not_block_health_check(api_context):
    """Persisting a workflow run must wait outside the FastAPI event loop."""
    client, tmp_path = api_context
    project_dir = tmp_path / "nonblocking-workflow-start"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Workflow start lock probe",
            "cwd": str(project_dir),
            "auto_start": False,
        },
    )
    task_id = created.json()["id"]
    database_path = project_dir / ".workstep" / "workstep.db"

    locked = threading.Event()

    def hold_write_lock() -> None:
        connection = sqlite3.connect(database_path, timeout=1)
        try:
            connection.execute("BEGIN IMMEDIATE")
            locked.set()
            time.sleep(0.35)
            connection.commit()
        finally:
            connection.close()

    locker = threading.Thread(target=hold_write_lock)
    locker.start()
    assert locked.wait(1)

    started_at = time.perf_counter()

    async def health_canary():
        await asyncio.sleep(0.05)
        response = await client.get("/api/health")
        return response, time.perf_counter() - started_at

    canary_task = asyncio.create_task(health_canary())
    await asyncio.sleep(0)
    run_task = asyncio.create_task(client.post(
        f"/api/task/run?project_id={project_id}",
        json={"task_id": task_id, "prompt": "run"},
    ))

    health, health_completed_at = await canary_task
    started = await run_task
    locker.join(timeout=1)

    assert health.status_code == 200
    assert health_completed_at < 0.2
    assert started.status_code == 200


@pytest.mark.anyio
async def test_workflow_completion_write_lock_does_not_block_health_check(
    api_context,
):
    """LLM completion persistence must wait outside the FastAPI event loop."""
    client, tmp_path = api_context
    project_dir = tmp_path / "nonblocking-workflow-completion"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    engine_started = asyncio.Event()
    release_engine = asyncio.Event()

    class CompletionProbeEngine:
        supports_resume = False

        async def spawn(self, prompt, cwd, **kwargs):
            engine_started.set()
            await release_engine.wait()
            yield InternalEvent(type="status", data={"status": "done"})

        async def stop(self):
            return None

    engine_id = "completion-db-probe"
    original_engine = ENGINE_REGISTRY.get(engine_id)
    ENGINE_REGISTRY[engine_id] = CompletionProbeEngine
    try:
        workflow = await client.post(
            f"/api/workflow/create?project_id={project_id}",
            json={
                "name": "CompletionProbe",
                "steps": {
                    "nodes": [{
                        "id": "complete",
                        "type": "complete",
                        "title": "Complete",
                        "engine": engine_id,
                    }],
                    "connections": [],
                },
            },
        )
        workflow_id = workflow.json()["id"]
        created = await client.post(
            f"/api/task/create?project_id={project_id}",
            json={
                "title": "Workflow completion lock probe",
                "cwd": str(project_dir),
                "workflow_id": workflow_id,
                "auto_start": False,
            },
        )
        task_id = created.json()["id"]
        started = await client.post(
            f"/api/task/run?project_id={project_id}",
            json={"task_id": task_id, "prompt": "run"},
        )
        assert started.status_code == 200
        await asyncio.wait_for(engine_started.wait(), timeout=1)

        database_path = project_dir / ".workstep" / "workstep.db"
        locked = threading.Event()

        def hold_write_lock() -> None:
            connection = sqlite3.connect(database_path, timeout=1)
            try:
                connection.execute("BEGIN IMMEDIATE")
                locked.set()
                time.sleep(0.35)
                connection.commit()
            finally:
                connection.close()

        locker = threading.Thread(target=hold_write_lock)
        locker.start()
        assert locked.wait(1)
        started_at = time.perf_counter()

        async def health_canary():
            await asyncio.sleep(0.05)
            response = await client.get("/api/health")
            return response, time.perf_counter() - started_at

        canary_task = asyncio.create_task(health_canary())
        await asyncio.sleep(0)
        release_engine.set()
        health, health_completed_at = await canary_task
        locker.join(timeout=1)

        assert health.status_code == 200
        assert health_completed_at < 0.2
    finally:
        if original_engine is None:
            ENGINE_REGISTRY.pop(engine_id, None)
        else:
            ENGINE_REGISTRY[engine_id] = original_engine


@pytest.mark.anyio
async def test_task_creation_auto_starts_the_selected_stage(api_context, monkeypatch):
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "auto-start-stage-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]
    workflow = await client.post(
        f"/api/workflow/create?project_id={project_id}",
        json={
            "name": "AutoStartStages",
            "steps": {
                "nodes": [
                    {"id": 1, "type": "plan", "title": "Plan", "autoStart": False},
                    {"id": 2, "type": "build", "title": "Build", "autoStart": False},
                ],
                "connections": [],
            },
        },
    )
    workflow_id = workflow.json()["id"]
    saved = await client.post(
        f"/api/project/save-steps?project_id={project_id}&workflow_id={workflow_id}",
        json={
            "steps": {
                "nodes": [
                    {"id": 1, "type": "plan", "title": "Plan", "autoStart": False},
                    {"id": 2, "type": "build", "title": "Build", "autoStart": True},
                ],
                "connections": [],
            },
        },
    )
    assert saved.status_code == 200
    runtime = AsyncMock()
    monkeypatch.setattr(main, "workflow_runtime", runtime)

    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Auto-start build",
            "cwd": str(project_dir),
            "workflow_id": workflow_id,
            "start_step_key": "build",
        },
    )

    assert created.status_code == 200
    runtime.start.assert_awaited_once_with(project_id, created.json()["id"], "")

    runtime.start.reset_mock()
    manual = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Manual build",
            "cwd": str(project_dir),
            "workflow_id": workflow_id,
            "start_step_key": "build",
            "auto_start": False,
        },
    )
    assert manual.status_code == 200
    runtime.start.assert_not_awaited()

    disabled = await client.post(
        f"/api/project/save-steps?project_id={project_id}&workflow_id={workflow_id}",
        json={
            "steps": {
                "nodes": [
                    {"id": 1, "type": "plan", "title": "Plan", "autoStart": False},
                    {"id": 2, "type": "build", "title": "Build", "autoStart": False},
                ],
                "connections": [],
            },
        },
    )
    assert disabled.status_code == 200
    forced = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Forced auto-start build",
            "cwd": str(project_dir),
            "workflow_id": workflow_id,
            "start_step_key": "build",
            "auto_start": True,
        },
    )
    assert forced.status_code == 200
    runtime.start.assert_awaited_once_with(project_id, forced.json()["id"], "")


@pytest.mark.anyio
async def test_send_stage_message_routes_to_running_stage(api_context, monkeypatch):
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "live-message-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    runtime = AsyncMock()
    runtime.send_stage_message = AsyncMock(
        return_value={"message_id": "m-1", "step_key": "do", "status": "queued"}
    )
    monkeypatch.setattr(main, "workflow_runtime", runtime)

    sent = await client.post(
        f"/api/task/task-1/step/do/message?project_id={project_id}",
        json={"content": "停下！"},
    )
    assert sent.status_code == 200
    assert sent.json()["status"] == "queued"
    runtime.send_stage_message.assert_awaited_once_with(
        project_id,
        "task-1",
        "do",
        "停下！",
        as_guidance=False,
    )


@pytest.mark.anyio
async def test_send_stage_message_conflict_when_stage_not_running(api_context, monkeypatch):
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "live-message-conflict-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    runtime = AsyncMock()
    runtime.send_stage_message = AsyncMock(
        side_effect=ValueError("阶段未在运行: do")
    )
    monkeypatch.setattr(main, "workflow_runtime", runtime)

    sent = await client.post(
        f"/api/task/task-1/step/do/message?project_id={project_id}",
        json={"content": "停下！"},
    )
    assert sent.status_code == 409
    assert "阶段未在运行" in sent.json()["detail"]


@pytest.mark.anyio
async def test_project_http_lifecycle_returns_a_stable_identity(api_context):
    """A project keeps the same public id across init, list, rename and register."""
    client, tmp_path = api_context
    project_dir = tmp_path / "project"
    project_dir.mkdir()

    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir), "name": "Original"},
    )
    assert initialized.status_code == 200
    project_id = initialized.json()["id"]

    listed = await client.get("/api/project/list")
    assert listed.status_code == 200
    assert listed.json()["projects"][0]["id"] == project_id

    renamed = await client.post(
        "/api/project/rename",
        json={"path": str(project_dir), "name": "Renamed"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Renamed"

    registered = await client.post(
        "/api/project/register",
        json={"path": str(project_dir)},
    )
    assert registered.status_code == 200
    assert registered.json()["id"] == project_id


@pytest.mark.anyio
async def test_delete_project_only_unregisters_it(api_context):
    client, tmp_path = api_context
    project_dir = tmp_path / "project-to-forget"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir), "name": "Temporary"},
    )
    project_id = initialized.json()["id"]

    deleted = await client.delete(f"/api/project/{project_id}")

    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True}
    assert (project_dir / ".workstep" / "workstep.db").exists()
    assert (project_dir / ".workstep" / "steps.json").exists()
    listed = await client.get("/api/project/list")
    assert listed.json() == {"projects": []}
    missing = await client.delete(f"/api/project/{project_id}")
    assert missing.status_code == 404


@pytest.mark.anyio
async def test_upload_image_returns_project_relative_path(api_context):
    """Uploaded image url is the project-relative path, not an API url."""
    client, tmp_path = api_context
    project_dir = tmp_path / "test_workstep"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    import base64
    png = base64.b64encode(b"\x89PNG\r\n\x1a\nfake-image-bytes").decode()
    uploaded = await client.post(
        f"/api/fs/upload/image?project_id={project_id}",
        json={"filename": "shot.png", "data_url": f"data:image/png;base64,{png}"},
    )
    assert uploaded.status_code == 200
    body = uploaded.json()
    assert body["url"].startswith(".workstep/uploads/")
    assert body["url"].endswith(".png")
    filename = body["filename"]
    assert body["url"] == f".workstep/uploads/{filename}"

    # File physically lands in the project uploads directory
    assert (project_dir / ".workstep" / "uploads" / filename).is_file()

    # The serve endpoint (used by the preview) still works for that file
    served = await client.get(
        f"/api/fs/serve/{filename}?project_id={project_id}"
    )
    assert served.status_code == 200

    # The project-relative URL itself resolves to the file (via daemon route)
    via_name = await client.get(
        f"/test_workstep/.workstep/uploads/{filename}"
    )
    assert via_name.status_code == 200
    assert via_name.content == b"\x89PNG\r\n\x1a\nfake-image-bytes"


@pytest.mark.anyio
async def test_upload_file_returns_project_relative_markdown_target(api_context):
    """Ordinary attachments land beside images and remain downloadable."""
    client, tmp_path = api_context
    project_dir = tmp_path / "file_upload_project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    import base64
    content = b"%PDF-1.7\nattachment"
    encoded = base64.b64encode(content).decode()
    uploaded = await client.post(
        f"/api/fs/upload/file?project_id={project_id}",
        json={
            "filename": "interaction-notes.pdf",
            "data_url": f"data:application/pdf;base64,{encoded}",
            "prefix": "task-create",
        },
    )

    assert uploaded.status_code == 200
    body = uploaded.json()
    assert body["url"].startswith(".workstep/uploads/task-create-")
    assert body["url"].endswith(".pdf")
    assert body["size"] == len(content)
    assert (project_dir / ".workstep" / "uploads" / body["filename"]).read_bytes() == content

    served = await client.get(
        f"/api/fs/serve/{body['filename']}?project_id={project_id}"
    )
    assert served.status_code == 200
    assert served.content == content


@pytest.mark.anyio
async def test_upload_image_prefixes_filename(api_context):
    """Uploaded image filename starts with the given flow prefix."""
    client, tmp_path = api_context
    project_dir = tmp_path / "prefix_project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    import base64
    png = base64.b64encode(b"\x89PNG\r\n\x1a\nfake-image-bytes").decode()
    uploaded = await client.post(
        f"/api/fs/upload/image?project_id={project_id}",
        json={
            "filename": "shot.png",
            "prefix": "f0e8bc06",
            "data_url": f"data:image/png;base64,{png}",
        },
    )
    assert uploaded.status_code == 200
    filename = uploaded.json()["filename"]
    assert filename.startswith("f0e8bc06-")
    assert filename.endswith(".png")
    assert (project_dir / ".workstep" / "uploads" / filename).is_file()


@pytest.mark.anyio
async def test_upload_image_rejects_unsafe_prefix(api_context):
    """Prefix must be a safe short id; path traversal is rejected."""
    client, tmp_path = api_context
    project_dir = tmp_path / "prefix_project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    import base64
    png = base64.b64encode(b"\x89PNG\r\n\x1a\nfake-image-bytes").decode()
    for prefix in ("../evil", "a" * 40, "a/b"):
        uploaded = await client.post(
            f"/api/fs/upload/image?project_id={project_id}",
            json={
                "filename": "shot.png",
                "prefix": prefix,
                "data_url": f"data:image/png;base64,{png}",
            },
        )
        assert uploaded.status_code == 400, prefix


@pytest.mark.anyio
async def test_upload_image_without_project_uses_global_uploads(api_context, monkeypatch):
    """No-project uploads (flow templates) land in ~/.workstep/data/uploads."""
    import api.fs as fs_api

    client, tmp_path = api_context
    monkeypatch.setattr(fs_api, "CONFIG_DIR", tmp_path / "global-workstep")

    import base64
    png = base64.b64encode(b"\x89PNG\r\n\x1a\nglobal-upload").decode()
    uploaded = await client.post(
        "/api/fs/upload/image?project_id=",
        json={"filename": "shot.png", "data_url": f"data:image/png;base64,{png}"},
    )
    assert uploaded.status_code == 200
    body = uploaded.json()
    filename = body["filename"]
    assert body["url"] == f"data/uploads/{filename}"
    assert (
        tmp_path / "global-workstep" / "data" / "uploads" / filename
    ).is_file()

    # Preview without a project_id: the path MarkdownMessage renders.
    served = await client.get(f"/api/fs/serve/{filename}")
    assert served.status_code == 200
    assert served.content == b"\x89PNG\r\n\x1a\nglobal-upload"


@pytest.mark.anyio
async def test_upload_served_via_unicode_project_relative_url(api_context):
    """Chinese project names in the relative URL decode and serve correctly."""
    client, tmp_path = api_context
    project_dir = tmp_path / "测试项目"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    import base64
    png = base64.b64encode(b"\x89PNG\r\n\x1a\nchinese-name").decode()
    uploaded = await client.post(
        f"/api/fs/upload/image?project_id={project_id}",
        json={"filename": "shot.png", "data_url": f"data:image/png;base64,{png}"},
    )
    assert uploaded.status_code == 200
    filename = uploaded.json()["filename"]

    via_name = await client.get(f"/测试项目/.workstep/uploads/{filename}")
    assert via_name.status_code == 200
    assert via_name.content == b"\x89PNG\r\n\x1a\nchinese-name"

    # Unknown project name → 404
    missing = await client.get(f"/不存在项目/.workstep/uploads/{filename}")
    assert missing.status_code == 404


@pytest.mark.anyio
async def test_default_workflow_can_be_saved_and_reloaded(api_context):
    """The workflow offered by the UI is accepted by the project save contract."""
    client, tmp_path = api_context
    project_dir = tmp_path / "workflow-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    default_response = await client.get("/api/project/default-steps")
    assert default_response.status_code == 200
    default_workflow = default_response.json()

    saved = await client.post(
        f"/api/project/save-steps?project_id={project_id}",
        json={"steps": default_workflow},
    )
    assert saved.status_code == 200
    assert saved.json()["saved"] is True

    listed = await client.get("/api/project/list")
    assert listed.json()["projects"][0]["steps"] == default_workflow


@pytest.mark.anyio
async def test_task_http_crud_lifecycle(api_context):
    """Tasks can be created, retrieved, paused, copied and deleted over HTTP."""
    client, tmp_path = api_context
    project_dir = tmp_path / "task-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "HTTP task",
            "description": "created through the public contract",
            "cwd": str(project_dir),
            "engine": "claude",
        },
    )
    assert created.status_code == 200
    task_id = created.json()["id"]

    fetched = await client.get(
        f"/api/task/{task_id}?project_id={project_id}"
    )
    assert fetched.status_code == 200
    assert fetched.json()["description"] == "created through the public contract"
    assert fetched.json()["steps"]
    assert all(step["status"] == "pending" for step in fetched.json()["steps"])
    assert fetched.json()["steps"][0]["step_key"] == "req"

    updated = await client.patch(
        f"/api/task/{task_id}?project_id={project_id}",
        json={"description": "updated while the task is active"},
    )
    assert updated.status_code == 200
    assert updated.json()["description"] == "updated while the task is active"

    listed = await client.get(f"/api/task/list?project_id={project_id}")
    assert [task["id"] for task in listed.json()["tasks"]] == [task_id]

    paused = await client.post(
        f"/api/task/pause?project_id={project_id}",
        json={"task_id": task_id},
    )
    assert paused.status_code == 200
    assert paused.json() == {"paused": True}

    copied = await client.post(
        f"/api/task/copy?project_id={project_id}",
        json={"task_id": task_id, "newTitle": "HTTP task copy"},
    )
    assert copied.status_code == 200
    copied_id = copied.json()["id"]

    deleted = await client.request(
        "DELETE",
        f"/api/task/delete?project_id={project_id}",
        json={"task_id": copied_id},
    )
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True}

    missing = await client.get(
        f"/api/task/{copied_id}?project_id={project_id}"
    )
    assert missing.status_code == 404


@pytest.mark.anyio
async def test_task_archive_contract(api_context):
    """Archive hides a task from the board list and restores it on demand."""
    client, tmp_path = api_context
    project_dir = tmp_path / "archive-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={"title": "Archivable", "cwd": str(project_dir), "engine": "claude"},
    )
    assert created.status_code == 200
    task_id = created.json()["id"]
    assert created.json()["archived"] is False

    archived = await client.post(
        f"/api/task/archive?project_id={project_id}",
        json={"task_id": task_id},
    )
    assert archived.status_code == 200
    assert archived.json() == {"archived": True}

    listed = await client.get(f"/api/task/list?project_id={project_id}")
    assert listed.status_code == 200
    assert listed.json()["tasks"] == []

    archived_list = await client.get(
        f"/api/task/list?project_id={project_id}&archived=true"
    )
    assert archived_list.status_code == 200
    assert [task["id"] for task in archived_list.json()["tasks"]] == [task_id]
    assert archived_list.json()["tasks"][0]["archived"] is True

    restored = await client.post(
        f"/api/task/unarchive?project_id={project_id}",
        json={"task_id": task_id},
    )
    assert restored.status_code == 200
    assert restored.json() == {"unarchived": True}

    listed_again = await client.get(f"/api/task/list?project_id={project_id}")
    assert [task["id"] for task in listed_again.json()["tasks"]] == [task_id]


@pytest.mark.anyio
async def test_task_search_filters_the_requested_project(api_context):
    """Search returns matching tasks from the explicitly selected project."""
    client, tmp_path = api_context
    project_dir = tmp_path / "search-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    for title in ("Find this task", "Ignore this task"):
        response = await client.post(
            f"/api/task/create?project_id={project_id}",
            json={"title": title, "cwd": str(project_dir), "engine": "claude"},
        )
        assert response.status_code == 200

    searched = await client.get(
        "/api/search/tasks",
        params={"projectId": project_id, "query": "Find"},
    )

    assert searched.status_code == 200
    assert [task["title"] for task in searched.json()["tasks"]] == [
        "Find this task"
    ]
    assert searched.json()["total"] == 1


@pytest.mark.anyio
async def test_global_task_search_merges_projects_and_counts_before_pagination(api_context):
    """Global search spans project databases and reports the unpaged total."""
    client, tmp_path = api_context

    for project_index, titles in enumerate(
        (("Shared alpha", "Shared beta"), ("Shared gamma",)),
        start=1,
    ):
        project_dir = tmp_path / f"search-all-{project_index}"
        project_dir.mkdir()
        initialized = await client.post(
            "/api/project/init",
            json={"path": str(project_dir)},
        )
        project_id = initialized.json()["id"]
        for title in titles:
            created = await client.post(
                f"/api/task/create?project_id={project_id}",
                json={"title": title, "cwd": str(project_dir), "engine": "codex"},
            )
            assert created.status_code == 200

    searched = await client.get(
        "/api/search/tasks",
        params={"query": "Shared", "limit": 1},
    )

    assert searched.status_code == 200
    assert len(searched.json()["tasks"]) == 1
    assert searched.json()["total"] == 3


@pytest.mark.anyio
async def test_session_list_returns_tasks_from_the_requested_project(api_context):
    """Project session history exposes the project's tasks newest first."""
    client, tmp_path = api_context
    project_dir = tmp_path / "session-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Visible session",
            "cwd": str(project_dir),
            "engine": "claude",
        },
    )
    task_id = created.json()["id"]

    sessions = await client.get(
        "/api/sessions",
        params={"project_id": project_id},
    )

    assert sessions.status_code == 200
    assert [session["id"] for session in sessions.json()["sessions"]] == [
        task_id
    ]


@pytest.mark.anyio
async def test_session_list_without_filter_combines_registered_projects(api_context):
    """The global history view includes sessions from every registered project."""
    client, tmp_path = api_context
    expected_ids = []

    for index in (1, 2):
        project_dir = tmp_path / f"session-project-{index}"
        project_dir.mkdir()
        initialized = await client.post(
            "/api/project/init",
            json={"path": str(project_dir)},
        )
        project_id = initialized.json()["id"]
        created = await client.post(
            f"/api/task/create?project_id={project_id}",
            json={
                "title": f"Project {index} session",
                "cwd": str(project_dir),
                "engine": "claude",
            },
        )
        expected_ids.append(created.json()["id"])

    sessions = await client.get("/api/sessions")

    assert sessions.status_code == 200
    assert {session["id"] for session in sessions.json()["sessions"]} == set(
        expected_ids
    )


@pytest.mark.anyio
async def test_engine_list_matches_the_frontend_contract(api_context):
    """The engine picker can discover installed and unavailable backends."""
    client, _ = api_context

    response = await client.get("/api/engine/list")

    assert response.status_code == 200
    engines = response.json()["engines"]
    assert {engine["id"] for engine in engines} == {
        "claude",
        "codex",
        "hermes",
        "qoder_sdk",
        "openclaw",
        "pydantic_ai",
        "claude_agent_sdk",
            "codex_sdk",
            "deepseek_harness",
        }
    assert all("installed" in engine for engine in engines)


@pytest.mark.anyio
async def test_engine_refresh_rescans_before_returning_results(
    api_context,
    monkeypatch,
):
    client, _ = api_context
    import api.engine as engine_api

    rescanned = False

    def refresh():
        nonlocal rescanned
        rescanned = True

    monkeypatch.setattr(engine_api, "refresh_registry", refresh)

    response = await client.post("/api/engine/refresh")

    assert response.status_code == 200
    assert rescanned is True
    assert "engines" in response.json()


@pytest.mark.anyio
async def test_engine_test_runs_a_minimal_prompt(api_context, monkeypatch):
    client, _ = api_context
    import api.engine as engine_api
    from engines.core.base import EngineTestResult

    class FakeEngine:
        tested = False

        async def test_connection(self, cwd, timeout_seconds):
            self.tested = True
            return EngineTestResult(True, "连接和对话测试通过", 12)

    fake = FakeEngine()
    monkeypatch.setattr(engine_api, "refresh_registry", lambda **kwargs: None)
    monkeypatch.setattr(engine_api, "create_engine", lambda engine_id: fake)

    response = await client.post(
        "/api/engine/test",
        json={"engine_id": "claude", "timeout_seconds": 3},
    )

    assert response.status_code == 200
    result = response.json()
    assert result["success"] is True
    assert result["message"] == "连接和对话测试通过"
    assert result["duration_ms"] == 12
    assert fake.tested is True


@pytest.mark.anyio
async def test_engine_test_reports_unavailable_engine(api_context, monkeypatch):
    client, _ = api_context
    import api.engine as engine_api

    monkeypatch.setattr(engine_api, "refresh_registry", lambda **kwargs: None)
    monkeypatch.setattr(engine_api, "create_engine", lambda engine_id: None)

    response = await client.post(
        "/api/engine/test",
        json={"engine_id": "missing"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "engine_id": "missing",
        "success": False,
        "message": "引擎未安装或当前不可用",
        "duration_ms": 0,
    }


@pytest.mark.anyio
async def test_engine_models_delegate_to_the_adapter(api_context, monkeypatch):
    client, _ = api_context
    import api.engine as engine_api
    from engines.core.base import EngineModel

    class FakeEngine:
        async def list_models(self, cwd):
            return [
                EngineModel("fast", "Fast"),
                EngineModel("smart", "Smart", "Best quality"),
            ]

    monkeypatch.setattr(engine_api, "refresh_registry", lambda **kwargs: None)
    monkeypatch.setattr(engine_api, "create_engine", lambda engine_id: FakeEngine())
    monkeypatch.setattr(
        engine_api.config_store,
        "get_engine_default_model",
        lambda engine_id: "smart",
    )

    response = await client.get("/api/engine/claude/models")

    assert response.status_code == 200
    result = response.json()
    assert result["default_model"] == "smart"
    assert result["models"][1] == {
        "id": "smart",
        "label": "Smart",
        "description": "Best quality",
    }


@pytest.mark.anyio
async def test_engine_default_model_can_be_saved(api_context, monkeypatch):
    client, _ = api_context
    import api.engine as engine_api

    saved = {}
    monkeypatch.setattr(engine_api, "refresh_registry", lambda **kwargs: None)
    monkeypatch.setattr(engine_api, "create_engine", lambda engine_id: object())
    monkeypatch.setattr(
        engine_api.config_store,
        "set_engine_default_model",
        lambda engine_id, model: saved.update({engine_id: model}),
    )

    response = await client.put(
        "/api/engine/claude/default-model",
        json={"model": "sonnet"},
    )

    assert response.status_code == 200
    assert response.json()["saved"] is True
    assert saved == {"claude": "sonnet"}


@pytest.mark.anyio
async def test_claude_permission_mode_requires_dangerous_confirmation(
    api_context,
    monkeypatch,
):
    client, _ = api_context
    import engines.claude_code as claude_code_module

    saved = []
    current = {"mode": "dontAsk"}
    monkeypatch.setattr(
        claude_code_module.config_store,
        "get_claude_permission_mode",
        lambda: current["mode"],
    )
    monkeypatch.setattr(
        claude_code_module.config_store,
        "set_claude_permission_mode",
        lambda mode: (current.update(mode=mode), saved.append(mode)),
    )

    rejected = await client.put(
        "/api/engine/claude/config",
        json={
            "values": {"permission_mode": "bypassPermissions"},
            "confirmed": {},
        },
    )
    accepted = await client.put(
        "/api/engine/claude/config",
        json={
            "values": {"permission_mode": "bypassPermissions"},
            "confirmed": {"permission_mode": True},
        },
    )

    assert rejected.status_code == 200
    assert rejected.json()["saved"] is False
    assert saved == ["bypassPermissions"]
    assert accepted.json()["saved"] is True
    assert accepted.json()["values"] == {
        "provider_id": "",
        "permission_mode": "bypassPermissions",
    }


@pytest.mark.anyio
async def test_claude_permission_mode_can_be_read(api_context, monkeypatch):
    client, _ = api_context
    import engines.claude_code as claude_code_module

    monkeypatch.setattr(
        claude_code_module.config_store,
        "get_claude_permission_mode",
        lambda: "acceptEdits",
    )

    response = await client.get("/api/engine/claude/config")

    assert response.status_code == 200
    body = response.json()
    assert body["values"]["permission_mode"] == "acceptEdits"
    permission_field = next(
        field for field in body["fields"] if field["key"] == "permission_mode"
    )
    assert "bypassPermissions" in [
        option["value"] for option in permission_field["options"]
    ]


@pytest.mark.anyio
async def test_engine_binary_path_can_be_saved_and_rescanned(
    api_context,
    monkeypatch,
    tmp_path,
):
    client, _ = api_context
    import api.engine as engine_api

    binary = tmp_path / "custom-claude"
    binary.write_text("#!/bin/sh\n")
    saved = {}
    rescanned = False
    engine_info = {
        "id": "claude",
        "installed": True,
        "version": "custom",
        "mode": "cli",
        "supports_resume": True,
        "binary_path": str(binary),
        "configured_path": str(binary),
    }

    monkeypatch.setattr(
        engine_api,
        "get_available_engines",
        lambda: [engine_info],
    )
    monkeypatch.setattr(
        engine_api.config_store,
        "set_engine_binary_path",
        lambda engine_id, path: saved.update({engine_id: path}),
    )

    def refresh():
        nonlocal rescanned
        rescanned = True

    monkeypatch.setattr(engine_api, "refresh_registry", refresh)

    response = await client.put(
        "/api/engine/claude/binary-path",
        json={"path": str(binary)},
    )

    assert response.status_code == 200
    assert response.json()["saved"] is True
    assert saved == {"claude": str(binary.resolve())}
    assert rescanned is True


@pytest.mark.anyio
async def test_engine_binary_path_rejects_missing_files(
    api_context,
    monkeypatch,
    tmp_path,
):
    client, _ = api_context
    import api.engine as engine_api

    monkeypatch.setattr(
        engine_api,
        "get_available_engines",
        lambda: [{"id": "claude"}],
    )

    response = await client.put(
        "/api/engine/claude/binary-path",
        json={"path": str(tmp_path / "missing-cli")},
    )

    assert response.status_code == 200
    assert response.json()["saved"] is False
    assert response.json()["message"] == "指定的可执行文件不存在"


def test_ensure_global_templates_seeds_without_overwrite(tmp_path, monkeypatch):
    """Startup seeding copies shipped templates but never overwrites files."""
    import api.templates as templates_api

    src = tmp_path / "shipped"
    dst = tmp_path / "global"
    src.mkdir()
    (src / "default-flow.json").write_text(json.dumps({
        "id": "default-flow",
        "name": "Default",
        "default": True,
        "steps": {"nodes": [], "connections": []},
    }))
    (src / "user-flow.json").write_text(json.dumps({
        "id": "user-flow",
        "name": "User",
        "steps": {"nodes": [], "connections": []},
    }))
    # Existing global file with user edits must survive
    dst.mkdir(parents=True)
    (dst / "default-flow.json").write_text(json.dumps({
        "id": "default-flow",
        "name": "Default (edited)",
        "default": True,
        "steps": {"nodes": [], "connections": []},
    }))

    monkeypatch.setattr(templates_api, "TEMPLATES_DIR", src)
    monkeypatch.setattr(templates_api, "GLOBAL_TEMPLATES_DIR", dst)
    templates_api.ensure_global_templates()

    kept = json.loads((dst / "default-flow.json").read_text())
    assert kept["name"] == "Default (edited)"  # 同名不覆盖
    copied = json.loads((dst / "user-flow.json").read_text())
    assert copied["id"] == "user-flow"


@pytest.mark.anyio
async def test_custom_template_http_lifecycle_validates_id_and_workflow(api_context):
    """Custom templates round-trip without allowing unsafe names or bad graphs."""
    client, tmp_path = api_context
    steps = await client.get("/api/project/default-steps")

    saved = await client.post(
        "/api/templates/save",
        json={
            "id": "my-template",
            "name": "My template",
            "description": "HTTP round trip",
            "steps": steps.json(),
        },
    )
    assert saved.status_code == 200

    fetched = await client.get("/api/templates/my-template")
    assert fetched.status_code == 200
    assert fetched.json()["steps"] == steps.json()

    listed = await client.get("/api/templates/list")
    assert any(
        item["id"] == "my-template" and item["custom"] is True and item["default"] is False
        for item in listed.json()["templates"]
    )

    # Templates shipping with a default flag are exposed as default templates
    shipped_dir = tmp_path / "templates"
    shipped_dir.mkdir(parents=True, exist_ok=True)
    (shipped_dir / "shipped.json").write_text(json.dumps({
        "id": "shipped",
        "name": "Shipped default",
        "description": "",
        "default": True,
        "steps": steps.json(),
    }))
    listed_with_default = await client.get("/api/templates/list")
    assert any(
        item["id"] == "shipped" and item["default"] is True and item["custom"] is True
        for item in listed_with_default.json()["templates"]
    )

    unsafe = await client.post(
        "/api/templates/save",
        json={
            "id": "../outside",
            "name": "Unsafe",
            "description": "",
            "steps": steps.json(),
        },
    )
    assert unsafe.status_code == 422

    invalid = await client.post(
        "/api/templates/save",
        json={
            "id": "bad-graph",
            "name": "Bad graph",
            "description": "",
            "steps": {
                "nodes": [
                    {
                        "id": "one",
                        "title": "One",
                        "engine": "codex",
                        "inputs": [],
                        "outputs": [],
                    }
                ],
                "connections": [
                    {"from": "one", "fromPort": 0, "to": "missing", "toPort": 0}
                ],
            },
        },
    )
    assert invalid.status_code == 422

    # Default (shipped) templates cannot be deleted
    (tmp_path / "templates" / "shipped-default.json").write_text(json.dumps({
        "id": "shipped-default",
        "name": "Shipped default",
        "description": "",
        "default": True,
        "steps": steps.json(),
    }))
    locked_delete = await client.delete("/api/templates/shipped-default")
    assert locked_delete.status_code == 400

    missing_delete = await client.delete("/api/templates/dev-workflow")
    assert missing_delete.status_code == 404

    deleted = await client.delete("/api/templates/my-template")
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True, "id": "my-template"}

    gone = await client.get("/api/templates/my-template")
    assert gone.status_code == 404


@pytest.mark.anyio
async def test_task_artifacts_are_listed_with_manifest_metadata(api_context):
    client, tmp_path = api_context
    project_dir = tmp_path / "artifact-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={"title": "Artifact task", "cwd": str(project_dir)},
    )
    task_id = created.json()["id"]

    artifact_dir = project_dir / ".workstep" / "artifacts" / "default" / task_id / "req"
    artifact_dir.mkdir(parents=True)
    (artifact_dir / "prd.md").write_text("# Product requirements")
    (artifact_dir / "manifest.json").write_text(json.dumps({
        "artifacts": [
            {"name": "PRD 文档", "type": "Markdown", "path": "prd.md"},
        ],
    }))

    response = await client.get(
        f"/api/task/{task_id}/artifacts",
        params={"project_id": project_id},
    )
    assert response.status_code == 200
    assert response.json()["artifacts"] == [{
        "step_key": "req",
        "name": "prd.md",
        "logical_name": "PRD 文档",
        "artifact_type": "Markdown",
        "path": str((artifact_dir / "prd.md").resolve()),
        "relative_path": "prd.md",
        "size": 22,
        "is_dir": False,
    }]


@pytest.mark.anyio
async def test_task_artifacts_include_directories_with_manifest_metadata(api_context):
    client, tmp_path = api_context
    project_dir = tmp_path / "artifact-dir-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={"title": "Directory artifact task", "cwd": str(project_dir)},
    )
    task_id = created.json()["id"]

    artifact_dir = project_dir / ".workstep" / "artifacts" / "default" / task_id / "req"
    artifact_dir.mkdir(parents=True)
    (artifact_dir / "prd.md").write_text("# PRD")
    (artifact_dir / "docs").mkdir()
    (artifact_dir / "docs" / "index.html").write_text("<h1>Docs</h1>")
    (artifact_dir / "docs" / "guide").mkdir()
    (artifact_dir / "docs" / "guide" / "intro.md").write_text("# Intro")
    (artifact_dir / ".hidden").mkdir()
    (artifact_dir / "manifest.json").write_text(json.dumps({
        "artifacts": [
            {"name": "PRD 文档", "type": "Markdown", "path": "prd.md"},
            {"name": "文档目录", "type": "Directory", "path": "docs"},
        ],
    }))

    response = await client.get(
        f"/api/task/{task_id}/artifacts",
        params={"project_id": project_id},
    )
    assert response.status_code == 200
    artifacts = response.json()["artifacts"]
    by_path = {item["path"]: item for item in artifacts}

    docs = by_path[str((artifact_dir / "docs").resolve())]
    assert docs["name"] == "docs"
    assert docs["logical_name"] == "文档目录"
    assert docs["artifact_type"] == "Directory"
    assert docs["relative_path"] == "docs/"
    assert docs["size"] is None
    assert docs["is_dir"] is True

    prd = by_path[str((artifact_dir / "prd.md").resolve())]
    assert prd["is_dir"] is False

    # Only the declared directory appears as a directory artifact; nested and
    # hidden directories stay browsable via the fs API instead.
    directories = [item for item in artifacts if item["is_dir"]]
    assert [item["relative_path"] for item in directories] == ["docs/"]
    assert not any(item["name"] == ".hidden" for item in artifacts)


@pytest.mark.anyio
async def test_file_browser_and_preview_cover_text_image_binary_and_size_limit(
    api_context,
):
    """The artifact browser returns safe, bounded preview representations."""
    client, tmp_path = api_context
    visible_dir = tmp_path / "visible"
    visible_dir.mkdir()
    hidden_file = tmp_path / ".secret"
    hidden_file.write_text("hidden")
    text_file = tmp_path / "notes.md"
    text_file.write_text("# WorkStep")
    image_file = tmp_path / "pixel.png"
    image_file.write_bytes(
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
    )
    binary_file = tmp_path / "payload.bin"
    binary_file.write_bytes(b"\xff\xfe\x00\x01")
    large_file = tmp_path / "large.txt"
    large_file.write_bytes(b"x" * (1024 * 1024 + 1))

    browsed = await client.get("/api/fs/browse", params={"path": str(tmp_path)})
    assert browsed.status_code == 200
    names = {entry["name"] for entry in browsed.json()["entries"]}
    assert "visible" in names
    assert "notes.md" in names
    assert ".secret" not in names

    text_preview = await client.get(
        "/api/fs/preview", params={"path": str(text_file)}
    )
    assert text_preview.json()["type"] == "text"
    assert text_preview.json()["content"] == "# WorkStep"

    image_preview = await client.get(
        "/api/fs/preview", params={"path": str(image_file)}
    )
    assert image_preview.json()["type"] == "image"
    assert image_preview.json()["content"].startswith("data:image/png;base64,")

    binary_preview = await client.get(
        "/api/fs/preview", params={"path": str(binary_file)}
    )
    assert binary_preview.json()["type"] == "binary"

    too_large = await client.get(
        "/api/fs/preview", params={"path": str(large_file)}
    )
    assert too_large.status_code == 413


@pytest.mark.anyio
async def test_file_endpoint_serves_raw_html_for_browser_preview(api_context):
    client, tmp_path = api_context
    html_file = tmp_path / "page.html"
    html_file.write_text("<h1>Hello</h1>")

    response = await client.get(
        "/api/fs/file", params={"path": str(html_file)}
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "<h1>Hello</h1>" in response.text

    missing = await client.get(
        "/api/fs/file", params={"path": str(tmp_path / "nope.html")}
    )
    assert missing.status_code == 404

    directory = await client.get(
        "/api/fs/file", params={"path": str(tmp_path)}
    )
    assert directory.status_code == 400


@pytest.mark.anyio
async def test_raw_file_endpoint_mirrors_the_filesystem_path(api_context):
    client, tmp_path = api_context
    site_dir = tmp_path / "docs site"
    site_dir.mkdir()
    (site_dir / "index.html").write_text('<link rel="stylesheet" href="./style.css">')
    (site_dir / "style.css").write_text("body { color: red; }")

    # Path-based URL keeps relative assets inside HTML working.
    raw = await client.get(
        f"/api/fs/raw/{site_dir.resolve().as_posix().lstrip('/')}/index.html"
    )
    assert raw.status_code == 200
    assert raw.headers["content-type"].startswith("text/html")
    assert "style.css" in raw.text

    css = await client.get(
        f"/api/fs/raw/{site_dir.resolve().as_posix().lstrip('/')}/style.css"
    )
    assert css.status_code == 200
    assert css.headers["content-type"].startswith("text/css")
    assert "red" in css.text

    missing = await client.get(
        f"/api/fs/raw/{site_dir.resolve().as_posix().lstrip('/')}/nope.html"
    )
    assert missing.status_code == 404

    directory = await client.get(
        f"/api/fs/raw/{site_dir.resolve().as_posix().lstrip('/')}"
    )
    assert directory.status_code == 400


@pytest.mark.anyio
async def test_open_directory_uses_the_artifacts_parent(
    api_context,
    monkeypatch,
):
    client, tmp_path = api_context
    import api.fs as fs_api

    artifact = tmp_path / "prd.md"
    artifact.write_text("# PRD")
    opener = AsyncMock()
    monkeypatch.setattr(fs_api, "_open_directory", opener)

    response = await client.post(
        "/api/fs/open-directory",
        json={"path": str(artifact)},
    )
    assert response.status_code == 200
    assert response.json() == {
        "opened": True,
        "path": str(tmp_path.resolve()),
    }
    opener.assert_awaited_once_with(tmp_path.resolve())


@pytest.mark.anyio
async def test_open_directory_supports_a_selected_application(
    api_context,
    monkeypatch,
):
    client, tmp_path = api_context
    import api.fs as fs_api

    opener = AsyncMock()
    monkeypatch.setattr(fs_api, "_open_with", opener)

    response = await client.post(
        "/api/fs/open-directory",
        json={"path": str(tmp_path), "opener": "vscode"},
    )

    assert response.status_code == 200
    opener.assert_awaited_once_with(tmp_path.resolve(), "vscode")


@pytest.mark.anyio
async def test_directory_openers_expose_the_platform_file_manager(
    api_context,
):
    client, _ = api_context

    response = await client.get("/api/fs/directory-openers")

    assert response.status_code == 200
    file_manager = next(
        opener
        for opener in response.json()["openers"]
        if opener["id"] == "file_manager"
    )
    assert file_manager["available"] is True


@pytest.mark.anyio
async def test_step_history_binds_the_requested_project(api_context):
    """Step replay reads the task's project DB, not whichever DB was used last."""
    client, tmp_path = api_context
    import api.project as project_api
    from models import Message

    first_dir = tmp_path / "history-one"
    first_dir.mkdir()
    first = await client.post("/api/project/init", json={"path": str(first_dir)})
    first_id = first.json()["id"]
    created = await client.post(
        f"/api/task/create?project_id={first_id}",
        json={"title": "History", "cwd": str(first_dir), "engine": "codex"},
    )
    task_id = created.json()["id"]
    with project_api.project_manager.activate_project_by_id(first_id):
        Message.create(
            id=(legacy_message_id := str(uuid.uuid4())),
            task=task_id,
            step_key="do",
            role="assistant",
            content="persisted output",
            run_status="succeeded",
            events_json=json.dumps([{
                "type": "thinking_delta",
                "data": {"delta": "legacy thought"},
            }]),
            prompt_json=json.dumps({"prompt": "complete stage prompt"}),
            usage_json=json.dumps({"input_tokens": 12, "output_tokens": 3}),
            position=1,
            started_at=100,
            ended_at=284,
            created_at=int(time.time()),
        )

    second_dir = tmp_path / "history-two"
    second_dir.mkdir()
    await client.post("/api/project/init", json={"path": str(second_dir)})

    response = await client.get(
        f"/api/task/{task_id}/step/do/history",
        params={"project_id": first_id},
    )

    assert response.status_code == 200
    assert response.json()["messages"][0]["content"] == "persisted output"

    task_history = await client.get(
        f"/api/task/{task_id}/history",
        params={"project_id": first_id},
    )
    assert task_history.status_code == 200
    assert task_history.json()["messages"][0]["started_at"] == "1970-01-01T00:01:40+00:00"
    assert task_history.json()["messages"][0]["ended_at"] == "1970-01-01T00:04:44+00:00"
    assert task_history.json()["messages"][0]["prompt"] == "complete stage prompt"
    assert task_history.json()["messages"][0]["usage"] == {
        "input_tokens": 12,
        "output_tokens": 3,
    }

    legacy_events = await client.get(
        f"/api/task/{task_id}/messages/{legacy_message_id}/events",
        params={"project_id": first_id},
    )
    assert legacy_events.status_code == 200
    assert legacy_events.json()["events"][0]["type"] == "REASONING_MESSAGE_CHUNK"
    assert legacy_events.json()["events"][0]["delta"] == "legacy thought"


@pytest.mark.anyio
async def test_step_history_returns_jsonl_summary_without_detailed_thoughts(api_context):
    client, tmp_path = api_context
    import api.project as project_api
    from agent_assistants.event_journal import TurnEventJournal
    from models import Message

    project_dir = tmp_path / "journal-history"
    project_dir.mkdir()
    initialized = await client.post("/api/project/init", json={"path": str(project_dir)})
    project_id = initialized.json()["id"]
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={"title": "Journal history", "cwd": str(project_dir)},
    )
    task_id = created.json()["id"]
    project = project_api.project_manager.get_project_by_id(project_id)
    journal = TurnEventJournal()
    message_id = str(uuid.uuid4())
    ref = journal.start(project.workstep_dir, f"task-{task_id}", message_id)
    journal.record(ref, {
        "type": "agent_thought_chunk",
        "data": {"content": {"text": "不应进入历史摘要"}},
    })
    journal.record(ref, {
        "type": "agent_message_chunk",
        "data": {"content": {"text": "可见回复"}},
    })
    journal.finish(ref)
    snapshot = journal.snapshot(ref)
    with project_api.project_manager.activate_project_by_id(project_id):
        Message.create(
            id=message_id,
            task=task_id,
            step_key="do",
            role="assistant",
            content="",
            run_status="running",
            event_log_path=ref.relative_path,
            event_summary_json=json.dumps(snapshot["summary"]),
            event_count=snapshot["summary"]["event_count"],
            last_event_seq=snapshot["summary"]["last_event_seq"],
            position=1,
            created_at=int(time.time()),
        )

    response = await client.get(
        f"/api/task/{task_id}/step/do/history",
        params={"project_id": project_id},
    )

    assert response.status_code == 200
    message = response.json()["messages"][0]
    assert message["content"] == "可见回复"
    assert message["events"] == []
    assert message["event_detail"] == {
        "available": True,
        "loaded": False,
        "event_count": 2,
        "last_event_seq": 2,
        "thought_characters": 8,
        "tool_count": 0,
    }
    assert "不应进入历史摘要" not in response.text


@pytest.mark.anyio
async def test_task_message_events_pages_detailed_jsonl_timeline(api_context):
    client, tmp_path = api_context
    import api.project as project_api
    from agent_assistants.event_journal import TurnEventJournal
    from models import Message

    project_dir = tmp_path / "journal-detail"
    project_dir.mkdir()
    initialized = await client.post("/api/project/init", json={"path": str(project_dir)})
    project_id = initialized.json()["id"]
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={"title": "Journal detail", "cwd": str(project_dir)},
    )
    task_id = created.json()["id"]
    project = project_api.project_manager.get_project_by_id(project_id)
    journal = TurnEventJournal()
    message_id = str(uuid.uuid4())
    ref = journal.start(project.workstep_dir, f"task-{task_id}", message_id)
    journal.record(ref, {
        "type": "agent_thought_chunk",
        "data": {"content": {"text": "详细思考"}},
    })
    journal.record(ref, {
        "type": "agent_message_chunk",
        "data": {"content": {"text": "详细回复"}},
    })
    journal.finish(ref)
    with project_api.project_manager.activate_project_by_id(project_id):
        Message.create(
            id=message_id,
            task=task_id,
            step_key="do",
            channel="execution",
            role="assistant",
            content="详细回复",
            event_log_path=ref.relative_path,
            event_count=2,
            last_event_seq=2,
            position=1,
            created_at=int(time.time()),
        )

    first = await client.get(
        f"/api/task/{task_id}/messages/{message_id}/events",
        params={"project_id": project_id, "limit": 1},
    )
    assert first.status_code == 200
    page = first.json()
    assert page["event_count"] == 2
    assert page["next_cursor"] == 1
    assert page["events"][0]["type"] == "REASONING_MESSAGE_CHUNK"
    assert page["events"][0]["delta"] == "详细思考"

    second = await client.get(
        f"/api/task/{task_id}/messages/{message_id}/events",
        params={"project_id": project_id, "cursor": page["next_cursor"], "limit": 1},
    )
    assert second.status_code == 200
    assert second.json()["events"][0]["type"] == "TEXT_MESSAGE_CHUNK"
    assert second.json()["complete"] is True


@pytest.mark.anyio
async def test_intervention_http_round_trip(api_context):
    """A pending engine question can be discovered and answered over HTTP."""
    client, _ = api_context
    from services.intervention import intervention_manager

    waiter = asyncio.create_task(
        intervention_manager.request_response(
            "question-1",
            "task-1",
            "do",
            {"prompt": "Continue?"},
        )
    )
    await asyncio.sleep(0)

    pending = await client.get("/api/intervention/pending")
    assert pending.status_code == 200
    assert pending.json() == {"pending": ["question-1"]}

    responded = await client.post(
        "/api/intervention/respond",
        json={"intervention_id": "question-1", "data": {"answer": "yes"}},
    )
    assert responded.status_code == 200
    assert await waiter == {"answer": "yes"}

    duplicate = await client.post(
        "/api/intervention/respond",
        json={"intervention_id": "question-1", "data": {"answer": "again"}},
    )
    assert duplicate.status_code == 404


@pytest.mark.anyio
async def test_project_memory_read_write_roundtrip(api_context):
    """MEMORY.md can be read and overwritten through the fs API."""
    client, tmp_path = api_context
    project_dir = tmp_path / "memory-project"
    project_dir.mkdir()
    initialized = await client.post("/api/project/init", json={"path": str(project_dir)})
    assert initialized.status_code == 200
    project_id = initialized.json()["id"]

    empty = await client.get(f"/api/fs/memory?project_id={project_id}")
    assert empty.status_code == 200
    assert empty.json()["content"] == ""

    content = "# 项目记忆\n\n## goal\n完成教育局数据上报\n"
    saved = await client.put(
        f"/api/fs/memory?project_id={project_id}",
        json={"content": content},
    )
    assert saved.status_code == 200
    assert saved.json()["saved"] is True

    read = await client.get(f"/api/fs/memory?project_id={project_id}")
    assert read.status_code == 200
    assert read.json()["content"] == content
    assert (project_dir / ".workstep" / "MEMORY.md").is_file()


@pytest.mark.anyio
async def test_workflow_soft_delete_and_restore_via_api(api_context):
    """DELETE moves a workflow to the recycle bin; POST restore brings it back."""
    client, tmp_path = api_context
    project_dir = tmp_path / "restore-api-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    assert initialized.status_code == 200, initialized.text
    project_id = initialized.json()["id"]
    workflow = await client.post(
        f"/api/workflow/create?project_id={project_id}",
        json={"name": "Restorable"},
    )
    assert workflow.status_code == 200, workflow.text
    workflow_id = workflow.json()["id"]

    deleted = await client.delete(
        f"/api/workflow/{workflow_id}?project_id={project_id}",
    )
    assert deleted.status_code == 200
    assert deleted.json()["soft"] is True

    listed = await client.get("/api/workflow/list", params={"project_id": project_id})
    bin_workflow = next(w for w in listed.json()["workflows"] if w["id"] == workflow_id)
    assert bin_workflow["deleted"] is True

    restored = await client.post(
        f"/api/workflow/{workflow_id}/restore?project_id={project_id}",
    )
    assert restored.status_code == 200
    assert restored.json()["deleted"] is False

    listed = await client.get("/api/workflow/list", params={"project_id": project_id})
    active_workflow = next(w for w in listed.json()["workflows"] if w["id"] == workflow_id)
    assert active_workflow["deleted"] is False


class ScriptedStageEngine:
    """Deterministic stage engine that records every prompt it receives."""

    def __init__(self, prompts: list[str]):
        self.prompts = prompts

    @property
    def supports_resume(self):
        return False

    async def spawn(self, prompt, cwd, **kwargs):
        self.prompts.append(prompt)
        yield InternalEvent(type="agent_message_chunk", data={"content": {"text": "阶段执行完成"}})
        yield InternalEvent(type="usage_update", data={
            "input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 0,
        })

    async def stop(self):
        return None


class ScriptedReviewEngine:
    """Deterministic review agent driven by a queue of (passed, score, summary)."""

    def __init__(self, prompts: list[str], results: list[tuple[bool, int, str]]):
        self.prompts = prompts
        self.results = results

    @property
    def supports_resume(self):
        return False

    async def spawn(self, prompt, cwd, **kwargs):
        self.prompts.append(prompt)
        index = min(len(self.prompts) - 1, len(self.results) - 1)
        passed, score, summary = self.results[index]
        text = json.dumps({
            "passed": passed,
            "score": score,
            "summary": summary,
            "issues": [] if passed else [{
                "severity": "error",
                "category": "quality",
                "description": "缺少验收内容",
                "suggestion": "补充验收内容后重试",
            }],
        }, ensure_ascii=False)
        yield InternalEvent(type="agent_message_chunk", data={"content": {"text": text}})
        yield InternalEvent(type="usage_update", data={
            "input_tokens": 20, "output_tokens": 10, "cache_read_input_tokens": 0,
        })

    async def stop(self):
        return None


async def _wait_for_task_status(client, project_id, task_id, expected, timeout=20):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        response = await client.get(f"/api/task/{task_id}?project_id={project_id}")
        assert response.status_code == 200, response.text
        last = response.json()
        if last.get("status") in expected:
            return last
        await asyncio.sleep(0.05)
    raise AssertionError(f"task {task_id} did not reach {expected}: {last}")


@pytest.mark.anyio
async def test_review_flow_end_to_end_via_api(api_context):
    """整个审核流程：跳过审核 → 自动审核重试 → 人工审核 → 驳回注入反馈 → 通过。"""
    client, tmp_path = api_context
    project_dir = tmp_path / "review-flow-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init", json={"path": str(project_dir)}
    )
    assert initialized.status_code == 200, initialized.text
    project_id = initialized.json()["id"]

    workflow = await client.post(
        f"/api/workflow/create?project_id={project_id}",
        json={
            "name": "ReviewFlow",
            "steps": {
                "nodes": [
                    {
                        "id": "plan", "type": "plan", "title": "需求",
                        "engine": "stage-fake", "prompt": "编写需求文档",
                        "review": {"mode": "skip"},
                    },
                    {
                        "id": "build", "type": "build", "title": "实现",
                        "engine": "stage-fake", "prompt": "编写代码",
                        "review": {
                            "mode": "auto", "auto": True, "maxRetries": 1,
                            "engine": "review-fake", "prompt": "检查代码质量",
                        },
                    },
                    {
                        "id": "verify", "type": "verify", "title": "验收",
                        "engine": "stage-fake", "prompt": "执行验收",
                        "review": {"mode": "manual", "auto": False},
                    },
                ],
                "connections": [
                    {"from": "plan", "to": "build"},
                    {"from": "build", "to": "verify"},
                ],
            },
        },
    )
    assert workflow.status_code == 200, workflow.text
    workflow_id = workflow.json()["id"]

    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Review flow task",
            "cwd": str(project_dir),
            "workflow_id": workflow_id,
        },
    )
    assert created.status_code == 200, created.text
    task_id = created.json()["id"]

    stage_prompts: list[str] = []
    review_prompts: list[str] = []
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY.clear()
    ENGINE_REGISTRY["stage-fake"] = lambda: ScriptedStageEngine(stage_prompts)
    ENGINE_REGISTRY["review-fake"] = lambda: ScriptedReviewEngine(
        review_prompts,
        [
            (False, 60, "缺少验收内容"),
            (True, 95, "修复完成"),
        ],
    )
    try:
        started = await client.post(
            f"/api/task/run?project_id={project_id}",
            json={"task_id": task_id, "prompt": ""},
        )
        assert started.status_code == 200, started.text

        # 1) plan 跳过审核直接通过；build 自动审核第一次不通过后自动重跑并再次审核通过；
        #    verify 人工审核停在 awaiting_review。
        task = await _wait_for_task_status(
            client, project_id, task_id, {"ready", "paused"}
        )
        assert task["status"] == "paused"
        steps = {step["step_key"]: step["status"] for step in task["steps"]}
        assert steps == {
            "plan": "passed", "build": "passed", "verify": "awaiting_review",
        }
        # plan + build + build(自动审核不通过后重跑) + verify
        assert len(stage_prompts) == 4
        assert len(review_prompts) == 2

        reviews = (await client.get(
            f"/api/task/{task_id}/reviews?project_id={project_id}"
        )).json()["reviews"]
        build_reviews = [r for r in reviews if r["step_key"] == "build"]
        assert [r["mode"] for r in build_reviews] == ["auto", "auto"]
        assert [r["status"] for r in build_reviews] == ["passed", "rejected"]
        verify_reviews = [r for r in reviews if r["step_key"] == "verify"]
        assert len(verify_reviews) == 1
        assert verify_reviews[0]["mode"] == "manual"
        assert verify_reviews[0]["status"] == "pending"

        # 2) 人工审核不通过：带原因驳回 → 自动重跑 verify，下一次提示词包含驳回原因
        reject = await client.post(
            f"/api/task/{task_id}/steps/verify/review/reject?project_id={project_id}",
            json={
                "review_run_id": verify_reviews[0]["id"],
                "comment": "缺少验收记录",
            },
        )
        assert reject.status_code == 200, reject.text
        assert reject.json()["resumed"] is True
        task = await _wait_for_task_status(
            client, project_id, task_id, {"ready", "paused"}
        )
        assert task["status"] == "paused"
        assert len(stage_prompts) == 5
        assert "缺少验收记录" in stage_prompts[4]
        assert "人工审核反馈" in stage_prompts[4]

        # 3) 审核通过 → verify 完成，任务 ready
        reviews = (await client.get(
            f"/api/task/{task_id}/reviews?project_id={project_id}"
        )).json()["reviews"]
        verify_reviews = [r for r in reviews if r["step_key"] == "verify"]
        assert [r["status"] for r in verify_reviews] == ["pending", "rejected"]
        approve = await client.post(
            f"/api/task/{task_id}/steps/verify/review/approve?project_id={project_id}",
            json={"review_run_id": verify_reviews[0]["id"]},
        )
        assert approve.status_code == 200, approve.text
        task = await _wait_for_task_status(
            client, project_id, task_id, {"ready", "paused"}
        )
        assert task["status"] == "ready"
        steps = {step["step_key"]: step["status"] for step in task["steps"]}
        assert steps == {
            "plan": "passed", "build": "passed", "verify": "passed",
        }
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)


async def _create_workflow(client, project_id: str, name: str):
    response = await client.post(
        f"/api/workflow/create?project_id={project_id}",
        json={
            "name": name,
            "steps": {
                "nodes": [
                    {
                        "id": name,
                        "title": name,
                        "engine": "claude",
                        "inputs": [],
                        "outputs": [],
                    }
                ],
                "connections": [],
            },
        },
    )
    assert response.status_code == 200
    return response.json()["id"]


@pytest.mark.anyio
async def test_reorder_workflows_persists_new_order(api_context):
    """Reordering via the API is reflected in the list and survives reloads."""
    client, tmp_path = api_context
    project_dir = tmp_path / "reorder-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init", json={"path": str(project_dir)}
    )
    project_id = initialized.json()["id"]

    # Initial project seeds a default workflow; create two more.
    listed = await client.get(f"/api/workflow/list?project_id={project_id}")
    initial_ids = [w["id"] for w in listed.json()["workflows"]]
    extra_a = await _create_workflow(client, project_id, "FlowA")
    extra_b = await _create_workflow(client, project_id, "FlowB")
    original = initial_ids + [extra_a, extra_b]

    # New workflows land at the end of the list.
    listed = await client.get(f"/api/workflow/list?project_id={project_id}")
    assert [w["id"] for w in listed.json()["workflows"]] == original

    # Move the default workflow to the end.
    reordered = original[1:] + [original[0]]
    response = await client.post(
        f"/api/workflow/reorder?project_id={project_id}",
        json={"ordered_ids": reordered},
    )
    assert response.status_code == 200
    assert response.json()["ok"] is True

    listed = await client.get(f"/api/workflow/list?project_id={project_id}")
    assert [w["id"] for w in listed.json()["workflows"]] == reordered

    # Order survives re-opening the same project.
    reopened = await client.post(
        "/api/project/init", json={"path": str(project_dir)}
    )
    assert reopened.status_code == 200
    assert reopened.json()["id"] == project_id
    listed = await client.get(f"/api/workflow/list?project_id={project_id}")
    assert [w["id"] for w in listed.json()["workflows"]] == reordered


@pytest.mark.anyio
async def test_reorder_workflows_ignores_unknown_ids(api_context):
    """Unknown ids are skipped and the remaining order is applied."""
    client, tmp_path = api_context
    project_dir = tmp_path / "reorder-unknown"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init", json={"path": str(project_dir)}
    )
    project_id = initialized.json()["id"]
    listed = await client.get(f"/api/workflow/list?project_id={project_id}")
    ids = [w["id"] for w in listed.json()["workflows"]]

    response = await client.post(
        f"/api/workflow/reorder?project_id={project_id}",
        json={"ordered_ids": ["missing", ids[0]]},
    )
    assert response.status_code == 200
    listed = await client.get(f"/api/workflow/list?project_id={project_id}")
    assert [w["id"] for w in listed.json()["workflows"]] == ids


@pytest.mark.anyio
async def test_resume_stage_message_routes_to_runtime(api_context, monkeypatch):
    """停止后的阶段发送消息：持久化并触发从该阶段重新执行。"""
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "resume-stage-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    runtime = AsyncMock()
    runtime.resume_stage_with_message = AsyncMock(
        return_value={
            "message_id": "m-1",
            "step_key": "do",
            "run_id": "run-1",
            "status": "queued",
            "sequence": 3,
            "created_at": "2026-08-12T00:00:00+00:00",
        }
    )
    monkeypatch.setattr(main, "workflow_runtime", runtime)

    sent = await client.post(
        f"/api/task/task-1/step/do/resume?project_id={project_id}",
        json={"content": "请改用中文输出"},
    )
    assert sent.status_code == 200
    assert sent.json()["status"] == "queued"
    assert sent.json()["run_id"] == "run-1"
    runtime.resume_stage_with_message.assert_awaited_once_with(
        project_id,
        "task-1",
        "do",
        "请改用中文输出",
    )


@pytest.mark.anyio
async def test_resume_stage_message_conflict_when_stage_not_stopped(api_context, monkeypatch):
    """未停止的阶段发送消息重跑返回冲突。"""
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "resume-stage-conflict-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    runtime = AsyncMock()
    runtime.resume_stage_with_message = AsyncMock(
        side_effect=ValueError("阶段未停止: do（当前状态 running）")
    )
    monkeypatch.setattr(main, "workflow_runtime", runtime)

    sent = await client.post(
        f"/api/task/task-1/step/do/resume?project_id={project_id}",
        json={"content": "请改用中文输出"},
    )
    assert sent.status_code == 409
    assert "阶段未停止" in sent.json()["detail"]


# --- /api/fs/mkdir (project path picker) ---

@pytest.mark.anyio
async def test_fs_mkdir_creates_directory(api_context):
    client, tmp_path = api_context
    res = await client.post("/api/fs/mkdir", json={"parent": str(tmp_path), "name": "new-folder"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["name"] == "new-folder"
    assert (tmp_path / "new-folder").is_dir()
    assert body["path"] == str(tmp_path / "new-folder")


@pytest.mark.anyio
async def test_fs_mkdir_rejects_invalid_names(api_context):
    client, tmp_path = api_context
    for name in ["", " ", "a b", "a/b", "a\\b", ".", "..", ".hidden"]:
        res = await client.post("/api/fs/mkdir", json={"parent": str(tmp_path), "name": name})
        assert res.status_code == 400, f"name={name!r} -> {res.status_code}: {res.text}"


@pytest.mark.anyio
async def test_fs_mkdir_rejects_existing_target(api_context):
    client, tmp_path = api_context
    (tmp_path / "exists").mkdir()
    res = await client.post("/api/fs/mkdir", json={"parent": str(tmp_path), "name": "exists"})
    assert res.status_code == 409, res.text


@pytest.mark.anyio
async def test_fs_mkdir_missing_parent(api_context):
    client, tmp_path = api_context
    res = await client.post("/api/fs/mkdir", json={"parent": str(tmp_path / "nope"), "name": "x"})
    assert res.status_code == 404, res.text


@pytest.mark.anyio
async def test_fs_mkdir_parent_is_file(api_context):
    client, tmp_path = api_context
    file_path = tmp_path / "file.txt"
    file_path.write_text("hi")
    res = await client.post("/api/fs/mkdir", json={"parent": str(file_path), "name": "x"})
    assert res.status_code == 400, res.text
