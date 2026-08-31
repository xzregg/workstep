"""Tests for task service: create, list, run with mock engine."""

import asyncio
import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient

from models import init_db
from streaming.bus import EventBus
from services.task import TaskService
from engines.core.events import InternalEvent
from engines.core.acp_base import AcpEngineBase


class MockEngine(AcpEngineBase):
    """Mock engine that yields predefined events."""

    def __init__(self, events=None, fail=False):
        self._events = events or []
        self._fail = fail
        self._stopped = False

    @staticmethod
    def is_installed():
        return True

    @staticmethod
    def get_version():
        return "mock-1.0"

    @staticmethod
    def resolve_binary():
        return "mock"

    async def spawn(self, prompt, cwd, model=None, add_dirs=None, session_id=None, **kwargs):
        if self._fail:
            yield InternalEvent(type="error", data={"message": "mock failure"})
            raise RuntimeError("mock failure")
        for event in self._events:
            yield event

    async def stop(self):
        self._stopped = True

    async def inject_response(self, tool_use_id, content):
        pass

    @property
    def supports_resume(self):
        return False

    @property
    def supports_interactive(self):
        return False

    def build_resume_params(self, session_id):
        return {}


@pytest.fixture
async def db_and_service(tmp_path):
    """Set up DB + TaskService with EventBus."""
    db_path = str(tmp_path / "test.db")
    db = init_db(db_path)
    bus = EventBus()
    service = TaskService(bus)
    yield service, bus
    await bus.close()
    db.close()


@pytest.fixture
async def subscriber(db_and_service):
    """Subscribe to event bus for capturing published events."""
    service, bus = db_and_service
    q = bus.subscribe()
    yield q, service, bus
    bus.unsubscribe(q)


def test_create_task(db_and_service):
    """create_task creates a task with default step."""
    service, _ = db_and_service
    task = service.create_task(title="Test", cwd="/tmp")

    assert task["title"] == "Test"


def test_create_and_update_scheduled_start(db_and_service):
    service, _ = db_and_service
    at = datetime.now(timezone.utc) + timedelta(hours=1)
    task = service.create_task(title="Scheduled", cwd="/tmp", scheduled_start_at=at)
    assert task["scheduled_start_state"] == "pending"
    assert task["scheduled_start_at"] == at

    updated = service.update_scheduled_start(task["id"], None)
    assert updated["scheduled_start_at"] is None
    assert updated["scheduled_start_state"] is None
    assert task["cwd"] == "/tmp"
    assert task["status"] == "ready"
    assert task["engine"] == "pydantic_ai"

    from models import TaskStep
    steps = TaskStep.select().where(TaskStep.task == task["id"])
    assert steps.count() == 1
    assert steps[0].step_key == "do"
    assert steps[0].status == "pending"


def test_running_task_cannot_be_deleted(db_and_service):
    service, _ = db_and_service
    created = service.create_task(title="Running", cwd="/tmp")
    from models import Task

    task = Task.get_by_id(created["id"])
    task.status = "running"
    task.save()

    with pytest.raises(RuntimeError, match="Running tasks cannot be deleted"):
        service.delete_task(task.id, "project-1")

    assert Task.get_or_none(Task.id == task.id) is not None


def test_task_history_returns_latest_page_in_chronological_order(db_and_service):
    service, _ = db_and_service
    task = service.create_task(title="History", cwd="/tmp")
    from models import Message

    for index, content in enumerate(("first", "second", "third"), start=1):
        Message.create(
            id=str(uuid.uuid4()),
            task=task["id"],
            step_key="do",
            role="assistant",
            content=content,
            position=index,
            created_at=index,
        )

    history = service.get_task_history(task["id"], limit=2)

    assert [message["content"] for message in history] == ["second", "third"]


