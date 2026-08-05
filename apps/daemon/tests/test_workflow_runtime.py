"""Behavior tests for the production workflow runtime interface."""

from contextlib import nullcontext
from types import SimpleNamespace
import asyncio

import pytest
from httpx import ASGITransport, AsyncClient

from engines.base import BaseLLMEngine
from engines.events import InternalEvent
from models import StepRun, Task, TaskStep, WorkflowRun, init_db
from models.fields import utc_now
from streaming.bus import EventBus


class RuntimeFakeEngine(BaseLLMEngine):
    @staticmethod
    def is_installed():
        return True

    @staticmethod
    def get_version():
        return "fake"

    @staticmethod
    def resolve_binary():
        return "fake"

    async def spawn(self, prompt, cwd, **kwargs):
        yield InternalEvent(type="text_delta", data={"delta": "done"})
        yield InternalEvent(type="status", data={"status": "done"})

    async def stop(self):
        return None

    async def inject_response(self, tool_use_id, content):
        return None

    @property
    def supports_resume(self):
        return False

    @property
    def supports_interactive(self):
        return False

    def build_resume_params(self, session_id):
        return {}


@pytest.mark.parametrize(
    ("statuses", "expected"),
    [
        (
            {"requirement": "passed", "solution": "reviewing", "closure": "pending"},
            "solution",
        ),
        (
            {"requirement": "passed", "solution": "passed", "closure": "passed"},
            "closure",
        ),
        (
            {"requirement": "failed", "solution": "pending", "closure": "pending"},
            "requirement",
        ),
    ],
)
def test_user_message_uses_current_task_stage(statuses, expected):
    from services.workflow_runtime import resolve_message_step_key

    steps_config = {
        "steps": [
            {"key": "requirement"},
            {"key": "solution"},
            {"key": "closure"},
        ]
    }

    assert resolve_message_step_key(steps_config, statuses) == expected


@pytest.mark.anyio
async def test_runtime_executes_saved_canvas_workflow(tmp_path):
    """A saved canvas workflow runs through the public runtime interface."""
    from engines.registry import ENGINE_REGISTRY
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="task-1",
        title="Runtime test",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    project = SimpleNamespace(
        id="project-1",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {
                    "id": 1,
                    "type": "req",
                    "title": "需求",
                    "engine": "claude",
                    "prompt": "Write requirements",
                },
                {
                    "id": 2,
                    "type": "ui",
                    "title": "UI",
                    "engine": "claude",
                    "prompt": "Design UI",
                },
            ],
            "connections": [
                {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
            ],
        },
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = RuntimeFakeEngine
    bus = EventBus()
    event_queue = bus.subscribe()
    try:
        runtime = WorkflowRuntime(bus, ProjectManagerStub())
        await runtime.run(project.id, task.id, "Build it")

        published_events = []
        while not event_queue.empty():
            published_events.append(event_queue.get_nowait())
        started_events = [
            event for event in published_events
            if event.get("type") == "message_started"
        ]
        assert len(started_events) == 2
        assert all(event.get("created_at") for event in started_events)

        statuses = {
            step.step_key: step.status
            for step in TaskStep.select().where(TaskStep.task == task)
        }
        assert statuses == {"req": "passed", "ui": "passed"}
        assert Task.get_by_id(task.id).status == "ready"

        from models import StepRun, WorkflowRun

        workflow_run = WorkflowRun.get(WorkflowRun.task == task)
        assert workflow_run.status == "succeeded"
        step_runs = (
            StepRun.select()
            .where(StepRun.run == workflow_run)
            .order_by(StepRun.started_at)
        )
        assert [(run.step_key, run.status) for run in step_runs] == [
            ("req", "succeeded"),
            ("ui", "succeeded"),
        ]
    finally:
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_restart_without_parent_reuses_passed_upstream_steps(tmp_path):
    """A legacy task retry starts at the requested stage, not its prerequisites."""
    from engines.registry import ENGINE_REGISTRY
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(
        id="task-legacy-restart",
        title="Legacy restart",
        cwd=str(tmp_path),
        engine="claude",
        created_at=now,
        updated_at=now,
    )
    project = SimpleNamespace(
        id="project-legacy-restart",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {"id": 1, "type": "requirement", "title": "Requirement", "engine": "claude"},
                {"id": 2, "type": "solution", "title": "Solution", "engine": "claude"},
                {"id": 3, "type": "closure", "title": "Closure", "engine": "claude"},
            ],
            "connections": [
                {"from": 1, "to": 2},
                {"from": 2, "to": 3},
            ],
        },
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

    for step_key, status in (
        ("requirement", "passed"),
        ("solution", "passed"),
        ("closure", "failed"),
    ):
        TaskStep.create(
            task=task,
            step_key=step_key,
            status=status,
            started_at=now,
            ended_at=now,
        )

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = RuntimeFakeEngine
    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
    try:
        handle = await runtime.restart_from_stage(
            project.id,
            task.id,
            "closure",
        )
        await runtime.wait(handle)

        workflow_run = WorkflowRun.get_by_id(handle.id)
        step_runs = (
            StepRun.select()
            .where(StepRun.run == workflow_run)
            .order_by(StepRun.step_key)
        )
        assert workflow_run.restart_from_step_key == "closure"
        assert {(run.step_key, run.status) for run in step_runs} == {
            ("requirement", "reused"),
            ("solution", "reused"),
            ("closure", "succeeded"),
        }
    finally:
        await runtime.shutdown()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_runtime_start_immediately_persists_user_message(tmp_path, monkeypatch):
    """The submitted prompt is available to history before execution finishes."""
    from models import Message
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="task-message",
        title="Persist prompt",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    project = SimpleNamespace(
        id="project-message",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [{"id": 1, "type": "req", "title": "需求"}],
            "connections": [],
        },
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            return nullcontext(project)

    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())

    async def skip_execution(**kwargs):
        return kwargs["workflow_run"].id

    monkeypatch.setattr(runtime, "_execute", skip_execution)
    try:
        handle = await runtime.start(project.id, task.id, "  Build it  ")
        user_message = Message.get(
            (Message.task == task) & (Message.role == "user")
        )

        assert user_message.content == "Build it"
        assert user_message.step_key == "req"
        assert user_message.run_id == handle.id
        await runtime.wait(handle)
    finally:
        db.close()


