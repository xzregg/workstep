"""HTTP contract tests for user-visible daemon features."""

from contextlib import AsyncExitStack
import asyncio
from datetime import datetime
import sqlite3
import subprocess
import threading
import time
import json
from pathlib import Path
import uuid
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from engines.core.events import InternalEvent
from engines.core.registry import ENGINE_REGISTRY
from services.project import ProjectManager
from services.schedule import ScheduleModule
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

    def get_engine_models(self, engine_id):
        return dict(self.values.get("engine_models", {}).get(engine_id, {}))

    def set_engine_models(self, engine_id, models, fetched_at):
        values = dict(self.values.get("engine_models", {}))
        values[engine_id] = {"models": list(models), "fetched_at": fetched_at}
        self.values["engine_models"] = values

    def clear_engine_models(self, engine_id):
        values = dict(self.values.get("engine_models", {}))
        values.pop(engine_id, None)
        self.values["engine_models"] = values

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
    schedule = ScheduleModule(manager, task_service, runtime)

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
    monkeypatch.setattr(main, "schedule_module", schedule)

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


async def _create_test_workflow(client, project_id):
    """Tests that execute tasks explicitly install their workflow fixture."""
    from services.project import DEFAULT_STEPS

    response = await client.post(
        f"/api/workflow/create?project_id={project_id}",
        json={"name": "测试流程", "steps": DEFAULT_STEPS},
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.anyio
async def test_slow_workflow_create_does_not_block_health(api_context, monkeypatch):
    """The workflow repository runs inside the project's database executor."""
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "slow-workflow-create"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init", json={"path": str(project_dir)}
    )
    assert initialized.status_code == 200
    project_id = initialized.json()["id"]

    service = main.project_manager._workflow_service
    original_create = service.create_workflow
    started = threading.Event()
    release = threading.Event()

    def slow_create(*args, **kwargs):
        started.set()
        release.wait(timeout=1)
        return original_create(*args, **kwargs)

    monkeypatch.setattr(service, "create_workflow", slow_create)
    started_at = time.perf_counter()
    create = asyncio.create_task(client.post(
        f"/api/workflow/create?project_id={project_id}",
        json={"name": "慢盘流程", "steps": {"nodes": [], "connections": []}},
    ))
    try:
        assert await asyncio.to_thread(started.wait, 1)
        assert not create.done()
        assert time.perf_counter() - started_at < 0.5
        health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
        assert health.status_code == 200
    finally:
        release.set()
        response = await create
    assert response.status_code == 200, response.text


@pytest.mark.anyio
async def test_task_detail_does_not_filter_steps_by_legacy_run_snapshot(api_context):
    """Task completion is based on the active run snapshot, not stale stages."""
    import main
    from models import Task, TaskStep, WorkflowRun
    from models.fields import utc_now

    client, tmp_path = api_context
    project_dir = tmp_path / "removed-stage-task"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]
    workflow_response = await client.post(
        f"/api/workflow/create?project_id={project_id}",
        json={
            "name": "可变流程",
            "steps": {
                "nodes": [
                    {"id": 1, "type": "build", "title": "构建"},
                    {"id": 2, "type": "deploy", "title": "上线"},
                ],
                "connections": [],
            },
        },
    )
    assert workflow_response.status_code == 200
    workflow_id = workflow_response.json()["id"]
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "已完成任务",
            "cwd": str(project_dir),
            "workflow_id": workflow_id,
            "auto_start": False,
        },
    )
    assert created.status_code == 200
    task_id = created.json()["id"]

    now = utc_now()
    with main.project_manager.activate_project_by_id(project_id):
        TaskStep.update(status="passed").where(
            (TaskStep.task == task_id) & (TaskStep.step_key == "build")
        ).execute()
        TaskStep.update(status="failed").where(
            (TaskStep.task == task_id) & (TaskStep.step_key == "deploy")
        ).execute()
        run = WorkflowRun.create(
            id="active-run-with-removed-stage",
            task=task_id,
            status="succeeded",
            workflow_schema_version=1,
            workflow_snapshot_json=json.dumps({"steps": [{"key": "build"}]}),
            started_at=now,
            ended_at=now,
        )
        Task.update(
            status="ready",
            active_workflow_run_id=run.id,
        ).where(Task.id == task_id).execute()

    response = await client.get(
        f"/api/task/{task_id}",
        params={"project_id": project_id},
    )

    assert response.status_code == 200
    assert "workflow_snapshot" not in response.json()
    assert [(step["step_key"], step["status"]) for step in response.json()["steps"]] == [
        ("build", "passed"),
        ("deploy", "failed"),
    ]


@pytest.mark.anyio
@pytest.mark.parametrize("endpoint", ["init", "register"])
async def test_new_project_stays_empty_after_reopening(api_context, endpoint):
    client, tmp_path = api_context
    path = str(tmp_path / "blank-project")
    response = await client.post("/api/project/init", json={"path": path})
    assert response.status_code == 200
    project = response.json()
    assert project["workflows"] == []
    assert project["steps"] == {}
    await client.delete(f"/api/project/{project['id']}")
    reopened = await client.post(f"/api/project/{endpoint}", json={"path": path})
    assert reopened.status_code == 200
    assert reopened.json()["workflows"] == []
    assert reopened.json()["steps"] == {}


@pytest.mark.anyio
@pytest.mark.parametrize("endpoint", ["init", "register"])
@pytest.mark.parametrize("legacy", [False, True])
async def test_reopen_project_restores_sessions_and_workflows(api_context, monkeypatch, endpoint, legacy):
    import main
    from agent_assistants.chat_session import ChatSessionModule
    from models.chat_session import ChatSession, ChatMessage

    client, tmp_path = api_context
    manager = main.project_manager
    module = ChatSessionModule(EventBus(), manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    path = tmp_path / "reopened"
    opened = await client.post("/api/project/init", json={"path": str(path)})
    pid = opened.json()["id"]

    def seed(project):
        workflow = manager.create_workflow(project, "旧流程", {"nodes": [], "connections": []})
        ChatSession.create(id="old-session", project_id=pid, workflow_id=workflow["id"],
                           title="旧会话", engine="codex", created_at=1, updated_at=1)
        ChatMessage.create(id="old-message", session="old-session", role="assistant",
                           content="以前的内容", created_at=1)
        return workflow["id"]

    workflow_id = await manager.run_db(pid, seed)
    assert (await client.delete(f"/api/project/{pid}")).status_code == 200
    # Old workspaces predate local identity metadata.
    if legacy:
        (path / ".workstep" / "project.json").unlink(missing_ok=True)
    reopened = await client.post(f"/api/project/{endpoint}", json={"path": str(path)})
    assert reopened.status_code == 200
    restored = reopened.json()
    sessions = await client.get("/api/chat-sessions", params={"project_id": restored["id"]})
    assert [s["id"] for s in sessions.json()["sessions"]] == ["old-session"]
    history = await client.get("/api/chat-sessions/old-session", params={"project_id": restored["id"]})
    assert history.json()["messages"][0]["content"] == "以前的内容"
    assert workflow_id in [w["id"] for w in restored["workflows"]]
    assert restored["id"] == pid
    await module.shutdown()


@pytest.mark.anyio
async def test_chat_history_with_multiple_old_project_ids_stays_project_local(api_context, monkeypatch):
    import main
    from agent_assistants.chat_session import ChatSessionModule
    from models.chat_session import ChatSession, ChatMessage

    client, tmp_path = api_context
    manager = main.project_manager
    module = ChatSessionModule(EventBus(), manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    project = (await client.post("/api/project/init", json={"path": str(tmp_path / "sales")})).json()
    other = (await client.post("/api/project/init", json={"path": str(tmp_path / "other")})).json()

    def seed(_project):
        for index, old_id in enumerate(["old-desktop", "old-container"]):
            ChatSession.create(id=f"old-{index}", project_id=old_id, workflow_id="",
                               title="旧会话", engine="codex", created_at=1, updated_at=1)
            ChatMessage.create(id=f"message-{index}", session=f"old-{index}", role="assistant",
                               content=f"历史内容{index}", created_at=1)

    await manager.run_db(project["id"], seed)
    params = {"project_id": project["id"]}
    listed = await client.get("/api/chat-sessions", params=params)
    assert {s["id"] for s in listed.json()["sessions"]} == {"old-0", "old-1"}
    assert {s["project_id"] for s in listed.json()["sessions"]} == {project["id"]}
    for index in range(2):
        history = await client.get(f"/api/chat-sessions/old-{index}", params=params)
        assert history.json()["project_id"] == project["id"]
        assert history.json()["messages"][0]["content"] == f"历史内容{index}"
        events = await client.get(f"/api/chat-sessions/old-{index}/messages/message-{index}/events", params=params)
        assert events.status_code == 200
    other_params = {"project_id": other["id"]}
    assert (await client.get("/api/chat-sessions", params=other_params)).json()["sessions"] == []
    assert (await client.get("/api/chat-sessions/old-0", params=other_params)).status_code == 404
    assert (await client.get("/api/chat-sessions/old-0/messages/message-0/events", params=other_params)).status_code == 404
    await module.shutdown()


@pytest.mark.anyio
async def test_reopen_project_slow_sql_does_not_block_health(api_context, monkeypatch):
    import peewee

    client, tmp_path = api_context
    path = tmp_path / "slow-reopen"
    opened = await client.post("/api/project/init", json={"path": str(path)})
    await client.delete(f"/api/project/{opened.json()['id']}")
    (path / ".workstep" / "project.json").unlink()
    started = threading.Event()
    release = threading.Event()
    original = peewee.SqliteDatabase.execute_sql

    def slow_query(db, sql, *args, **kwargs):
        if sql.startswith("SELECT") and '"chat_sessions"' in sql:
            started.set()
            assert release.wait(2)
        return original(db, sql, *args, **kwargs)

    monkeypatch.setattr(peewee.SqliteDatabase, "execute_sql", slow_query)
    reopening = asyncio.create_task(client.post("/api/project/init", json={"path": str(path)}))
    try:
        assert await asyncio.to_thread(started.wait, 1)
        health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
        assert health.status_code == 200
        assert not reopening.done()
    finally:
        release.set()
        response = await reopening
    assert response.status_code == 200


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
async def test_managed_task_creation_uses_live_signed_policy(api_context, monkeypatch):
    from dataclasses import replace
    from time import time
    import main
    from services.gateway_client.identity import ManagedActor
    from services.gateway_client.policy import ManagedPolicy

    client, tmp_path = api_context
    project_dir = tmp_path / "managed-task-policy"
    project_dir.mkdir()
    project_id = (await client.post("/api/project/init", json={"path": str(project_dir)})).json()["id"]
    workflow_id = (await _create_test_workflow(client, project_id))["id"]
    monkeypatch.setenv("WORKSTEP_DESKTOP_RUNTIME", "1")
    monkeypatch.setenv("WORKSTEP_DESKTOP_TOKEN", "desktop-secret")
    monkeypatch.setattr(main.gateway_client, "managed_config", object())
    actor = ManagedActor("user-1", "alice", "device-1", "instance-1", 0)
    session = main.gateway_client.local_sessions.create(actor)
    now = int(time())
    policy = ManagedPolicy("gateway-test", "device-1", "user-1", 0, now, now + 600,
                           frozenset(), frozenset(), False, False, False, False, False)
    main.gateway_client.policy_cache.apply(policy)
    headers = {"X-WorkStep-Desktop-Token": "desktop-secret",
               "X-WorkStep-Local-Session": session}
    body = {"title": "Managed task", "cwd": str(project_dir), "workflow_id": workflow_id}
    denied = await client.post(f"/api/task/create?project_id={project_id}", json=body, headers=headers)
    assert denied.status_code == 403
    main.gateway_client.policy_cache.apply(replace(
        policy, task_create_project_ids=frozenset({project_id}),
    ))
    scoped = await client.post(f"/api/task/create?project_id={project_id}", json=body,
                               headers=headers)
    assert scoped.status_code == 200, scoped.text
    main.gateway_client.policy_cache.apply(replace(
        policy, task_create=True,
        task_create_denied_project_ids=frozenset({project_id}),
    ))
    explicitly_denied = await client.post(
        f"/api/task/create?project_id={project_id}", json=body, headers=headers,
    )
    assert explicitly_denied.status_code == 403
    main.gateway_client.policy_cache.apply(replace(policy, task_create=True))
    allowed = await client.post(f"/api/task/create?project_id={project_id}", json=body, headers=headers)
    assert allowed.status_code == 200, allowed.text
    main.gateway_client.policy_cache.clear()


@pytest.mark.anyio
async def test_project_only_remote_actor_creates_task_in_host_project(api_context, monkeypatch):
    import base64
    import main
    from services.gateway_client.bridge import ManagedHttpBridge
    from workstep_gateway_protocol import FrameType, ProxyFrame

    client, tmp_path = api_context
    project_dir = tmp_path / "remote-task-project"
    project_dir.mkdir()
    project_id = (await client.post("/api/project/init", json={
        "path": str(project_dir),
    })).json()["id"]
    workflow_id = (await _create_test_workflow(client, project_id))["id"]
    monkeypatch.setattr(main.gateway_client, "managed_config", object())
    frames = []

    async def capture(frame):
        frames.append(frame)

    bridge = ManagedHttpBridge(main.app, "remote-create", {
        "method": "POST", "path": "/api/task/create",
        "query": f"project_id={project_id}",
        "headers": [["content-type", "application/json"]],
        "user_id": "worker", "username": "Worker",
        "project_id": project_id, "access_level": "edit", "task_create": True,
    }, capture, "device-1")
    bridge.start_task()
    body = json.dumps({"title": "Remote task", "workflow_id": workflow_id,
                       "cwd": "/tmp/other-project", "auto_start": False}).encode()
    await bridge.feed(ProxyFrame(stream_id="remote-create", type=FrameType.http_request,
                                 payload={"phase": "body", "data": base64.b64encode(body).decode()}))
    await bridge.feed(ProxyFrame(stream_id="remote-create", type=FrameType.http_request,
                                 payload={"phase": "end"}))
    await asyncio.wait_for(bridge._task, timeout=2)
    assert frames[0].payload["status"] == 200
    result = json.loads(b"".join(base64.b64decode(frame.payload["data"])
                           for frame in frames if frame.payload.get("phase") == "body"))
    assert result["cwd"] == str(project_dir)
    assert result["creator_id"] == "worker"


@pytest.mark.anyio
async def test_single_project_summary_hides_host_path_and_keeps_health_responsive(
        api_context, monkeypatch):
    from main import project_manager

    client, tmp_path = api_context
    project_dir = tmp_path / "published-summary"
    project_dir.mkdir()
    project_id = (await client.post("/api/project/init", json={
        "path": str(project_dir),
    })).json()["id"]
    original = project_manager.project_summary
    entered = threading.Event()

    def slow_summary(project):
        entered.set()
        time.sleep(0.25)
        return original(project)

    monkeypatch.setattr(project_manager, "project_summary", slow_summary)
    pending = asyncio.create_task(client.get(f"/api/project/{project_id}/summary"))
    assert await asyncio.to_thread(entered.wait, 1)
    health = await asyncio.wait_for(client.get("/api/health"), timeout=0.15)
    assert health.status_code == 200
    summary = await pending
    assert summary.status_code == 200
    assert summary.json()["id"] == project_id
    assert "path" not in summary.json()
    assert (await client.get("/api/project/unknown/summary")).status_code == 404


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
    await _create_test_workflow(client, project_id)
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
async def test_schedule_write_does_not_block_health_check(api_context, monkeypatch):
    """Schedule persistence must run outside the FastAPI event loop."""
    client, tmp_path = api_context
    project_dir = tmp_path / "nonblocking-schedule-writer"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]
    await _create_test_workflow(client, project_id)
    workflows = await client.get(
        "/api/workflow/list",
        params={"project_id": project_id},
    )
    workflow_id = workflows.json()["workflows"][0]["id"]
    project = __import__("main").project_manager.get_project_by_id(project_id)
    original_execute_sql = project.db.execute_sql

    def slow_schedule_insert(sql, params=None, commit=None):
        if 'INSERT INTO "schedules"' in sql:
            time.sleep(0.35)
        return original_execute_sql(sql, params)

    monkeypatch.setattr(project.db, "execute_sql", slow_schedule_insert)
    started_at = time.perf_counter()

    async def health_canary():
        await asyncio.sleep(0.05)
        response = await client.get("/api/health")
        return response, time.perf_counter() - started_at

    canary_task = asyncio.create_task(health_canary())
    await asyncio.sleep(0)
    create_schedule = asyncio.create_task(client.post(
        "/api/schedule/create",
        params={"project_id": project_id},
        json={
            "name": "Non-blocking schedule",
            "workflow_id": workflow_id,
            "task_template": {"title": "Scheduled task"},
            "rule": {
                "kind": "once",
                "run_at": "2099-01-01T00:00:00+00:00",
                "timezone": "UTC",
            },
        },
    ))

    health, health_completed_at = await canary_task
    created = await create_schedule

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
    await _create_test_workflow(client, project_id)
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
async def test_cancel_task_lookup_does_not_block_health_check(api_context, monkeypatch):
    client, tmp_path = api_context
    project_dir = tmp_path / "nonblocking-cancel-lookup"
    project_dir.mkdir()
    initialized = await client.post("/api/project/init", json={"path": str(project_dir)})
    project_id = initialized.json()["id"]
    await _create_test_workflow(client, project_id)
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={"title": "Cancel lookup", "cwd": str(project_dir), "auto_start": False},
    )
    task_id = created.json()["id"]
    project = __import__("main").project_manager.get_project_by_id(project_id)
    original_execute_sql = project.db.execute_sql

    def slow_task_lookup(sql, params=None, commit=None):
        if 'FROM "tasks"' in sql:
            time.sleep(0.25)
        return original_execute_sql(sql, params)

    monkeypatch.setattr(project.db, "execute_sql", slow_task_lookup)
    started = time.perf_counter()
    cancel = asyncio.create_task(client.post("/api/task/cancel", json={"task_id": task_id}))
    await asyncio.sleep(0.02)
    health = await client.get("/api/health")
    elapsed = time.perf_counter() - started
    cancelled = await cancel

    assert health.status_code == 200
    assert cancelled.status_code == 200
    assert elapsed < 0.15


