"""Behavior tests for the production workflow runtime interface."""

from contextlib import nullcontext
from types import SimpleNamespace
import asyncio

import pytest
from httpx import ASGITransport, AsyncClient

from engines.core.acp_base import AcpEngineBase
from engines.core.events import InternalEvent
from models import StepRun, Task, TaskStep, WorkflowRun, init_db
from models.fields import utc_now
from streaming.bus import EventBus


class RuntimeFakeEngine(AcpEngineBase):
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
        yield InternalEvent(type="agent_message_chunk", data={"content": {"text": "done"}})
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
def test_user_message_uses_current_task_step(statuses, expected):
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
    from engines.core.registry import ENGINE_REGISTRY
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
            if event.get("type") == "TEXT_MESSAGE_START"
        ]
        assert len(started_events) == 3
        assert all(event.get("created_at") for event in started_events)
        assert sum(1 for event in started_events if event.get("role") == "user") == 1

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
        assert [run.artifact_round for run in step_runs] == [1, 1]
        assert (tmp_path / ".workstep" / "artifacts" / "default" / "task-1" / "req" / "1").is_dir()
        assert (tmp_path / ".workstep" / "artifacts" / "default" / "task-1" / "ui" / "1").is_dir()
    finally:
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_runtime_persists_selected_entry_with_two_boundary_inputs(tmp_path):
    """A selected C entry consumes A2/B1 from task context across recovery."""
    import json

    from engines.core.registry import ENGINE_REGISTRY
    from models import Message
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="task-direct-c",
        title="Direct C",
        description="Deploy the approved build",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    TaskStep.create(task=task, step_key="a", status="skipped")
    TaskStep.create(task=task, step_key="b", status="skipped")
    TaskStep.create(task=task, step_key="c", status="pending")
    project = SimpleNamespace(
        id="project-direct-c",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {
                    "id": 1,
                    "type": "a",
                    "title": "A",
                    "engine": "claude",
                    "prompt": "Run A",
                    "outputs": [{"name": "A2", "type": "md"}],
                },
                {
                    "id": 2,
                    "type": "b",
                    "title": "B",
                    "engine": "claude",
                    "prompt": "Run B",
                    "outputs": [{"name": "B1", "type": "md"}],
                },
                {
                    "id": 3,
                    "type": "c",
                    "title": "C",
                    "engine": "claude",
                    "prompt": "Run C",
                    "inputs": [
                        {"name": "A2", "type": "md"},
                        {"name": "B1", "type": "md"},
                    ],
                },
            ],
            "connections": [
                {"from": 1, "fromPort": 0, "to": 3, "toPort": 0},
                {"from": 2, "fromPort": 0, "to": 3, "toPort": 1},
            ],
        },
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

    prompts = []

    class RecordingEngine(RuntimeFakeEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            prompts.append(prompt)
            yield InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": "done"}},
            )
            yield InternalEvent(type="status", data={"status": "done"})

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = RecordingEngine
    bus = EventBus()
    try:
        runtime = WorkflowRuntime(bus, ProjectManagerStub())
        await runtime.run(project.id, task.id, "")

        assert len(prompts) == 1
        assert "## Task title\nDirect C" in prompts[0]
        assert "## Task description\nDeploy the approved build" in prompts[0]
        assert prompts[0].count(
            "Use the task title, description, dispatched inputs"
        ) == 2
        statuses = {
            row.step_key: row.status
            for row in TaskStep.select().where(TaskStep.task == task)
        }
        assert statuses == {"a": "skipped", "b": "skipped", "c": "passed"}
        workflow_run = WorkflowRun.get(WorkflowRun.task == task)
        routing_state = json.loads(workflow_run.routing_state_json)
        assert workflow_run.restart_from_step_key == "c"
        assert routing_state["entry_step_key"] == "c"
        assert routing_state["execution_scope"] == ["c"]
    finally:
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_switching_from_running_a_to_c_does_not_keep_a_in_child_scope(
    tmp_path,
):
    """Directly selecting C cancels running A instead of carrying it forward."""
    import json

    from engines.core.registry import ENGINE_REGISTRY
    from services.workflow_runtime import WorkflowRuntime

    class BlockingAEngine(RuntimeFakeEngine):
        started = asyncio.Event()
        release = asyncio.Event()

        async def spawn(self, prompt, cwd, **kwargs):
            if "Do A" in prompt:
                type(self).started.set()
                await type(self).release.wait()
                return
            yield InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": "c done"}},
            )
            yield InternalEvent(type="status", data={"status": "done"})

        async def stop(self):
            type(self).release.set()

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="task-switch-a-c",
        title="Switch A to C",
        description="Stop A and run C",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    project = SimpleNamespace(
        id="project-switch-a-c",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {
                    "id": 1, "type": "a", "title": "A",
                    "engine": "claude", "prompt": "Do A",
                    "outputs": [{"name": "A2"}],
                },
                {
                    "id": 2, "type": "c", "title": "C",
                    "engine": "claude", "prompt": "Do C",
                    "inputs": [{"name": "A2"}],
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
    ENGINE_REGISTRY["claude"] = BlockingAEngine
    bus = EventBus()
    runtime = WorkflowRuntime(bus, ProjectManagerStub())
    try:
        first = await runtime.start(project.id, task.id, "")
        await asyncio.wait_for(BlockingAEngine.started.wait(), timeout=1)
        child = await runtime.restart_from_step(project.id, task.id, "c")
        await asyncio.wait_for(runtime.wait(child), timeout=3)
        await asyncio.gather(first._completion, return_exceptions=True)

        child_run = WorkflowRun.get_by_id(child.id)
        assert child_run.restart_from_step_key == "c"
        assert json.loads(child_run.routing_state_json)["execution_scope"] == ["c"]
        assert [
            row.step_key
            for row in StepRun.select().where(StepRun.run == child_run)
        ] == ["c"]
        statuses = {
            row.step_key: row.status
            for row in TaskStep.select().where(TaskStep.task == task)
        }
        assert statuses == {"a": "cancelled", "c": "passed"}
    finally:
        await runtime.shutdown()
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_restart_cancels_parallel_active_steps_and_pending_reviews(tmp_path):
    """Superseding a run closes active parallel work outside the new scope."""
    from engines.core.registry import ENGINE_REGISTRY
    from models import ReviewRun
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(
        id="task-parallel-restart",
        title="Parallel restart",
        cwd=str(tmp_path),
        engine="claude",
        status="running",
        created_at=now,
        updated_at=now,
    )
    project = SimpleNamespace(
        id="project-parallel-restart",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {"id": 1, "type": "a", "title": "A", "engine": "claude"},
                {"id": 2, "type": "b", "title": "B", "engine": "claude"},
                {"id": 3, "type": "c", "title": "C", "engine": "claude"},
            ],
            "connections": [],
        },
    )
    TaskStep.create(task=task, step_key="a", status="running")
    TaskStep.create(task=task, step_key="b", status="awaiting_review")
    TaskStep.create(task=task, step_key="c", status="passed")
    parent = WorkflowRun.create(
        id="parallel-parent",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=now,
    )
    a_run = StepRun.create(
        id="parallel-a-run",
        run=parent,
        step_key="a",
        attempt=1,
        status="running",
        engine="claude",
        started_at=now,
    )
    b_run = StepRun.create(
        id="parallel-b-run",
        run=parent,
        step_key="b",
        attempt=1,
        status="succeeded",
        engine="claude",
        started_at=now,
        ended_at=now,
    )
    review = ReviewRun.create(
        id="parallel-b-review",
        workflow_run=parent,
        step_run=b_run,
        task=task,
        step_key="b",
        attempt=1,
        mode="manual",
        status="pending",
        started_at=now,
    )
    task.active_workflow_run_id = parent.id
    task.save()

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = RuntimeFakeEngine
    bus = EventBus()
    runtime = WorkflowRuntime(bus, ProjectManagerStub())
    try:
        child = await runtime.restart_from_step(project.id, task.id, "c")
        await asyncio.wait_for(runtime.wait(child), timeout=3)

        statuses = {
            row.step_key: row.status
            for row in TaskStep.select().where(TaskStep.task == task)
        }
        assert statuses == {"a": "cancelled", "b": "cancelled", "c": "passed"}
        assert StepRun.get_by_id(a_run.id).status == "cancelled"
        assert ReviewRun.get_by_id(review.id).status == "cancelled"
    finally:
        await runtime.shutdown()
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_runtime_merges_pending_inserts_after_step_finishes(tmp_path):
    """阶段结束后由后端合并待插入消息并重跑，不依赖页面存活。"""
    from engines.core.registry import ENGINE_REGISTRY
    from models import Message, PendingMessageInsert
    from services.pending_message_inserts import create_pending_insert
    from services.workflow_runtime import WorkflowRuntime

    class BlockingFirstRunEngine(RuntimeFakeEngine):
        calls = 0
        started = asyncio.Event()
        release = asyncio.Event()

        async def spawn(self, prompt, cwd, **kwargs):
            type(self).calls += 1
            if type(self).calls == 1:
                type(self).started.set()
                await type(self).release.wait()
            yield InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": "done"}},
            )

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="task-pending-stage",
        title="Pending stage inserts",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    project = SimpleNamespace(
        id="project-pending-stage",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {"id": 1, "type": "do", "title": "执行", "engine": "claude"}
            ],
            "connections": [],
        },
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = BlockingFirstRunEngine
    bus = EventBus()
    runtime = WorkflowRuntime(bus, ProjectManagerStub())
    try:
        first_run = asyncio.create_task(runtime.run(project.id, task.id, "开始"))
        await asyncio.wait_for(BlockingFirstRunEngine.started.wait(), timeout=1)
        target = (
            Message.select()
            .where(
                (Message.task == task)
                & (Message.channel == "execution")
                & (Message.role == "assistant")
                & (Message.run_status == "running")
            )
            .get()
        )
        create_pending_insert(target.id, "补充第一条", "测试用户")
        create_pending_insert(target.id, "补充第二条", "测试用户")

        BlockingFirstRunEngine.release.set()
        await asyncio.wait_for(first_run, timeout=3)
        for _ in range(200):
            merged = Message.get_or_none(
                (Message.task == task)
                & (Message.role == "user")
                & (Message.content == "补充第一条\n\n补充第二条")
            )
            if merged is not None and BlockingFirstRunEngine.calls == 2:
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("pending stage inserts were not consumed")

        assert merged.author_name == "测试用户"
        assert PendingMessageInsert.select().count() == 0
    finally:
        await runtime.shutdown()
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_restart_without_parent_reuses_passed_upstream_steps(tmp_path):
    """A legacy task retry starts at the requested stage, not its prerequisites."""
    from engines.core.registry import ENGINE_REGISTRY
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
        handle = await runtime.restart_from_step(
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
async def test_restart_without_parent_rejects_unusable_input_round(tmp_path):
    """显式沿用上游产物时，轮次必须存在且可被下游继承。"""
    from engines.core.registry import ENGINE_REGISTRY
    from services.artifact_rounds import write_round_manifest
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(
        id="task-invalid-input-round",
        title="Invalid input round",
        cwd=str(tmp_path),
        engine="claude",
        created_at=now,
        updated_at=now,
    )
    project = SimpleNamespace(
        id="project-invalid-input-round",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {"id": 1, "type": "req", "title": "Requirement", "engine": "claude"},
                {"id": 2, "type": "ui", "title": "UI", "engine": "claude"},
            ],
            "connections": [{"from": 1, "to": 2}],
        },
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

    write_round_manifest(
        artifacts_root=tmp_path / ".workstep" / "artifacts",
        workflow_id=None,
        task_id=task.id,
        step_key="req",
        artifact_round=1,
        status="passed",
        eligible_for_downstream=True,
    )
    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = RuntimeFakeEngine
    try:
        with pytest.raises(ValueError, match="不可沿用"):
            await runtime.restart_from_step(
                project.id,
                task.id,
                "ui",
                input_rounds={"req": 2},
            )
        with pytest.raises(ValueError, match="不是目标步骤"):
            await runtime.restart_from_step(
                project.id,
                task.id,
                "ui",
                input_rounds={"missing": 1},
            )
        assert TaskStep.select().where(TaskStep.task == task).count() == 0
    finally:
        await runtime.shutdown()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_restart_downstream_step_skips_failed_upstream(tmp_path):
    """@ 下游阶段时，失败的上游不会被 DAG 判定为 ready 而抢先执行。"""
    import json

    from engines.core.registry import ENGINE_REGISTRY
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(
        id="task-restart-downstream",
        title="Restart downstream",
        cwd=str(tmp_path),
        engine="claude",
        created_at=now,
        updated_at=now,
    )
    # req -> backend -> frontend -> test
    project = SimpleNamespace(
        id="project-restart-downstream",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {"id": 1, "type": "req", "title": "需求", "engine": "claude"},
                {"id": 2, "type": "backend", "title": "后端", "engine": "claude"},
                {"id": 3, "type": "frontend", "title": "前端", "engine": "claude"},
                {"id": 4, "type": "test", "title": "测试", "engine": "claude"},
            ],
            "connections": [
                {"from": 1, "to": 2},
                {"from": 2, "to": 3},
                {"from": 3, "to": 4},
            ],
        },
    )
    parent = WorkflowRun.create(
        id="run-restart-downstream-parent",
        task=task,
        status="superseded",
        workflow_schema_version=1,
        workflow_snapshot_json=json.dumps(project.steps),
        started_at=now,
        ended_at=now,
    )
    task.active_workflow_run_id = parent.id
    task.save()
    for step_key, status in (
        ("req", "passed"),
        ("backend", "failed"),
        ("frontend", "pending"),
        ("test", "pending"),
    ):
        TaskStep.create(
            task=task,
            step_key=step_key,
            status=status,
            engine="claude",
            started_at=now if status == "passed" else None,
            ended_at=now if status == "passed" else None,
        )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            return nullcontext(project)

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = RuntimeFakeEngine
    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
    try:
        handle = await runtime.restart_from_step(
            project.id,
            task.id,
            "frontend",
        )
        await runtime.wait(handle)

        child = WorkflowRun.get_by_id(handle.id)
        step_runs = {
            run.step_key: run.status
            for run in StepRun.select().where(StepRun.run == child)
        }
        # 只应重跑 frontend 及其下游 test；失败的上游 backend 不再执行，
        # 但仍保留其真实状态（不能改成 skipped，否则前端会把该阶段隐藏）。
        assert step_runs["frontend"] == "succeeded"
        assert step_runs["test"] == "succeeded"
        assert step_runs.get("backend") != "succeeded"
        backend_step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "backend")
        )
        assert backend_step.status == "failed"
        frontend_step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "frontend")
        )
        assert frontend_step.status == "passed"
    finally:
        await runtime.shutdown()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_rerun_upstream_with_new_artifact_restarts_previously_blocked_downstream(
    tmp_path,
):
    """上游首次缺产物导致下游失败后，重跑产生产物应继续调度下游。"""
    import re
    from pathlib import Path

    from engines.core.registry import ENGINE_REGISTRY
    from models import ReviewRun
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(
        id="task-restart-after-missing-output",
        title="Restart after missing output",
        cwd=str(tmp_path),
        engine="conditional-writer",
        created_at=now,
        updated_at=now,
    )
    workflow = {
        "nodes": [
            {
                "id": 1,
                "type": "design",
                "title": "方案",
                "engine": "conditional-writer",
                "outputs": [{"name": "方案目录", "type": "directory"}],
                "review": {"mode": "manual", "maxRetries": 1},
            },
            {
                "id": 2,
                "type": "handoff",
                "title": "流转",
                "engine": "conditional-writer",
                "inputs": [{"name": "方案目录", "type": "directory"}],
            },
        ],
        "connections": [
            {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
        ],
    }
    project = SimpleNamespace(
        id="project-restart-after-missing-output",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps=workflow,
    )
    producer_calls = 0
    downstream_calls = 0

    class ConditionalWriterEngine(RuntimeFakeEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            nonlocal producer_calls, downstream_calls
            match = re.search(r"output directory: `([^`]+?)/?`", prompt)
            if match:
                producer_calls += 1
                if producer_calls >= 2:
                    output_dir = Path(match.group(1))
                    output_dir.mkdir(parents=True, exist_ok=True)
                    (output_dir / "result.md").write_text("ready", encoding="utf-8")
            else:
                downstream_calls += 1
            yield InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": "done"}},
            )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["conditional-writer"] = ConditionalWriterEngine
    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
    try:
        await runtime.run(project.id, task.id)
        first_review = (
            ReviewRun.select()
            .where((ReviewRun.task == task) & (ReviewRun.step_key == "design"))
            .order_by(ReviewRun.started_at.desc())
            .get()
        )
        resumed = await runtime.decide_review(
            project.id,
            task.id,
            "design",
            first_review.id,
            "approve",
        )
        assert resumed is not None
        await runtime.wait(resumed)
        assert TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "handoff")
        ).status == "failed"
        assert downstream_calls == 0

        handle = await runtime.restart_from_step(project.id, task.id, "design")
        await runtime.wait(handle)

        latest_review = (
            ReviewRun.select()
            .where((ReviewRun.task == task) & (ReviewRun.step_key == "design"))
            .order_by(ReviewRun.started_at.desc())
            .get()
        )
        resumed = await runtime.decide_review(
            project.id,
            task.id,
            "design",
            latest_review.id,
            "approve",
        )
        assert resumed is not None
        await runtime.wait(resumed)

        assert producer_calls == 2
        assert downstream_calls == 1
        assert TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "handoff")
        ).status == "passed"
        assert Task.get_by_id(task.id).status == "ready"
    finally:
        await runtime.shutdown()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_restart_from_step_picks_up_edited_engine(tmp_path):
    """编辑流程更换阶段引擎后，重跑该阶段应使用新引擎而非父 run 快照。"""
    import json

    from engines.core.registry import ENGINE_REGISTRY
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(
        id="task-engine-change",
        title="Engine change on restart",
        cwd=str(tmp_path),
        engine="engine-a",
        created_at=now,
        updated_at=now,
    )

    # 编辑后（当前）的流程：阶段 do 改用 engine-b
    project = SimpleNamespace(
        id="project-engine-change",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {"id": 1, "type": "do", "title": "执行", "engine": "engine-b"},
            ],
            "connections": [],
        },
    )

    # 父 run 的快照：阶段 do 仍是编辑前的 engine-a
    parent = WorkflowRun.create(
        id="run-parent",
        task=task,
        status="superseded",
        workflow_schema_version=1,
        workflow_snapshot_json=json.dumps(
            {
                "nodes": [
                    {"id": 1, "type": "do", "title": "执行", "engine": "engine-a"},
                ],
                "connections": [],
            }
        ),
        started_at=now,
        ended_at=now,
    )
    task.active_workflow_run_id = parent.id
    task.save()
    TaskStep.create(
        task=task,
        step_key="do",
        status="failed",
        engine="engine-a",
        started_at=now,
        ended_at=now,
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["engine-a"] = RuntimeFakeEngine
    ENGINE_REGISTRY["engine-b"] = RuntimeFakeEngine
    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
    try:
        handle = await runtime.restart_from_step(project.id, task.id, "do")
        await runtime.wait(handle)

        child = WorkflowRun.get_by_id(handle.id)
        assert child.parent_run_id == parent.id
        # 子 run 不再复制完整流程；实际执行直接采用当前流程（engine-b）。
        assert json.loads(child.workflow_snapshot_json) == {}

        step_run = (
            StepRun.select()
            .where((StepRun.run == child) & (StepRun.step_key == "do"))
            .order_by(StepRun.attempt.desc())
            .first()
        )
        assert step_run.status == "succeeded"
        assert step_run.engine == "engine-b"
        assert json.loads(step_run.io_contract_json) == {
            "inputs": [],
            "outputs": [],
        }

        step = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "do"))
        assert step.status == "passed"
        assert step.engine == "engine-b"
    finally:
        await runtime.shutdown()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