@pytest.mark.anyio
async def test_runtime_start_with_empty_input_creates_no_user_message(tmp_path, monkeypatch):
    """Starting an unstarted task does not add an empty chat bubble."""
    from models import Message
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="task-start",
        title="Start workflow",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    project = SimpleNamespace(
        id="project-start",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [{"id": 1, "type": "req", "title": "需求"}],
            "connections": [],
        },
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            return nullcontext(project)

    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())

    async def skip_execution(**kwargs):
        return kwargs["workflow_run"].id

    monkeypatch.setattr(runtime, "_execute", skip_execution)
    try:
        handle = await runtime.start(project.id, task.id, "")
        await runtime.wait(handle)

        assert Message.select().where(Message.task == task).count() == 0
    finally:
        db.close()


@pytest.mark.anyio
async def test_run_endpoint_starts_the_project_workflow(monkeypatch):
    """The endpoint returns the run identity owned by WorkflowRuntime."""
    import main

    received = {}

    class RuntimeStub:
        async def start(self, project_id, task_id, user_input):
            received.update(
                project_id=project_id,
                task_id=task_id,
                user_input=user_input,
            )
            return SimpleNamespace(id="run-1")

    monkeypatch.setattr(main, "workflow_runtime", RuntimeStub(), raising=False)
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/task/run?project_id=project-1",
            json={"task_id": "task-1", "prompt": "Build it"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "status": "started",
        "task_id": "task-1",
        "run_id": "run-1",
    }
    assert received == {
        "project_id": "project-1",
        "task_id": "task-1",
        "user_input": "Build it",
    }


@pytest.mark.anyio
async def test_run_endpoint_reports_an_unknown_project_or_task(monkeypatch):
    """Runtime lookup failures are returned to the caller, not lost in a task."""
    import main

    class RuntimeStub:
        async def start(self, project_id, task_id, user_input):
            raise ValueError(f"Task not found: {task_id}")

    monkeypatch.setattr(main, "workflow_runtime", RuntimeStub(), raising=False)
    transport = ASGITransport(app=main.app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/task/run?project_id=project-1",
            json={"task_id": "missing", "prompt": "Build it"},
        )

    assert response.status_code == 404
    assert response.json()["detail"] == "Task not found: missing"


