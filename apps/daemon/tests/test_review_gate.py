"""Stage review gate and automatic retry behavior."""

import json

import pytest

from engines.core.events import InternalEvent
from engines.core.registry import ENGINE_REGISTRY
from models import Message, ReviewRun, StepRun, Task, TaskStep, WorkflowRun, init_db
from services.task_runner import TaskRunner
from streaming.bus import EventBus


class SequencedReviewEngine:
    def __init__(self, calls: list[str]):
        self.calls = calls

    @property
    def supports_resume(self):
        return False

    async def spawn(self, prompt, cwd, **kwargs):
        self.calls.append(prompt)
        call_number = len(self.calls)
        if call_number == 2:
            text = json.dumps({
                "passed": False,
                "score": 60,
                "summary": "缺少验收内容",
                "issues": [{
                    "severity": "error",
                    "category": "requirement_gap",
                    "description": "缺少验收标准",
                    "suggestion": "补充验收标准",
                }],
            }, ensure_ascii=False)
        elif call_number == 4:
            text = json.dumps({
                "passed": True,
                "score": 95,
                "summary": "修复完成",
                "issues": [],
            }, ensure_ascii=False)
        else:
            text = "阶段执行完成"
        yield InternalEvent(type="agent_message_chunk", data={"content": {"text": text}})
        yield InternalEvent(type="usage_update", data={
            "input_tokens": 100 + call_number,
            "output_tokens": 20,
            "cache_read_input_tokens": 40,
        })

    async def stop(self):
        return None


