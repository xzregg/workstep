"""Tests for daemon-restart recovery (workflow checkpoint resume).

Requirement: after a process restart, a workflow whose ``WorkflowRun`` is still
``running`` is re-launched from the last completed node instead of starting
over, and a graceful shutdown leaves runs recoverable for the next start.
"""

import asyncio
import json
import threading
import time
from datetime import timedelta
from types import SimpleNamespace

import pytest

from engines.core.acp_base import AcpEngineBase
from engines.core.events import InternalEvent
from models import Message, ReviewRun, StepRun, Task, TaskStep, WorkflowRun
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
        # Recovery must use the project's current workflow, not the legacy
        # definition stored on the run row.
        project.steps = snapshot
        legacy_snapshot = json.loads(json.dumps(snapshot))
        legacy_snapshot["nodes"][1]["prompt"] = "Old B prompt"
        run = WorkflowRun.create(
            id="run-rec",
            task=task,
            status=run_status,
            workflow_schema_version=1,
            workflow_snapshot_json=json.dumps(legacy_snapshot, ensure_ascii=False),
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
async def test_slow_recovery_database_work_does_not_block_event_loop(tmp_path, monkeypatch):
    import services.workflow_runtime as runtime_module
    from engines.core.registry import ENGINE_REGISTRY

    original, pm, _project, _run_id = _project_with_run(tmp_path)
    entered = threading.Event()
    entered_at = [0.0]
    prepare = runtime_module.prepare_project_recovery

    def slow_prepare(*args, **kwargs):
        entered_at[0] = time.monotonic()
        entered.set()
        time.sleep(0.2)
        return prepare(*args, **kwargs)

    monkeypatch.setattr(runtime_module, "prepare_project_recovery", slow_prepare)
    bus = EventBus()
    runtime = WorkflowRuntime(bus, pm)
    try:
        recovery = asyncio.create_task(runtime.recover_running_workflows())
        assert await asyncio.to_thread(entered.wait, 2)
        await asyncio.sleep(0.02)
        assert time.monotonic() - entered_at[0] < 0.17
        assert await recovery == 1
    finally:
        await runtime.shutdown()
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)


@pytest.mark.anyio
async def test_recovered_execution_message_keeps_persisted_run_initiator(tmp_path, monkeypatch):
    from engines.core.registry import ENGINE_REGISTRY
    from models import ProjectAuditEvent
    from services import project_audit

    original, manager, project, run_id = _project_with_run(tmp_path)

    def attribute_run(_project):
        run = WorkflowRun.get_by_id(run_id)
        run.initiated_by_user_id = "user-1"
        run.initiated_by_username = "alice"
        run.initiated_by_name = "Alice Display"
        run.initiated_by_device_id = "device-1"
        run.initiated_by_device_name = "Office PC"
        run.save()

    await manager.run_db(project.id, attribute_run)
    bus = EventBus()
    runtime = WorkflowRuntime(bus, manager)
    try:
        with monkeypatch.context() as patcher:
            patcher.setattr(
                project_audit, "record_project_audit",
                lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("audit unavailable")),
            )
            assert await runtime.recover_running_workflows() == 0
        def rollback_state(_project):
            return (
                WorkflowRun.get_by_id(run_id).recovered_count,
                ProjectAuditEvent.select().where(
                    ProjectAuditEvent.action == "task.recover",
                ).count(),
            )
        assert await manager.run_db(project.id, rollback_state) == (0, 0)
        assert await runtime.recover_running_workflows() == 1

        def recovery_audit(_project):
            return ProjectAuditEvent.get(
                (ProjectAuditEvent.task_id == "task-rec")
                & (ProjectAuditEvent.action == "task.recover")
            )

        audit = await manager.run_db(project.id, recovery_audit)
        assert audit.actor_type == "system"
        assert audit.initiated_by_user_id == "user-1"
        assert audit.initiated_by_username == "alice"
        assert audit.metadata_json == '{"workflow_run_id": "' + run_id + '"}'

        async def finished():
            return await manager.run_db(
                project.id, lambda _project: Task.get_by_id("task-rec").status == "ready",
            )

        for _ in range(250):
            if await finished():
                break
            await asyncio.sleep(0.02)
        else:
            raise AssertionError("Recovered workflow did not finish")

        def read_messages(_project):
            return [
                (row.initiated_by_user_id, row.initiated_by_username,
                 row.author_device_id)
                for row in Message.select().where(
                    (Message.task == "task-rec")
                    & (Message.role == "assistant")
                    & (Message.channel == "execution")
                )
            ]

        assert ("user-1", "alice", "device-1") in await manager.run_db(
            project.id, read_messages,
        )
    finally:
        await runtime.shutdown()
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)


