"""Stage review gate and automatic retry behavior."""

import asyncio
import json
import re

import pytest

from engines.core.events import InternalEvent
from engines.core.registry import ENGINE_REGISTRY
from models import (
    Message,
    ReviewRun,
    StepSupplement,
    StepRun,
    Task,
    TaskStep,
    WorkflowRun,
    init_db,
)
from services.task_runner import TaskRunner
from services.pipeline import Step
from services.review_gate import ReviewGate
from services.history import get_message_events, get_task_history
from streaming.bus import EventBus


def test_review_prompt_uses_step_as_the_product_term(tmp_path):
    task = type("TaskStub", (), {
        "workflow_id": "flow",
        "id": "task",
    })()
    step = Step(
        key="build",
        label="构建",
        prompt="完成构建",
        outputs=[{"name": "成品", "type": "md"}],
    )

    prompt = ReviewGate._assemble_prompt(
        task,
        step,
        tmp_path,
        "执行完成",
        "检查完整性",
        "## Step requirements\n完成构建",
        1,
    )

    assert prompt.startswith("You are the WorkStep step review agent.")
    assert "## Execution contract" in prompt
    assert "step requirements" in prompt.lower()
    assert prompt.count("完成构建") == 1
    assert "declared outputs" not in prompt
    assert not re.search(r"\bstage\b", prompt, re.IGNORECASE)


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


class PausedReviewEngine:
    """Pause the automatic review so its in-progress UI state is observable."""

    def __init__(self, review_started: asyncio.Event, release_review: asyncio.Event):
        self.review_started = review_started
        self.release_review = release_review
        self.calls = 0

    @property
    def supports_resume(self):
        return False

    async def spawn(self, prompt, cwd, **kwargs):
        self.calls += 1
        if self.calls == 1:
            yield InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": "阶段执行完成"}},
            )
            return

        self.review_started.set()
        await self.release_review.wait()
        yield InternalEvent(
            type="agent_message_chunk",
            data={
                "content": {
                    "text": json.dumps({
                        "passed": True,
                        "score": 100,
                        "summary": "审核通过",
                        "issues": [],
                    }, ensure_ascii=False),
                },
            },
        )

    async def stop(self):
        self.release_review.set()


class StreamingPausedReviewEngine(PausedReviewEngine):
    """Pause after emitting a visible review chunk."""

    async def spawn(self, prompt, cwd, **kwargs):
        self.calls += 1
        if self.calls == 1:
            yield InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": "阶段执行完成"}},
            )
            return

        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": "正在检查验收标准"}},
        )
        self.review_started.set()
        await self.release_review.wait()
        yield InternalEvent(
            type="agent_message_chunk",
            data={
                "content": {
                    "text": json.dumps({
                        "passed": True,
                        "score": 100,
                        "summary": "审核通过",
                        "issues": [],
                    }, ensure_ascii=False),
                },
            },
        )


class CompletedExecutionEngine:
    @property
    def supports_resume(self):
        return False

    async def spawn(self, prompt, cwd, **kwargs):
        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": "阶段执行完成"}},
        )

    async def stop(self):
        return None


class StoppableReviewEngine:
    def __init__(self, review_started: asyncio.Event):
        self.review_started = review_started
        self.stopped = asyncio.Event()

    @property
    def supports_resume(self):
        return False

    async def spawn(self, prompt, cwd, **kwargs):
        self.review_started.set()
        await self.stopped.wait()
        yield InternalEvent(
            type="agent_message_chunk",
            data={
                "content": {
                    "text": json.dumps({
                        "passed": True,
                        "score": 100,
                        "summary": "审核通过",
                        "issues": [],
                    }, ensure_ascii=False),
                },
            },
        )

    async def stop(self):
        self.stopped.set()


