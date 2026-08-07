"""Stage review gate and automatic retry behavior."""

import json

import pytest

from engines.events import InternalEvent
from engines.registry import ENGINE_REGISTRY
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
        yield InternalEvent(type="text_delta", data={"delta": text})
        yield InternalEvent(type="usage", data={
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
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()