@pytest.mark.anyio
async def test_slow_resume_path_check_does_not_block_event_loop(tmp_path, monkeypatch):
    import services.workflow_runtime as runtime_module
    from engines.core.registry import ENGINE_REGISTRY

    original, pm, _project, _run_id = _project_with_run(tmp_path)
    entered = threading.Event()
    entered_at = [0.0]
    heal = runtime_module.heal_task_cwd

    def slow_heal(*args, **kwargs):
        entered_at[0] = time.monotonic()
        entered.set()
        time.sleep(0.2)
        return heal(*args, **kwargs)

    monkeypatch.setattr(runtime_module, "heal_task_cwd", slow_heal)
    bus = EventBus()
    runtime = WorkflowRuntime(bus, pm)
    try:
        recovery = asyncio.create_task(runtime.recover_running_workflows())
        assert await asyncio.to_thread(entered.wait, 2)
        await asyncio.sleep(0.02)
        assert time.monotonic() - entered_at[0] < 0.17
        assert await recovery == 1
    finally:
        await runtime.shutdown()
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)


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
        assert "Old B prompt" not in prompts
        assert "Do A" not in prompts
    finally:
        await bus.close()
        from engines.core.registry import ENGINE_REGISTRY
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)


@pytest.mark.anyio
@pytest.mark.parametrize("step_status", ["reviewing", "running"])
@pytest.mark.parametrize("review_status", ["running", "passed"])
async def test_recovery_restarts_only_review_after_execution_succeeded(
    tmp_path, step_status, review_status,
):
    from agent_assistants.event_journal import TurnEventJournal
    from engines.core.registry import ENGINE_REGISTRY
    from services.history import get_task_history

    class ReviewRecoveryEngine(RecoveryFakeEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            RecoveryFakeEngine.prompts.append(prompt)
            text = '{"passed":true,"score":100,"summary":"通过","issues":[]}'
            yield InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": text}},
            )

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = ReviewRecoveryEngine
    pm = ProjectManager()
    project = pm.init_project(tmp_path / "proj", name="Review recovery")
    review_ref = None
    if review_status == "running":
        journal = TurnEventJournal()
        review_ref = journal.start(
            project.workstep_dir, "task-task-review-rec", "review-message-a-1"
        )
        journal.record(review_ref, {
            "type": "session_started",
            "data": {"session_id": "interrupted-review-session"},
        })
        journal.sync(review_ref, durable=True)
    now = utc_now()
    with pm.activate_project(project.path):
        task = Task.create(
            id="task-review-rec", title="Review recovery",
            cwd=str(project.path), engine="claude", status="running",
            created_at=now, updated_at=now,
        )
        TaskStep.create(
            task=task, step_key="a", status=step_status, engine="claude",
        )
        project.steps = {
            "nodes": [{
                "id": 1, "type": "a", "title": "A", "engine": "claude",
                "prompt": "Do A", "review": {"mode": "auto", "maxRetries": 0},
            }],
            "connections": [],
        }
        run = WorkflowRun.create(
            id="run-review-rec", task=task, status="running",
            workflow_schema_version=1, workflow_snapshot_json="{}",
            initiated_by_user_id="review-user",
            initiated_by_username="reviewer",
            started_at=now,
        )
        step_run = StepRun.create(
            id="step-a-review-1", run=run, step_key="a", attempt=1,
            artifact_round=1, status="succeeded", engine="claude",
            started_at=now, ended_at=now,
        )
        ReviewRun.create(
            id="review-a-1", workflow_run=run, step_run=step_run,
            task=task, step_key="a", attempt=1, mode="auto",
            status=review_status, engine="claude", started_at=now,
        )
        Message.create(
            id="exec-a-1", task=task, step_key="a", channel="execution",
            role="assistant", content="A 已完成", run_status="running",
            step_run_id=step_run.id, position=1, created_at=now,
        )
        Message.create(
            id="review-message-a-1", task=task, step_key="a",
            channel="review", role="assistant", content="审核中",
            run_status="running", step_run_id=step_run.id,
            event_log_path=review_ref.relative_path if review_ref else None,
            position=0, created_at=now,
        )
        task.active_workflow_run_id = run.id
        task.save()

    bus = EventBus()
    runtime = WorkflowRuntime(bus, pm)
    try:
        assert await runtime.recover_running_workflows() == 1
        with pm.activate_project(project.path):
            await _wait_until(lambda: Task.get_by_id(task.id).status == "ready")
            assert TaskStep.get(
                (TaskStep.task == task) & (TaskStep.step_key == "a")
            ).status == "passed"
            assert list(
                StepRun.select().where(
                    (StepRun.run == run) & (StepRun.step_key == "a")
                )
            ) == [step_run]
            reviews = list(
                ReviewRun.select().where(ReviewRun.step_run == step_run)
                .order_by(ReviewRun.attempt)
            )
            assert [(review.attempt, review.status) for review in reviews] == (
                [(1, "failed"), (2, "passed")]
                if review_status == "running" else [(1, "passed")]
            )
            assert Message.get_by_id("exec-a-1").run_status == "succeeded"
            if review_status == "running":
                interrupted_message = Message.get_by_id("review-message-a-1")
                assert interrupted_message.run_status == "failed"
                interrupted = next(
                    item for item in get_task_history(task.id, project.workstep_dir)
                    if item["id"] == "review-message-a-1"
                )
                assert interrupted["session_id"] == "interrupted-review-session"
            else:
                assert Message.get_by_id("review-message-a-1").run_status == "completed"
            system_message = Message.get_by_id("review-message-a-1")
            assert system_message.author_type == "system"
            assert system_message.author_username == "system"
            assert system_message.initiated_by_user_id == "review-user"
            assert system_message.initiated_by_username == "reviewer"
        assert len(RecoveryFakeEngine.prompts) == (1 if review_status == "running" else 0)
        if review_status == "running":
            assert "step review agent" in RecoveryFakeEngine.prompts[0]
    finally:
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)