@pytest.mark.anyio
async def test_task_creation_auto_starts_the_selected_step(api_context, monkeypatch):
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
    runtime.start.assert_awaited_once_with(project_id, created.json()["id"], "", source="manual")

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
    runtime.start.assert_awaited_once_with(project_id, forced.json()["id"], "", source="manual")


@pytest.mark.anyio
async def test_send_step_message_routes_to_running_step(api_context, monkeypatch):
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
    runtime.send_step_message = AsyncMock(
        return_value={"message_id": "m-1", "step_key": "do", "status": "queued"}
    )
    monkeypatch.setattr(main, "workflow_runtime", runtime)

    sent = await client.post(
        f"/api/task/task-1/step/do/message?project_id={project_id}",
        json={"content": "停下！"},
    )
    assert sent.status_code == 200
    assert sent.json()["status"] == "queued"
    runtime.send_step_message.assert_awaited_once_with(
        project_id,
        "task-1",
        "do",
        "停下！",
        as_guidance=False,
    )


@pytest.mark.anyio
async def test_send_step_message_conflict_when_step_not_running(api_context, monkeypatch):
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
    runtime.send_step_message = AsyncMock(
        side_effect=ValueError("步骤未在运行: do")
    )
    monkeypatch.setattr(main, "workflow_runtime", runtime)

    sent = await client.post(
        f"/api/task/task-1/step/do/message?project_id={project_id}",
        json={"content": "停下！"},
    )
    assert sent.status_code == 409
    assert "步骤未在运行" in sent.json()["detail"]


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
    assert not (project_dir / ".workstep" / "steps.json").exists()
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
async def test_slow_filesystem_write_does_not_block_health_check(
    api_context, monkeypatch
):
    client, tmp_path = api_context
    project_dir = tmp_path / "nonblocking-upload"
    project_dir.mkdir()
    initialized = await client.post("/api/project/init", json={"path": str(project_dir)})
    project_id = initialized.json()["id"]
    original_write_bytes = Path.write_bytes

    def slow_upload(path, content):
        if path.parent.name == "uploads":
            time.sleep(0.25)
        return original_write_bytes(path, content)

    monkeypatch.setattr(Path, "write_bytes", slow_upload)
    started = time.perf_counter()
    upload = asyncio.create_task(client.post(
        "/api/fs/upload/file",
        params={"project_id": project_id},
        json={"filename": "probe.txt", "data_url": "data:text/plain;base64,cHJvYmU="},
    ))
    await asyncio.sleep(0.02)
    health = await client.get("/api/health")
    elapsed = time.perf_counter() - started
    uploaded = await upload

    assert health.status_code == 200
    assert uploaded.status_code == 200
    assert elapsed < 0.15

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
    await _create_test_workflow(client, project_id)

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
    await _create_test_workflow(client, project_id)

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
    # 未执行过的阶段带 has_history=false，前端据此判断能否 @。
    assert all(step["has_history"] is False for step in fetched.json()["steps"])

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
async def test_task_delete_workspace_choice_preserves_or_removes_worktrees(api_context, monkeypatch):
    import api.git as git_api
    import main
    import services.project as project_service
    from services.git import GitService
    from services.git.task_workspace import TaskGitWorkspace

    client, tmp_path = api_context
    project_dir = tmp_path / 'git-task-deletion'
    project_dir.mkdir()
    subprocess.run(['git', '-C', str(project_dir), 'init', '-b', 'main'], check=True, capture_output=True)
    (project_dir / '.gitignore').write_text('.workstep/\n')
    subprocess.run(['git', '-C', str(project_dir), 'add', '.gitignore'], check=True, capture_output=True)
    subprocess.run(['git', '-C', str(project_dir), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                    'commit', '-m', 'initial'], check=True, capture_output=True)
    initialized = await client.post('/api/project/init', json={'path': str(project_dir)})
    project_id = initialized.json()['id']
    await _create_test_workflow(client, project_id)
    service = GitService(lambda: [{'id': project_id, 'name': 'Project', 'path': str(project_dir)}], lambda: 2)
    monkeypatch.setattr(git_api, 'git_service', service)
    monkeypatch.setattr(project_service, 'project_manager', main.project_manager)
    try:
        job = await service.start_scan()
        while job['state'] == 'running':
            await asyncio.sleep(.01)
        repo_id = service.snapshot['repositories'][0]['id']

        async def create_with_worktree():
            response = await client.post(f'/api/task/create?project_id={project_id}', json={
                'title': 'Disposable task', 'description': '', 'cwd': str(project_dir), 'engine': 'claude',
            })
            assert response.status_code == 200, response.text
            task = response.json()
            workspace = TaskGitWorkspace(service, task['workflow_id'])
            created = await workspace.add(project_dir, task['id'], repo_id, 'source', 'main')
            return task['id'], created['worktrees'][0]

        kept_id, kept_tree = await create_with_worktree()
        route = f'/api/task/delete?project_id={project_id}'
        blocked = await client.request('DELETE', route, json={'task_id': kept_id})
        assert blocked.status_code == 409
        kept = await client.request('DELETE', route, json={'task_id': kept_id, 'delete_workspace': False})
        assert kept.status_code == 200, kept.text
        assert Path(kept_tree['path']).is_dir()

        removed_id, removed_tree = await create_with_worktree()
        workspace_root = Path(removed_tree['path']).parent
        original_is_dir = Path.is_dir
        checking_workspace = threading.Event()

        def slow_workspace_check(path):
            if path == workspace_root and not checking_workspace.is_set():
                checking_workspace.set()
                time.sleep(.2)
            return original_is_dir(path)

        monkeypatch.setattr(Path, 'is_dir', slow_workspace_check)
        pending = asyncio.create_task(client.request('DELETE', route, json={'task_id': removed_id, 'delete_workspace': True}))
        assert await asyncio.to_thread(checking_workspace.wait, 2)
        health = await asyncio.wait_for(client.get('/api/health'), timeout=.15)
        assert health.status_code == 200
        removed = await pending
        assert removed.status_code == 200, removed.text
        assert not Path(removed_tree['path']).exists()
        assert subprocess.run(['git', '-C', str(project_dir), 'branch', '--list', removed_tree['branch']],
                              check=True, capture_output=True, text=True).stdout == ''
        assert (await client.get(f'/api/task/{removed_id}?project_id={project_id}')).status_code == 404

        blocked_id, blocked_tree = await create_with_worktree()
        (Path(blocked_tree['path']).parent / 'unrecognized.txt').write_text('keep')
        blocked = await client.request('DELETE', route, json={'task_id': blocked_id, 'delete_workspace': True})
        assert blocked.status_code == 409
        assert (await client.get(f'/api/task/{blocked_id}?project_id={project_id}')).status_code == 200
        assert Path(blocked_tree['path']).is_dir()

        forced_id, forced_tree = await create_with_worktree()
        (Path(forced_tree['path']) / '.dirty').write_text('discard')
        forced = await client.delete(
            f'/api/git/projects/{project_id}/tasks/{forced_id}/worktrees/source?force=true'
        )
        assert forced.status_code == 200, forced.text
        assert not Path(forced_tree['path']).exists()
        assert subprocess.run(['git', '-C', str(project_dir), 'branch', '--list', forced_tree['branch']],
                              check=True, capture_output=True, text=True).stdout == ''
    finally:
        await service.close()