@pytest.mark.anyio
async def test_cancel_step_stops_active_automatic_review_engine(tmp_path):
    """Stopping during review targets the review engine and ends as cancelled."""
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="cancel-running-review-task",
        title="Cancel running review",
        cwd=str(tmp_path),
        engine="review-test",
        created_at=1,
        updated_at=1,
    )
    workflow_run = WorkflowRun.create(
        id="workflow-cancel-running-review",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    review_started = asyncio.Event()
    review_engine = StoppableReviewEngine(review_started)
    engines = [CompletedExecutionEngine(), review_engine]
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["review-test"] = lambda: engines.pop(0)
    runner = TaskRunner(EventBus())
    pipeline_task = asyncio.create_task(runner.run_pipeline(
        task,
        {
            "steps": [{
                "key": "build",
                "label": "构建",
                "engine": "review-test",
                "dependsOn": [],
                "review": {
                    "auto": True,
                    "maxRetries": 0,
                    "engine": "review-test",
                },
            }],
        },
        tmp_path / "artifacts",
        workflow_run=workflow_run,
    ))
    try:
        await asyncio.wait_for(review_started.wait(), timeout=2)
        assert await runner.cancel_step(task.id, "build") is True
        await asyncio.wait_for(pipeline_task, timeout=2)

        assert review_engine.stopped.is_set()
        task_step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "build")
        )
        assert task_step.status == "cancelled"
        assert ReviewRun.get(ReviewRun.workflow_run == workflow_run).status == "failed"
    finally:
        if not pipeline_task.done():
            review_engine.stopped.set()
            await pipeline_task
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_automatic_review_message_is_visible_while_review_is_running(tmp_path):
    """自动审核开始后，刷新历史和实时事件都应立即得到同一条审核消息。"""
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="running-review-task",
        title="Running review",
        cwd=str(tmp_path),
        engine="review-test",
        created_at=1,
        updated_at=1,
    )
    workflow_run = WorkflowRun.create(
        id="workflow-running-review",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    review_started = asyncio.Event()
    release_review = asyncio.Event()
    engine = PausedReviewEngine(review_started, release_review)
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["review-test"] = lambda: engine
    bus = EventBus()
    event_queue = bus.subscribe()
    pipeline_task = asyncio.create_task(TaskRunner(bus).run_pipeline(
        task,
        {
            "steps": [{
                "key": "build",
                "label": "构建",
                "engine": "review-test",
                "dependsOn": [],
                "review": {
                    "auto": True,
                    "maxRetries": 0,
                    "engine": "review-test",
                },
            }],
        },
        tmp_path / "artifacts",
        workflow_run=workflow_run,
    ))
    try:
        await asyncio.wait_for(review_started.wait(), timeout=2)
        published = []
        while not event_queue.empty():
            published.append(event_queue.get_nowait())
        starts = [
            event for event in published
            if event.get("type") == "TEXT_MESSAGE_START"
            and event.get("channel") == "review"
        ]
        assert len(starts) == 1
        assert starts[0].get("messageId")
        assert starts[0].get("status") == "running"
        assert starts[0].get("content") == "审核中"

        running_messages = await asyncio.to_thread(
            lambda: list(Message.select().where(
                (Message.task == task)
                & (Message.channel == "review")
                & (Message.run_status == "running")
            ))
        )
        assert len(running_messages) == 1
        assert running_messages[0].id == starts[0]["messageId"]
        assert running_messages[0].content == "审核中"

        release_review.set()
        await pipeline_task
        completed_events = []
        while not event_queue.empty():
            completed_events.append(event_queue.get_nowait())
        review_message_id = starts[0]["messageId"]
        assert any(
            event.get("type") == "TEXT_MESSAGE_CHUNK"
            and event.get("channel") == "review"
            and event.get("messageId") == review_message_id
            for event in completed_events
        )
        assert any(
            event.get("type") == "TEXT_MESSAGE_END"
            and event.get("channel") == "review"
            and event.get("messageId") == review_message_id
            and event.get("status") == "completed"
            for event in completed_events
        )
        finished_messages = await asyncio.to_thread(
            lambda: list(Message.select().where(
                (Message.task == task) & (Message.channel == "review")
            ))
        )
        assert len(finished_messages) == 1
        assert finished_messages[0].id == review_message_id
        assert finished_messages[0].run_status == "completed"
        assert "审核结果：通过" in finished_messages[0].content
    finally:
        release_review.set()
        await pipeline_task
        bus.unsubscribe(event_queue)
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_running_review_placeholder_survives_empty_journal(tmp_path):
    """审核刚启动、journal 还没有任何 chunk 时，历史必须仍返回「审核中」。"""
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="running-placeholder-task",
        title="Running placeholder",
        cwd=str(tmp_path),
        engine="review-test",
        created_at=1,
        updated_at=1,
    )
    workflow_run = WorkflowRun.create(
        id="workflow-running-placeholder",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    review_started = asyncio.Event()
    release_review = asyncio.Event()
    engine = PausedReviewEngine(review_started, release_review)
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["review-test"] = lambda: engine
    pipeline_task = asyncio.create_task(TaskRunner(EventBus()).run_pipeline(
        task,
        {
            "steps": [{
                "key": "build",
                "label": "构建",
                "engine": "review-test",
                "dependsOn": [],
                "review": {
                    "auto": True,
                    "maxRetries": 0,
                    "engine": "review-test",
                },
            }],
        },
        tmp_path / "artifacts",
        workflow_run=workflow_run,
    ))
    try:
        await asyncio.wait_for(review_started.wait(), timeout=2)
        history = await asyncio.to_thread(get_task_history, task.id, tmp_path)
        running_review = next(
            message for message in history
            if message.get("step_key") == "build"
            and message.get("role") == "assistant"
            and message.get("run_status") == "running"
        )
        assert running_review["content"] == "审核中"
    finally:
        release_review.set()
        await pipeline_task
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_automatic_review_history_restores_running_output(tmp_path):
    """审核运行中的 LLM 输出也要写入事件日志，历史刷新不能只剩「审核中」。"""
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="streaming-review-task",
        title="Streaming review",
        cwd=str(tmp_path),
        engine="review-test",
        created_at=1,
        updated_at=1,
    )
    workflow_run = WorkflowRun.create(
        id="workflow-streaming-review",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    review_started = asyncio.Event()
    release_review = asyncio.Event()
    engine = StreamingPausedReviewEngine(review_started, release_review)
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["review-test"] = lambda: engine
    pipeline_task = asyncio.create_task(TaskRunner(EventBus()).run_pipeline(
        task,
        {
            "steps": [{
                "key": "build",
                "label": "构建",
                "engine": "review-test",
                "dependsOn": [],
                "review": {
                    "auto": True,
                    "maxRetries": 0,
                    "engine": "review-test",
                },
            }],
        },
        tmp_path / "artifacts",
        workflow_run=workflow_run,
    ))
    try:
        await asyncio.wait_for(review_started.wait(), timeout=2)

        history = await asyncio.to_thread(get_task_history, task.id, tmp_path)
        running_review = next(
            message for message in history
            if message.get("step_key") == "build"
            and message.get("role") == "assistant"
            and message.get("run_status") == "running"
        )
        assert "正在检查验收标准" in running_review["content"]
        assert running_review["event_detail"]["event_count"] >= 1
        events_page = await asyncio.to_thread(
            get_message_events,
            task.id,
            running_review["id"],
            tmp_path,
        )
        assert any(
            event.get("type") == "TEXT_MESSAGE_CHUNK"
            and event.get("messageId") == running_review["id"]
            for event in events_page["events"]
        )
    finally:
        release_review.set()
        await pipeline_task
        db.close()


@pytest.mark.anyio
async def test_execution_message_ends_before_its_automatic_review(tmp_path):
    """执行消息的 ended_at 不能晚于其审核消息，否则前端会把审核排到执行上方。"""
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="ordering-review-task",
        title="Ordering review",
        cwd=str(tmp_path),
        engine="review-test",
        created_at=1,
        updated_at=1,
    )
    workflow_run = WorkflowRun.create(
        id="workflow-ordering-review",
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
                    "key": "req",
                    "label": "需求",
                    "engine": "review-test",
                    "dependsOn": [],
                    "review": {
                        "auto": True,
                        "maxRetries": 0,
                        "engine": "review-test",
                    },
                }]
            },
            tmp_path / "artifacts",
            workflow_run=workflow_run,
        )
        messages = list(
            Message.select()
            .where((Message.task == task) & (Message.step_key == "req"))
            .order_by(Message.sequence)
        )
        execution = next(m for m in messages if m.channel == "execution")
        review = next(m for m in messages if m.channel == "review")
        assert execution.sequence < review.sequence
        assert execution.ended_at is not None
        assert review.ended_at is not None
        assert execution.ended_at <= review.ended_at
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


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
        step_runs = list(
            StepRun.select()
            .where(StepRun.run == workflow_run)
            .order_by(StepRun.attempt)
        )
        assert len(step_runs) == 2
        assert [run.artifact_round for run in step_runs] == [1, 2]
        assert (
            tmp_path / "artifacts" / "default" / task.id / "build" / "1"
        ).is_dir()
        assert (
            tmp_path / "artifacts" / "default" / task.id / "build" / "2"
        ).is_dir()
        assert "第 2 轮" not in calls[0]
        assert "/1" in calls[0]
        assert "/2" in calls[2]
        reviews = list(
            ReviewRun.select()
            .where(ReviewRun.workflow_run == workflow_run)
            .order_by(ReviewRun.started_at, ReviewRun.id)
        )
        assert sorted(review.status for review in reviews) == ["passed", "rejected"]
        assert "## Previous review feedback" in calls[2]
        assert '"score": 60' in calls[2]
        assert '"category": "requirement_gap"' in calls[2]
        assert "缺少验收标准" in calls[2]
        assert "补充验收标准" in calls[2]
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
        assert [message.artifact_round for message in review_messages] == [1, 2]
        assert [message.step_run_id for message in review_messages] == [
            run.id for run in step_runs
        ]
        execution_messages = list(
            Message.select()
            .where((Message.task == task) & (Message.channel == "execution"))
            .order_by(Message.sequence)
        )
        assert [message.artifact_round for message in execution_messages] == [1, 2]
        assert [message.step_run_id for message in execution_messages] == [
            run.id for run in step_runs
        ]
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
        assert "## Previous review feedback" in calls[1]
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