@pytest.mark.anyio
async def test_automatic_review_retries_with_feedback(tmp_path):
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="review-task",
        title="Review task",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    workflow_run = WorkflowRun.create(
        id="workflow-review",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    steps = {
        "steps": [{
            "key": "build",
            "label": "构建",
            "engine": "review-test",
            "prompt": "完成构建",
            "dependsOn": [],
            "review": {
                "auto": True,
                "maxRetries": 1,
                "engine": "review-test",
                "model": "",
                "prompt": "检查验收标准",
            },
        }]
    }
    calls: list[str] = []
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["review-test"] = lambda: SequencedReviewEngine(calls)
    try:
        await TaskRunner(EventBus()).run_pipeline(
            task,
            steps,
            tmp_path / "artifacts",
            workflow_run=workflow_run,
        )

        assert Task.get_by_id(task.id).status == "ready"
        assert StepRun.select().where(StepRun.run == workflow_run).count() == 2
        reviews = list(
            ReviewRun.select()
            .where(ReviewRun.workflow_run == workflow_run)
            .order_by(ReviewRun.started_at, ReviewRun.id)
        )
        assert sorted(review.status for review in reviews) == ["passed", "rejected"]
        assert "缺少验收标准" in calls[2]
        task_step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "build")
        )
        assert task_step.started_at is not None
        assert task_step.ended_at is not None
        assert task_step.ended_at >= max(
            review.ended_at for review in reviews if review.ended_at is not None
        )
        review_messages = list(
            Message.select()
            .where((Message.task == task) & (Message.channel == "review"))
            .order_by(Message.sequence)
        )
        assert len(review_messages) == 2
        assert all(message.usage_json is not None for message in review_messages)
        usage = json.loads(review_messages[-1].usage_json)
        assert usage["input_tokens"] == 104
        assert usage["output_tokens"] == 20
        assert usage["cache_read_input_tokens"] == 40
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_manual_review_waits_for_user(tmp_path):
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="manual-review-task",
        title="Manual review",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    workflow_run = WorkflowRun.create(
        id="workflow-manual-review",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    calls: list[str] = []
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["review-test"] = lambda: SequencedReviewEngine(calls)
    try:
        await TaskRunner(EventBus()).run_pipeline(
            task,
            {
                "steps": [{
                    "key": "build",
                    "label": "构建",
                    "engine": "review-test",
                    "dependsOn": [],
                    "review": {"auto": False, "maxRetries": 0},
                }]
            },
            tmp_path / "artifacts",
            workflow_run=workflow_run,
        )
        assert Task.get_by_id(task.id).status == "paused"
        review = ReviewRun.get(ReviewRun.workflow_run == workflow_run)
        assert review.mode == "manual"
        assert review.status == "pending"
        assert len(calls) == 1
        task_step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "build")
        )
        assert task_step.started_at is not None
        assert task_step.ended_at is None
        review_messages = list(
            Message.select()
            .where((Message.task == task) & (Message.channel == "review"))
            .order_by(Message.sequence)
        )
        assert len(review_messages) == 1
        # 人工审核不展示「审核结果：未通过」，直接提示等待用户审核
        assert review_messages[0].content == "等待你审核"
        # 人工审核没有运行引擎：无提示词、无 token、无引擎/模型
        assert review_messages[0].prompt_json is None
        assert review_messages[0].usage_json is None
        assert review_messages[0].engine is None
        assert review_messages[0].model is None
        assert json.loads(review_messages[0].events_json) == [{
            "type": "review_context",
            "data": {"review_run_id": review.id},
        }]
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_review_message_published_to_bus(tmp_path):
    """审核消息持久化后必须实时推送 channel=review 的消息事件（前端据此刷新）。"""
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="review-publish-task",
        title="Review publish",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    workflow_run = WorkflowRun.create(
        id="workflow-review-publish",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    calls: list[str] = []
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["review-test"] = lambda: SequencedReviewEngine(calls)
    bus = EventBus()
    event_queue = bus.subscribe()
    try:
        await TaskRunner(bus).run_pipeline(
            task,
            {
                "steps": [{
                    "key": "build",
                    "label": "构建",
                    "engine": "review-test",
                    "dependsOn": [],
                    "review": {"auto": False, "maxRetries": 0},
                }]
            },
            tmp_path / "artifacts",
            workflow_run=workflow_run,
        )
        published = []
        while not event_queue.empty():
            published.append(event_queue.get_nowait())
        review_events = [
            event for event in published
            if event.get("channel") == "review"
        ]
        started = [
            event for event in review_events
            if event.get("type") == "TEXT_MESSAGE_START"
        ]
        completed = [
            event for event in review_events
            if event.get("type") == "TEXT_MESSAGE_END"
        ]
        assert len(started) == 1
        assert len(completed) == 1
        assert started[0].get("messageId")
        assert started[0]["messageId"] == completed[0]["messageId"]
        assert completed[0].get("status") == "completed"
        assert completed[0].get("content") == "等待你审核"
        assert completed[0]["messageId"] == str(
            Message.get(
                (Message.task == task) & (Message.channel == "review")
            ).id
        )
    finally:
        bus.unsubscribe(event_queue)
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_task_review_override_disables_auto_review(tmp_path):
    """Task-level review_overrides with auto=false must not spawn the review agent."""
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="override-task",
        title="Override review",
        cwd=str(tmp_path),
        engine="claude",
        review_overrides_json=json.dumps({
            "build": {"auto": False, "maxRetries": 1},
        }),
        created_at=1,
        updated_at=1,
    )
    workflow_run = WorkflowRun.create(
        id="workflow-override",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    calls: list[str] = []
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["review-test"] = lambda: SequencedReviewEngine(calls)
    try:
        await TaskRunner(EventBus()).run_pipeline(
            task,
            {
                "steps": [{
                    "key": "build",
                    "label": "构建",
                    "engine": "review-test",
                    "dependsOn": [],
                    "review": {"auto": True, "maxRetries": 1},
                }]
            },
            tmp_path / "artifacts",
            workflow_run=workflow_run,
        )
        # Only the stage execution spawns; the review agent must not run.
        assert len(calls) == 1
        assert Task.get_by_id(task.id).status == "paused"
        review = ReviewRun.get(ReviewRun.workflow_run == workflow_run)
        assert review.mode == "manual"
        assert review.status == "pending"
        task_step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "build")
        )
        assert task_step.status == "awaiting_review"
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_review_skip_mode_passes_without_review(tmp_path):
    """mode=skip 时阶段执行完成后直接通过，不创建审核记录、不启动审核 Agent。"""
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="skip-review-task",
        title="Skip review",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    workflow_run = WorkflowRun.create(
        id="workflow-skip-review",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    calls: list[str] = []
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["review-test"] = lambda: SequencedReviewEngine(calls)
    try:
        await TaskRunner(EventBus()).run_pipeline(
            task,
            {
                "steps": [{
                    "key": "build",
                    "label": "构建",
                    "engine": "review-test",
                    "prompt": "完成构建",
                    "dependsOn": [],
                    "review": {"mode": "skip", "auto": True, "maxRetries": 1},
                }]
            },
            tmp_path / "artifacts",
            workflow_run=workflow_run,
        )
        assert Task.get_by_id(task.id).status == "ready"
        # 只有阶段执行调用过一次引擎，审核 Agent 从未启动
        assert len(calls) == 1
        assert (
            ReviewRun.select()
            .where(ReviewRun.workflow_run == workflow_run)
            .count()
            == 0
        )
        task_step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "build")
        )
        assert task_step.status == "passed"
        assert task_step.ended_at is not None
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_auto_review_exhaustion_falls_back_to_manual(tmp_path):
    """自动审核次数耗尽后转入人工审核（awaiting_review），不再继续自动重跑。"""
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="exhaust-review-task",
        title="Exhaust review",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    workflow_run = WorkflowRun.create(
        id="workflow-exhaust-review",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    calls: list[str] = []
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["review-test"] = lambda: SequencedReviewEngine(calls)
    try:
        await TaskRunner(EventBus()).run_pipeline(
            task,
            {
                "steps": [{
                    "key": "build",
                    "label": "构建",
                    "engine": "review-test",
                    "prompt": "完成构建",
                    "dependsOn": [],
                    "review": {"mode": "auto", "auto": True, "maxRetries": 0},
                }]
            },
            tmp_path / "artifacts",
            workflow_run=workflow_run,
        )
        # 阶段执行 + 一次自动审核；重试次数为 0，不重跑阶段、不再启动审核 Agent
        assert len(calls) == 2
        assert Task.get_by_id(task.id).status == "paused"
        reviews = list(
            ReviewRun.select()
            .where(ReviewRun.workflow_run == workflow_run)
            .order_by(ReviewRun.started_at, ReviewRun.id)
        )
        assert [review.mode for review in reviews] == ["auto", "manual"]
        assert [review.status for review in reviews] == ["rejected", "pending"]
        task_step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "build")
        )
        assert task_step.status == "awaiting_review"
        assert task_step.ended_at is None
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_manual_reject_injects_feedback_into_next_attempt(tmp_path):
    """人工审核驳回后保存原因，并自动重跑该阶段，下次提示词包含驳回原因。"""
    from contextlib import nullcontext
    from types import SimpleNamespace

    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="manual-reject-task",
        title="Manual reject",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    project = SimpleNamespace(
        id="project-reject",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [{
                "id": 1,
                "type": "build",
                "key": "build",
                "title": "构建",
                "engine": "review-test",
                "prompt": "完成构建",
                "review": {"mode": "manual", "auto": False, "maxRetries": 1},
            }],
        },
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

    calls: list[str] = []
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["review-test"] = lambda: SequencedReviewEngine(calls)
    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
    try:
        handle = await runtime.start(project.id, task.id, "")
        await runtime.wait(handle)

        review = ReviewRun.get(ReviewRun.task == task)
        assert review.mode == "manual"
        assert review.status == "pending"

        reject_handle = await runtime.decide_review(
            project.id,
            task.id,
            "build",
            review.id,
            "reject",
            comment="缺少需求文档",
        )
        await runtime.wait(reject_handle)

        # 阶段被自动重跑，第二次提示词包含人工驳回原因
        assert len(calls) == 2
        assert "缺少需求文档" in calls[1]
        task_step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "build")
        )
        # 驳回原因已被下一次运行消费
        assert task_step.review_feedback is None
        assert task_step.status == "awaiting_review"
        reviews = list(
            ReviewRun.select()
            .where(ReviewRun.task == task)
            .order_by(ReviewRun.started_at, ReviewRun.id)
        )
        assert len(reviews) == 2
        assert reviews[0].status == "rejected"
        assert reviews[0].decision_comment == "缺少需求文档"
        assert reviews[1].status == "pending"
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