@pytest.mark.anyio
async def test_run_endpoint_rejects_a_duplicate_active_task(monkeypatch):
    """Starting the same task twice is an explicit conflict."""
    import main

    class RuntimeStub:
        async def start(self, project_id, task_id, user_input):
            raise RuntimeError(f"Task is already running: {task_id}")

    monkeypatch.setattr(main, "workflow_runtime", RuntimeStub(), raising=False)
    transport = ASGITransport(app=main.app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/task/run?project_id=project-1",
            json={"task_id": "task-1", "prompt": "Build it"},
        )

    assert response.status_code == 409
    assert response.json()["detail"] == "Task is already running: task-1"


@pytest.mark.anyio
async def test_run_endpoint_reports_an_invalid_saved_workflow(monkeypatch):
    """A saved workflow contract error is a validation response."""
    import main
    from services.workflow_definition import WorkflowValidationError

    class RuntimeStub:
        async def start(self, project_id, task_id, user_input):
            raise WorkflowValidationError("workflow: cycle detected")

    monkeypatch.setattr(main, "workflow_runtime", RuntimeStub(), raising=False)
    transport = ASGITransport(app=main.app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/task/run?project_id=project-1",
            json={"task_id": "task-1", "prompt": "Build it"},
        )

    assert response.status_code == 422
    assert response.json()["detail"] == "workflow: cycle detected"


@pytest.mark.anyio
async def test_runtime_cancels_an_active_pipeline(tmp_path):
    """Cancellation uses the same runtime that owns the active TaskRunner."""
    from engines.registry import ENGINE_REGISTRY
    from models import WorkflowRun
    from services.workflow_runtime import WorkflowRuntime

    class BlockingEngine(RuntimeFakeEngine):
        def __init__(self):
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def spawn(self, prompt, cwd, **kwargs):
            self.started.set()
            await self.release.wait()
            if False:
                yield InternalEvent(type="status", data={"status": "done"})

        async def stop(self):
            self.release.set()

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="task-cancel",
        title="Cancel runtime",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    project = SimpleNamespace(
        id="project-cancel",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {
                    "id": 1,
                    "type": "req",
                    "title": "需求",
                    "engine": "claude",
                }
            ],
            "connections": [],
        },
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            return nullcontext(project)

    engine = BlockingEngine()
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = lambda: engine
    try:
        runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
        active_run = asyncio.create_task(
            runtime.run(project.id, task.id, "Start")
        )
        await engine.started.wait()

        assert await runtime.cancel(task.id) is True
        await asyncio.wait_for(active_run, timeout=1)

        assert Task.get_by_id(task.id).status == "paused"
        assert WorkflowRun.get(WorkflowRun.task == task).status == "failed"
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_cancel_endpoint_uses_the_workflow_runtime(monkeypatch):
    """The public cancel command reaches the owner of pipeline runners."""
    import main

    class RuntimeStub:
        async def cancel(self, task_id):
            return task_id == "task-1"

    monkeypatch.setattr(main, "workflow_runtime", RuntimeStub(), raising=False)
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/task/cancel",
            json={"task_id": "task-1"},
        )

    assert response.status_code == 200
    assert response.json() == {"cancelled": True}


@pytest.mark.anyio
async def test_pause_endpoint_stops_an_active_pipeline(monkeypatch):
    """Pause reaches the runtime so an active engine cannot keep running."""
    import main

    calls = []

    class RuntimeStub:
        async def cancel(self, task_id):
            calls.append(task_id)
            return True

    monkeypatch.setattr(main, "workflow_runtime", RuntimeStub(), raising=False)
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/api/task/pause?project_id=project-1",
            json={"task_id": "task-1"},
        )

    assert response.status_code == 200
    assert response.json() == {"paused": True}
    assert calls == ["task-1"]