def test_create_task_from_later_stage_skips_predecessors(db_and_service):
    """A stage-specific task does not require outputs from earlier stages."""
    service, _ = db_and_service
    task = service.create_task(
        title="Frontend only",
        cwd="/tmp",
        start_step_key="frontend",
        workflow={
            "steps": [
                {"key": "req", "engine": "claude"},
                {"key": "ui", "engine": "claude", "dependsOn": ["req"]},
                {
                    "key": "frontend",
                    "engine": "codex",
                    "dependsOn": ["ui"],
                },
            ],
        },
    )

    assert {
        step["step_key"]: step["status"]
        for step in task["steps"]
    } == {
        "req": "skipped",
        "ui": "skipped",
        "frontend": "pending",
    }


def test_create_task_from_stage_skips_unrelated_branch(db_and_service):
    service, _ = db_and_service
    task = service.create_task(
        title="Build only",
        cwd="/tmp",
        start_step_key="build",
        workflow={
            "steps": [
                {"key": "req"},
                {"key": "build", "dependsOn": ["req"]},
                {"key": "docs", "dependsOn": ["req"]},
                {"key": "test", "dependsOn": ["build"]},
            ],
        },
    )

    assert {
        step["step_key"]: step["status"]
        for step in task["steps"]
    } == {
        "req": "skipped",
        "docs": "skipped",
        "build": "pending",
        "test": "pending",
    }


def test_create_task_rejects_unknown_start_stage(db_and_service):
    service, _ = db_and_service

    with pytest.raises(ValueError, match="does not exist"):
        service.create_task(
            title="Invalid start",
            cwd="/tmp",
            start_step_key="missing",
            workflow={"steps": [{"key": "req"}]},
        )


@pytest.mark.anyio
async def test_create_task_api_initializes_steps_from_project_workflow(
    tmp_path,
    monkeypatch,
):
    """A task starts with every stage from the project's saved canvas."""
    import main
    from main import app
    from models import TaskStep

    db = init_db(str(tmp_path / "workflow-task.db"))
    bus = EventBus()
    service = TaskService(bus)
    workflow = {
        "nodes": [
            {
                "id": 1,
                "type": "plan",
                "title": "Plan",
                "engine": "claude",
            },
            {
                "id": 2,
                "type": "build",
                "title": "Build",
                "engine": "codex",
            },
        ],
        "connections": [
            {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
        ],
    }

    class ProjectManagerStub:
        def bind_project_by_id(self, project_id):
            if project_id != "project-1":
                raise ValueError("Project not found")
            return SimpleNamespace(steps=workflow)

    monkeypatch.setattr(main, "project_manager", ProjectManagerStub())
    monkeypatch.setattr(main, "task_service", service)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/task/create?project_id=project-1",
            json={"title": "Workflow task", "cwd": str(tmp_path)},
        )

    assert response.status_code == 200
    task_id = response.json()["id"]
    steps = {
        step.step_key: (step.status, step.engine)
        for step in TaskStep.select().where(TaskStep.task == task_id)
    }
    assert steps == {
        "plan": ("pending", "claude"),
        "build": ("pending", "codex"),
    }
    db.close()


@pytest.mark.anyio
async def test_create_task_api_derives_missing_title_from_description(
    tmp_path,
    monkeypatch,
):
    """A task title is optional when the description can provide one."""
    import main
    from main import app

    db = init_db(str(tmp_path / "derived-title-task.db"))
    bus = EventBus()
    service = TaskService(bus)

    class ProjectManagerStub:
        def bind_project_by_id(self, project_id):
            if project_id != "project-1":
                raise ValueError("Project not found")
            return SimpleNamespace(
                steps={"nodes": [], "connections": []},
                path=tmp_path,
            )

    monkeypatch.setattr(main, "project_manager", ProjectManagerStub())
    monkeypatch.setattr(main, "task_service", service)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/task/create?project_id=project-1",
            json={
                "cwd": str(tmp_path),
                "description": "这是一个超过十个字的任务内容",
                "auto_start": False,
            },
        )

    assert response.status_code == 200
    assert response.json()["title"] == "这是一个超过十个字的..."
    db.close()