def test_review_journal_placeholder_is_not_a_session_id():
    from services.history import session_id_from_journal_path

    message = SimpleNamespace(
        id="review-message", task_id="task", channel="review",
        event_log_path="event_logs/task-task/review-message/review-message.jsonl",
    )
    assert session_id_from_journal_path(message) is None
    message.event_log_path = (
        "event_logs/task-task/review-session/review-message.jsonl"
    )
    assert session_id_from_journal_path(message) == "review-session"


@pytest.mark.anyio
async def test_recovery_preserves_direct_entry_and_boundary_inputs(tmp_path):
    """Recovery must not expand a direct-C run back to skipped A/B."""
    from engines.core.registry import ENGINE_REGISTRY

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = RecoveryFakeEngine
    pm = ProjectManager()
    project = pm.init_project(tmp_path / "proj", name="Recovery entry")
    now = utc_now()
    with pm.activate_project(project.path):
        task = Task.create(
            id="task-entry-rec",
            title="Direct C",
            description="Recover C only",
            cwd=str(project.path),
            engine="claude",
            status="running",
            created_at=now,
            updated_at=now,
        )
        TaskStep.create(task=task, step_key="a", status="skipped")
        TaskStep.create(task=task, step_key="b", status="skipped")
        TaskStep.create(task=task, step_key="c", status="running")
        project.steps = {
            "nodes": [
                {
                    "id": 1, "type": "a", "title": "A",
                    "engine": "claude", "prompt": "Do A",
                    "outputs": [{"name": "A2"}],
                },
                {
                    "id": 2, "type": "b", "title": "B",
                    "engine": "claude", "prompt": "Do B",
                    "outputs": [{"name": "B1"}],
                },
                {
                    "id": 3, "type": "c", "title": "C",
                    "engine": "claude", "prompt": "Do C",
                    "inputs": [{"name": "A2"}, {"name": "B1"}],
                },
            ],
            "connections": [
                {"from": 1, "fromPort": 0, "to": 3, "toPort": 0},
                {"from": 2, "fromPort": 0, "to": 3, "toPort": 1},
            ],
        }
        run = WorkflowRun.create(
            id="run-entry-rec",
            task=task,
            status="running",
            workflow_schema_version=1,
            workflow_snapshot_json="{}",
            restart_from_step_key="c",
            routing_state_json=json.dumps({
                "active_edges": [],
                "return_counts": {},
                "feedback_inputs": {},
                "routed_rounds": {},
                "entry_step_key": "c",
                "execution_scope": ["c"],
            }),
            started_at=now,
        )
        StepRun.create(
            id="step-c-entry-1",
            run=run,
            step_key="c",
            attempt=1,
            status="running",
            engine="claude",
            started_at=now,
        )
        task.active_workflow_run_id = run.id
        task.save()

    bus = EventBus()
    runtime = WorkflowRuntime(bus, pm)
    try:
        assert await runtime.recover_running_workflows() == 1
        with pm.activate_project(project.path):
            await _wait_until(
                lambda: Task.get_by_id(task.id).status == "ready"
            )
            assert {
                row.step_key: row.status
                for row in TaskStep.select().where(TaskStep.task == task)
            } == {"a": "skipped", "b": "skipped", "c": "passed"}
        assert len(RecoveryFakeEngine.prompts) == 1
        assert "Do C" in RecoveryFakeEngine.prompts[0]
        assert "Do A" not in RecoveryFakeEngine.prompts[0]
        assert "Do B" not in RecoveryFakeEngine.prompts[0]
        assert RecoveryFakeEngine.prompts[0].count(
            "Use the task title, description, dispatched inputs"
        ) == 2
    finally:
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)