@pytest.mark.anyio
async def test_task_api_keeps_previous_step_status_after_restart_reset(api_context):
    """A reset downstream step keeps its latest historical result for display."""
    import main
    from models import Message, StepRun, Task, TaskStep, WorkflowRun
    from models.fields import utc_now

    client, tmp_path = api_context
    project_dir = tmp_path / "previous-stage-status"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]
    workflow = await _create_test_workflow(client, project_id)
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Restarted task",
            "cwd": str(project_dir),
            "workflow_id": workflow["id"],
            "engine": "claude",
        },
    )
    task_id = created.json()["id"]

    now = utc_now()
    with main.project_manager.activate_project_by_id(project_id):
        task = Task.get_by_id(task_id)
        parent = WorkflowRun.create(
            id="previous-status-parent",
            task=task,
            status="superseded",
            workflow_schema_version=1,
            workflow_snapshot_json=json.dumps(workflow["steps"]),
            started_at=now,
            ended_at=now,
        )
        child = WorkflowRun.create(
            id="previous-status-child",
            task=task,
            status="failed",
            workflow_schema_version=1,
            workflow_snapshot_json=json.dumps(workflow["steps"]),
            parent_run_id=parent.id,
            restart_from_step_key="req",
            started_at=now,
            ended_at=now,
        )
        task.active_workflow_run_id = child.id
        task.save(only=[Task.active_workflow_run_id])
        TaskStep.update(
            status="pending",
            started_at=None,
            ended_at=None,
            error=None,
        ).where(TaskStep.task == task).execute()
        StepRun.create(
            id="previous-status-req",
            run=parent,
            step_key="req",
            attempt=1,
            status="succeeded",
            artifact_round=1,
            started_at=now,
            ended_at=now,
        )
        StepRun.create(
            id="previous-status-ui",
            run=parent,
            step_key="ui",
            attempt=1,
            status="succeeded",
            artifact_round=1,
            started_at=now,
            ended_at=now,
        )

    fetched = await client.get(
        f"/api/task/{task_id}?project_id={project_id}"
    )
    assert fetched.status_code == 200
    steps = {step["step_key"]: step for step in fetched.json()["steps"]}
    assert steps["req"]["status"] == "pending"
    assert steps["req"]["previous_status"] == "passed"
    assert steps["ui"]["status"] == "pending"
    assert steps["ui"]["previous_status"] == "passed"
    assert steps["frontend"]["previous_status"] is None

    with main.project_manager.activate_project_by_id(project_id):
        task = Task.get_by_id(task_id)
        stopped_run = StepRun.create(
            id="previous-status-stopped", run=child, step_key="frontend",
            attempt=1, status="failed", started_at=now, ended_at=now,
        )
        Message.create(
            id="previous-status-stop-message", task=task, channel="execution",
            step_key="frontend", role="assistant", run_status="cancelled",
            step_run_id=stopped_run.id, content="已停止", sequence=1, position=1,
            created_at=1,
        )
    fetched = await client.get(f"/api/task/{task_id}?project_id={project_id}")
    assert fetched.status_code == 200
    steps = {step["step_key"]: step for step in fetched.json()["steps"]}
    assert steps["frontend"]["previous_status"] == "cancelled"


@pytest.mark.anyio
async def test_task_execution_report_api_returns_task_scoped_analysis(api_context):
    client, tmp_path = api_context
    project_dir = tmp_path / "execution-report"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]
    workflow = await _create_test_workflow(client, project_id)
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Execution report task",
            "cwd": str(project_dir),
            "workflow_id": workflow["id"],
            "engine": "claude",
        },
    )
    task_id = created.json()["id"]

    response = await client.get(
        f"/api/task/{task_id}/execution-report?project_id={project_id}"
    )
    assert response.status_code == 200
    assert response.json()["summary"]["run_count"] == 0
    assert response.json()["segments"] == []

    missing = await client.get(
        f"/api/task/missing/execution-report?project_id={project_id}"
    )
    assert missing.status_code == 404


@pytest.mark.anyio
async def test_task_execution_report_slow_sql_does_not_block_health(api_context, monkeypatch):
    client, tmp_path = api_context
    project_dir = tmp_path / "slow-execution-report"
    project_dir.mkdir()
    initialized = await client.post("/api/project/init", json={"path": str(project_dir)})
    project_id = initialized.json()["id"]
    workflow = await _create_test_workflow(client, project_id)
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Slow report",
            "cwd": str(project_dir),
            "workflow_id": workflow["id"],
            "engine": "claude",
        },
    )
    task_id = created.json()["id"]
    project = __import__("main").project_manager.get_project_by_id(project_id)
    original_execute_sql = project.db.execute_sql
    query_started = threading.Event()

    def slow_message_query(sql, params=None, commit=None):
        if 'FROM "message"' in sql and not query_started.is_set():
            query_started.set()
            time.sleep(0.35)
        return original_execute_sql(sql, params)

    monkeypatch.setattr(project.db, "execute_sql", slow_message_query)
    report_task = asyncio.create_task(client.get(
        f"/api/task/{task_id}/execution-report?project_id={project_id}"
    ))
    assert await asyncio.to_thread(query_started.wait, 1)
    started_at = time.perf_counter()
    health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
    health_elapsed = time.perf_counter() - started_at
    report = await report_task

    assert health.status_code == 200
    assert health_elapsed < 0.2
    assert report.status_code == 200



@pytest.mark.anyio
async def test_task_read_model_slow_sql_does_not_block_health(api_context, monkeypatch):
    """Project task projection runs on its database executor."""
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "slow-task-read-model"
    project_dir.mkdir()
    initialized = await client.post("/api/project/init", json={"path": str(project_dir)})
    project_id = initialized.json()["id"]
    await _create_test_workflow(client, project_id)
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={"title": "Slow task projection", "cwd": str(project_dir)},
    )
    task_id = created.json()["id"]
    project = main.project_manager.get_project_by_id(project_id)
    original_execute_sql = project.db.execute_sql
    query_started = threading.Event()

    def slow_task_query(sql, params=None, commit=None):
        if 'FROM "step_runs"' in sql and not query_started.is_set():
            query_started.set()
            time.sleep(0.35)
        return original_execute_sql(sql, params)

    monkeypatch.setattr(project.db, "execute_sql", slow_task_query)
    task_request = asyncio.create_task(client.get(
        f"/api/task/{task_id}?project_id={project_id}"
    ))
    assert await asyncio.to_thread(query_started.wait, 1)
    assert not task_request.done()
    started_at = time.perf_counter()
    health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
    elapsed = time.perf_counter() - started_at
    detail = await task_request

    assert health.status_code == 200
    assert elapsed < 0.2
    assert detail.status_code == 200
    assert detail.json()["title"] == "Slow task projection"


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
    await _create_test_workflow(client, project_id)

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
async def test_archive_experience_is_not_persisted_before_user_confirmation(
    api_context, monkeypatch
):
    """Preparing a draft does not write Memory or archive before confirmation."""
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "archive-experience-draft"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]
    await _create_test_workflow(client, project_id)
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={"title": "Review before writing", "cwd": str(project_dir)},
    )
    task_id = created.json()["id"]
    monkeypatch.setattr(
        main.coordinator_module,
        "draft_archive_experience",
        AsyncMock(return_value="- 问题：测试失败\n- 经验：先复现再修复"),
        raising=False,
    )

    prepared = await client.post(
        f"/api/task/{task_id}/archive-experience/prepare"
        f"?project_id={project_id}&message_id=read-only-draft"
    )

    assert prepared.status_code == 200
    assert prepared.json() == {
        "message_id": "read-only-draft",
        "experience": "- 问题：测试失败\n- 经验：先复现再修复",
        "has_experience": True,
        "cached": False,
    }
    assert not (project_dir / ".workstep" / "MEMORY.md").exists()
    listed = await client.get(f"/api/task/list?project_id={project_id}")
    assert [task["id"] for task in listed.json()["tasks"]] == [task_id]


@pytest.mark.anyio
async def test_archive_experience_reuses_the_previous_draft(api_context, monkeypatch):
    """Opening archive again returns the prior draft without another LLM call."""
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "archive-experience-reuse"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]
    await _create_test_workflow(client, project_id)
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={"title": "Reuse draft", "cwd": str(project_dir)},
    )
    task_id = created.json()["id"]
    draft = AsyncMock(return_value="- 错误：跳过复现；原因：误判；纠正：先写失败测试。")
    monkeypatch.setattr(
        main.coordinator_module,
        "draft_archive_experience",
        draft,
        raising=False,
    )

    first = await client.post(
        f"/api/task/{task_id}/archive-experience/prepare"
        f"?project_id={project_id}&message_id=first-draft"
    )
    reopened = await client.get(
        f"/api/task/{task_id}/archive-experience/draft?project_id={project_id}"
    )

    assert first.status_code == 200
    assert first.json()["cached"] is False
    assert reopened.status_code == 200
    assert reopened.json() == {
        "found": True,
        "message_id": "first-draft",
        "experience": "- 错误：跳过复现；原因：误判；纠正：先写失败测试。",
        "has_experience": True,
        "events": [],
        "prompt": "",
    }
    draft.assert_awaited_once()


@pytest.mark.anyio
async def test_archive_with_no_worthy_experience_skips_memory(api_context, monkeypatch):
    """A verified empty result archives the task without creating Memory content."""
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "archive-experience-empty"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]
    await _create_test_workflow(client, project_id)
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={"title": "Nothing to record", "cwd": str(project_dir)},
    )
    task_id = created.json()["id"]
    monkeypatch.setattr(
        main.coordinator_module,
        "draft_archive_experience",
        AsyncMock(return_value="- 未发现值得记录的错误经验。"),
        raising=False,
    )

    prepared = await client.post(
        f"/api/task/{task_id}/archive-experience/prepare"
        f"?project_id={project_id}&message_id=empty-draft"
    )
    confirmed = await client.post(
        f"/api/task/{task_id}/archive-experience/confirm?project_id={project_id}",
        json={"experience": ""},
    )

    assert prepared.status_code == 200
    assert prepared.json()["experience"] == ""
    assert prepared.json()["has_experience"] is False
    assert confirmed.status_code == 200
    assert confirmed.json() == {"archived": True, "memory_saved": False}
    assert not (project_dir / ".workstep" / "MEMORY.md").exists()


@pytest.mark.anyio
async def test_confirmed_archive_experience_is_appended_to_memory(api_context):
    """Only the reviewed experience submitted at confirmation is persisted."""
    client, tmp_path = api_context
    project_dir = tmp_path / "archive-experience-confirm"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]
    await _create_test_workflow(client, project_id)
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={"title": "Confirmed lesson", "cwd": str(project_dir)},
    )
    task_id = created.json()["id"]
    await client.put(
        f"/api/fs/memory?project_id={project_id}",
        json={"content": "# 项目记忆\n\n已有经验"},
    )

    confirmed = await client.post(
        f"/api/task/{task_id}/archive-experience/confirm?project_id={project_id}",
        json={"experience": "- 问题：接口超时\n- 经验：为慢请求保留重试入口"},
    )

    assert confirmed.status_code == 200
    assert confirmed.json() == {"archived": True, "memory_saved": True}
    memory = await client.get(f"/api/fs/memory?project_id={project_id}")
    assert memory.json()["content"] == (
        "# 项目记忆\n\n已有经验\n\n"
        "## 错误经验：Confirmed lesson\n\n"
        "- 问题：接口超时\n- 经验：为慢请求保留重试入口\n"
    )
    listed = await client.get(f"/api/task/list?project_id={project_id}")
    assert listed.json()["tasks"] == []