def test_copy_task_resets_workflow_steps_to_pending(db_and_service):
    """A copied task keeps its stages but starts with no execution history."""
    from models import TaskStep

    service, _ = db_and_service
    original = service.create_task(
        title="Original",
        cwd="/tmp",
        workflow={
            "steps": [
                {"key": "plan", "engine": "claude"},
                {"key": "build", "engine": "codex", "dependsOn": ["plan"]},
            ]
        },
    )
    for step in TaskStep.select().where(TaskStep.task == original["id"]):
        step.status = "passed" if step.step_key == "plan" else "failed"
        step.started_at = 10
        step.ended_at = 20
        step.error = "old failure" if step.step_key == "build" else None
        step.save()

    copied = service.copy_task(original["id"], "Copy", "project-1")

    copied_steps = list(
        TaskStep.select()
        .where(TaskStep.task == copied["id"])
        .order_by(TaskStep.step_key)
    )
    assert [
        (
            step.step_key,
            step.status,
            step.engine,
            step.started_at,
            step.ended_at,
            step.error,
        )
        for step in copied_steps
    ] == [
        ("build", "pending", "codex", None, None, None),
        ("plan", "pending", "claude", None, None, None),
    ]


def test_list_tasks(db_and_service):
    """list_tasks returns all tasks."""
    service, _ = db_and_service
    service.create_task(title="First", cwd="/tmp")
    service.create_task(title="Second", cwd="/tmp")

    tasks = service.list_tasks()
    assert len(tasks) == 2
    titles = {t["title"] for t in tasks}
    assert titles == {"First", "Second"}


def test_archive_task_hides_from_list(db_and_service):
    """Archived tasks are hidden by default and listed with archived=True."""
    service, _ = db_and_service
    archived_task = service.create_task(title="Archive me", cwd="/tmp")
    service.create_task(title="Keep me", cwd="/tmp")

    assert service.archive_task(archived_task["id"]) is True
    assert service.archive_task("missing") is False

    assert {t["title"] for t in service.list_tasks()} == {"Keep me"}
    assert [t["archived"] for t in service.list_tasks()] == [False]
    assert {t["title"] for t in service.list_tasks(archived=True)} == {"Archive me"}

    assert service.unarchive_task(archived_task["id"]) is True
    assert {t["title"] for t in service.list_tasks()} == {"Archive me", "Keep me"}
    assert service.list_tasks(archived=True) == []


def test_running_task_cannot_be_archived(db_and_service):
    """Running tasks are rejected for archiving."""
    service, _ = db_and_service
    created = service.create_task(title="Running", cwd="/tmp")
    from models import Task

    task = Task.get_by_id(created["id"])
    task.status = "running"
    task.save()

    with pytest.raises(RuntimeError):
        service.archive_task(created["id"])


def test_get_task(db_and_service):
    """get_task returns task by ID or None."""
    service, _ = db_and_service
    created = service.create_task(title="Find me", cwd="/tmp")

    found = service.get_task(created["id"])
    assert found["title"] == "Find me"

    assert service.get_task("nonexistent") is None


def test_get_task_exposes_step_session_id(db_and_service):
    """Step dicts include the engine session id stored per stage."""
    from models import TaskStep

    service, _ = db_and_service
    created = service.create_task(title="Session", cwd="/tmp")
    TaskStep.update(session_id="sess-abc-123").where(
        TaskStep.task == created["id"]
    ).execute()

    found = service.get_task(created["id"])
    assert found["steps"][0]["session_id"] == "sess-abc-123"


