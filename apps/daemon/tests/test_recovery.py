"""Tests for daemon-restart recovery (workflow checkpoint resume).

Requirement: after a process restart, a workflow whose ``WorkflowRun`` is still
``running`` is re-launched from the last completed node instead of starting
over, and a graceful shutdown leaves runs recoverable for the next start.
"""

import asyncio
import json

import pytest

from engines.core.acp_base import AcpEngineBase
from engines.core.events import InternalEvent
from models import StepRun, Task, TaskStep, WorkflowRun
from models.fields import utc_now
from services.project import ProjectManager
from services.workflow_runtime import WorkflowRuntime
from streaming.bus import EventBus


class RecoveryFakeEngine(AcpEngineBase):
    """Fake engine recording the prompts it executes."""

    delay = 0.0
    prompts: list[str] = []

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
        RecoveryFakeEngine.prompts.append(prompt)
        if RecoveryFakeEngine.delay:
            await asyncio.sleep(RecoveryFakeEngine.delay)
        yield InternalEvent(type="agent_message_chunk", data={"content": {"text": "ok"}})
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


class MemoryConfigStore:
    """In-memory project registry used at the filesystem boundary."""

    def __init__(self):
        self.values = {}

    def get(self, key, default=None):
        return self.values.get(key, default)

    def set(self, key, value):
        self.values[key] = value


@pytest.fixture(autouse=True)
def _isolate_config_store(monkeypatch):
    import services.project as project_service

    monkeypatch.setattr(
        project_service, "config_store", MemoryConfigStore()
    )


@pytest.fixture(autouse=True)
def _reset_fake_engine():
    RecoveryFakeEngine.delay = 0.0
    RecoveryFakeEngine.prompts = []
    yield
    RecoveryFakeEngine.delay = 0.0
    RecoveryFakeEngine.prompts = []


def _project_with_run(tmp_path, *, run_status="running", task_status="running"):
    """Project with a two-node chain where node 'a' finished and 'b' is in flight."""
    from engines.core.registry import ENGINE_REGISTRY

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = RecoveryFakeEngine

    pm = ProjectManager()
    project = pm.init_project(tmp_path / "proj", name="Recovery")
    now = utc_now()
    with pm.activate_project(project.path):
        task = Task.create(
            id="task-rec",
            title="Rec",
            cwd=str(project.path),
            engine="claude",
            created_at=now,
            updated_at=now,
            status=task_status,
        )
        TaskStep.create(task=task, step_key="a", status="passed", engine="claude")
        TaskStep.create(
            task=task, step_key="b", status="running", engine="claude"
        )
        snapshot = {
            "nodes": [
                {
                    "id": 1, "type": "a", "title": "A",
                    "engine": "claude", "prompt": "Do A",
                },
                {
                    "id": 2, "type": "b", "title": "B",
                    "engine": "claude", "prompt": "Do B",
                },
            ],
            "connections": [
                {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
            ],
        }
        run = WorkflowRun.create(
            id="run-rec",
            task=task,
            status=run_status,
            workflow_schema_version=1,
            workflow_snapshot_json=json.dumps(snapshot, ensure_ascii=False),
            started_at=now,
        )
        StepRun.create(
            id="step-a-1",
            run=run,
            step_key="a",
            attempt=1,
            status="succeeded",
            engine="claude",
            started_at=now,
            ended_at=now,
        )
        StepRun.create(
            id="step-b-1",
            run=run,
            step_key="b",
            attempt=1,
            status="running",
            engine="claude",
            started_at=now,
        )
        task.active_workflow_run_id = run.id
        task.save()
        run_id = run.id
    return original, pm, project, run_id


async def _wait_until(condition, timeout=5.0):
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if condition():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("condition not met in time")


@pytest.mark.anyio
async def test_recovery_resumes_from_last_completed_node(tmp_path):
    original, pm, project, run_id = _project_with_run(tmp_path)
    bus = EventBus()
    runtime = WorkflowRuntime(bus, pm)
    try:
        recovered = await runtime.recover_running_workflows()
        assert recovered == 1

        with pm.activate_project(project.path):
            await _wait_until(
                lambda: Task.get_by_id("task-rec").status == "ready"
            )
            run = WorkflowRun.get_by_id(run_id)
            assert run.status == "succeeded"
            steps = {
                step.step_key: step
                for step in TaskStep.select().where(
                    TaskStep.task == Task.get_by_id("task-rec")
                )
            }
            assert steps["a"].status == "passed"
            assert steps["b"].status == "passed"
            # The interrupted attempt is failed and a fresh attempt is created.
            stale = StepRun.get_by_id("step-b-1")
            assert stale.status == "failed"
            assert "中断" in stale.error
            rerun = StepRun.get(
                (StepRun.run == run)
                & (StepRun.step_key == "b")
                & (StepRun.attempt == 2)
            )
            assert rerun.status == "succeeded"
        # The completed upstream node was not re-executed.
        prompts = "\n".join(RecoveryFakeEngine.prompts)
        assert "Do B" in prompts
        assert "Do A" not in prompts
    finally:
        await bus.close()
        from engines.core.registry import ENGINE_REGISTRY
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)