@pytest.mark.anyio
async def test_online_reconciler_recovers_own_running_run_without_runner(tmp_path):
    """进程仍存活但 runner 丢失时，在线巡检接管本实例的孤儿运行。"""
    original, pm, project, run_id = _project_with_run(tmp_path)
    runtime = WorkflowRuntime(EventBus(), pm)
    try:
        with pm.activate_project(project.path):
            WorkflowRun.update(
                owner_id=runtime._leases.instance_id,
                heartbeat_at=utc_now(),
            ).where(WorkflowRun.id == run_id).execute()

        assert await runtime.reconcile_orphaned_workflows() == 1

        with pm.activate_project(project.path):
            await _wait_until(
                lambda: Task.get_by_id("task-rec").status == "ready"
            )
            assert WorkflowRun.get_by_id(run_id).status == "succeeded"
            attempts = list(
                StepRun.select()
                .where(
                    (StepRun.run == run_id)
                    & (StepRun.step_key == "b")
                )
                .order_by(StepRun.attempt)
            )
            assert [attempt.status for attempt in attempts] == [
                "failed",
                "succeeded",
            ]
    finally:
        await runtime.shutdown()
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
            events_json=json.dumps([{
                "type": "interaction_request",
                "data": {
                    "interaction_id": "ask-1",
                    "method": "session/request_permission",
                },
                "timestamp": 1,
            }], ensure_ascii=False),
            position=0,
            started_at=now,
            created_at=now,
        )
        old_run = WorkflowRun.create(
            id="old-run-b", task=task, status="superseded",
            workflow_schema_version=1, workflow_snapshot_json="{}",
            started_at=now - timedelta(hours=1), ended_at=now - timedelta(minutes=30),
        )
        old_step = StepRun.create(
            id="old-step-b", run=old_run, step_key="b", attempt=1,
            status="succeeded", engine="claude",
            started_at=now - timedelta(hours=1), ended_at=now - timedelta(minutes=59),
        )
        Message.create(
            id="old-msg-b", task=task, channel="execution", step_key="b",
            role="assistant", run_status="running", step_run_id=old_step.id,
            position=0, started_at=now - timedelta(hours=1),
            created_at=now - timedelta(hours=1),
        )
    bus = EventBus()
    runtime = WorkflowRuntime(bus, pm)
    try:
        await runtime.recover_running_workflows()
        with pm.activate_project(project.path):
            message = Message.get_by_id("msg-b")
            assert message.run_status == "failed"
            assert message.ended_at is not None
            assert Message.get_by_id("old-msg-b").run_status == "running"
            sealed = json.loads(message.events_json)
            assert [event["type"] for event in sealed] == [
                "interaction_request",
                "interaction_response",
            ]
            assert sealed[1]["data"]["interaction_id"] == "ask-1"
            assert sealed[1]["data"]["response"] == {
                "outcome": {"outcome": "cancelled"},
            }
    finally:
        await bus.close()
        from engines.core.registry import ENGINE_REGISTRY
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)