@pytest.mark.anyio
async def test_run_task_success(subscriber, tmp_path):
    """run_task spawns engine and publishes events to bus."""
    q, service, bus = subscriber

    # Patch registry to use mock engine
    from engines import registry
    original = registry.ENGINE_REGISTRY.copy()
    registry.ENGINE_REGISTRY["pydantic_ai"] = lambda: MockEngine(events=[
        InternalEvent(
            type="agent_thought_chunk",
            data={"content": {"text": "legacy 内部思考"}},
        ),
        InternalEvent(type="agent_message_chunk", data={"content": {"text": "Hello"}}),
        InternalEvent(type="agent_message_chunk", data={"content": {"text": " world"}}),
        InternalEvent(type="usage_update", data={
            "input_tokens": 10,
            "output_tokens": 5,
            "cache_creation_input_tokens": 6,
            "cache_read_input_tokens": 7,
        }),
    ])

    try:
        task = service.create_task(title="Run test", cwd=str(tmp_path))
        await service.run_task(task["id"], "Say hello")

        # Collect events from bus
        events = []
        while not q.empty():
            events.append(await q.get())

        # Should have status:running, text_deltas, usage, status:passed
        types = [e["type"] for e in events]
        assert "RUN_STARTED" in types
        assert "TEXT_MESSAGE_CHUNK" in types

        # Task should be back to ready (single stage completed)
        updated = service.get_task(task["id"])
        assert updated["status"] == "ready"

        # Usage (incl. cache hit) must be persisted to message.usage_json
        from models import Message
        msg = Message.select().where(Message.task == task["id"]).order_by(Message.created_at.desc()).get()
        assert uuid.UUID(msg.id).version == 7
        assert msg.usage_json is not None
        import json as _json
        usage = _json.loads(msg.usage_json)
        assert usage["input_tokens"] == 10
        assert usage["output_tokens"] == 5
        assert usage["cache_creation_input_tokens"] == 6
        assert usage["cache_read_input_tokens"] == 7
        assert "legacy 内部思考" not in (msg.events_json or "")
        assert msg.event_log_path
        records = [
            _json.loads(line)
            for line in (tmp_path / ".workstep" / msg.event_log_path)
            .read_text()
            .splitlines()
        ]
        assert "agent_thought_chunk" in {record["type"] for record in records}

    finally:
        registry.ENGINE_REGISTRY.clear()
        registry.ENGINE_REGISTRY.update(original)