@pytest.mark.anyio
async def test_recovery_marks_stale_messages_failed(tmp_path):
    from models import Message

    original, pm, project, run_id = _project_with_run(tmp_path)
    with pm.activate_project(project.path):
        task = Task.get_by_id("task-rec")
        now = utc_now()
        Message.create(
            id="msg-b",
            task=task,
            channel="execution",
            step_key="b",
            role="assistant",
            run_id="msg-b",
            run_status="running",
            position=0,
            started_at=now,
            created_at=now,
        )
    bus = EventBus()
    runtime = WorkflowRuntime(bus, pm)
    try:
        await runtime.recover_running_workflows()
        with pm.activate_project(project.path):
            message = Message.get_by_id("msg-b")
            assert message.run_status == "failed"
            assert message.ended_at is not None
    finally:
        await bus.close()
        from engines.core.registry import ENGINE_REGISTRY
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)


@pytest.mark.anyio
async def test_recovery_skips_paused_runs(tmp_path):
    original, pm, project, run_id = _project_with_run(
        tmp_path, run_status="paused", task_status="paused"
    )
    bus = EventBus()
    runtime = WorkflowRuntime(bus, pm)
    try:
        recovered = await runtime.recover_running_workflows()
        assert recovered == 0
        with pm.activate_project(project.path):
            assert Task.get_by_id("task-rec").status == "paused"
            assert WorkflowRun.get_by_id(run_id).status == "paused"
        assert RecoveryFakeEngine.prompts == []
    finally:
        await bus.close()
        from engines.core.registry import ENGINE_REGISTRY
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)


@pytest.mark.anyio
async def test_graceful_shutdown_leaves_run_recoverable(tmp_path):
    original, pm, project, run_id = _project_with_run(tmp_path)
    bus = EventBus()
    runtime = WorkflowRuntime(bus, pm)
    try:
        # Recover, then stop the daemon while node 'b' is still executing.
        RecoveryFakeEngine.delay = 10.0
        assert await runtime.recover_running_workflows() == 1
        await asyncio.sleep(0.2)
        await runtime.shutdown()

        with pm.activate_project(project.path):
            run = WorkflowRun.get_by_id(run_id)
            assert run.status == "running"
            assert run.ended_at is None
            assert Task.get_by_id("task-rec").status == "running"
            # The in-flight attempt stays open so the next start re-runs it.
            in_flight = StepRun.get(
                (StepRun.run == run_id)
                & (StepRun.step_key == "b")
                & (StepRun.attempt == 2)
            )
            assert in_flight.status == "running"

        # A subsequent daemon start resumes the same run.
        RecoveryFakeEngine.delay = 0.0
        assert await runtime.recover_running_workflows() == 1
        with pm.activate_project(project.path):
            await _wait_until(
                lambda: Task.get_by_id("task-rec").status == "ready"
            )
            assert WorkflowRun.get_by_id(run_id).status == "succeeded"
            # The interrupted attempt is failed; a fresh attempt succeeds.
            interrupted = StepRun.get_by_id(in_flight.id)
            assert interrupted.status == "failed"
            assert "中断" in interrupted.error
            rerun = StepRun.get(
                (StepRun.run == run_id)
                & (StepRun.step_key == "b")
                & (StepRun.attempt == 3)
            )
            assert rerun.status == "succeeded"
    finally:
        await bus.close()
        from engines.core.registry import ENGINE_REGISTRY
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)


