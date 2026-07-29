"""Behavior tests for the production workflow runtime interface."""

from contextlib import nullcontext
from types import SimpleNamespace
import asyncio

import pytest
from httpx import ASGITransport, AsyncClient

from engines.base import BaseLLMEngine
from engines.events import InternalEvent
from models import Task, TaskStep, init_db
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
    try:
        runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
        await runtime.run(project.id, task.id, "Build it")

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
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
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