@pytest.mark.anyio
async def test_archive_experience_slow_memory_write_does_not_block_health(
    api_context, monkeypatch
):
    """The memory write and task archive stay off the event loop."""
    client, tmp_path = api_context
    project_dir = tmp_path / "slow-archive-memory"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init", json={"path": str(project_dir)}
    )
    project_id = initialized.json()["id"]
    await _create_test_workflow(client, project_id)
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={"title": "Slow memory", "cwd": str(project_dir)},
    )
    task_id = created.json()["id"]
    original_write_text = Path.write_text
    write_started = threading.Event()

    def slow_memory_write(path, *args, **kwargs):
        if path.name.startswith(".MEMORY.md."):
            write_started.set()
            time.sleep(0.35)
        return original_write_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", slow_memory_write)
    confirm_task = asyncio.create_task(client.post(
        f"/api/task/{task_id}/archive-experience/confirm?project_id={project_id}",
        json={"experience": "先复现故障再修复"},
    ))
    assert await asyncio.to_thread(write_started.wait, 1)
    started_at = time.perf_counter()
    health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
    elapsed = time.perf_counter() - started_at
    confirmed = await confirm_task

    assert health.status_code == 200
    assert elapsed < 0.2
    assert confirmed.status_code == 200
    assert confirmed.json() == {"archived": True, "memory_saved": True}
    memory = await client.get(f"/api/fs/memory?project_id={project_id}")
    assert "先复现故障再修复" in memory.json()["content"]


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
    await _create_test_workflow(client, project_id)

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
        await _create_test_workflow(client, project_id)
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
    await _create_test_workflow(client, project_id)

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
        await _create_test_workflow(client, project_id)
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
        "cursor",
        "opencode",
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
    import services.engine_actions as engine_actions
    from engines.core.base import EngineTestResult

    class FakeEngine:
        tested = False

        async def test_connection(self, cwd, timeout_seconds):
            self.tested = True
            return EngineTestResult(True, "连接和对话测试通过", 12)

    fake = FakeEngine()
    monkeypatch.setattr(engine_actions, "refresh_registry", lambda **kwargs: None)
    monkeypatch.setattr(engine_actions, "create_engine", lambda engine_id: fake)

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
async def test_engine_test_uses_unsaved_form_values(api_context, monkeypatch):
    client, _ = api_context
    import services.engine_actions as engine_actions
    from engines.core.base import EngineTestResult

    class FakeEngine:
        received_overrides = None

        async def test_connection(
            self,
            cwd,
            timeout_seconds,
            config_overrides=None,
        ):
            self.received_overrides = config_overrides
            return EngineTestResult(True, "连接和对话测试通过", 12)

    fake = FakeEngine()
    monkeypatch.setattr(engine_actions, "refresh_registry", lambda **kwargs: None)
    monkeypatch.setattr(engine_actions, "create_engine", lambda engine_id: fake)

    response = await client.post(
        "/api/engine/test",
        json={
            "engine_id": "codex",
            "timeout_seconds": 3,
            "values": {
                "provider_id": "provider-draft",
                "sandbox_mode": "read-only",
            },
            "clear": {"approval_policy": True},
        },
    )

    assert response.status_code == 200
    assert response.json()["success"] is True
    assert fake.received_overrides == {
        "provider_id": "provider-draft",
        "sandbox_mode": "read-only",
        "__workstep_clear_keys__": ["approval_policy"],
    }


@pytest.mark.anyio
async def test_engine_test_uses_selected_model(api_context, monkeypatch):
    client, _ = api_context
    import services.engine_actions as engine_actions
    from engines.core.base import EngineTestResult

    class FakeEngine:
        received_model = object()

        async def test_connection(
            self,
            cwd,
            timeout_seconds,
            config_overrides=None,
            model=None,
        ):
            self.received_model = model
            return EngineTestResult(True, "连接和对话测试通过", 12)

    fake = FakeEngine()
    monkeypatch.setattr(engine_actions, "refresh_registry", lambda **kwargs: None)
    monkeypatch.setattr(engine_actions, "create_engine", lambda engine_id: fake)

    response = await client.post(
        "/api/engine/test",
        json={
            "engine_id": "claude",
            "timeout_seconds": 3,
            "model": "claude-opus-4-6",
        },
    )

    assert response.status_code == 200
    assert response.json()["success"] is True
    assert fake.received_model == "claude-opus-4-6"

    # 未传模型时不应向引擎透传 model 参数
    class BareEngine:
        received_model = object()

        async def test_connection(self, cwd, timeout_seconds):
            self.received_model = None
            return EngineTestResult(True, "连接和对话测试通过", 12)

    bare = BareEngine()
    monkeypatch.setattr(engine_actions, "create_engine", lambda engine_id: bare)
    response = await client.post(
        "/api/engine/test",
        json={"engine_id": "claude", "timeout_seconds": 3},
    )
    assert response.status_code == 200
    assert bare.received_model is None


@pytest.mark.anyio
async def test_engine_test_reports_unavailable_engine(api_context, monkeypatch):
    client, _ = api_context
    import services.engine_actions as engine_actions

    monkeypatch.setattr(engine_actions, "refresh_registry", lambda **kwargs: None)
    monkeypatch.setattr(engine_actions, "create_engine", lambda engine_id: None)

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

    response = await client.get("/api/engine/claude/models?refresh=1")

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
        "model_map": "",
        "custom_settings": "",
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
    await _create_test_workflow(client, project_id)
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
    artifacts = response.json()["artifacts"]
    assert datetime.fromisoformat(artifacts[0].pop("updated_at")).tzinfo is not None
    assert artifacts == [{
        "step_key": "req",
        "round": 1,
        "is_latest": True,
        "is_selected": True,
        "manifest_status": None,
        "eligible_for_downstream": True,
        "name": "prd.md",
        "logical_name": "PRD 文档",
        "artifact_type": "Markdown",
        "output_port": None,
        "declared_output": True,
        "path": str((artifact_dir / "prd.md").resolve()),
        "relative_path": "prd.md",
        "size": 22,
        "is_dir": False,
        "round_unchanged_from": None,
        "unchanged_from_round": None,
    }]


@pytest.mark.anyio
async def test_artifact_content_comparison_does_not_block_health(api_context, monkeypatch):
    import services.artifacts as artifact_service

    client, tmp_path = api_context
    project_dir = tmp_path / "artifact-comparison-canary"
    project_dir.mkdir()
    initialized = await client.post("/api/project/init", json={"path": str(project_dir)})
    project_id = initialized.json()["id"]
    await _create_test_workflow(client, project_id)
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={"title": "Comparison canary", "cwd": str(project_dir)},
    )
    task_id = created.json()["id"]
    artifact_dir = project_dir / ".workstep" / "artifacts" / "default" / task_id / "req"
    artifact_dir.mkdir(parents=True)
    (artifact_dir / "prd.md").write_text("same", encoding="utf-8")
    original_validation = artifact_service._manifest_validation
    started = threading.Event()

    def slow_validation(*args, **kwargs):
        started.set()
        time.sleep(0.25)
        return original_validation(*args, **kwargs)

    monkeypatch.setattr(artifact_service, "_manifest_validation", slow_validation)
    listing = asyncio.create_task(client.get(
        f"/api/task/{task_id}/artifacts", params={"project_id": project_id},
    ))
    assert await asyncio.to_thread(started.wait, 1)
    health_started = time.perf_counter()
    health = await client.get("/api/health")
    health_elapsed = time.perf_counter() - health_started
    response = await listing
    assert health.status_code == 200
    assert health_elapsed < 0.15
    assert response.status_code == 200


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
    await _create_test_workflow(client, project_id)
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
    assert docs["declared_output"] is True
    assert docs["relative_path"] == "docs/"
    assert docs["size"] is None
    assert docs["is_dir"] is True

    prd = by_path[str((artifact_dir / "prd.md").resolve())]
    assert prd["is_dir"] is False
    assert prd["declared_output"] is True
    assert str((artifact_dir / "docs" / "index.html").resolve()) not in by_path
    assert str((artifact_dir / "docs" / "guide" / "intro.md").resolve()) not in by_path

    # A directory output stays as one entry. Its files and nested/hidden
    # directories remain browsable through the fs API instead.
    directories = [item for item in artifacts if item["is_dir"]]
    assert [item["relative_path"] for item in directories] == ["docs/"]
    assert not any(item["name"] == ".hidden" for item in artifacts)


@pytest.mark.anyio
async def test_task_artifacts_are_listed_by_round(api_context):
    client, tmp_path = api_context
    project_dir = tmp_path / "artifact-round-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]
    await _create_test_workflow(client, project_id)
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={"title": "Artifact round task", "cwd": str(project_dir)},
    )
    task_id = created.json()["id"]

    round_one = (
        project_dir / ".workstep" / "artifacts" / "default" / task_id / "req" / "1"
    )
    round_two = round_one.parent / "2"
    round_one.mkdir(parents=True)
    round_two.mkdir(parents=True)
    (round_one / "prd.md").write_text("# First")
    (round_two / "prd.md").write_text("# Second")
    for round_dir, eligible in ((round_one, False), (round_two, True)):
        (round_dir / "manifest.json").write_text(json.dumps({
            "round": int(round_dir.name),
            "status": "passed" if eligible else "rejected",
            "eligible_for_downstream": eligible,
            "artifacts": [
                {"name": "PRD 文档", "type": "Markdown", "path": "prd.md"},
            ],
        }))

    response = await client.get(
        f"/api/task/{task_id}/artifacts",
        params={"project_id": project_id},
    )
    assert response.status_code == 200
    artifacts = response.json()["artifacts"]
    assert [item["round"] for item in artifacts] == [1, 2]
    assert [item["is_selected"] for item in artifacts] == [False, True]
    assert [item["eligible_for_downstream"] for item in artifacts] == [False, True]
    assert artifacts[1]["manifest_status"] == "passed"
    assert artifacts[1]["relative_path"] == "prd.md"