@pytest.mark.anyio
async def test_e2e_three_stage_run_resumes_after_crash(tmp_path):
    """A three-stage workflow survives a simulated daemon crash."""
    from engines.core.registry import ENGINE_REGISTRY
    from services.task import TaskService

    class CrashStageEngine(RecoveryFakeEngine):
        """Hangs on the first invocation of stage b (an in-flight crash)."""

        started: asyncio.Event | None = None
        invocation_count = 0

        async def spawn(self, prompt, cwd, **kwargs):
            key = "b" if "Do B" in prompt else ("a" if "Do A" in prompt else "c")
            if key == "b":
                CrashStageEngine.invocation_count += 1
                if CrashStageEngine.invocation_count == 1:
                    if CrashStageEngine.started is not None:
                        CrashStageEngine.started.set()
                    await asyncio.Event().wait()
                    if False:
                        yield InternalEvent(type="status", data={"status": "done"})
            yield InternalEvent(type="agent_message_chunk", data={"content": {"text": f"{key} output"}})
            yield InternalEvent(type="status", data={"status": "done"})

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = CrashStageEngine
    started = asyncio.Event()
    CrashStageEngine.started = started
    CrashStageEngine.invocation_count = 0

    pm = ProjectManager()
    project = pm.init_project(tmp_path / "proj", name="E2E")
    project.steps = {
        "nodes": [
            {
                "id": 1, "type": "a", "title": "A",
                "engine": "claude", "prompt": "Do A",
            },
            {
                "id": 2, "type": "b", "title": "B",
                "engine": "claude", "prompt": "Do B",
            },
            {
                "id": 3, "type": "c", "title": "C",
                "engine": "claude", "prompt": "Do C",
            },
        ],
        "connections": [
            {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
            {"from": 2, "fromPort": 0, "to": 3, "toPort": 0},
        ],
    }
    now = utc_now()
    with pm.activate_project(project.path):
        task = Task.create(
            id="task-e2e",
            title="E2E",
            cwd=str(project.path),
            engine="claude",
            created_at=now,
            updated_at=now,
        )
        TaskStep.create(task=task, step_key="a", status="pending", engine="claude")
        TaskStep.create(task=task, step_key="b", status="pending", engine="claude")
        TaskStep.create(task=task, step_key="c", status="pending", engine="claude")
        task_id = task.id

    bus1 = EventBus()
    runtime1 = WorkflowRuntime(bus1, pm)
    bus2 = EventBus()
    runtime2 = WorkflowRuntime(bus2, pm)
    recovered_queue = bus2.subscribe()
    try:
        handle = await runtime1.start(project.id, task_id, "")
        await asyncio.wait_for(started.wait(), timeout=2)
        run_id = handle.id

        # The daemon "crashes": runtime1 is abandoned without graceful
        # shutdown, so the run stays ``running`` in the DB with stage b in
        # flight. A fresh daemon instance recovers it.
        assert await runtime2.recover_running_workflows() == 1

        with pm.activate_project(project.path):
            await _wait_until(
                lambda: Task.get_by_id(task_id).status == "ready"
            )
            run = WorkflowRun.get_by_id(run_id)
            assert run.status == "succeeded"
            assert run.recovered_count == 1
            assert run.recovered_at is not None
            statuses = {
                step.step_key: step.status
                for step in TaskStep.select().where(
                    TaskStep.task == Task.get_by_id(task_id)
                )
            }
            assert statuses == {"a": "passed", "b": "passed", "c": "passed"}
            b_runs = list(
                StepRun.select()
                .where((StepRun.run == run) & (StepRun.step_key == "b"))
                .order_by(StepRun.attempt)
            )
            assert [step_run.status for step_run in b_runs] == [
                "failed", "succeeded",
            ]
            assert "中断" in b_runs[0].error
            a_run = StepRun.get(
                (StepRun.run == run)
                & (StepRun.step_key == "a")
                & (StepRun.attempt == 1)
            )
            c_run = StepRun.get(
                (StepRun.run == run)
                & (StepRun.step_key == "c")
                & (StepRun.attempt == 1)
            )
            assert a_run.status == "succeeded"
            assert c_run.status == "succeeded"
            # The task API surfaces the recovery marker for the UI hint.
            task_dict = TaskService(EventBus())._task_to_dict(
                Task.get_by_id(task_id)
            )
            assert task_dict["recovered_count"] == 1
            assert task_dict["recovered_at"] is not None

        events = []
        while not recovered_queue.empty():
            events.append(await recovered_queue.get())
        assert any(
            event.get("type") == "CUSTOM"
            and event.get("name") == "workstep.run_recovered"
            for event in events
        )
        # Stage a never re-ran; b ran once more after recovery; c ran once.
        assert CrashStageEngine.invocation_count == 2
    finally:
        await runtime1.shutdown()
        await bus1.close()
        await bus2.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
