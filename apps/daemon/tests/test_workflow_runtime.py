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
    finally:
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
async def test_restart_from_stage_picks_up_edited_engine(tmp_path):
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
        handle = await runtime.restart_from_stage(project.id, task.id, "do")
        await runtime.wait(handle)

        child = WorkflowRun.get_by_id(handle.id)
        assert child.parent_run_id == parent.id
        # 子 run 快照采用编辑后的当前流程（engine-b），而非父快照（engine-a）
        snapshot = json.loads(child.workflow_snapshot_json)
        assert snapshot["nodes"][0]["engine"] == "engine-b"

        step_run = (
            StepRun.select()
            .where((StepRun.run == child) & (StepRun.step_key == "do"))
            .order_by(StepRun.attempt.desc())
            .first()
        )
        assert step_run.status == "succeeded"
        assert step_run.engine == "engine-b"

        step = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "do"))
        assert step.status == "passed"
        assert step.engine == "engine-b"
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
async def test_completed_stage_message_uses_session_only_for_same_engine(
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
        accepted = await runtime.resume_stage_with_message(
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
async def test_task_stage_engine_override_hands_off_history_by_file_once(tmp_path):
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
        await runtime.update_stage_execution_config(
            project.id,
            task.id,
            "do",
            engine="engine-b",
            model=None,
            config={},
            context_mode="smart",
        )
        await runtime.resume_stage_with_message(
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
async def test_task_stage_provider_override_hands_off_history_without_session(tmp_path):
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
        await runtime.update_stage_execution_config(
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

    async def spawn(self, prompt, cwd, **kwargs):
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
async def test_resume_stage_after_cancel_persists_message_and_reruns(tmp_path):
    """人工停止阶段后，发送的消息写入该阶段 LLM 会话并重新执行该阶段。"""
    from engines.core.registry import ENGINE_REGISTRY
    from models import Message, StageSupplement
    from services.pipeline import Step
    from services.prompt import assemble_prompt
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="task-resume",
        title="Resume after cancel",
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
                    "prompt": "work",
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
        accepted = await runtime.resume_stage_with_message(
            project.id,
            task.id,
            "do",
            "请改用中文输出",
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
        assert message.run_status == "completed"

        # 4) 同时保存为阶段引导，后续重跑提示中包含该消息
        supplement = StageSupplement.get(
            (StageSupplement.task == task)
            & (StageSupplement.step_key == "do")
        )
        assert supplement.content == "请改用中文输出"
        assert supplement.active is True

        # 5) 阶段重新执行并完成
        child = WorkflowRun.get_by_id(accepted["run_id"])
        assert child.restart_from_step_key == "do"
        await _wait_run_finished(accepted["run_id"])
        step = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "do"))
        assert step.status == "passed"
        assert Task.get_by_id(task.id).status == "ready"

        prompt = assemble_prompt(
            task,
            Step.from_dict({"key": "do", "prompt": "work", "outputs": []}),
            tmp_path / "artifacts",
        )
        assert "请改用中文输出" in prompt
    finally:
        await runtime.shutdown()
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_resume_stage_rejects_empty_or_unstopped_stage(tmp_path):
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
            await runtime.resume_stage_with_message(
                project.id, task.id, "do", "   "
            )
        with pytest.raises(ValueError, match="阶段当前不可重新执行"):
            await runtime.resume_stage_with_message(
                project.id, task.id, "do", "重新来"
            )
        with pytest.raises(ValueError, match="Stage does not exist"):
            await runtime.resume_stage_with_message(
                project.id, task.id, "missing", "重新来"
            )
    finally:
        await runtime.shutdown()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()