@pytest.mark.anyio
async def test_task_artifacts_include_the_input_snapshot_for_each_step_round(api_context):
    from models import StepRun, Task, WorkflowRun

    client, tmp_path = api_context
    project_dir = tmp_path / "artifact-input-snapshot-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]
    await _create_test_workflow(client, project_id)
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={"title": "Input snapshot task", "cwd": str(project_dir)},
    )
    task_id = created.json()["id"]
    input_path = str(project_dir / "upstream" / "prd.md")
    snapshot = {
        "execution_type": "forward",
        "triggered_edges": [],
        "ports": [{
            "port": 0,
            "name": "PRD",
            "status": "ready",
            "sources": [{
                "edge_id": "req-build",
                "kind": "solid",
                "step": "req",
                "output_port": 0,
                "round": 2,
                "name": "PRD",
                "path": input_path,
                "size": 12,
            }],
        }],
    }
    with __import__("main").project_manager.activate_project_by_id(project_id):
        task = Task.get_by_id(task_id)
        run = WorkflowRun.create(
            id="input-snapshot-run",
            task=task,
            status="succeeded",
            workflow_schema_version=1,
            workflow_snapshot_json="{}",
        )
        StepRun.create(
            id="input-snapshot-step-run",
            run=run,
            step_key="build",
            attempt=1,
            artifact_round=3,
            input_snapshot_json=json.dumps(snapshot),
            status="succeeded",
        )

    response = await client.get(
        f"/api/task/{task_id}/artifacts",
        params={"project_id": project_id},
    )

    assert response.status_code == 200
    assert response.json()["artifact_directory"] == str(
        project_dir / ".workstep" / "artifacts" / (created.json()["workflow_id"] or "default") / task_id
    )
    assert response.json()["input_snapshots"] == [{
        "step_key": "build",
        "round": 3,
        **snapshot,
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
async def test_project_file_browser_defaults_to_project_root_and_clamps_parent(
    api_context,
):
    """Project-scoped browsing starts at its root and never exposes a parent above it."""
    client, tmp_path = api_context
    project_dir = tmp_path / "browser-project"
    docs_dir = project_dir / "docs"
    docs_dir.mkdir(parents=True)
    (docs_dir / "guide.md").write_text("# Guide")
    (docs_dir / ".config.json").write_text("{}")
    (docs_dir / ".settings").mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()

    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    root = await client.get(
        "/api/fs/browse",
        params={"project_id": project_id},
    )
    assert root.status_code == 200
    assert root.json()["path"] == str(project_dir.resolve())
    assert root.json()["relative_path"] == ""
    assert root.json()["parent"] is None
    assert root.json()["entries"] == [{
        "name": "docs",
        "type": "directory",
        "path": str(docs_dir.resolve()),
        "relative_path": "docs",
    }]

    child = await client.get(
        "/api/fs/browse",
        params={"path": "docs", "project_id": project_id},
    )
    assert child.status_code == 200
    assert child.json()["relative_path"] == "docs"
    assert child.json()["parent"] == str(project_dir.resolve())
    assert child.json()["parent_relative_path"] == ""
    assert child.json()["entries"][0]["relative_path"] == "docs/guide.md"

    with_hidden = await client.get(
        "/api/fs/browse",
        params={"path": "docs", "project_id": project_id, "include_hidden": True},
    )
    assert with_hidden.status_code == 200
    assert {item["relative_path"] for item in with_hidden.json()["entries"]} == {
        "docs/.settings", "docs/.config.json", "docs/guide.md",
    }

    escaped = await client.get(
        "/api/fs/browse",
        params={"path": str(outside), "project_id": project_id},
    )
    assert escaped.status_code == 403


@pytest.mark.anyio
async def test_project_file_search_can_include_dotfiles(
    api_context,
):
    client, tmp_path = api_context
    project_dir = tmp_path / "search-project"
    (project_dir / "docs" / "nested").mkdir(parents=True)
    (project_dir / "docs" / "nested" / "Guide.md").write_text("guide")
    (project_dir / "docs" / "other.txt").write_text("other")
    (project_dir / ".private").mkdir()
    (project_dir / ".private" / "guide-secret.md").write_text("secret")
    (project_dir / "docs" / ".guide-hidden.md").write_text("hidden")

    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    response = await client.get(
        "/api/fs/search",
        params={"project_id": project_id, "query": "guide"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "query": "guide",
        "truncated": False,
        "entries": [{
            "name": "Guide.md",
            "type": "file",
            "path": str((project_dir / "docs" / "nested" / "Guide.md").resolve()),
            "relative_path": "docs/nested/Guide.md",
        }],
    }

    with_hidden = await client.get(
        "/api/fs/search",
        params={"project_id": project_id, "query": "guide", "include_hidden": True},
    )
    assert with_hidden.status_code == 200
    assert {item["relative_path"] for item in with_hidden.json()["entries"]} == {
        ".private/guide-secret.md", "docs/.guide-hidden.md", "docs/nested/Guide.md",
    }

    escaped = await client.get(
        "/api/fs/search",
        params={
            "project_id": project_id,
            "root": str(tmp_path),
            "query": "guide",
        },
    )
    assert escaped.status_code == 403


@pytest.mark.anyio
async def test_project_directory_editor_operations_stay_within_browser_root(api_context):
    client, tmp_path = api_context
    project_dir = tmp_path / "editable-project"
    output_dir = project_dir / "outputs"
    output_dir.mkdir(parents=True)
    outside = project_dir / "outside.txt"
    outside.write_text("keep")
    initialized = await client.post("/api/project/init", json={"path": str(project_dir)})
    project_id = initialized.json()["id"]
    scope = {"project_id": project_id, "root": str(output_dir)}

    created_dir = await client.post("/api/fs/entry", json={
        **scope, "parent": str(output_dir), "name": "docs", "kind": "directory",
    })
    assert created_dir.status_code == 200
    created_file = await client.post("/api/fs/entry", json={
        **scope, "parent": str(output_dir / "docs"), "name": "notes.md", "kind": "file",
    })
    assert created_file.status_code == 200
    assert (output_dir / "docs" / "notes.md").read_text() == ""
    duplicate = await client.post("/api/fs/entry", json={
        **scope, "parent": str(output_dir / "docs"), "name": "notes.md", "kind": "file",
    })
    assert duplicate.status_code == 409

    saved = await client.put("/api/fs/content", json={
        **scope, "path": str(output_dir / "docs" / "notes.md"),
        "content": "hello", "expected_content": "",
    })
    assert saved.status_code == 200
    assert (output_dir / "docs" / "notes.md").read_text() == "hello"
    stale = await client.put("/api/fs/content", json={
        **scope, "path": str(output_dir / "docs" / "notes.md"),
        "content": "lost", "expected_content": "",
    })
    assert stale.status_code == 409

    renamed = await client.patch("/api/fs/entry", json={
        **scope, "path": str(output_dir / "docs" / "notes.md"), "name": "renamed.md",
    })
    assert renamed.status_code == 200
    assert (output_dir / "docs" / "renamed.md").read_text() == "hello"
    deleted = await client.request("DELETE", "/api/fs/entry", json={
        **scope, "path": str(output_dir / "docs"),
    })
    assert deleted.status_code == 200
    assert not (output_dir / "docs").exists()

    for path in (str(output_dir), str(outside), "../outside.txt"):
        response = await client.request("DELETE", "/api/fs/entry", json={**scope, "path": path})
        assert response.status_code == 403
    assert outside.read_text() == "keep"
    invalid = await client.post("/api/fs/entry", json={
        **scope, "parent": str(output_dir), "name": "../escape", "kind": "file",
    })
    assert invalid.status_code == 400
    outside_create = await client.post("/api/fs/entry", json={
        **scope, "parent": str(project_dir), "name": "escape.txt", "kind": "file",
    })
    assert outside_create.status_code == 403
    outside_save = await client.put("/api/fs/content", json={
        **scope, "path": str(outside), "content": "changed", "expected_content": "keep",
    })
    assert outside_save.status_code == 403
    assert outside.read_text() == "keep"


@pytest.mark.anyio
async def test_slow_browser_file_save_does_not_block_health(api_context, monkeypatch):
    client, tmp_path = api_context
    project_dir = tmp_path / "slow-browser-save"
    project_dir.mkdir()
    file_path = project_dir / "note.txt"
    file_path.write_text("before")
    initialized = await client.post("/api/project/init", json={"path": str(project_dir)})
    project_id = initialized.json()["id"]
    started = threading.Event()
    release = threading.Event()
    original_write_text = Path.write_text

    def slow_write(path, content, *args, **kwargs):
        if path == file_path:
            started.set()
            assert release.wait(2)
        return original_write_text(path, content, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", slow_write)
    saving = asyncio.create_task(client.put("/api/fs/content", json={
        "project_id": project_id, "path": "note.txt",
        "content": "after", "expected_content": "before",
    }))
    try:
        assert await asyncio.to_thread(started.wait, 1)
        health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
        assert health.status_code == 200
        assert not saving.done()
    finally:
        release.set()
        saved = await saving
    assert saved.status_code == 200
    assert file_path.read_text() == "after"


@pytest.mark.anyio
async def test_project_file_preview_resolves_relative_paths_and_scopes_raw_files(
    api_context,
):
    """Message file links stay relative while every read remains project-scoped."""
    client, tmp_path = api_context
    project_dir = tmp_path / "message-preview-project"
    docs_dir = project_dir / "docs"
    docs_dir.mkdir(parents=True)
    (docs_dir / "index.html").write_text(
        '<link rel="stylesheet" href="./theme.css"><h1>Preview</h1>'
    )
    (docs_dir / "theme.css").write_text("h1 { color: blue; }")
    outside_file = tmp_path / "outside.txt"
    outside_file.write_text("secret")

    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    preview = await client.get(
        "/api/fs/preview",
        params={"path": "docs/index.html", "project_id": project_id},
    )
    assert preview.status_code == 200
    assert preview.json()["extension"] == ".html"
    assert preview.json()["relative_path"] == "docs/index.html"
    assert "<h1>Preview</h1>" in preview.json()["content"]

    html = await client.get(
        f"/api/fs/project-raw/{project_id}/docs/index.html",
    )
    assert html.status_code == 200
    assert html.headers["content-type"].startswith("text/html")

    stylesheet = await client.get(
        f"/api/fs/project-raw/{project_id}/docs/theme.css",
    )
    assert stylesheet.status_code == 200
    assert stylesheet.text == "h1 { color: blue; }"

    escaped = await client.get(
        "/api/fs/preview",
        params={"path": str(outside_file), "project_id": project_id},
    )
    assert escaped.status_code == 403

    absolute_preview = await client.get(
        "/api/fs/preview",
        params={
            "path": str(outside_file),
            "project_id": project_id,
            "absolute": "true",
        },
    )
    assert absolute_preview.status_code == 200
    assert absolute_preview.json()["content"] == "secret"
    assert absolute_preview.json()["relative_path"] is None

    absolute_raw = await client.get(
        f"/api/fs/project-raw/{project_id}/{str(outside_file).lstrip('/')}",
        params={"project_id": project_id, "absolute": "true"},
    )
    assert absolute_raw.status_code == 200
    assert absolute_raw.text == "secret"


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
async def test_slow_directory_opener_detection_keeps_health_responsive(
    api_context,
    monkeypatch,
):
    client, tmp_path = api_context
    import api.fs as fs_api

    started = threading.Event()
    release = threading.Event()

    def slow_open_command(directory, opener_id):
        started.set()
        assert release.wait(timeout=2)
        return ["fake-opener", str(directory)]

    runner = AsyncMock()
    monkeypatch.setattr(fs_api, "_open_command", slow_open_command)
    monkeypatch.setattr(fs_api, "_run_open_command", runner)
    request = asyncio.create_task(client.post(
        "/api/fs/open-directory",
        json={"path": str(tmp_path), "opener": "vscode"},
    ))
    try:
        assert await asyncio.to_thread(started.wait, 1)
        health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
        assert health.status_code == 200
        assert not request.done()
    finally:
        release.set()
        await request
    runner.assert_awaited_once_with(["fake-opener", str(tmp_path.resolve())], tmp_path.resolve())


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


async def _init_journal_project(client, tmp_path, name):
    project_dir = tmp_path / name
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    assert initialized.status_code == 200
    return initialized.json()["id"]


@pytest.mark.anyio
async def test_open_session_journal_reveals_the_journal_folder(
    api_context,
    monkeypatch,
):
    client, tmp_path = api_context
    import api.fs as fs_api

    project_id = await _init_journal_project(client, tmp_path, "journal-reveal")
    project = __import__("main").project_manager.get_project_by_id(project_id)
    journal_dir = project.workstep_dir / "event_logs" / "sess-reveal"
    journal_dir.mkdir(parents=True)
    (journal_dir / "msg-1.jsonl").write_text("")

    opener = AsyncMock()
    monkeypatch.setattr(fs_api, "_open_directory", opener)

    response = await client.post(
        "/api/fs/open-session-journal",
        json={
            "project_id": project_id,
            "session_id": "sess-reveal",
            "message_id": "msg-1",
        },
    )

    assert response.status_code == 200
    assert response.json() == {"opened": True, "path": str(journal_dir)}
    opener.assert_awaited_once_with(journal_dir)


@pytest.mark.anyio
async def test_open_session_journal_finds_task_layout_by_message_id(
    api_context,
    monkeypatch,
):
    """Task turns journal under ``event_logs/task-{id}/`` while the UI shows a
    different session id; the message scan still locates the folder."""
    client, tmp_path = api_context
    import api.fs as fs_api

    project_id = await _init_journal_project(client, tmp_path, "journal-task")
    project = __import__("main").project_manager.get_project_by_id(project_id)
    journal_dir = project.workstep_dir / "event_logs" / "task-42"
    journal_dir.mkdir(parents=True)
    (journal_dir / "msg-task.jsonl").write_text("")

    opener = AsyncMock()
    monkeypatch.setattr(fs_api, "_open_directory", opener)

    response = await client.post(
        "/api/fs/open-session-journal",
        json={
            "project_id": project_id,
            "session_id": "coordinator-session",
            "message_id": "msg-task",
        },
    )

    assert response.status_code == 200
    opener.assert_awaited_once_with(journal_dir)


@pytest.mark.anyio
async def test_open_session_journal_rejects_missing_journal(api_context):
    client, tmp_path = api_context

    project_id = await _init_journal_project(client, tmp_path, "journal-missing")

    missing = await client.post(
        "/api/fs/open-session-journal",
        json={"project_id": project_id, "session_id": "sess-absent"},
    )
    assert missing.status_code == 404

    traversal = await client.post(
        "/api/fs/open-session-journal",
        json={"project_id": project_id, "session_id": "../secret"},
    )
    assert traversal.status_code == 404


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
    await _create_test_workflow(client, first_id)
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
async def test_task_history_projects_terminal_parent_messages_without_writing_db(api_context, monkeypatch):
    client, tmp_path = api_context
    from datetime import timedelta
    import api.project as project_api
    from models import Message, ReviewRun, StepRun, WorkflowRun
    from models.fields import utc_now

    project_dir = tmp_path / "stale-message-history"
    project_dir.mkdir()
    project_id = (await client.post(
        "/api/project/init", json={"path": str(project_dir)}
    )).json()["id"]
    await _create_test_workflow(client, project_id)
    task_id = (await client.post(
        f"/api/task/create?project_id={project_id}",
        json={"title": "Stale message", "cwd": str(project_dir), "engine": "codex"},
    )).json()["id"]
    now = utc_now()
    started = now - timedelta(minutes=5)
    with project_api.project_manager.activate_project_by_id(project_id):
        old_run = WorkflowRun.create(
            id=str(uuid.uuid4()), task=task_id, status="superseded",
            workflow_schema_version=1, workflow_snapshot_json="{}",
            started_at=started, ended_at=now,
        )
        step_run = StepRun.create(
            id=str(uuid.uuid4()), run=old_run, step_key="do", attempt=1,
            status="succeeded", engine="codex",
            started_at=started, ended_at=started + timedelta(seconds=30),
        )
        review = ReviewRun.create(
            id=str(uuid.uuid4()), workflow_run=old_run, step_run=step_run,
            task=task_id, step_key="do", attempt=1, mode="auto",
            status="cancelled", engine="codex",
            started_at=started + timedelta(seconds=31), ended_at=now,
        )
        for sequence, channel, timestamp in (
            (1, "execution", started),
            (2, "review", started + timedelta(seconds=31)),
        ):
            Message.create(
                id=f"stale-{channel}", task=task_id, step_key="do",
                channel=channel, sequence=sequence, role="assistant",
                content="审核中" if channel == "review" else "旧输出",
                run_status="running", step_run_id=step_run.id,
                position=sequence, started_at=timestamp, created_at=timestamp,
            )
        active_run = WorkflowRun.create(
            id=str(uuid.uuid4()), task=task_id, status="running",
            workflow_schema_version=1, workflow_snapshot_json="{}",
            started_at=now,
        )
        active_step = StepRun.create(
            id=str(uuid.uuid4()), run=active_run, step_key="do", attempt=1,
            status="running", engine="codex", started_at=now,
        )
        Message.create(
            id="active-execution", task=task_id, step_key="do",
            channel="execution", sequence=3, role="assistant",
            run_status="running", step_run_id=active_step.id,
            position=3, started_at=now, created_at=now,
        )

    project = __import__("main").project_manager.get_project_by_id(project_id)
    original_execute_sql = project.db.execute_sql
    query_started = threading.Event()

    def slow_step_run_query(sql, params=None, commit=None):
        if "step_runs" in sql and not query_started.is_set():
            query_started.set()
            time.sleep(0.35)
        return original_execute_sql(sql, params)

    monkeypatch.setattr(project.db, "execute_sql", slow_step_run_query)
    history_task = asyncio.create_task(client.get(
        f"/api/task/{task_id}/history", params={"project_id": project_id},
    ))
    assert await asyncio.to_thread(query_started.wait, 1)
    health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
    response = await history_task
    assert health.status_code == 200
    assert response.status_code == 200
    messages = {message["id"]: message for message in response.json()["messages"]}
    assert messages["stale-execution"]["run_status"] == "succeeded"
    assert messages["stale-execution"]["ended_at"] == step_run.ended_at.isoformat()
    assert messages["stale-review"]["run_status"] == "cancelled"
    assert messages["stale-review"]["ended_at"] == review.ended_at.isoformat()
    assert messages["active-execution"]["run_status"] == "running"
    assert messages["active-execution"]["ended_at"] is None

    step_response = await client.get(
        f"/api/task/{task_id}/step/do/history",
        params={"project_id": project_id},
    )
    assert step_response.status_code == 200
    step_messages = {message["id"]: message for message in step_response.json()["messages"]}
    assert step_messages["stale-execution"]["run_status"] == "succeeded"
    assert step_messages["stale-review"]["run_status"] == "cancelled"
    assert step_messages["active-execution"]["run_status"] == "running"
    with project_api.project_manager.activate_project_by_id(project_id):
        assert Message.get_by_id("stale-execution").run_status == "running"
        assert Message.get_by_id("stale-review").run_status == "running"



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
    await _create_test_workflow(client, project_id)
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

    full_page = await client.get(
        f"/api/task/{task_id}/messages/{message_id}/events",
        params={"project_id": project_id, "limit": 30000},
    )
    assert full_page.status_code == 200
    assert len(full_page.json()["events"]) == 2


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
    await _create_test_workflow(client, project_id)
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


class ScriptedStepEngine:
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
async def test_review_flow_end_to_end_via_api(api_context, monkeypatch):
    """整个审核流程：跳过审核 → 自动审核重试 → 人工审核 → 驳回注入反馈 → 通过。"""
    client, tmp_path = api_context
    from services.config import config_store

    monkeypatch.setattr(config_store, "get_user_name", lambda: "张三")
    monkeypatch.setattr(
        config_store,
        "get_device_identity",
        lambda: {"device_id": "device-a", "device_name": "MacBook"},
    )
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

    step_prompts: list[str] = []
    review_prompts: list[str] = []
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY.clear()
    ENGINE_REGISTRY["stage-fake"] = lambda: ScriptedStepEngine(step_prompts)
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
        assert len(step_prompts) == 4
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
        assert len(step_prompts) == 5
        assert "缺少验收记录" in step_prompts[4]
        assert "## Previous review feedback" in step_prompts[4]

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
        reviews = (await client.get(
            f"/api/task/{task_id}/reviews?project_id={project_id}"
        )).json()["reviews"]
        approved_review = next(
            review for review in reviews
            if review["id"] == verify_reviews[0]["id"]
        )
        assert approved_review["reviewer_name"] == "张三"
        assert approved_review["reviewer_device_id"] == "device-a"
        assert approved_review["reviewer_device_name"] == "MacBook"

        history = (await client.get(
            f"/api/task/{task_id}/history?project_id={project_id}&limit=300"
        )).json()["messages"]
        approved_message = next(
            message for message in history
            if message["channel"] == "review"
            and any(
                event.get("type") == "review_context"
                and event.get("data", {}).get("review_run_id") == approved_review["id"]
                for event in message["events"]
            )
        )
        assert approved_message["author_name"] == "张三"
        assert approved_message["author_device_id"] == "device-a"
        assert approved_message["author_device_name"] == "MacBook"
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)


@pytest.mark.anyio
async def test_manual_review_terminate_endpoint_does_not_resume(api_context, monkeypatch):
    """人工审核可终止任务，且接口不得恢复流程。"""
    client, _tmp_path = api_context
    import main

    calls = []

    class RuntimeStub:
        async def decide_review(
            self,
            project_id,
            task_id,
            step_key,
            review_run_id,
            decision,
            comment,
        ):
            calls.append({
                "project_id": project_id,
                "task_id": task_id,
                "step_key": step_key,
                "review_run_id": review_run_id,
                "decision": decision,
                "comment": comment,
            })
            return None

    monkeypatch.setattr(main, "workflow_runtime", RuntimeStub())
    response = await client.post(
        "/api/task/task-1/steps/build/review/terminate?project_id=project-1",
        json={"review_run_id": "review-1", "comment": "不再继续"},
    )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "decision": "terminate",
        "resumed": False,
        "run_id": None,
    }
    assert calls == [{
        "project_id": "project-1",
        "task_id": "task-1",
        "step_key": "build",
        "review_run_id": "review-1",
        "decision": "terminate",
        "comment": "不再继续",
    }]


@pytest.mark.anyio
async def test_review_history_slow_sql_does_not_block_health(api_context, monkeypatch):
    """Review history is materialized inside the project's database executor."""
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "slow-review-history"
    project_dir.mkdir()
    project_id = (await client.post(
        "/api/project/init", json={"path": str(project_dir)}
    )).json()["id"]
    await _create_test_workflow(client, project_id)
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={"title": "Review history", "cwd": str(project_dir)},
    )
    task_id = created.json()["id"]
    project = main.project_manager.get_project_by_id(project_id)
    original_execute_sql = project.db.execute_sql
    query_started = threading.Event()

    def slow_review_query(sql, params=None, commit=None):
        if 'FROM "review_runs"' in sql and not query_started.is_set():
            query_started.set()
            time.sleep(0.35)
        return original_execute_sql(sql, params)

    monkeypatch.setattr(project.db, "execute_sql", slow_review_query)
    history_request = asyncio.create_task(client.get(
        f"/api/task/{task_id}/reviews?project_id={project_id}"
    ))
    assert await asyncio.to_thread(query_started.wait, 1)
    assert not history_request.done()
    started_at = time.perf_counter()
    health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
    elapsed = time.perf_counter() - started_at
    history = await history_request

    assert health.status_code == 200
    assert elapsed < 0.2
    assert history.status_code == 200
    assert history.json() == {"reviews": []}


@pytest.mark.anyio
async def test_manual_review_complete_task_endpoint_does_not_resume(api_context, monkeypatch):
    import main

    client, _tmp_path = api_context
    runtime = AsyncMock()
    runtime.decide_review.return_value = None
    monkeypatch.setattr(main, "workflow_runtime", runtime)
    response = await client.post(
        "/api/task/task-1/steps/build/review/complete-task?project_id=project-1",
        json={"review_run_id": "review-1"},
    )
    assert response.status_code == 200
    assert response.json() == {
        "decision": "complete_task", "resumed": False, "run_id": None,
    }
    runtime.decide_review.assert_awaited_once_with(
        "project-1", "task-1", "build", "review-1", "complete_task", None,
    )


@pytest.mark.anyio
@pytest.mark.parametrize("schedule_downstream", [True, False])
async def test_set_complete_review_endpoint_forwards_downstream_choice(
    api_context, monkeypatch, schedule_downstream,
):
    import main

    client, _tmp_path = api_context
    runtime = AsyncMock()
    runtime.decide_review.return_value = None
    monkeypatch.setattr(main, "workflow_runtime", runtime)
    response = await client.post(
        "/api/task/task-1/steps/build/review/set-complete?project_id=project-1",
        json={"review_run_id": "review-1", "schedule_downstream": schedule_downstream},
    )
    assert response.status_code == 200
    runtime.decide_review.assert_awaited_once_with(
        "project-1", "task-1", "build", "review-1", "set_complete", None,
        schedule_downstream=schedule_downstream,
    )


@pytest.mark.anyio
@pytest.mark.parametrize("decision", ["complete-task", "set-complete"])
async def test_review_completion_api_keeps_health_responsive_during_slow_db(
    api_context, monkeypatch, decision,
):
    import main
    from models import ReviewRun, StepRun, Task, TaskStep, WorkflowRun
    from models.fields import utc_now

    client, tmp_path = api_context
    project_dir = tmp_path / "review-complete-health"
    project_dir.mkdir()
    project_id = (await client.post(
        "/api/project/init", json={"path": str(project_dir)},
    )).json()["id"]
    workflow_response = await client.post(
        f"/api/workflow/create?project_id={project_id}",
        json={"name": "审核完成健康检查", "steps": {
            "nodes": [
                {"id": "do", "key": "do", "type": "do", "title": "执行", "engine": "claude"},
                {"id": "later", "key": "later", "type": "later", "title": "后续", "engine": "claude"},
            ],
            "connections": [{"from": "do", "to": "later"}],
        }},
    )
    assert workflow_response.status_code == 200, workflow_response.text
    workflow = workflow_response.json()
    task_id = (await client.post(
        f"/api/task/create?project_id={project_id}",
        json={"title": "Complete", "cwd": str(project_dir), "workflow_id": workflow["id"]},
    )).json()["id"]
    project = main.project_manager.get_project_by_id(project_id)
    now = utc_now()
    with main.project_manager.activate_project_by_id(project_id):
        task = Task.get_by_id(task_id)
        task.status = "paused"
        task.save()
        current_step = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "do"))
        current_step.status = "awaiting_review"
        current_step.save()
        run = WorkflowRun.create(
            id=str(uuid.uuid4()), task=task, status="paused",
            workflow_schema_version=1, workflow_snapshot_json="{}", started_at=now,
        )
        step_run = StepRun.create(
            id=str(uuid.uuid4()), run=run, step_key="do", attempt=1,
            status="succeeded", started_at=now, ended_at=now,
        )
        review = ReviewRun.create(
            id=str(uuid.uuid4()), task=task, workflow_run=run,
            step_run=step_run, step_key="do", mode="manual", status="pending",
            started_at=now,
        )
        task.active_workflow_run_id = run.id
        task.save()

    original_execute_sql = project.db.execute_sql
    query_started = threading.Event()

    def slow_review_query(sql, params=None, commit=None):
        if "review_runs" in sql and not query_started.is_set():
            query_started.set()
            time.sleep(0.35)
        return original_execute_sql(sql, params)

    monkeypatch.setattr(project.db, "execute_sql", slow_review_query)
    decision_request = asyncio.create_task(client.post(
        f"/api/task/{task_id}/steps/do/review/{decision}?project_id={project_id}",
        json={"review_run_id": review.id, "schedule_downstream": False},
    ))
    assert await asyncio.to_thread(query_started.wait, 1)
    health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
    response = await decision_request

    assert health.status_code == 200
    assert response.status_code == 200, response.text
    with main.project_manager.activate_project_by_id(project_id):
        assert TaskStep.get((TaskStep.task == task_id) & (TaskStep.step_key == "do")).status == "passed"
        assert TaskStep.get((TaskStep.task == task_id) & (TaskStep.step_key == "later")).status == (
            "skipped" if decision == "complete-task" else "pending"
        )
        assert Task.get_by_id(task_id).status == (
            "ready" if decision == "complete-task" else "paused"
        )
        assert WorkflowRun.get_by_id(run.id).status == (
            "succeeded" if decision == "complete-task" else "paused"
        )


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

    # Create workflows explicitly in the empty project.
    listed = await client.get(f"/api/workflow/list?project_id={project_id}")
    initial_ids = [w["id"] for w in listed.json()["workflows"]]
    extra_a = await _create_workflow(client, project_id, "FlowA")
    extra_b = await _create_workflow(client, project_id, "FlowB")
    original = initial_ids + [extra_a, extra_b]

    # New workflows land at the end of the list.
    listed = await client.get(f"/api/workflow/list?project_id={project_id}")
    assert [w["id"] for w in listed.json()["workflows"]] == original

    # Move the first workflow to the end.
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
    await _create_test_workflow(client, project_id)
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
async def test_resume_step_message_routes_to_runtime(api_context, monkeypatch):
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
    runtime.resume_step_with_message = AsyncMock(
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
    runtime.resume_step_with_message.assert_awaited_once_with(
        project_id,
        "task-1",
        "do",
        "请改用中文输出",
        reset_session=False,
    )


@pytest.mark.anyio
async def test_resume_step_message_can_reset_step_session(api_context, monkeypatch):
    """重置步骤随本次消息传给 runtime，并要求使用新会话。"""
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "reset-step-session-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    runtime = AsyncMock()
    runtime.resume_step_with_message = AsyncMock(return_value={
        "message_id": "m-reset",
        "step_key": "do",
        "run_id": "run-reset",
        "status": "queued",
        "sequence": 4,
        "created_at": "2026-09-23T00:00:00+00:00",
    })
    monkeypatch.setattr(main, "workflow_runtime", runtime)

    response = await client.post(
        f"/api/task/task-1/step/do/resume?project_id={project_id}",
        json={"content": "按当前任务重新执行", "reset_step": True},
    )

    assert response.status_code == 200
    runtime.resume_step_with_message.assert_awaited_once_with(
        project_id,
        "task-1",
        "do",
        "按当前任务重新执行",
        reset_session=True,
    )


@pytest.mark.anyio
async def test_restart_step_with_fresh_session_routes_to_runtime(api_context, monkeypatch):
    """引擎会话丢失时，重建会话重跑接口透传到 runtime。"""
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "restart-stage-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    runtime = AsyncMock()
    runtime.restart_step_with_fresh_session = AsyncMock(
        return_value={
            "step_key": "do",
            "run_id": "run-2",
            "status": "queued",
        }
    )
    monkeypatch.setattr(main, "workflow_runtime", runtime)

    response = await client.post(
        f"/api/task/task-1/step/do/restart?project_id={project_id}",
    )
    assert response.status_code == 200
    assert response.json()["status"] == "queued"
    runtime.restart_step_with_fresh_session.assert_awaited_once_with(
        project_id,
        "task-1",
        "do",
    )


@pytest.mark.anyio
async def test_restart_step_reports_conflict_for_running_step(api_context, monkeypatch):
    """执行中的阶段重建会话返回冲突。"""
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "restart-stage-conflict-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init",
        json={"path": str(project_dir)},
    )
    project_id = initialized.json()["id"]

    runtime = AsyncMock()
    runtime.restart_step_with_fresh_session = AsyncMock(
        side_effect=ValueError("步骤执行中，不能重建会话: do")
    )
    monkeypatch.setattr(main, "workflow_runtime", runtime)

    response = await client.post(
        f"/api/task/task-1/step/do/restart?project_id={project_id}",
    )
    assert response.status_code == 409
    assert "不能重建会话" in response.json()["detail"]


