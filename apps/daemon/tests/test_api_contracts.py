"""HTTP contract tests for user-visible daemon features."""

from contextlib import AsyncExitStack
import asyncio
import json
import time
import uuid
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from services.project import ProjectManager
from services.task import TaskService
from services.workflow_runtime import WorkflowRuntime
from streaming.bus import EventBus


class MemoryConfigStore:
    """In-memory project registry used at the filesystem boundary."""

    def __init__(self):
        self.values = {}

    def get(self, key, default=None):
        return self.values.get(key, default)

    def set(self, key, value):
        self.values[key] = value


@pytest.fixture
async def api_context(tmp_path, monkeypatch):
    """Run the real FastAPI routes against isolated project databases."""
    import api.history as history_api
    import api.project as project_api
    import api.search as search_api
    import api.templates as templates_api
    import main
    import services.project as project_service

    config_store = MemoryConfigStore()
    manager = ProjectManager()
    bus = EventBus()
    task_service = TaskService(bus)
    runtime = WorkflowRuntime(bus, manager)

    monkeypatch.setattr(project_service, "config_store", config_store)
    monkeypatch.setattr(project_api, "project_manager", manager)
    monkeypatch.setattr(history_api, "project_manager", manager)
    monkeypatch.setattr(search_api, "project_manager", manager)
    monkeypatch.setattr(templates_api, "TEMPLATES_DIR", tmp_path / "templates")
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "task_service", task_service)
    monkeypatch.setattr(main, "workflow_runtime", runtime)

    transport = ASGITransport(app=main.app)
    async with AsyncExitStack() as stack:
        client = await stack.enter_async_context(
            AsyncClient(transport=transport, base_url="http://test")
        )
        yield client, tmp_path

    await runtime.shutdown()
    await bus.close()
    manager.close_all()


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
        "qoder",
        "qcode",
        "openclaw",
        "api",
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
    from engines.base import EngineTestResult

    class FakeEngine:
        tested = False

        async def test_connection(self, cwd, timeout_seconds):
            self.tested = True
            return EngineTestResult(True, "连接和对话测试通过", 12)

    fake = FakeEngine()
    monkeypatch.setattr(engine_api, "refresh_registry", lambda: None)
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

    monkeypatch.setattr(engine_api, "refresh_registry", lambda: None)
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
    from engines.base import EngineModel

    class FakeEngine:
        async def list_models(self, cwd):
            return [
                EngineModel("fast", "Fast"),
                EngineModel("smart", "Smart", "Best quality"),
            ]

    monkeypatch.setattr(engine_api, "refresh_registry", lambda: None)
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
    monkeypatch.setattr(engine_api, "refresh_registry", lambda: None)
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


@pytest.mark.anyio
async def test_custom_template_http_lifecycle_validates_id_and_workflow(api_context):
    """Custom templates round-trip without allowing unsafe names or bad graphs."""
    client, _ = api_context
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
        item["id"] == "my-template" and item["custom"] is True
        for item in listed.json()["templates"]
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

    artifact_dir = project_dir / ".workstep" / "artifacts" / "req" / task_id
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
    }]


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
            id=str(uuid.uuid4()),
            task=task_id,
            step_key="do",
            role="assistant",
            content="persisted output",
            run_status="succeeded",
            events_json=json.dumps([{"type": "text_delta"}]),
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
    assert task_history.json()["messages"][0]["started_at"] == 100
    assert task_history.json()["messages"][0]["ended_at"] == 284


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