class RecordingReviewEngine:
    """Records every spawn kwargs for both stage and review calls."""

    def __init__(self, calls: list[dict]):
        self.calls = calls

    @property
    def supports_resume(self):
        return False

    async def spawn(self, prompt, cwd, **kwargs):
        self.calls.append({**kwargs, "prompt": prompt, "cwd": cwd})
        yield InternalEvent(type="agent_message_chunk", data={"content": {"text": "完成"}})
        yield InternalEvent(type="usage_update", data={
            "input_tokens": 10,
            "output_tokens": 5,
        })

    async def stop(self):
        return None


@pytest.mark.anyio
async def test_stage_and_review_pass_config_overrides(tmp_path):
    """阶段主引擎与评审引擎分别收到各自的 stage config 覆盖。"""
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="config-task",
        title="Config task",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    workflow_run = WorkflowRun.create(
        id="workflow-config",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    steps = {
        "steps": [{
            "key": "build",
            "label": "构建",
            "engine": "config-engine",
            "config": {"permission_mode": "acceptEdits"},
            "prompt": "完成构建",
            "dependsOn": [],
            "review": {
                "mode": "auto",
                "auto": True,
                "maxRetries": 1,
                "engine": "config-review",
                "model": "",
                "prompt": "检查",
                "config": {"permission_mode": "bypassPermissions"},
            },
        }]
    }
    calls: list[dict] = []
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["config-engine"] = lambda: RecordingReviewEngine(calls)
    ENGINE_REGISTRY["config-review"] = lambda: RecordingReviewEngine(calls)
    try:
        await TaskRunner(EventBus()).run_pipeline(
            task,
            steps,
            tmp_path / "artifacts",
            workflow_run=workflow_run,
        )
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()

    stage_call = next(
        c for c in calls
        if c.get("config_overrides") == {"permission_mode": "acceptEdits"}
    )
    review_call = next(
        c for c in calls
        if c.get("config_overrides") == {"permission_mode": "bypassPermissions"}
    )
    assert "完成构建" in stage_call["prompt"]
    assert "检查" in review_call["prompt"]


class ResumableSessionEngine:
    """supports_resume=True 引擎：记录收到的 session_id，返回 session_started。

    阶段执行与审核共用本类，但通过 prompt 开头区分角色：
    - stage 会话 id 固定为 "exec-session"
    - review 会话 id 固定为 "review-session"
    """

    def __init__(self, stage_sessions: list, review_sessions: list):
        self.stage_sessions = stage_sessions
        self.review_sessions = review_sessions

    @property
    def supports_resume(self):
        return True

    async def spawn(self, prompt, cwd, **kwargs):
        if prompt.startswith("你是 WorkStep 的阶段审核 Agent"):
            call_index = len(self.review_sessions)
            self.review_sessions.append(kwargs.get("session_id"))
            passed = call_index >= 1
            yield InternalEvent(type="session_started", data={
                "session_id": kwargs.get("session_id") or "review-session",
            })
            yield InternalEvent(type="agent_message_chunk", data={"content": {"text": json.dumps({
                "passed": passed,
                "score": 100 if passed else 60,
                "summary": "审核通过" if passed else "缺少验收内容",
                "issues": [],
            }, ensure_ascii=False)}})
        else:
            self.stage_sessions.append(kwargs.get("session_id"))
            yield InternalEvent(type="session_started", data={
                "session_id": kwargs.get("session_id") or "exec-session",
            })
            yield InternalEvent(type="agent_message_chunk", data={"content": {"text": "完成"}})
        yield InternalEvent(type="usage_update", data={
            "input_tokens": 10,
            "output_tokens": 5,
        })

    async def stop(self):
        return None


@pytest.mark.anyio
async def test_review_session_isolated_and_reused_per_stage(tmp_path):
    """审核会话与阶段执行会话隔离；同一阶段多次审核复用同一审核会话。"""
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="session-isolation-task",
        title="Session isolation",
        cwd=str(tmp_path),
        engine="resumable-engine",
        created_at=1,
        updated_at=1,
    )
    workflow_run = WorkflowRun.create(
        id="workflow-session-isolation",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    steps = {
        "steps": [{
            "key": "build",
            "label": "构建",
            "engine": "resumable-engine",
            "prompt": "完成构建",
            "dependsOn": [],
            "review": {
                "mode": "auto",
                "auto": True,
                "maxRetries": 1,
                "engine": "resumable-engine",
                "model": "",
                "prompt": "检查",
            },
        }]
    }
    stage_sessions: list = []
    review_sessions: list = []
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["resumable-engine"] = lambda: ResumableSessionEngine(
        stage_sessions, review_sessions
    )
    try:
        await TaskRunner(EventBus()).run_pipeline(
            task,
            steps,
            tmp_path / "artifacts",
            workflow_run=workflow_run,
        )
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)

    task_step = TaskStep.get(
        (TaskStep.task == task) & (TaskStep.step_key == "build")
    )
    # 阶段执行会话被持久化，且与审核会话不同。
    assert task_step.session_id is not None
    assert task_step.session_id == "exec-session"
    # 审核使用独立会话，写入 TaskStep.review_session_id。
    assert task_step.review_session_id == "review-session"
    assert task_step.review_session_id != task_step.session_id
    # 阶段执行首次无会话，重跑复用已持久化的执行会话。
    assert stage_sessions == [None, "exec-session"]
    # 审核首次无会话；重跑时复用已持久化的审核会话，而非重新开新会话。
    assert review_sessions == [None, "review-session"]
    db.close()