@pytest.mark.anyio
async def test_recovery_projects_interrupted_jsonl_message_back_to_sqlite(tmp_path):
    from agent_assistants.event_journal import TurnEventJournal
    from models import Message

    original, pm, project, _ = _project_with_run(tmp_path)
    journal = TurnEventJournal()
    ref = journal.start(project.workstep_dir, "task-task-rec", "msg-jsonl")
    journal.record(ref, {
        "type": "agent_message_chunk",
        "data": {"content": {"text": "中断前回复"}},
    })
    journal.record(ref, {
        "type": "interaction_request",
        "data": {
            "interaction_id": "ask-jsonl",
            "method": "session/request_permission",
        },
    })
    journal.sync(ref, durable=True)
    with pm.activate_project(project.path):
        task = Task.get_by_id("task-rec")
        now = utc_now()
        Message.create(
            id="msg-jsonl",
            task=task,
            channel="execution",
            step_key="b",
            role="assistant",
            run_id="msg-jsonl",
            run_status="running",
            event_log_path=ref.relative_path,
            position=0,
            started_at=now,
            created_at=now,
        )

    bus = EventBus()
    runtime = WorkflowRuntime(bus, pm)
    try:
        await runtime.recover_running_workflows()
        with pm.activate_project(project.path):
            message = Message.get_by_id("msg-jsonl")
            assert message.run_status == "failed"
            assert message.content == "中断前回复"
            assert message.event_count == 3
            sealed = json.loads(message.events_json)
            assert [event["type"] for event in sealed] == [
                "interaction_request",
                "interaction_response",
            ]
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
async def test_e2e_three_step_run_resumes_after_crash(tmp_path):
    """A three-stage workflow survives a simulated daemon crash."""
    from engines.core.registry import ENGINE_REGISTRY
    from services.task_read_model import task_to_dict

    class CrashStepEngine(RecoveryFakeEngine):
        """Hangs on the first invocation of stage b (an in-flight crash)."""

        started: asyncio.Event | None = None
        invocation_count = 0

        async def spawn(self, prompt, cwd, **kwargs):
            key = "b" if "Do B" in prompt else ("a" if "Do A" in prompt else "c")
            if key == "b":
                CrashStepEngine.invocation_count += 1
                if CrashStepEngine.invocation_count == 1:
                    if CrashStepEngine.started is not None:
                        CrashStepEngine.started.set()
                    await asyncio.Event().wait()
                    if False:
                        yield InternalEvent(type="status", data={"status": "done"})
            yield InternalEvent(type="agent_message_chunk", data={"content": {"text": f"{key} output"}})
            yield InternalEvent(type="status", data={"status": "done"})

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = CrashStepEngine
    started = asyncio.Event()
    CrashStepEngine.started = started
    CrashStepEngine.invocation_count = 0

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
        from services.remote_access import ActorSnapshot, actor_context

        with actor_context(ActorSnapshot(
            actor_id="recovery-user", user_name="Recovery User",
            device_id="recovery-device", device_name="Test Device",
            source="local", username="recovery-user",
        )):
            handle = await runtime1.start(project.id, task_id, "")
        await asyncio.wait_for(started.wait(), timeout=2)
        run_id = handle.id

        # The daemon "crashes": runtime1 is abandoned without graceful
        # shutdown, so the run stays ``running`` in the DB with stage b in
        # flight. A dead process stops renewing its run lease, so expire the
        # heartbeat (and halt runtime1's lease loop) before a fresh daemon
        # instance recovers it.
        if runtime1._leases._heartbeat_task is not None:
            runtime1._leases._heartbeat_task.cancel()
        from datetime import timedelta

        from services.workflow_lease import RUN_LEASE_STALE_SECONDS

        with pm.activate_project(project.path):
            WorkflowRun.update(
                heartbeat_at=utc_now() - timedelta(seconds=RUN_LEASE_STALE_SECONDS + 5)
            ).where(WorkflowRun.id == run_id).execute()
        assert await runtime2.recover_running_workflows() == 1

        with pm.activate_project(project.path):
            await _wait_until(
                lambda: (
                    Task.get_by_id(task_id).status == "ready"
                    and WorkflowRun.get_by_id(run_id).status == "succeeded"
                )
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
            task_dict = task_to_dict(Task.get_by_id(task_id))
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
        assert CrashStepEngine.invocation_count == 2
    finally:
        await runtime1.shutdown()
        await bus1.close()
        await bus2.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)