@pytest.mark.anyio
async def test_resume_step_message_slow_sql_does_not_block_health(
    api_context, monkeypatch
):
    """A stopped step's follow-up is persisted in its project DB executor."""
    import main
    from models import TaskStep

    client, tmp_path = api_context
    project_dir = tmp_path / "slow-step-followup"
    project_dir.mkdir()
    project_id = (await client.post(
        "/api/project/init", json={"path": str(project_dir)}
    )).json()["id"]
    workflow = await _create_test_workflow(client, project_id)
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Step follow-up", "cwd": str(project_dir),
            "workflow_id": workflow["id"], "auto_start": False,
        },
    )
    task_id = created.json()["id"]
    step_key = created.json()["steps"][0]["step_key"]
    await main.project_manager.run_db(
        project_id,
        lambda _project: TaskStep.update(status="cancelled").where(
            (TaskStep.task == task_id) & (TaskStep.step_key == step_key)
        ).execute(),
    )
    restart = AsyncMock(return_value=type("Handle", (), {"id": "followup-run"})())
    monkeypatch.setattr(main.workflow_runtime, "restart_from_step", restart)
    project = main.project_manager.get_project_by_id(project_id)
    original_execute_sql = project.db.execute_sql
    query_started = threading.Event()
    query_started_at = [0.0]

    def slow_task_query(sql, params=None, commit=None):
        if 'FROM "tasks"' in sql and not query_started.is_set():
            query_started_at[0] = time.perf_counter()
            query_started.set()
            time.sleep(0.35)
        return original_execute_sql(sql, params)

    monkeypatch.setattr(project.db, "execute_sql", slow_task_query)
    followup = asyncio.create_task(client.post(
        f"/api/task/{task_id}/step/{step_key}/resume?project_id={project_id}",
        json={"content": "补充验收要求"},
    ))
    assert await asyncio.to_thread(query_started.wait, 1)
    assert time.perf_counter() - query_started_at[0] < 0.2
    assert not followup.done()
    health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
    accepted = await followup

    assert health.status_code == 200
    assert accepted.status_code == 200
    assert accepted.json()["run_id"] == "followup-run"
    restart.assert_awaited_once()
    history = await client.get(f"/api/task/{task_id}/history?project_id={project_id}")
    assert any(message["content"] == "补充验收要求" for message in history.json()["messages"])