@pytest.mark.parametrize("manifest_output_mode", ["missing", "empty"])
async def test_restart_routes_reused_round_even_when_legacy_manifest_is_stale(
    tmp_path,
    manifest_output_mode,
):
    """A passed reused stage remains routable when its old manifest was not updated."""
    import json

    from engines.core.registry import ENGINE_REGISTRY
    from services.artifact_rounds import step_round_dir, write_round_manifest
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(
        id="task-stale-reused-manifest",
        title="Restart review",
        cwd=str(tmp_path),
        engine="claude",
        workflow_id="workflow-1",
        created_at=now,
        updated_at=now,
    )
    workflow = {
        "nodes": [
            {
                "id": 1,
                "type": "write",
                "title": "Write",
                "engine": "claude",
                "outputs": [{"name": "draft", "type": "md"}],
            },
            {
                "id": 2,
                "type": "review",
                "title": "Review",
                "engine": "claude",
                "inputs": [{"name": "draft", "type": "md"}],
            },
            {
                "id": 3,
                "type": "publish",
                "title": "Publish",
                "engine": "claude",
            },
            {
                "id": 4,
                "type": "manual-extra",
                "title": "Manual extra",
                "engine": "claude",
            },
        ],
        "connections": [
            {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
            {"from": 2, "fromPort": 0, "to": 3, "toPort": 0},
        ],
    }
    project = SimpleNamespace(
        id="project-stale-reused-manifest",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps=workflow,
        workflow_by_id=lambda workflow_id: (
            {"id": workflow_id, "steps": workflow}
            if workflow_id == "workflow-1"
            else None
        ),
    )
    parent = WorkflowRun.create(
        id="run-stale-reused-parent",
        task=task,
        status="succeeded",
        workflow_schema_version=1,
        workflow_snapshot_json=json.dumps(workflow),
        started_at=now,
        ended_at=now,
    )
    task.active_workflow_run_id = parent.id
    task.save()
    for step_key, status in (
        ("write", "passed"),
        ("review", "passed"),
        ("publish", "passed"),
        ("manual-extra", "pending"),
    ):
        TaskStep.create(
            task=task,
            step_key=step_key,
            status=status,
            engine="claude",
            started_at=now if status == "passed" else None,
            ended_at=now if status == "passed" else None,
        )
    source_run = StepRun.create(
        id="step-run-stale-write",
        run=parent,
        step_key="write",
        attempt=1,
        artifact_round=1,
        status="succeeded",
        engine="claude",
        started_at=now,
        ended_at=now,
    )
    round_dir = step_round_dir(
        project.workstep_dir / "artifacts",
        task.workflow_id,
        task.id,
        "write",
        1,
    )
    round_dir.mkdir(parents=True, exist_ok=True)
    (round_dir / "draft.md").write_text("approved draft", encoding="utf-8")
    write_round_manifest(
        artifacts_root=project.workstep_dir / "artifacts",
        workflow_id=task.workflow_id,
        task_id=task.id,
        step_key="write",
        artifact_round=1,
        workflow_run_id=parent.id,
        step_run_id=source_run.id,
        status="awaiting_review",
        eligible_for_downstream=False,
        outputs=[{"name": "draft", "type": "md"}],
    )
    # Older WorkStep versions only recorded the artifact list.  Reusing one
    # of those rounds must still restore its outgoing forward route.
    manifest_path = round_dir / "manifest.json"
    legacy_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest_output_mode == "missing":
        legacy_manifest.pop("outputs")
    else:
        legacy_manifest["outputs"] = []
    manifest_path.write_text(
        json.dumps(legacy_manifest, ensure_ascii=False),
        encoding="utf-8",
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = RuntimeFakeEngine
    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
    try:
        handle = await runtime.restart_from_step(
            project.id,
            task.id,
            "review",
        )
        await runtime.wait(handle)

        child = WorkflowRun.get_by_id(handle.id)
        runs = {
            row.step_key: row.status
            for row in StepRun.select().where(StepRun.run == child)
        }
        assert runs == {
            "write": "reused",
            "review": "succeeded",
            "publish": "succeeded",
        }
        assert TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "review")
        ).status == "passed"
        assert TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "publish")
        ).status == "passed"
        assert TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "manual-extra")
        ).status == "pending"
    finally:
        await runtime.shutdown()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("previous_engine", "current_engine", "expected_input_session", "expected_saved_session"),
    [
        ("resumable", "resumable", "session-original", "session-original"),
        ("old-engine", "resumable", None, "session-new"),
    ],
)
async def test_completed_step_message_uses_session_only_for_same_engine(
    tmp_path,
    previous_engine,
    current_engine,
    expected_input_session,
    expected_saved_session,
):
    """完成阶段重跑时，同引擎复用会话，换引擎创建新会话。"""
    import json

    from engines.core.registry import ENGINE_REGISTRY
    from models import Message
    from services.workflow_runtime import WorkflowRuntime

    received_session_ids = []

    class ResumableFakeEngine(RuntimeFakeEngine):
        @property
        def supports_resume(self):
            return True

        async def spawn(self, prompt, cwd, **kwargs):
            received_session_ids.append(kwargs.get("session_id"))
            if kwargs.get("session_id") is None:
                yield InternalEvent(
                    type="session_started",
                    data={"session_id": "session-new"},
                )
            yield InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": "done again"}},
            )

    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(
        id="task-rerun-completed",
        title="Rerun completed stage",
        cwd=str(tmp_path),
        engine=current_engine,
        created_at=now,
        updated_at=now,
    )
    project = SimpleNamespace(
        id="project-rerun-completed",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {"id": 1, "type": "done", "title": "完成阶段", "engine": current_engine},
            ],
            "connections": [],
        },
    )
    parent = WorkflowRun.create(
        id="run-completed-parent",
        task=task,
        status="succeeded",
        workflow_schema_version=1,
        workflow_snapshot_json=json.dumps(project.steps),
        started_at=now,
        ended_at=now,
    )
    task.active_workflow_run_id = parent.id
    task.save()
    TaskStep.create(
        task=task,
        step_key="done",
        status="passed",
        # This field may already have been synchronized to the edited
        # workflow before the rerun starts; message history remains the
        # authoritative engine provenance for the saved session.
        engine=current_engine,
        session_id="session-original",
        started_at=now,
        ended_at=now,
    )
    Message.create(
        id="previous-stage-response",
        task=task,
        channel="execution",
        step_key="done",
        sequence=1,
        role="assistant",
        engine=previous_engine,
        content="previous output",
        run_status="succeeded",
        position=1,
        started_at=now,
        ended_at=now,
        created_at=now,
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["resumable"] = ResumableFakeEngine
    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
    try:
        accepted = await runtime.resume_step_with_message(
            project.id,
            task.id,
            "done",
            "继续完善结果",
        )
        for _ in range(500):
            if task.id not in runtime._runners:
                break
            await asyncio.sleep(0.01)
        assert task.id not in runtime._runners

        assert received_session_ids == [expected_input_session]
        step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "done")
        )
        assert step.status == "passed"
        assert step.session_id == expected_saved_session
    finally:
        await runtime.shutdown()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_task_step_engine_override_hands_off_history_by_file_once(tmp_path):
    """当前任务换引擎后，以文件引用交接阶段历史且不复用旧 session。"""
    import json

    from engines.core.registry import ENGINE_REGISTRY
    from models import Message
    from services.workflow_runtime import WorkflowRuntime

    prompts: list[str] = []
    received_sessions: list[str | None] = []

    class TargetEngine(RuntimeFakeEngine):
        @property
        def supports_resume(self):
            return True

        async def spawn(self, prompt, cwd, **kwargs):
            prompts.append(prompt)
            received_sessions.append(kwargs.get("session_id"))
            yield InternalEvent(
                type="session_started",
                data={"session_id": "target-session"},
            )
            yield InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": "new output"}},
            )

    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(
        id="task-stage-handoff",
        title="Stage handoff",
        cwd=str(tmp_path),
        engine="engine-a",
        created_at=now,
        updated_at=now,
    )
    project = SimpleNamespace(
        id="project-stage-handoff",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [{
                "id": 1,
                "type": "do",
                "title": "执行",
                "engine": "engine-a",
                "prompt": "完成任务",
            }],
            "connections": [],
        },
    )
    parent = WorkflowRun.create(
        id="run-stage-handoff-parent",
        task=task,
        status="succeeded",
        workflow_schema_version=1,
        workflow_snapshot_json=json.dumps(project.steps),
        started_at=now,
        ended_at=now,
    )
    task.active_workflow_run_id = parent.id
    task.save()
    TaskStep.create(
        task=task,
        step_key="do",
        status="passed",
        engine="engine-a",
        session_id="source-session",
        started_at=now,
        ended_at=now,
    )
    Message.create(
        id="old-stage-user",
        task=task,
        channel="execution",
        step_key="do",
        sequence=1,
        role="user",
        content="保留旧约束",
        run_status="completed",
        position=0,
        created_at=now,
    )
    Message.create(
        id="old-stage-assistant",
        task=task,
        channel="execution",
        step_key="do",
        sequence=2,
        role="assistant",
        engine="engine-a",
        content="旧阶段结果",
        run_status="succeeded",
        position=1,
        created_at=now,
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["engine-b"] = TargetEngine
    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
    try:
        await runtime.update_step_execution_config(
            project.id,
            task.id,
            "do",
            engine="engine-b",
            model=None,
            config={},
            context_mode="smart",
        )
        await runtime.resume_step_with_message(
            project.id, task.id, "do", "继续处理"
        )
        for _ in range(500):
            if task.id not in runtime._runners:
                break
            await asyncio.sleep(0.01)
        assert task.id not in runtime._runners

        assert received_sessions == [None]
        assert len(prompts) == 1
        assert "<workstep_context_handoff>" in prompts[0]
        assert "handoffs.jsonl" in prompts[0]
        assert "保留旧约束" not in prompts[0]
        step = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "do"))
        assert step.pending_handoff_json is None
        handoff_files = list((tmp_path / ".workstep" / "event_logs").rglob("handoffs.jsonl"))
        assert len(handoff_files) == 1
        records = [json.loads(line) for line in handoff_files[0].read_text().splitlines()]
        assert any(item["type"] == "handoff_consumed" for item in records)
    finally:
        await runtime.shutdown()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_task_step_provider_override_hands_off_history_without_session(tmp_path):
    """同引擎换供应商时，即使旧运行无可复用 session，也保留阶段历史交接。"""
    import json

    from engines.core.registry import ENGINE_REGISTRY
    from models import Message
    from services.workflow_runtime import WorkflowRuntime

    class ProviderEngine(RuntimeFakeEngine):
        ENGINE_ID = "provider-engine"

        @classmethod
        def supported_provider_protocols(cls):
            return {"anthropic_messages"}

    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(
        id="task-stage-provider-handoff",
        title="Stage provider handoff",
        cwd=str(tmp_path),
        engine="provider-engine",
        created_at=now,
        updated_at=now,
    )
    project = SimpleNamespace(
        id="project-stage-provider-handoff",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [{
                "id": 1,
                "type": "do",
                "title": "执行",
                "engine": "provider-engine",
                "config": {"provider_id": "provider-a"},
                "prompt": "完成任务",
            }],
            "connections": [],
        },
    )
    TaskStep.create(
        task=task,
        step_key="do",
        status="passed",
        engine="provider-engine",
        session_id=None,
        started_at=now,
        ended_at=now,
    )
    Message.create(
        id="old-provider-stage-response",
        task=task,
        channel="execution",
        step_key="do",
        sequence=1,
        role="assistant",
        engine="provider-engine",
        content="旧供应商阶段结果",
        run_status="succeeded",
        position=1,
        created_at=now,
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["provider-engine"] = ProviderEngine
    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
    try:
        await runtime.update_step_execution_config(
            project.id,
            task.id,
            "do",
            engine="provider-engine",
            model=None,
            config={"provider_id": "provider-b"},
            context_mode="smart",
        )

        step = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "do"))
        metadata = json.loads(step.pending_handoff_json or "{}")
        assert metadata["source_engine"] == "provider-engine"
        assert metadata["target_engine"] == "provider-engine"
        assert metadata["source_provider"] == "provider-a"
        assert metadata["target_provider"] == "provider-b"
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
async def test_runtime_start_publishes_user_message_live_event(tmp_path, monkeypatch):
    """远端 B 需要在 A 启动任务时立即看到用户输入，而不是等重新打开详情。"""
    from models import Message
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="task-live-start",
        title="Live start",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    project = SimpleNamespace(
        id="project-live-start",
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

    class RecordingEventBus(EventBus):
        def __init__(self):
            super().__init__()
            self.events = []

        async def publish(self, event):
            self.events.append(event)
            await super().publish(event)

    bus = RecordingEventBus()
    runtime = WorkflowRuntime(bus, ProjectManagerStub())

    async def skip_execution(**kwargs):
        return kwargs["workflow_run"].id

    monkeypatch.setattr(runtime, "_execute", skip_execution)
    try:
        handle = await runtime.start(project.id, task.id, "Build it")
        user_start = next(
            event for event in bus.events
            if event.get("type") == "TEXT_MESSAGE_START"
            and event.get("role") == "user"
        )
        assert user_start["messageId"]
        assert user_start["task_id"] == task.id
        assert user_start["channel"] == "execution"
        assert user_start["step_key"] == "req"
        assert user_start["content"] == "Build it"

        await runtime.wait(handle)
    finally:
        db.close()


@pytest.mark.anyio
async def test_run_endpoint_starts_the_project_workflow(monkeypatch):
    """The endpoint returns the run identity owned by WorkflowRuntime."""
    import main

    received = {}

    class RuntimeStub:
        async def start(self, project_id, task_id, user_input, source="manual"):
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
        async def start(self, project_id, task_id, user_input, source="manual"):
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
        async def start(self, project_id, task_id, user_input, source="manual"):
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
        async def start(self, project_id, task_id, user_input, source="manual"):
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
    from engines.core.registry import ENGINE_REGISTRY
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
    from engines.core.registry import ENGINE_REGISTRY
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
    """A graceful shutdown stops engines but leaves runs recoverable."""
    from engines.core.registry import ENGINE_REGISTRY
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
        # Graceful shutdown leaves the run marked ``running`` so the next
        # daemon start resumes it from the last completed node.
        assert workflow_run.status == "running"
        assert workflow_run.ended_at is None
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
    """Never-scheduled runs stay recoverable after a graceful shutdown."""
    from engines.core.registry import ENGINE_REGISTRY
    from models import WorkflowRun
    from services.workflow_runtime import WorkflowRuntime

    class EarlyBlockingEngine(RuntimeFakeEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            try:
                await asyncio.Event().wait()
            finally:
                pass
            if False:
                yield InternalEvent(type="status", data={"status": "done"})

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
    ENGINE_REGISTRY["claude"] = EarlyBlockingEngine
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
        # Interrupted runs stay ``running`` for restart recovery instead of
        # being finalized as failed.
        assert [run.status for run in runs] == ["running", "running"]
        assert all(run.ended_at is None for run in runs)
        for handle in handles:
            with pytest.raises(asyncio.CancelledError):
                await runtime.wait(handle)
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


# ── 人工停止后带消息重新执行阶段 ──────────────────────────────────


class ResumeFakeEngine(RuntimeFakeEngine):
    """Blocks until stopped; otherwise finishes after a short delay."""

    def __init__(self):
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.prompts: list[str] = []

    async def spawn(self, prompt, cwd, **kwargs):
        self.prompts.append(prompt)
        self.started.set()
        try:
            await asyncio.wait_for(self.release.wait(), timeout=0.2)
        except asyncio.TimeoutError:
            pass
        yield InternalEvent(type="text_delta", data={"delta": "done"})
        yield InternalEvent(type="status", data={"status": "done"})

    async def stop(self):
        self.release.set()


async def _wait_run_finished(run_id: str, timeout: float = 5.0) -> WorkflowRun:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        run = WorkflowRun.get_by_id(run_id)
        if run.status != "running":
            return run
        if loop.time() > deadline:
            raise AssertionError(
                f"workflow run {run_id} still running after {timeout}s"
            )
        await asyncio.sleep(0.02)


@pytest.mark.anyio
async def test_cancel_orphaned_running_step_preserves_session_for_restart(tmp_path):
    """停止失联 runner 时收尾持久状态，并从日志路径恢复已有会话。"""
    from models import Message
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(
        id="task-orphan",
        title="Orphan",
        cwd=str(tmp_path),
        engine="claude_agent_sdk",
        status="running",
        created_at=now,
        updated_at=now,
    )
    step = TaskStep.create(
        task=task,
        step_key="do",
        status="running",
        engine="claude_agent_sdk",
        session_id=None,
        started_at=now,
    )
    run = WorkflowRun.create(
        id="run-orphan",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json='{"nodes": [], "connections": []}',
        owner_id="stale-owner",
        heartbeat_at=now,
        started_at=now,
    )
    step_run = StepRun.create(
        id="step-run-orphan",
        run=run,
        step_key="do",
        attempt=1,
        status="running",
        engine="claude_agent_sdk",
        started_at=now,
    )
    session_id = "bfaea402-9b52-4846-9f11-f998428b5958"
    message = Message.create(
        id="01a0c776-90c2-7839-81bb-ae423b279e39",
        task=task,
        step_key="do",
        channel="execution",
        role="assistant",
        content="",
        run_status="running",
        event_log_path=(
            f"event_logs/task-{task.id}/{session_id}/"
            "01a0c776-90c2-7839-81bb-ae423b279e39.jsonl"
        ),
        position=0,
        started_at=now,
        created_at=now,
    )
    task.active_workflow_run_id = run.id
    task.save()

    project = SimpleNamespace(
        id="project-orphan",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

        def find_project_for_task(self, task_id):
            assert task_id == task.id
            return project

    bus = EventBus()
    runtime = WorkflowRuntime(bus, ProjectManagerStub())
    try:
        with pytest.raises(ValueError, match="仍由其他运行器执行"):
            await runtime.cancel_step(project.id, task.id, "do")
        assert TaskStep.get_by_id((task.id, "do")).status == "running"

        # 租约过期后才允许本实例将失联步骤收尾。
        WorkflowRun.update(heartbeat_at=1).where(WorkflowRun.id == run.id).execute()
        runtime._leased_runs[run.id] = project.id
        assert await runtime.cancel(task.id) is True

        step = TaskStep.get_by_id((task.id, "do"))
        assert step.status == "cancelled"
        assert step.error == "手动停止（运行器已不存在）"
        assert step.session_id == session_id
        assert step.ended_at is not None

        step_run = StepRun.get_by_id(step_run.id)
        assert step_run.status == "failed"
        assert step_run.ended_at is not None

        message = Message.get_by_id(message.id)
        assert message.run_status == "cancelled"
        assert message.ended_at is not None

        task = Task.get_by_id(task.id)
        assert task.status == "paused"
        run = WorkflowRun.get_by_id(run.id)
        assert run.status == "failed"
        assert run.owner_id is None
        assert run.heartbeat_at is None
        assert run.id not in runtime._leased_runs

        # 重复点击停止保持幂等，不会破坏为后续 @ 重跑保留的 session。
        assert await runtime.cancel_step(project.id, task.id, "do") is True
        assert TaskStep.get_by_id((task.id, "do")).session_id == session_id
    finally:
        await runtime.shutdown()
        await bus.close()
        db.close()


@pytest.mark.anyio
async def test_resume_step_after_cancel_persists_message_and_reruns(tmp_path):
    """人工停止阶段后，发送的消息写入该阶段 LLM 会话并重新执行该阶段。"""
    from engines.core.registry import ENGINE_REGISTRY
    from models import Message, StepSupplement
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="task-resume",
        title="Resume after cancel",
        creator_name="任务创建者",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    project = SimpleNamespace(
        id="project-resume",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {
                    "id": 1,
                    "type": "do",
                    "title": "执行",
                    "engine": "claude",
                    "prompt": "触发者：{name}；任务创建者：{creator_name}",
                }
            ],
            "connections": [],
        },
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

    instances: list[ResumeFakeEngine] = []

    def factory():
        engine = ResumeFakeEngine()
        instances.append(engine)
        return engine

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = factory
    bus = EventBus()
    runtime = WorkflowRuntime(bus, ProjectManagerStub())
    try:
        # 1) 运行阶段并人工停止
        first = asyncio.create_task(runtime.run(project.id, task.id, ""))
        for _ in range(100):
            if instances:
                break
            await asyncio.sleep(0.01)
        assert instances, "engine was never spawned"
        await asyncio.wait_for(instances[0].started.wait(), timeout=1)
        assert await runtime.cancel_step(project.id, task.id, "do") is True
        await asyncio.wait_for(first, timeout=2)
        step = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "do"))
        assert step.status == "cancelled"

        # 2) 向已停止的阶段发送消息：持久化并重新执行
        accepted = await runtime.resume_step_with_message(
            project.id,
            task.id,
            "do",
            "请改用中文输出",
            author_name="阶段触发人",
        )
        assert accepted["step_key"] == "do"
        assert accepted["status"] == "queued"
        assert accepted["message_id"]
        assert accepted["run_id"]
        assert accepted["sequence"] >= 0
        assert accepted["created_at"]

        # 3) 消息进入阶段执行历史（插入到该阶段的 LLM 上下文）
        message = Message.get(Message.id == accepted["message_id"])
        assert message.channel == "execution"
        assert message.role == "user"
        assert message.step_key == "do"
        assert message.content == "请改用中文输出"
        assert message.author_name == "阶段触发人"
        assert message.run_status == "completed"

        # 4) 普通 @ 阶段消息只属于本次重跑，不会成为永久阶段补充。
        assert StepSupplement.select().where(
            (StepSupplement.task == task)
            & (StepSupplement.step_key == "do")
        ).count() == 0

        # 5) 阶段重新执行并完成
        child = WorkflowRun.get_by_id(accepted["run_id"])
        assert child.restart_from_step_key == "do"
        await _wait_run_finished(accepted["run_id"])
        step = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "do"))
        assert step.status == "passed"
        assert Task.get_by_id(task.id).status == "ready"
        assert "触发者：阶段触发人；任务创建者：任务创建者" in instances[1].prompts[0]
        assert "请改用中文输出" in instances[1].prompts[0]
    finally:
        await runtime.shutdown()
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_resume_step_rejects_empty_or_unstopped_step(tmp_path):
    """空消息与未停止的阶段不能触发带消息重跑。"""
    from engines.core.registry import ENGINE_REGISTRY
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(
        id="task-resume-validation",
        title="Resume validation",
        cwd=str(tmp_path),
        engine="claude",
        created_at=now,
        updated_at=now,
    )
    TaskStep.create(
        task=task,
        step_key="do",
        status="pending",
        engine="claude",
        started_at=None,
        ended_at=None,
    )
    project = SimpleNamespace(
        id="project-resume-validation",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {"id": 1, "type": "do", "title": "执行", "engine": "claude"}
            ],
            "connections": [],
        },
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            return nullcontext(project)

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = RuntimeFakeEngine
    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
    try:
        with pytest.raises(ValueError, match="不能为空"):
            await runtime.resume_step_with_message(
                project.id, task.id, "do", "   "
            )
        with pytest.raises(ValueError, match="步骤当前不可重新执行"):
            await runtime.resume_step_with_message(
                project.id, task.id, "do", "重新来"
            )
        with pytest.raises(ValueError, match="Step does not exist"):
            await runtime.resume_step_with_message(
                project.id, task.id, "missing", "重新来"
            )
    finally:
        await runtime.shutdown()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_resume_step_allows_pending_step_with_execution_history(tmp_path):
    """已经执行过的阶段回到 pending 后，仍可带消息重新执行。"""
    import json

    from engines.core.registry import ENGINE_REGISTRY
    from models import Message
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(
        id="task-resume-history",
        title="Resume with history",
        cwd=str(tmp_path),
        engine="claude",
        created_at=now,
        updated_at=now,
    )
    parent = WorkflowRun.create(
        id="run-resume-history",
        task=task,
        status="succeeded",
        workflow_schema_version=1,
        workflow_snapshot_json=json.dumps(
            {
                "nodes": [
                    {"id": 1, "type": "do", "title": "执行", "engine": "claude"}
                ],
                "connections": [],
            }
        ),
        started_at=now,
        ended_at=now,
    )
    task.active_workflow_run_id = parent.id
    task.save()
    TaskStep.create(
        task=task,
        step_key="do",
        status="pending",
        engine="claude",
        started_at=None,
        ended_at=None,
    )
    Message.create(
        id="older-output",
        task=task,
        channel="execution",
        step_key="do",
        sequence=1,
        role="assistant",
        engine="claude",
        content="previous output",
        run_status="failed",
        position=1,
        started_at=now,
        ended_at=now,
        created_at=now,
    )
    project = SimpleNamespace(
        id="project-resume-history",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {"id": 1, "type": "do", "title": "执行", "engine": "claude"}
            ],
            "connections": [],
        },
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            return nullcontext(project)

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = RuntimeFakeEngine
    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
    try:
        accepted = await runtime.resume_step_with_message(
            project.id, task.id, "do", "重新来"
        )
        assert accepted["step_key"] == "do"
        assert accepted["message_id"]
    finally:
        await runtime.shutdown()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_resume_step_rejects_running_step_even_with_history(tmp_path):
    """执行中的阶段不接受带消息重跑：实时注入走独立接口。"""
    import json

    from engines.core.registry import ENGINE_REGISTRY
    from models import Message
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(
        id="task-resume-running",
        title="Resume running",
        cwd=str(tmp_path),
        engine="claude",
        created_at=now,
        updated_at=now,
    )
    parent = WorkflowRun.create(
        id="run-resume-running",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json=json.dumps(
            {
                "nodes": [
                    {"id": 1, "type": "do", "title": "执行", "engine": "claude"}
                ],
                "connections": [],
            }
        ),
        started_at=now,
    )
    task.active_workflow_run_id = parent.id
    task.save()
    TaskStep.create(
        task=task,
        step_key="do",
        status="running",
        engine="claude",
        started_at=now,
    )
    Message.create(
        id="older-output-running",
        task=task,
        channel="execution",
        step_key="do",
        sequence=1,
        role="assistant",
        engine="claude",
        content="previous output",
        run_status="succeeded",
        position=1,
        started_at=now,
        ended_at=now,
        created_at=now,
    )
    project = SimpleNamespace(
        id="project-resume-running",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {"id": 1, "type": "do", "title": "执行", "engine": "claude"}
            ],
            "connections": [],
        },
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            return nullcontext(project)

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = RuntimeFakeEngine
    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
    try:
        with pytest.raises(ValueError, match="步骤当前不可重新执行"):
            await runtime.resume_step_with_message(
                project.id, task.id, "do", "重新来"
            )
    finally:
        await runtime.shutdown()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_restart_step_with_fresh_session_clears_session_and_reruns(tmp_path):
    """引擎会话丢失时清掉 session_id，并用完整阶段提示词重跑。"""
    import json

    from engines.core.registry import ENGINE_REGISTRY
    from models import Message
    from services.workflow_runtime import WorkflowRuntime

    prompts: list[str] = []
    received_sessions: list[str | None] = []

    class FreshSessionEngine(RuntimeFakeEngine):
        @property
        def supports_resume(self):
            return True

        async def spawn(self, prompt, cwd, **kwargs):
            prompts.append(prompt)
            received_sessions.append(kwargs.get("session_id"))
            yield InternalEvent(
                type="session_started",
                data={"session_id": "session-fresh"},
            )
            yield InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": "rebuilt"}},
            )

    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(
        id="task-fresh-session",
        title="Fresh session re-run",
        cwd=str(tmp_path),
        engine="resumable",
        created_at=now,
        updated_at=now,
    )
    parent = WorkflowRun.create(
        id="run-fresh-session",
        task=task,
        status="succeeded",
        workflow_schema_version=1,
        workflow_snapshot_json=json.dumps(
            {
                "nodes": [
                    {"id": 1, "type": "do", "title": "执行", "engine": "resumable"}
                ],
                "connections": [],
            }
        ),
        started_at=now,
        ended_at=now,
    )
    task.active_workflow_run_id = parent.id
    task.save()
    TaskStep.create(
        task=task,
        step_key="do",
        status="failed",
        engine="resumable",
        session_id="01a0aa38-2890-7ed3-9a30-ecfbe37f3056",
        session_provider="prov-1",
        started_at=now,
        ended_at=now,
    )
    Message.create(
        id="lost-rollout-output",
        task=task,
        channel="execution",
        step_key="do",
        sequence=1,
        role="assistant",
        engine="resumable",
        content="",
        run_status="failed",
        position=1,
        started_at=now,
        ended_at=now,
        created_at=now,
    )
    project = SimpleNamespace(
        id="project-fresh-session",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {"id": 1, "type": "do", "title": "执行", "engine": "resumable"}
            ],
            "connections": [],
        },
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            return nullcontext(project)

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["resumable"] = FreshSessionEngine
    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
    try:
        accepted = await runtime.restart_step_with_fresh_session(
            project.id, task.id, "do"
        )
        assert accepted["step_key"] == "do"
        for _ in range(500):
            if task.id not in runtime._runners:
                break
            await asyncio.sleep(0.01)
        # 旧会话已被清空，新会话以完整提示词（非 followup）启动。
        assert received_sessions and received_sessions[0] is None
        assert prompts and "User message" not in prompts[0]
        step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "do")
        )
        assert step.session_id == "session-fresh"
    finally:
        await runtime.shutdown()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_restart_step_with_fresh_session_rejects_running_step(tmp_path):
    """执行中的阶段不能重建会话。"""
    from engines.core.registry import ENGINE_REGISTRY
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(
        id="task-fresh-running",
        title="Fresh session running",
        cwd=str(tmp_path),
        engine="resumable",
        created_at=now,
        updated_at=now,
    )
    TaskStep.create(
        task=task,
        step_key="do",
        status="running",
        engine="resumable",
        started_at=now,
    )
    project = SimpleNamespace(
        id="project-fresh-running",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {"id": 1, "type": "do", "title": "执行", "engine": "resumable"}
            ],
            "connections": [],
        },
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            return nullcontext(project)

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["resumable"] = RuntimeFakeEngine
    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
    try:
        with pytest.raises(ValueError, match="不能重建会话"):
            await runtime.restart_step_with_fresh_session(
                project.id, task.id, "do"
            )
    finally:
        await runtime.shutdown()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_resume_step_message_can_reset_to_fresh_session(tmp_path):
    """用户选择重置步骤时，消息进入完整提示词且不再传旧 session_id。"""
    import json

    from engines.core.registry import ENGINE_REGISTRY
    from models import Message
    from services.workflow_runtime import WorkflowRuntime

    prompts: list[str] = []
    received_sessions: list[str | None] = []

    class ResetStepEngine(RuntimeFakeEngine):
        @property
        def supports_resume(self):
            return True

        async def spawn(self, prompt, cwd, **kwargs):
            prompts.append(prompt)
            received_sessions.append(kwargs.get("session_id"))
            yield InternalEvent(
                type="session_started",
                data={"session_id": "session-after-reset"},
            )
            yield InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": "reset complete"}},
            )

    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(
        id="task-reset-step-session",
        title="重置步骤任务",
        description="这是重置后仍需重新注入的任务说明",
        cwd=str(tmp_path),
        engine="resettable",
        created_at=now,
        updated_at=now,
    )
    parent = WorkflowRun.create(
        id="run-reset-step-session",
        task=task,
        status="succeeded",
        workflow_schema_version=1,
        workflow_snapshot_json=json.dumps({
            "nodes": [{
                "id": 1,
                "type": "do",
                "title": "执行",
                "engine": "resettable",
                "prompt": "完成当前任务",
            }],
            "connections": [],
        }),
        started_at=now,
        ended_at=now,
    )
    task.active_workflow_run_id = parent.id
    task.save()
    TaskStep.create(
        task=task,
        step_key="do",
        status="passed",
        engine="resettable",
        session_id="session-before-reset",
        session_provider="provider-before-reset",
        started_at=now,
        ended_at=now,
    )
    Message.create(
        id="previous-step-output",
        task=task,
        channel="execution",
        step_key="do",
        sequence=1,
        role="assistant",
        engine="resettable",
        content="previous",
        run_status="succeeded",
        position=1,
        started_at=now,
        ended_at=now,
        created_at=now,
    )
    project = SimpleNamespace(
        id="project-reset-step-session",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [{
                "id": 1,
                "type": "do",
                "title": "执行",
                "engine": "resettable",
                "prompt": "完成当前任务",
            }],
            "connections": [],
        },
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            return nullcontext(project)

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["resettable"] = ResetStepEngine
    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
    try:
        accepted = await runtime.resume_step_with_message(
            project.id,
            task.id,
            "do",
            "使用干净上下文重新完成",
            reset_session=True,
        )
        assert accepted["status"] == "queued"
        for _ in range(500):
            if task.id not in runtime._runners:
                break
            await asyncio.sleep(0.01)

        assert received_sessions == [None]
        assert prompts and "重置步骤任务" in prompts[0]
        assert "这是重置后仍需重新注入的任务说明" in prompts[0]
        assert "使用干净上下文重新完成" in prompts[0]
        step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "do")
        )
        assert step.session_id == "session-after-reset"
    finally:
        await runtime.shutdown()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_run_heals_missing_task_cwd_to_project_root(tmp_path):
    """容器时代遗留的 /data 路径在运行前回退到真实项目根目录。"""
    from engines.core.registry import ENGINE_REGISTRY
    from services.workflow_runtime import WorkflowRuntime

    project_root = tmp_path / "sass"
    project_root.mkdir()
    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(
        id="task-heal-cwd",
        title="Heal cwd",
        cwd="/data/projects/sass",
        engine="claude",
        created_at=now,
        updated_at=now,
    )
    project = SimpleNamespace(
        id="project-heal-cwd",
        path=project_root,
        workstep_dir=project_root / ".workstep",
        steps={
            "nodes": [
                {"id": 1, "type": "do", "title": "执行", "engine": "claude"}
            ],
            "connections": [],
        },
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            return nullcontext(project)

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = RuntimeFakeEngine
    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
    try:
        await runtime.run(project.id, task.id, "")
        assert Task.get_by_id(task.id).cwd == str(project_root)
    finally:
        await runtime.shutdown()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()
