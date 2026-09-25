"""Stage review gate and automatic retry behavior."""

import asyncio
import json
import re
import threading
import time
from types import SimpleNamespace

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
        "cwd": str(tmp_path),
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


class FailingReviewEngine:
    calls: list[str] = []
    failure_mode = "engine_error"

    @property
    def supports_resume(self):
        return False

    async def spawn(self, prompt, cwd, **kwargs):
        type(self).calls.append(prompt)
        if len(type(self).calls) == 1:
            yield InternalEvent(type="agent_message_chunk", data={
                "content": {"text": "阶段执行完成"},
            })
        elif type(self).failure_mode == "invalid_report":
            yield InternalEvent(type="agent_message_chunk", data={
                "content": {"text": "not valid review JSON"},
            })
        else:
            yield InternalEvent(type="session_started", data={
                "session_id": "bad-review-session",
            })
            yield InternalEvent(type="error", data={
                "message": "Review engine request failed: invalid_id_prefix",
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


class LiveReviewEngine(PausedReviewEngine):
    capabilities = SimpleNamespace(supports_live_step_message=True)

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
            data={"content": {"text": "审核前输出"}},
        )
        self.review_started.set()
        await self.release_review.wait()
        queue = kwargs.get("live_message_queue")
        assert queue is not None
        message_id, content = queue.get_nowait()
        assert "补充审核要求" in content
        yield InternalEvent(
            type="live_message",
            data={"message_id": message_id, "status": "delivered"},
        )
        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": json.dumps({
                "passed": True, "score": 100, "summary": "已按补充要求审核", "issues": [],
            }, ensure_ascii=False)}},
        )


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
            type="session_started",
            data={"session_id": "running-review-session"},
        )
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
        assert StepRun.get(StepRun.run == workflow_run).status == "succeeded"
        assert Message.get(
            (Message.task == task) & (Message.channel == "execution")
            & (Message.role == "assistant")
        ).run_status == "succeeded"
        assert Message.get(
            (Message.task == task) & (Message.channel == "review")
            & (Message.role == "assistant")
        ).run_status == "cancelled"
    finally:
        if not pipeline_task.done():
            review_engine.stopped.set()
            await pipeline_task
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_automatic_review_accepts_live_message_and_splits_output(tmp_path):
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="live-review-task", title="Live review", cwd=str(tmp_path),
        engine="review-test", created_at=1, updated_at=1,
    )
    workflow_run = WorkflowRun.create(
        id="workflow-live-review", task=task, status="running",
        workflow_schema_version=1, workflow_snapshot_json="{}", started_at=1,
    )
    review_started = asyncio.Event()
    release_review = asyncio.Event()
    engine = LiveReviewEngine(review_started, release_review)
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["review-test"] = lambda: engine
    bus = EventBus()
    runner = TaskRunner(bus)
    pipeline_task = asyncio.create_task(runner.run_pipeline(
        task,
        {"steps": [{
            "key": "build", "label": "构建", "engine": "review-test",
            "dependsOn": [], "review": {
                "auto": True, "maxRetries": 0, "engine": "review-test",
            },
        }]},
        tmp_path / "artifacts", workflow_run=workflow_run,
    ))
    try:
        await asyncio.wait_for(review_started.wait(), timeout=2)
        original_run_db = runner._run_db

        async def slow_live_message_write(operation):
            if operation.__name__ != "persist_live_message":
                return await original_run_db(operation)

            def slow_operation():
                time.sleep(0.05)
                return operation()

            return await original_run_db(slow_operation)

        runner._live._run_db = slow_live_message_write
        sending = asyncio.create_task(
            runner.send_live_message(task.id, "build", "补充审核要求")
        )
        await asyncio.wait_for(asyncio.sleep(0.01), timeout=0.03)
        assert not sending.done()
        accepted = await sending
        assert accepted["status"] == "queued"
        assert accepted["channel"] == "review"
        release_review.set()
        await pipeline_task
        messages = list(Message.select().where(Message.task == task).order_by(Message.sequence))
        review_messages = [m for m in messages if m.channel == "review"]
        assert [(m.role, m.run_status) for m in review_messages] == [
            ("assistant", "succeeded"), ("user", "succeeded"),
            ("assistant", "completed"),
        ]
        assert review_messages[0].content == "审核前输出"
        assert review_messages[1].content == "补充审核要求"
        assert "已按补充要求审核" in review_messages[2].content
        assert review_messages[0].sequence < review_messages[1].sequence < review_messages[2].sequence
        assert review_messages[0].ended_at is not None
        assert review_messages[2].started_at == review_messages[0].ended_at
    finally:
        release_review.set()
        if not pipeline_task.done():
            await pipeline_task
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_automatic_review_message_is_visible_while_review_is_running(
    tmp_path, monkeypatch
):
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
    original_execute_sql = db.execute_sql
    review_insert_started = threading.Event()

    def slow_review_insert(sql, params=None, commit=None):
        if (
            'INSERT INTO "message"' in sql
            and params is not None
            and "review" in params
            and not review_insert_started.is_set()
        ):
            review_insert_started.set()
            time.sleep(0.35)
        return original_execute_sql(sql, params)

    monkeypatch.setattr(db, "execute_sql", slow_review_insert)
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
        assert await asyncio.to_thread(review_insert_started.wait, 1)
        assert not pipeline_task.done()
        heartbeat_started = time.perf_counter()
        await asyncio.wait_for(asyncio.sleep(0), timeout=0.2)
        assert time.perf_counter() - heartbeat_started < 0.2
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
        execution_messages = await asyncio.to_thread(
            lambda: list(Message.select().where(
                (Message.task == task)
                & (Message.channel == "execution")
                & (Message.role == "assistant")
            ))
        )
        assert len(execution_messages) == 1
        assert execution_messages[0].run_status == "succeeded"
        running_prompt = json.loads(running_messages[0].prompt_json or "{}").get("prompt")
        assert running_prompt
        assert "You are the WorkStep step review agent." in running_prompt
        assert starts[0].get("prompt") == running_prompt
        history = await asyncio.to_thread(get_task_history, task.id)
        assert next(message for message in history if message["id"] == starts[0]["messageId"])["prompt"] == running_prompt

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
        assert running_review["session_id"] == "running-review-session"
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
        release_review.set()
        await pipeline_task
        history = await asyncio.to_thread(get_task_history, task.id, tmp_path)
        finished_review = next(
            message for message in history if message["id"] == running_review["id"]
        )
        assert finished_review["session_id"] == "running-review-session"
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
@pytest.mark.parametrize("failure_mode", ["engine_error", "invalid_report"])
async def test_review_engine_error_waits_for_manual_review_without_rerunning_step(
    tmp_path, failure_mode,
):
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="review-engine-error-task", title="Review engine error",
        cwd=str(tmp_path), engine="claude", created_at=1, updated_at=1,
    )
    workflow_run = WorkflowRun.create(
        id="workflow-review-engine-error", task=task, status="running",
        workflow_schema_version=1, workflow_snapshot_json="{}", started_at=1,
    )
    original = ENGINE_REGISTRY.copy()
    FailingReviewEngine.calls = []
    FailingReviewEngine.failure_mode = failure_mode
    ENGINE_REGISTRY["review-test"] = FailingReviewEngine
    try:
        await TaskRunner(EventBus()).run_pipeline(
            task,
            {"steps": [{
                "key": "build", "label": "构建", "engine": "review-test",
                "prompt": "完成构建", "dependsOn": [],
                "review": {"mode": "auto", "auto": True, "maxRetries": 2},
            }]},
            tmp_path / "artifacts", workflow_run=workflow_run,
        )

        assert len(FailingReviewEngine.calls) == 2
        assert StepRun.select().where(StepRun.run == workflow_run).count() == 1
        reviews = list(ReviewRun.select().where(
            ReviewRun.workflow_run == workflow_run,
        ).order_by(ReviewRun.attempt))
        assert [(review.mode, review.status) for review in reviews] == [
            ("auto", "failed"), ("manual", "pending"),
        ]
        assert reviews[0].error == (
            "Review engine request failed: invalid_id_prefix"
            if failure_mode == "engine_error" else "Review agent returned invalid JSON"
        )
        task_step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "build")
        )
        assert task_step.status == "awaiting_review"
        assert task_step.review_session_id is None
        review_message = Message.get(
            (Message.task == task) & (Message.channel == "review")
            & (Message.role == "assistant") & (Message.run_status == "failed")
        )
        assert "审核失败" in review_message.content
        assert "审核结果：未通过" not in review_message.content
        assert "## Previous review feedback" not in FailingReviewEngine.calls[0]
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

        import threading
        from unittest.mock import patch

        lookup_started = threading.Event()
        original_lookup = ReviewRun.get_or_none

        def slow_review_lookup(*args, **kwargs):
            lookup_started.set()
            time.sleep(0.2)
            return original_lookup(*args, **kwargs)

        with patch.object(ReviewRun, "get_or_none", side_effect=slow_review_lookup):
            deciding = asyncio.create_task(runtime.decide_review(
                project.id,
                task.id,
                "build",
                review.id,
                "reject",
                comment="请检查 {worktrees} 和 ｛step_name｝，保留 {custom_value}",
            ))
            assert await asyncio.to_thread(lookup_started.wait, 1)
            heartbeat = asyncio.get_running_loop().time()
            await asyncio.sleep(0.02)
            assert asyncio.get_running_loop().time() - heartbeat < 0.1
            assert not deciding.done()
            reject_handle = await deciding
        await runtime.wait(reject_handle)

        # 阶段被自动重跑，第二次提示词包含人工驳回原因
        assert len(calls) == 2
        assert "## Previous review feedback" in calls[1]
        assert f"请检查 .workstep/artifacts/default/{task.id}/.worktrees 和 构建，保留 {{custom_value}}" in calls[1]
        assert "{worktrees}" not in calls[1]
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
        assert reviews[0].decision_comment == "请检查 {worktrees} 和 ｛step_name｝，保留 {custom_value}"
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
@pytest.mark.parametrize("schedule_downstream", [True, False])
async def test_terminated_manual_review_can_be_set_complete_only_with_artifact(
    tmp_path, schedule_downstream,
):
    from contextlib import nullcontext
    from services.artifact_rounds import step_round_dir
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="terminated-review-complete", title="Complete existing output",
        cwd=str(tmp_path), engine="claude", created_at=1, updated_at=1,
    )
    project = SimpleNamespace(
        id="project-terminated-review", path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={"nodes": [
            {"id": 1, "type": "build", "key": "build", "title": "构建",
             "engine": "review-test", "prompt": "完成构建",
             "review": {"mode": "manual", "auto": False, "maxRetries": 1}},
            {"id": 2, "type": "publish", "key": "publish", "title": "发布",
             "engine": "review-test", "prompt": "完成发布",
             "review": {"mode": "skip", "auto": True, "maxRetries": 1}},
        ], "connections": [{"from": 1, "to": 2}]},
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
        first = await runtime.start(project.id, task.id, "")
        await runtime.wait(first)
        review = ReviewRun.get(ReviewRun.task == task)
        await runtime.decide_review(project.id, task.id, "build", review.id, "terminate")
        with pytest.raises(RuntimeError, match="是否继续调度"):
            await runtime.decide_review(
                project.id, task.id, "build", review.id, "set_complete",
            )
        with pytest.raises(RuntimeError, match="产物"):
            await runtime.decide_review(
                project.id, task.id, "build", review.id, "set_complete",
                schedule_downstream=schedule_downstream,
            )

        round_dir = step_round_dir(
            project.workstep_dir / "artifacts", task.workflow_id,
            task.id, "build", review.step_run.artifact_round,
        )
        round_dir.mkdir(parents=True, exist_ok=True)
        (round_dir / "成品.md").write_text("已完成", encoding="utf-8")
        resumed = await runtime.decide_review(
            project.id, task.id, "build", review.id, "set_complete",
            schedule_downstream=schedule_downstream,
        )
        assert (resumed is not None) is schedule_downstream
        if resumed is not None:
            await runtime.wait(resumed)
        assert ReviewRun.get_by_id(review.id).status == "passed"
        assert ReviewRun.get_by_id(review.id).decision == "set_complete"
        assert TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "build")).status == "passed"
        assert TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "publish")).status == (
            "passed" if schedule_downstream else "pending"
        )
        assert WorkflowRun.get_by_id(first.id).status == (
            "succeeded" if schedule_downstream else "stopped"
        )
        assert Task.get_by_id(task.id).status == (
            "ready" if schedule_downstream else "stopped"
        )
        assert len(calls) == (2 if schedule_downstream else 1)
    finally:
        await runtime.shutdown()
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
@pytest.mark.parametrize("schedule_downstream", [True, False])
@pytest.mark.parametrize("superseded", [True, False])
async def test_stopped_automatic_review_can_set_step_complete(
    tmp_path, schedule_downstream, superseded,
):
    from contextlib import nullcontext
    from services.artifact_rounds import step_round_dir
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="stopped-auto-review-complete", title="Complete stopped review output",
        cwd=str(tmp_path), engine="review-test", created_at=1, updated_at=1,
    )
    project = SimpleNamespace(
        id="project-stopped-auto-review", path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={"nodes": [
            {"id": 1, "type": "build", "key": "build", "title": "构建",
             "engine": "review-test", "prompt": "完成构建",
             "review": {"mode": "auto", "auto": True, "engine": "review-test", "maxRetries": 0}},
            {"id": 2, "type": "publish", "key": "publish", "title": "发布",
             "engine": "review-test", "prompt": "完成发布",
             "review": {"mode": "skip", "auto": True, "maxRetries": 0}},
        ], "connections": [{"from": 1, "to": 2}]},
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

    review_started = asyncio.Event()
    review_engine = StoppableReviewEngine(review_started)
    engines = [CompletedExecutionEngine(), review_engine, CompletedExecutionEngine()]
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["review-test"] = lambda: engines.pop(0)
    bus = EventBus()
    runtime = WorkflowRuntime(bus, ProjectManagerStub())
    try:
        first = await runtime.start(project.id, task.id, "")
        await asyncio.wait_for(review_started.wait(), timeout=2)
        assert await runtime.cancel_step(project.id, task.id, "build") is True
        await runtime.wait(first)
        review = ReviewRun.get(ReviewRun.task == task)
        assert (review.mode, review.status, review.error) == (
            "auto", "failed", "手动停止",
        )
        assert TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "build")).status == "cancelled"
        assert Task.get_by_id(task.id).status == "paused"
        assert WorkflowRun.get_by_id(first.id).status == "failed"
        with pytest.raises(RuntimeError, match="产物"):
            await runtime.decide_review(
                project.id, task.id, "build", review.id, "set_complete",
                schedule_downstream=schedule_downstream,
            )
        round_dir = step_round_dir(
            project.workstep_dir / "artifacts", task.workflow_id,
            task.id, "build", review.step_run.artifact_round,
        )
        round_dir.mkdir(parents=True, exist_ok=True)
        (round_dir / "成品.md").write_text("已完成", encoding="utf-8")
        review.error = "自动审核异常"
        review.save()
        with pytest.raises(RuntimeError, match="已停止的审核"):
            await runtime.decide_review(
                project.id, task.id, "build", review.id, "set_complete",
                schedule_downstream=schedule_downstream,
            )
        review.error = "手动停止"
        review.save()
        if superseded:
            from datetime import timedelta

            newer_run = WorkflowRun.create(
                id="later-run", task=task, status="failed",
                workflow_schema_version=1,
                routing_state_json=WorkflowRun.get_by_id(first.id).routing_state_json,
            )
            newer_step_run = StepRun.create(
                id="later-step-run", run=newer_run, step_key="build",
                attempt=1, artifact_round=review.step_run.artifact_round + 1,
                status="failed",
            )
            ReviewRun.create(
                id="later-review", workflow_run=newer_run,
                step_run=newer_step_run, task=task, step_key="build",
                mode="auto", status="failed",
                error="Review agent returned invalid JSON",
                started_at=review.started_at + timedelta(seconds=1),
            )
            task.active_workflow_run_id = newer_run.id
            task.status = "stopped"
            task.save()
            TaskStep.update(status="failed").where(
                (TaskStep.task == task) & (TaskStep.step_key == "build")
            ).execute()

        resumed = await runtime.decide_review(
            project.id, task.id, "build", review.id, "set_complete",
            schedule_downstream=schedule_downstream,
        )
        assert (resumed is not None) is schedule_downstream
        if resumed is not None:
            await runtime.wait(resumed)
        assert ReviewRun.get_by_id(review.id).status == "passed"
        assert TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "build")).status == "passed"
        assert TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "publish")).status == (
            "passed" if schedule_downstream else "pending"
        )
        if superseded and schedule_downstream:
            assert WorkflowRun.get_by_id(newer_run.id).status == "succeeded"
    finally:
        review_engine.stopped.set()
        await runtime.shutdown()
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
@pytest.mark.parametrize("schedule_downstream", [True, False])
@pytest.mark.parametrize("other_step_status", ["pending", "awaiting_review"])
@pytest.mark.parametrize("message_status", ["failed", "cancelled"])
async def test_failed_execution_with_existing_artifact_can_be_set_complete(
    tmp_path, schedule_downstream, other_step_status, message_status,
):
    from contextlib import nullcontext
    from services.artifact_rounds import step_round_dir
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="failed-execution-complete", title="Complete existing output",
        cwd=str(tmp_path), status="paused", engine="review-test",
        created_at=1, updated_at=1,
    )
    project = SimpleNamespace(
        id="project-failed-execution", path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={"nodes": [
            {"id": 1, "type": "build", "key": "build", "title": "构建",
             "engine": "review-test", "prompt": "完成构建",
             "review": {"mode": "skip", "auto": True}},
            {"id": 2, "type": "publish", "key": "publish", "title": "发布",
             "engine": "review-test", "prompt": "完成发布",
             "review": {"mode": "skip", "auto": True}},
        ], "connections": [{"from": 1, "to": 2}]},
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

    run = WorkflowRun.create(
        id="failed-run", task=task, status="failed", workflow_schema_version=1,
    )
    task.active_workflow_run_id = run.id
    task.save()
    TaskStep.create(task=task, step_key="build", status="failed", error="429 Too Many Requests")
    TaskStep.create(task=task, step_key="publish", status=other_step_status)
    step_run = StepRun.create(
        id="failed-step-run", run=run, step_key="build", attempt=1,
        artifact_round=1, status="failed", error="429 Too Many Requests",
    )
    Message.create(
        id="failed-execution", task=task, channel="execution", step_key="build",
        role="assistant", sequence=1, position=1, run_status=message_status,
        step_run_id=step_run.id, content="429 Too Many Requests", created_at=1,
    )
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["review-test"] = lambda: CompletedExecutionEngine()
    bus = EventBus()
    runtime = WorkflowRuntime(bus, ProjectManagerStub())
    try:
        if other_step_status == "pending":
            with pytest.raises(RuntimeError, match="产物"):
                await runtime.complete_failed_step(
                    project.id, task.id, "failed-execution", 1,
                    schedule_downstream=schedule_downstream,
                )
        round_dir = step_round_dir(
            project.workstep_dir / "artifacts", task.workflow_id, task.id, "build", 1,
        )
        round_dir.mkdir(parents=True, exist_ok=True)
        (round_dir / "成品.md").write_text("已完成", encoding="utf-8")
        if schedule_downstream and other_step_status == "awaiting_review":
            with pytest.raises(RuntimeError, match="其他步骤"):
                await runtime.complete_failed_step(
                    project.id, task.id, "failed-execution", 1,
                    schedule_downstream=True,
                )
            return
        resumed = await runtime.complete_failed_step(
            project.id, task.id, "failed-execution", 1,
            schedule_downstream=schedule_downstream,
        )
        assert (resumed is not None) is schedule_downstream
        if resumed:
            await runtime.wait(resumed)
        assert TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "build")).status == "passed"
        assert TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "publish")).status == (
            "passed" if schedule_downstream else other_step_status
        )
        assert StepRun.select().where(
            (StepRun.run == run) & (StepRun.step_key == "build")
            & (StepRun.status == "reused")
        ).count() == 1
        if not schedule_downstream:
            assert Task.get_by_id(task.id).status == "paused"
            assert WorkflowRun.get_by_id(run.id).status == "failed"
    finally:
        await runtime.shutdown()
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_manual_review_can_complete_task_and_later_restart_skipped_step(tmp_path):
    from contextlib import nullcontext
    from types import SimpleNamespace

    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="manual-complete-task", title="Complete at review",
        cwd=str(tmp_path), engine="claude", created_at=1, updated_at=1,
    )
    project = SimpleNamespace(
        id="project-manual-complete", path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {"id": 1, "type": "build", "key": "build", "title": "构建",
                 "engine": "review-test", "prompt": "完成构建",
                 "review": {"mode": "manual", "auto": False, "maxRetries": 1}},
                {"id": 2, "type": "publish", "key": "publish", "title": "发布",
                 "engine": "review-test", "prompt": "完成发布",
                 "review": {"mode": "skip", "auto": True, "maxRetries": 1}},
            ],
            "connections": [{"from": 1, "to": 2}],
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
        first = await runtime.start(project.id, task.id, "")
        await runtime.wait(first)
        review = ReviewRun.get(ReviewRun.task == task)
        assert review.status == "pending"
        assert TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "publish")).status == "pending"

        resumed = await runtime.decide_review(
            project.id, task.id, "build", review.id, "complete_task",
        )
        assert resumed is None
        assert ReviewRun.get_by_id(review.id).status == "passed"
        assert ReviewRun.get_by_id(review.id).decision == "complete_task"
        assert TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "build")).status == "passed"
        assert TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "publish")).status == "skipped"
        assert Task.get_by_id(task.id).status == "ready"
        assert WorkflowRun.get_by_id(first.id).status == "succeeded"
        assert len(calls) == 1

        later = await runtime.resume_step_with_message(
            project.id, task.id, "publish", "@发布 继续执行",
        )
        for _ in range(200):
            if WorkflowRun.get_by_id(later["run_id"]).status != "running":
                break
            await asyncio.sleep(0.01)
        assert TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "build")).status == "passed"
        assert TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "publish")).status == "passed"
        assert Task.get_by_id(task.id).status == "ready"
        assert WorkflowRun.get_by_id(first.id).status == "superseded"
        assert WorkflowRun.get_by_id(later["run_id"]).status == "succeeded"
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