@pytest.mark.anyio
async def test_manual_review_can_terminate_until_user_reruns_step(tmp_path):
    """终止人工审核后不再调度；只有用户 @ 当前步骤才重新执行。"""
    from contextlib import nullcontext
    from types import SimpleNamespace

    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="manual-terminate-task",
        title="Terminate manual review",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    project = SimpleNamespace(
        id="project-terminate",
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
    bus = EventBus()
    runtime = WorkflowRuntime(bus, ProjectManagerStub())
    try:
        handle = await runtime.start(project.id, task.id, "")
        await runtime.wait(handle)
        review = ReviewRun.get(ReviewRun.task == task)

        resumed = await runtime.decide_review(
            project.id,
            task.id,
            "build",
            review.id,
            "terminate",
            comment="无需继续",
        )

        assert resumed is None
        assert len(calls) == 1
        review = ReviewRun.get_by_id(review.id)
        assert review.status == "terminated"
        assert review.decision == "terminate"
        assert review.decision_comment == "无需继续"
        assert Task.get_by_id(task.id).status == "stopped"
        task_step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "build")
        )
        assert task_step.status == "cancelled"
        assert task_step.error == "无需继续"
        assert WorkflowRun.get_by_id(handle.id).status == "stopped"

        accepted = await runtime.resume_step_with_message(
            project.id,
            task.id,
            "build",
            "@构建 请继续",
        )
        for _ in range(200):
            if WorkflowRun.get_by_id(accepted["run_id"]).status != "running":
                break
            await asyncio.sleep(0.01)
        assert WorkflowRun.get_by_id(accepted["run_id"]).status == "paused"
        assert len(calls) == 2
    finally:
        await runtime.shutdown()
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_message_skips_pending_manual_review_and_reruns_step(tmp_path):
    """等待人工审核时继续发消息，会跳过旧审核并完善同一阶段。"""
    from contextlib import nullcontext
    from types import SimpleNamespace

    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="manual-review-message-task",
        title="Continue manual review stage",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    project = SimpleNamespace(
        id="project-manual-review-message",
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
    bus = EventBus()
    event_queue = bus.subscribe()
    runtime = WorkflowRuntime(bus, ProjectManagerStub())
    try:
        first_handle = await runtime.start(project.id, task.id, "")
        await runtime.wait(first_handle)
        old_review = ReviewRun.get(ReviewRun.task == task)
        assert old_review.status == "pending"

        accepted = await runtime.resume_step_with_message(
            project.id,
            task.id,
            "build",
            "请补充边界场景后再给我审核",
        )
        for _ in range(200):
            if WorkflowRun.get_by_id(accepted["run_id"]).status != "running":
                break
            await asyncio.sleep(0.01)
        assert WorkflowRun.get_by_id(accepted["run_id"]).status == "paused"

        old_review = ReviewRun.get_by_id(old_review.id)
        assert old_review.status == "skipped"
        assert old_review.ended_at is not None
        old_message = Message.get(
            (Message.task == task)
            & (Message.channel == "review")
            & (Message.started_at == old_review.started_at)
        )
        assert json.loads(old_message.events_json) == [{
            "type": "review_context",
            "data": {"review_run_id": old_review.id, "status": "skipped"},
        }]

        assert not StepSupplement.select().where(
            (StepSupplement.task == task)
            & (StepSupplement.step_key == "build")
        ).exists()
        assert len(calls) == 2
        assert "请补充边界场景后再给我审核" in calls[1]

        reviews = list(
            ReviewRun.select()
            .where(ReviewRun.task == task)
            .order_by(ReviewRun.started_at, ReviewRun.id)
        )
        assert [review.status for review in reviews] == ["skipped", "pending"]
        assert TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "build")
        ).status == "awaiting_review"

        second_review = reviews[1]
        accepted_again = await runtime.resume_step_with_message(
            project.id,
            task.id,
            "build",
            "再补充异常恢复场景",
        )
        for _ in range(200):
            if WorkflowRun.get_by_id(accepted_again["run_id"]).status != "running":
                break
            await asyncio.sleep(0.01)
        assert WorkflowRun.get_by_id(accepted_again["run_id"]).status == "paused"
        assert ReviewRun.get_by_id(second_review.id).status == "skipped"
        assert [
            review.status
            for review in (
                ReviewRun.select()
                .where(ReviewRun.task == task)
                .order_by(ReviewRun.started_at, ReviewRun.id)
            )
        ] == ["skipped", "skipped", "pending"]
        assert len(calls) == 3
        assert "再补充异常恢复场景" in calls[2]

        published = []
        while not event_queue.empty():
            published.append(event_queue.get_nowait())
        assert any(
            event.get("type") == "CUSTOM"
            and event.get("name") == "workstep.review_status"
            and event.get("value", {}).get("status") == "skipped"
            for event in published
        )

        with pytest.raises(RuntimeError, match="skipped"):
            await runtime.decide_review(
                project.id,
                task.id,
                "build",
                old_review.id,
                "approve",
            )
    finally:
        await runtime.shutdown()
        await bus.close()
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
async def test_step_and_review_pass_config_overrides(tmp_path):
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

    step_call = next(
        c for c in calls
        if c.get("config_overrides") == {"permission_mode": "acceptEdits"}
    )
    review_call = next(
        c for c in calls
        if c.get("config_overrides") == {"permission_mode": "bypassPermissions"}
    )
    assert "完成构建" in step_call["prompt"]
    assert "检查" in review_call["prompt"]