@pytest.mark.anyio
async def test_retry_failed_message_api_targets_message_without_blocking_health(api_context, monkeypatch):
    import main
    from models import Message, StepRun, Task, TaskStep, WorkflowRun
    from models.fields import utc_now

    client, tmp_path = api_context
    project_dir = tmp_path / "retry-failed-message"
    project_dir.mkdir()
    project_id = (await client.post(
        "/api/project/init", json={"path": str(project_dir)},
    )).json()["id"]
    workflow = await _create_test_workflow(client, project_id)
    task_id = (await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Retry failed message", "cwd": str(project_dir),
            "workflow_id": workflow["id"], "engine": "claude",
        },
    )).json()["id"]
    project = main.project_manager.get_project_by_id(project_id)
    now = utc_now()
    with main.project_manager.activate_project_by_id(project_id):
        task = Task.get_by_id(task_id)
        task.status = "failed"
        task.save()
        TaskStep.create(task=task, step_key="do", status="failed", engine="claude")
        run = WorkflowRun.create(
            id=str(uuid.uuid4()), task=task, status="failed",
            workflow_schema_version=1, workflow_snapshot_json="{}",
            started_at=now, ended_at=now,
        )
        step_run = StepRun.create(
            id=str(uuid.uuid4()), run=run, step_key="do", attempt=1,
            status="failed", engine="claude", error="temporary network error",
            started_at=now, ended_at=now,
        )
        Message.create(
            id="failed-message", task=task, step_key="do",
            channel="execution", role="assistant", sequence=1,
            run_status="failed", step_run_id=step_run.id,
            position=1, created_at=now,
        )
        task.active_workflow_run_id = run.id
        task.save()

    restart = AsyncMock(return_value=type("Handle", (), {"id": "new-run"})())
    monkeypatch.setattr(main.workflow_runtime, "restart_from_step", restart)
    original_execute_sql = project.db.execute_sql
    query_started = threading.Event()

    def slow_step_run_query(sql, params=None, commit=None):
        if "step_runs" in sql and not query_started.is_set():
            query_started.set()
            time.sleep(0.35)
        return original_execute_sql(sql, params)

    monkeypatch.setattr(project.db, "execute_sql", slow_step_run_query)
    retry_request = asyncio.create_task(client.post(
        f"/api/task/{task_id}/messages/failed-message/retry?project_id={project_id}",
    ))
    assert await asyncio.to_thread(query_started.wait, 1)
    health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
    response = await retry_request

    assert health.status_code == 200
    assert response.status_code == 200
    assert response.json()["run_id"] == "new-run"
    restart.assert_awaited_once()


@pytest.mark.anyio
async def test_cancel_orphaned_step_slow_sql_does_not_block_health(
    api_context, monkeypatch
):
    """Cancelling a persisted step without a runner stays off the event loop."""
    import main
    from models import Task, TaskStep, WorkflowRun
    from models.fields import utc_now

    client, tmp_path = api_context
    project_dir = tmp_path / "orphan-step-cancel"
    project_dir.mkdir()
    project_id = (await client.post(
        "/api/project/init", json={"path": str(project_dir)}
    )).json()["id"]
    workflow = await _create_test_workflow(client, project_id)
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Orphan step", "cwd": str(project_dir),
            "workflow_id": workflow["id"], "auto_start": False,
        },
    )
    task_id = created.json()["id"]
    step_key = created.json()["steps"][0]["step_key"]

    def make_orphan(_project):
        task = Task.get_by_id(task_id)
        task.status = "running"
        run = WorkflowRun.create(
            id=str(uuid.uuid4()), task=task, status="running",
            workflow_schema_version=1, workflow_snapshot_json="{}",
            owner_id="stale-peer", heartbeat_at=1, started_at=utc_now(),
        )
        task.active_workflow_run_id = run.id
        task.save()
        TaskStep.update(status="running").where(
            (TaskStep.task == task) & (TaskStep.step_key == step_key)
        ).execute()

    await main.project_manager.run_db(project_id, make_orphan)
    project = main.project_manager.get_project_by_id(project_id)
    original_execute_sql = project.db.execute_sql
    query_started = threading.Event()
    query_started_at = [0.0]

    def slow_task_query(sql, params=None, commit=None):
        if 'FROM "tasks"' in sql and not query_started.is_set():
            query_started_at[0] = time.perf_counter()
            query_started.set()
            time.sleep(0.35)
        return original_execute_sql(sql, params)

    monkeypatch.setattr(project.db, "execute_sql", slow_task_query)
    cancellation = asyncio.create_task(client.post(
        f"/api/task/{task_id}/step/{step_key}/cancel?project_id={project_id}"
    ))
    assert await asyncio.to_thread(query_started.wait, 1)
    assert time.perf_counter() - query_started_at[0] < 0.2
    assert not cancellation.done()
    health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
    cancelled = await cancellation

    assert health.status_code == 200
    assert cancelled.status_code == 200
    assert cancelled.json() == {"cancelled": True}
    task = await client.get(f"/api/task/{task_id}?project_id={project_id}")
    assert task.json()["status"] == "paused"
    assert task.json()["steps"][0]["status"] == "cancelled"