@pytest.mark.anyio
async def test_start_returns_a_handle_that_can_be_waited(tmp_path):
    """start returns immediately while wait observes background completion."""
    from engines.registry import ENGINE_REGISTRY
    from models import WorkflowRun
    from services.workflow_runtime import WorkflowRuntime

    class BlockingEngine(RuntimeFakeEngine):
        def __init__(self):
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def spawn(self, prompt, cwd, **kwargs):
            self.started.set()
            await self.release.wait()
            yield InternalEvent(type="status", data={"status": "done"})

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="task-background",
        title="Background runtime",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    project = SimpleNamespace(
        id="project-background",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {
                    "id": 1,
                    "type": "req",
                    "title": "需求",
                    "engine": "claude",
                }
            ],
            "connections": [],
        },
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            return nullcontext(project)

    engine = BlockingEngine()
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = lambda: engine
    try:
        runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
        handle = await asyncio.wait_for(
            runtime.start(project.id, task.id, "Start"),
            timeout=1,
        )
        await asyncio.wait_for(engine.started.wait(), timeout=1)

        assert WorkflowRun.get_by_id(handle.id).status == "running"
        waiter = asyncio.create_task(runtime.wait(handle))
        await asyncio.sleep(0)
        assert waiter.done() is False

        engine.release.set()
        assert await asyncio.wait_for(waiter, timeout=1) == handle.id
        assert WorkflowRun.get_by_id(handle.id).status == "succeeded"
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_shutdown_cancels_and_waits_for_active_runs(tmp_path):
    """shutdown does not return until every active run has been cancelled."""
    from engines.registry import ENGINE_REGISTRY
    from models import WorkflowRun
    from services.workflow_runtime import WorkflowRuntime

    class CancellationAwareEngine(RuntimeFakeEngine):
        def __init__(self):
            self.started = asyncio.Event()
            self.cancelled = asyncio.Event()
            self.stopped = asyncio.Event()

        async def spawn(self, prompt, cwd, **kwargs):
            self.started.set()
            try:
                await asyncio.Event().wait()
            finally:
                self.cancelled.set()
            if False:
                yield InternalEvent(type="status", data={"status": "done"})

        async def stop(self):
            self.stopped.set()

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="task-shutdown",
        title="Shutdown runtime",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    project = SimpleNamespace(
        id="project-shutdown",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {
                    "id": 1,
                    "type": "req",
                    "title": "需求",
                    "engine": "claude",
                }
            ],
            "connections": [],
        },
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            return nullcontext(project)

    engine = CancellationAwareEngine()
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = lambda: engine
    try:
        runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
        handle = await runtime.start(project.id, task.id, "Start")
        await asyncio.wait_for(engine.started.wait(), timeout=1)

        await asyncio.wait_for(runtime.shutdown(), timeout=1)

        assert engine.cancelled.is_set()
        assert engine.stopped.is_set()
        workflow_run = WorkflowRun.get_by_id(handle.id)
        assert workflow_run.status == "failed"
        assert workflow_run.ended_at is not None
        with pytest.raises(asyncio.CancelledError):
            await runtime.wait(handle)

        await runtime.shutdown()
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_shutdown_finalizes_runs_cancelled_before_they_are_scheduled(
    tmp_path,
):
    """Even never-scheduled background runs leave no running DB records."""
    from engines.registry import ENGINE_REGISTRY
    from models import WorkflowRun
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    tasks = [
        Task.create(
            id=f"task-early-{index}",
            title=f"Early shutdown {index}",
            cwd=str(tmp_path),
            engine="claude",
            created_at=1,
            updated_at=1,
        )
        for index in range(2)
    ]
    project = SimpleNamespace(
        id="project-early-shutdown",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {
                    "id": 1,
                    "type": "req",
                    "title": "需求",
                    "engine": "claude",
                }
            ],
            "connections": [],
        },
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            return nullcontext(project)

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = RuntimeFakeEngine
    try:
        runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
        handles = [
            await runtime.start(project.id, task.id, "Start")
            for task in tasks
        ]

        await asyncio.wait_for(runtime.shutdown(), timeout=1)

        runs = [
            WorkflowRun.get_by_id(handle.id)
            for handle in handles
        ]
        assert [run.status for run in runs] == ["failed", "failed"]
        assert all(run.ended_at is not None for run in runs)
        for handle in handles:
            with pytest.raises(asyncio.CancelledError):
                await runtime.wait(handle)
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()