class ResumableSessionEngine:
    """supports_resume=True 引擎：记录收到的 session_id，返回 session_started。

    阶段执行与审核共用本类，但通过 prompt 开头区分角色：
    - stage 会话 id 固定为 "exec-session"
    - review 会话 id 固定为 "review-session"
    """

    def __init__(
        self,
        step_sessions: list,
        review_sessions: list,
        step_prompts: list[str],
        review_prompts: list[str],
    ):
        self.step_sessions = step_sessions
        self.review_sessions = review_sessions
        self.step_prompts = step_prompts
        self.review_prompts = review_prompts

    @property
    def supports_resume(self):
        return True

    async def spawn(self, prompt, cwd, **kwargs):
        if prompt.startswith("You are the WorkStep step review agent"):
            call_index = len(self.review_sessions)
            self.review_sessions.append(kwargs.get("session_id"))
            self.review_prompts.append(prompt)
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
            self.step_sessions.append(kwargs.get("session_id"))
            self.step_prompts.append(prompt)
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
async def test_review_session_isolated_and_reused_per_step(tmp_path):
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
    step_sessions: list = []
    review_sessions: list = []
    step_prompts: list[str] = []
    review_prompts: list[str] = []
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["resumable-engine"] = lambda: ResumableSessionEngine(
        step_sessions, review_sessions, step_prompts, review_prompts
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
    assert step_sessions == [None, "exec-session"]
    # 审核首次无会话；重跑时复用已持久化的审核会话，而非重新开新会话。
    assert review_sessions == [None, "review-session"]
    assert "完成构建" in step_prompts[0]
    assert "完成构建" not in step_prompts[1]
    assert "## Step execution update" in step_prompts[1]
    assert "## Previous review feedback" in step_prompts[1]
    assert "缺少验收内容" in step_prompts[1]
    # The second review receives the incremental execution contract too.
    assert "完成构建" not in review_prompts[1]
    db.close()