@pytest.mark.anyio
async def test_recovery_skips_run_leased_by_live_daemon(tmp_path):
    """A live peer's fresh lease must not be clobbered by startup recovery."""
    original, pm, project, run_id = _project_with_run(tmp_path)
    bus = EventBus()
    runtime = WorkflowRuntime(bus, pm)
    try:
        with pm.activate_project(project.path):
            WorkflowRun.update(
                owner_id="some-other-daemon",
                heartbeat_at=utc_now(),
            ).where(WorkflowRun.id == run_id).execute()

        assert await runtime.recover_running_workflows() == 0

        with pm.activate_project(project.path):
            run = WorkflowRun.get_by_id(run_id)
            # Nothing was rewritten: the in-flight step stays running and the
            # owner is untouched, so the live peer's status writes are safe.
            assert run.owner_id == "some-other-daemon"
            assert run.status == "running"
            assert run.recovered_count == 0
            b_step = StepRun.get(
                (StepRun.run == run) & (StepRun.step_key == "b")
            )
            assert b_step.status == "running"
            assert Task.get_by_id("task-rec").status == "running"
        # A stale-lease retry is scheduled so a genuinely crashed peer is
        # still recovered instead of orphaned.
        assert runtime._leases._retry_tasks
    finally:
        await runtime.shutdown()
        await bus.close()
        from engines.core.registry import ENGINE_REGISTRY as _reg
        _reg.clear()
        _reg.update(original)


@pytest.mark.anyio
async def test_recovery_takes_over_expired_lease(tmp_path):
    """An expired lease from a crashed peer is recovered as before."""
    from datetime import timedelta

    from services.workflow_lease import RUN_LEASE_STALE_SECONDS

    original, pm, project, run_id = _project_with_run(tmp_path)
    bus = EventBus()
    runtime = WorkflowRuntime(bus, pm)
    try:
        with pm.activate_project(project.path):
            WorkflowRun.update(
                owner_id="crashed-daemon",
                heartbeat_at=utc_now()
                - timedelta(seconds=RUN_LEASE_STALE_SECONDS + 5),
            ).where(WorkflowRun.id == run_id).execute()

        assert await runtime.recover_running_workflows() == 1
        with pm.activate_project(project.path):
            await _wait_until(
                lambda: Task.get_by_id("task-rec").status == "ready"
            )
            run = WorkflowRun.get_by_id(run_id)
            assert run.status == "succeeded"
    finally:
        await runtime.shutdown()
        await bus.close()
        from engines.core.registry import ENGINE_REGISTRY as _reg
        _reg.clear()
        _reg.update(original)


@pytest.mark.anyio
async def test_run_lease_claimed_on_start_and_released_on_finish(tmp_path):
    """A started run carries this instance's owner; finishing clears it."""
    from engines.core.registry import ENGINE_REGISTRY

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = RecoveryFakeEngine
    RecoveryFakeEngine.delay = 0.0
    RecoveryFakeEngine.prompts = []

    pm = ProjectManager()
    project = pm.init_project(tmp_path / "proj", name="Lease")
    now = utc_now()
    with pm.activate_project(project.path):
        task = Task.create(
            id="task-lease",
            title="Lease",
            cwd=str(project.path),
            engine="claude",
            created_at=now,
            updated_at=now,
        )
        TaskStep.create(task=task, step_key="a", status="pending", engine="claude")
    project.steps = {
        "nodes": [
            {"id": 1, "type": "a", "title": "A", "engine": "claude", "prompt": "Do A"},
        ],
        "connections": [],
    }

    bus = EventBus()
    runtime = WorkflowRuntime(bus, pm)
    try:
        from services.remote_access import ActorSnapshot, actor_context

        with actor_context(ActorSnapshot(
            actor_id="lease-user", user_name="Lease User",
            device_id="lease-device", device_name="Test Device",
            source="local", username="lease-user",
        )):
            handle = await runtime.start(project.id, "task-lease", "")
        with pm.activate_project(project.path):
            run = WorkflowRun.get_by_id(handle.id)
            assert run.owner_id == runtime._leases.instance_id
            assert run.heartbeat_at is not None
        await asyncio.wait_for(runtime.wait(handle), timeout=5)
        with pm.activate_project(project.path):
            run = WorkflowRun.get_by_id(handle.id)
            assert run.owner_id is None
            assert run.heartbeat_at is None
            assert run.status == "succeeded"
        assert handle.id not in runtime._leases._leased_runs
    finally:
        await runtime.shutdown()
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