@pytest.mark.anyio
async def test_set_failed_step_complete_api_does_not_block_health(api_context, monkeypatch):
    import main
    from models import Message, StepRun, Task, TaskStep, WorkflowRun
    from models.fields import utc_now
    from services.artifact_rounds import step_round_dir

    client, tmp_path = api_context
    project_dir = tmp_path / "complete-failed-step"
    project_dir.mkdir()
    project_id = (await client.post(
        "/api/project/init", json={"path": str(project_dir)},
    )).json()["id"]
    workflow = await _create_test_workflow(client, project_id)
    task_id = (await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Complete failed step", "cwd": str(project_dir),
            "workflow_id": workflow["id"], "engine": "claude",
        },
    )).json()["id"]
    project = main.project_manager.get_project_by_id(project_id)
    now = utc_now()
    with main.project_manager.activate_project_by_id(project_id):
        task = Task.get_by_id(task_id)
        task.status = "paused"
        run = WorkflowRun.create(
            id=str(uuid.uuid4()), task=task, status="failed",
            workflow_schema_version=1, started_at=now, ended_at=now,
        )
        task.active_workflow_run_id = run.id
        task.save()
        TaskStep.get_or_create(
            task=task, step_key="do", defaults={"status": "failed"},
        )
        TaskStep.update(status="failed", error="429 Too Many Requests").where(
            (TaskStep.task == task) & (TaskStep.step_key == "do")
        ).execute()
        TaskStep.create(task=task, step_key="other", status="awaiting_review")
        step_run = StepRun.create(
            id=str(uuid.uuid4()), run=run, step_key="do", attempt=1,
            artifact_round=1, status="failed", error="429 Too Many Requests",
        )
        Message.create(
            id="ui-failure", task=task, step_key="do", channel="execution",
            role="assistant", sequence=1, run_status="failed",
            step_run_id=step_run.id, position=1, created_at=now,
        )
    round_dir = step_round_dir(
        project.workstep_dir / "artifacts", workflow["id"], task_id, "do", 1,
    )
    round_dir.mkdir(parents=True, exist_ok=True)
    (round_dir / "成品.md").write_text("已完成", encoding="utf-8")
    original_execute_sql = project.db.execute_sql
    query_started = threading.Event()
    query_started_at = [0.0]

    def slow_step_query(sql, params=None, commit=None):
        if 'FROM "message"' in sql and not query_started.is_set():
            query_started_at[0] = time.perf_counter()
            query_started.set()
            time.sleep(0.35)
        return original_execute_sql(sql, params)

    monkeypatch.setattr(project.db, "execute_sql", slow_step_query)
    completion = asyncio.create_task(client.post(
        f"/api/task/{task_id}/messages/ui-failure/set-complete?project_id={project_id}",
        json={"artifact_round": 1, "schedule_downstream": False},
    ))
    assert await asyncio.to_thread(query_started.wait, 1)
    assert time.perf_counter() - query_started_at[0] < 0.2
    assert not completion.done()
    health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
    response = await completion

    assert health.status_code == 200
    assert response.status_code == 200
    assert response.json() == {"completed": True, "resumed": False, "run_id": None}
    with main.project_manager.activate_project_by_id(project_id):
        assert TaskStep.get(
            (TaskStep.task == task_id) & (TaskStep.step_key == "other")
        ).status == "awaiting_review"


@pytest.mark.anyio
async def test_resume_step_message_conflict_when_step_not_stopped(api_context, monkeypatch):
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
    runtime.resume_step_with_message = AsyncMock(
        side_effect=ValueError("步骤未停止: do（当前状态 running）")
    )
    monkeypatch.setattr(main, "workflow_runtime", runtime)

    sent = await client.post(
        f"/api/task/task-1/step/do/resume?project_id={project_id}",
        json={"content": "请改用中文输出"},
    )
    assert sent.status_code == 409
    assert "步骤未停止" in sent.json()["detail"]


@pytest.mark.anyio
async def test_step_execution_config_inherits_and_overrides_without_mutating_workflow(
    api_context,
):
    """任务阶段配置默认继承流程，任务覆盖不会污染共享流程。"""
    client, tmp_path = api_context
    project_dir = tmp_path / "stage-config-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init", json={"path": str(project_dir)}
    )
    project_id = initialized.json()["id"]
    workflow = await client.post(
        f"/api/workflow/create?project_id={project_id}",
        json={
            "name": "StageConfigFlow",
            "steps": {
                "nodes": [{
                    "id": "implement",
                    "title": "实现",
                    "engine": "codex",
                    "model": "gpt-flow",
                    "config": {"sandbox_mode": "read-only"},
                    "inputs": [],
                    "outputs": [],
                }],
                "connections": [],
            },
        },
    )
    workflow_id = workflow.json()["id"]
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Config task",
            "cwd": str(project_dir),
            "workflow_id": workflow_id,
            "auto_start": False,
        },
    )
    task_id = created.json()["id"]
    endpoint = (
        f"/api/task/{task_id}/step/implement/config?project_id={project_id}"
    )

    inherited = await client.get(endpoint)
    assert inherited.status_code == 200
    assert inherited.json()["configured"] is None
    assert inherited.json()["resolved"] == {
        "engine": "codex",
        "model": "gpt-flow",
        "config": {"sandbox_mode": "read-only"},
    }
    assert inherited.json()["source"] == "workflow"

    overridden = await client.patch(
        endpoint,
        json={
            "engine": "pydantic_ai",
            "model": "gpt-task",
            "config": {"sandbox": "workspace-write"},
            "context_mode": "smart",
        },
    )
    assert overridden.status_code == 200, overridden.text
    assert overridden.json()["configured"] == {
        "engine": "pydantic_ai",
        "model": "gpt-task",
        "config": {"sandbox": "workspace-write"},
    }
    assert overridden.json()["resolved"] == overridden.json()["configured"]
    assert overridden.json()["source"] == "task_override"

    unchanged = await client.get(
        f"/api/workflow/{workflow_id}?project_id={project_id}"
    )
    node = unchanged.json()["steps"]["nodes"][0]
    assert (node["engine"], node["model"], node["config"]) == (
        "codex",
        "gpt-flow",
        {"sandbox_mode": "read-only"},
    )

    reset = await client.delete(endpoint)
    assert reset.status_code == 200
    assert reset.json()["configured"] is None
    assert reset.json()["resolved"]["engine"] == "codex"

    sensitive = await client.patch(
        endpoint,
        json={
            "engine": "pydantic_ai",
            "model": "gpt-task",
            "config": {"api_key": "must-not-be-stored"},
        },
    )
    assert sensitive.status_code == 422
    assert "api_key" in sensitive.json()["detail"]


@pytest.mark.anyio
async def test_step_execution_config_rejects_changes_while_step_runs(
    api_context,
):
    """执行中的阶段配置只读。"""
    from models import TaskStep
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "running-stage-config-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init", json={"path": str(project_dir)}
    )
    project_id = initialized.json()["id"]
    await _create_test_workflow(client, project_id)
    workflows = await client.get(
        "/api/workflow/list", params={"project_id": project_id}
    )
    workflow_id = workflows.json()["workflows"][0]["id"]
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Running config task",
            "cwd": str(project_dir),
            "workflow_id": workflow_id,
            "auto_start": False,
        },
    )
    task_id = created.json()["id"]
    step_key = created.json()["steps"][0]["step_key"]
    await main.project_manager.run_db(
        project_id,
        lambda _project: TaskStep.update(status="running").where(
            (TaskStep.task == task_id) & (TaskStep.step_key == step_key)
        ).execute(),
    )

    endpoint = f"/api/task/{task_id}/step/{step_key}/config?project_id={project_id}"
    current = await client.get(endpoint)
    assert current.status_code == 200, current.text
    assert current.json()["editable"] is False
    changed = await client.patch(
        endpoint,
        json={"engine": "pydantic_ai", "model": None, "config": {}},
    )
    assert changed.status_code == 409


@pytest.mark.anyio
async def test_step_execution_config_write_does_not_block_health_check(api_context):
    """阶段覆盖写入等待 SQLite 锁时，事件循环仍能响应健康检查。"""
    client, tmp_path = api_context
    project_dir = tmp_path / "stage-config-lock-project"
    project_dir.mkdir()
    initialized = await client.post(
        "/api/project/init", json={"path": str(project_dir)}
    )
    project_id = initialized.json()["id"]
    await _create_test_workflow(client, project_id)
    workflows = await client.get(
        "/api/workflow/list", params={"project_id": project_id}
    )
    workflow_id = workflows.json()["workflows"][0]["id"]
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Config lock task",
            "cwd": str(project_dir),
            "workflow_id": workflow_id,
            "auto_start": False,
        },
    )
    task_id = created.json()["id"]
    step_key = created.json()["steps"][0]["step_key"]
    endpoint = f"/api/task/{task_id}/step/{step_key}/config?project_id={project_id}"
    # Keep this concurrency canary independent of developer-machine engine
    # installations by using the always-available built-in engine.
    current = {
        "engine": "pydantic_ai",
        "model": None,
        "config": {},
    }
    database_path = project_dir / ".workstep" / "workstep.db"
    locked = threading.Event()

    def hold_write_lock():
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
    update = asyncio.create_task(client.patch(endpoint, json=current))
    await asyncio.sleep(0.05)
    health = await client.get("/api/health")
    health_elapsed = time.perf_counter() - started_at
    updated = await update
    locker.join(timeout=1)

    assert health.status_code == 200
    assert health_elapsed < 0.2
    assert updated.status_code == 200


@pytest.mark.anyio
async def test_step_config_slow_engine_factory_does_not_block_health(
    api_context, monkeypatch
):
    """Synchronous engine discovery stays off the event loop."""
    import engines.core.registry as registry

    client, tmp_path = api_context
    project_dir = tmp_path / "slow-step-engine-factory"
    project_dir.mkdir()
    project_id = (await client.post(
        "/api/project/init", json={"path": str(project_dir)}
    )).json()["id"]
    await _create_test_workflow(client, project_id)
    workflow_id = (await client.get(
        "/api/workflow/list", params={"project_id": project_id}
    )).json()["workflows"][0]["id"]
    created = await client.post(
        f"/api/task/create?project_id={project_id}",
        json={
            "title": "Slow engine factory", "cwd": str(project_dir),
            "workflow_id": workflow_id, "auto_start": False,
        },
    )
    task_id = created.json()["id"]
    step_key = created.json()["steps"][0]["step_key"]
    factory_started = threading.Event()
    factory_started_at = [0.0]
    original_factory = registry.create_engine

    def slow_factory(engine_id):
        factory_started_at[0] = time.perf_counter()
        factory_started.set()
        time.sleep(0.35)
        return original_factory(engine_id)

    monkeypatch.setattr(registry, "create_engine", slow_factory)
    update = asyncio.create_task(client.patch(
        f"/api/task/{task_id}/step/{step_key}/config?project_id={project_id}",
        json={"engine": "pydantic_ai", "model": None, "config": {}},
    ))
    assert await asyncio.to_thread(factory_started.wait, 1)
    assert time.perf_counter() - factory_started_at[0] < 0.2
    assert not update.done()
    started_at = time.perf_counter()
    health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
    elapsed = time.perf_counter() - started_at
    updated = await update

    assert health.status_code == 200
    assert elapsed < 0.2
    assert updated.status_code == 200


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