@pytest.mark.anyio
async def test_run_task_failure(subscriber):
    """run_task handles engine failure gracefully."""
    q, service, bus = subscriber

    from engines import registry
    original = registry.ENGINE_REGISTRY.copy()

    class FailEngine(MockEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            yield InternalEvent(type="error", data={"message": "boom"})
            raise RuntimeError("boom")

    registry.ENGINE_REGISTRY["pydantic_ai"] = lambda: FailEngine()

    try:
        task = service.create_task(title="Fail test", cwd="/tmp")
        await service.run_task(task["id"], "do something")

        # Task should be stopped
        updated = service.get_task(task["id"])
        assert updated["status"] == "stopped"

    finally:
        registry.ENGINE_REGISTRY.clear()
        registry.ENGINE_REGISTRY.update(original)


@pytest.mark.anyio
async def test_run_task_error_event_is_a_failed_run(subscriber):
    """An engine-reported error is terminal even when the iterator exits normally."""
    q, service, bus = subscriber

    from engines import registry
    from models import Message, TaskStep

    original = registry.ENGINE_REGISTRY.copy()
    registry.ENGINE_REGISTRY["pydantic_ai"] = lambda: MockEngine(events=[
        InternalEvent(type="error", data={"message": "binary not found"}),
    ])

    try:
        task = service.create_task(title="Reported failure", cwd="/tmp")
        await service.run_task(task["id"], "do something")

        updated = service.get_task(task["id"])
        step = TaskStep.get(
            (TaskStep.task == task["id"]) & (TaskStep.step_key == "do")
        )
        message = (
            Message.select()
            .where(Message.task == task["id"])
            .order_by(Message.created_at.desc())
            .get()
        )
        events = []
        while not q.empty():
            events.append(await q.get())

        assert updated["status"] == "stopped"
        assert step.status == "failed"
        assert step.error == "binary not found"
        assert message.run_status == "failed"
        assert events[-1]["type"] == "RUN_ERROR"
        assert events[-1]["status"] == "failed"

    finally:
        registry.ENGINE_REGISTRY.clear()
        registry.ENGINE_REGISTRY.update(original)


@pytest.mark.anyio
async def test_cancel_task(db_and_service):
    """cancel_task stops a running engine."""
    service, bus = db_and_service
    mock = MockEngine(events=[
        InternalEvent(type="text_delta", data={"delta": "slow..."}),
    ])
    service._running_engines["test-id"] = mock

    result = await service.cancel_task("test-id")
    assert result is True
    assert mock._stopped is True

    # Cancel non-running returns False
    assert await service.cancel_task("nonexistent") is False


@pytest.mark.anyio
async def test_cancel_task_finalizes_running_records(subscriber):
    """Stopping an active engine leaves no run or step in a successful/running state."""
    q, service, bus = subscriber

    from engines import registry
    from models import Message, TaskStep

    class BlockingEngine(MockEngine):
        def __init__(self):
            super().__init__()
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def spawn(self, prompt, cwd, **kwargs):
            self.started.set()
            await self.release.wait()
            if False:
                yield InternalEvent(type="status", data={"status": "done"})

        async def stop(self):
            self._stopped = True
            self.release.set()

    engine = BlockingEngine()
    original = registry.ENGINE_REGISTRY.copy()
    registry.ENGINE_REGISTRY["pydantic_ai"] = lambda: engine

    try:
        task = service.create_task(title="Cancel active run", cwd="/tmp")
        run = asyncio.create_task(service.run_task(task["id"], "keep working"))
        await engine.started.wait()

        assert await service.cancel_task(task["id"]) is True
        await asyncio.wait_for(run, timeout=1)

        updated = service.get_task(task["id"])
        step = TaskStep.get(
            (TaskStep.task == task["id"]) & (TaskStep.step_key == "do")
        )
        message = (
            Message.select()
            .where(Message.task == task["id"])
            .order_by(Message.created_at.desc())
            .get()
        )
        events = []
        while not q.empty():
            events.append(await q.get())

        assert updated["status"] == "paused"
        assert step.status == "cancelled"
        assert step.error == "手动停止"
        assert message.run_status == "cancelled"
        assert task["id"] not in service._running_engines
        assert events[-1]["type"] == "RUN_ERROR"
        assert events[-1]["status"] == "cancelled"

    finally:
        registry.ENGINE_REGISTRY.clear()
        registry.ENGINE_REGISTRY.update(original)


def test_get_task_exposes_duration_fields(db_and_service):
    """Task dict exposes first-message/completed timestamps and duration_ms."""
    from datetime import datetime, timedelta, timezone

    from models import Message, TaskStep

    service, _ = db_and_service
    created = service.create_task(title="Duration", cwd="/tmp")

    fresh = service.get_task(created["id"])
    assert fresh["first_message_at"] is None
    assert fresh["completed_at"] is None
    assert fresh["duration_ms"] is None

    first = datetime(2026, 8, 13, 1, 0, 0, tzinfo=timezone.utc)
    Message.create(
        id=str(uuid.uuid4()),
        task=created["id"],
        step_key="do",
        role="assistant",
        content="first",
        position=1,
        created_at=first,
    )
    TaskStep.update(
        status="passed",
        started_at=first,
        ended_at=first + timedelta(minutes=25, seconds=30),
    ).where(TaskStep.task == created["id"]).execute()

    found = service.get_task(created["id"])
    assert found["first_message_at"] == first
    assert found["completed_at"] == first + timedelta(minutes=25, seconds=30)
    assert found["duration_ms"] == 25 * 60_000 + 30_000


def test_get_task_exposes_total_tokens(db_and_service):
    """Task dict aggregates total token usage from message usage_json."""
    import json as json_mod

    from models import Message

    service, _ = db_and_service
    created = service.create_task(title="Tokens", cwd="/tmp")

    fresh = service.get_task(created["id"])
    assert fresh["total_tokens"] is None

    Message.create(
        id=str(uuid.uuid4()),
        task=created["id"],
        step_key="do",
        role="assistant",
        content="a",
        position=1,
        created_at=1,
        usage_json=json_mod.dumps({"total_tokens": 1234}),
    )
    Message.create(
        id=str(uuid.uuid4()),
        task=created["id"],
        step_key="do",
        role="assistant",
        content="b",
        position=2,
        created_at=2,
        usage_json=json_mod.dumps({"input_tokens": 100, "output_tokens": 50}),
    )

    found = service.get_task(created["id"])
    assert found["total_tokens"] == 1234 + 150
