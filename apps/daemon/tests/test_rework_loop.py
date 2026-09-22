"""Rework-verify loop: a rejected verifier sends feedback upstream to rework."""

import json

import pytest

from engines.core.events import InternalEvent
from engines.core.registry import ENGINE_REGISTRY
from models import ReviewRun, StepRun, Task, TaskStep, WorkflowRun, init_db
from services.task_runner import TaskRunner
from streaming.bus import EventBus


class ReworkProducerEngine:
    """Producer stage engine: records prompts so we can assert feedback delivery."""

    def __init__(self, calls: list[str]):
        self.calls = calls

    @property
    def supports_resume(self):
        return False

    async def spawn(self, prompt, cwd, **kwargs):
        self.calls.append(prompt)
        yield InternalEvent(type="agent_message_chunk", data={"content": {"text": "构建产物完成"}})

    async def stop(self):
        return None


class ReworkVerifierEngine:
    """Verifier stage engine: first review rejects, second review passes."""

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
                "score": 40,
                "summary": "发现缺陷",
                "issues": [{
                    "severity": "error",
                    "category": "bug",
                    "description": "接口返回错误",
                    "suggestion": "修复接口",
                }],
            }, ensure_ascii=False)
        elif call_number == 4:
            text = json.dumps({
                "passed": True,
                "score": 90,
                "summary": "修复完成",
                "issues": [],
            }, ensure_ascii=False)
        else:
            text = "测试执行完成"
        yield InternalEvent(type="agent_message_chunk", data={"content": {"text": text}})

    async def stop(self):
        return None


class ReworkAlwaysRejectEngine:
    """Verifier engine whose review always rejects, exhausting maxRetries."""

    def __init__(self, calls: list[str]):
        self.calls = calls

    @property
    def supports_resume(self):
        return False

    async def spawn(self, prompt, cwd, **kwargs):
        self.calls.append(prompt)
        yield InternalEvent(type="agent_message_chunk", data={"content": {"text": json.dumps({
            "passed": False,
            "score": 10,
            "summary": "仍不合格",
            "issues": [],
        }, ensure_ascii=False)}})

    async def stop(self):
        return None


def _make_task(tmp_path, task_id="rework-task"):
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id=task_id,
        title="Rework task",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    workflow_run = WorkflowRun.create(
        id=f"workflow-{task_id}",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    return db, task, workflow_run


@pytest.mark.anyio
async def test_rejected_verifier_reworks_upstream_with_feedback(tmp_path):
    db, task, workflow_run = _make_task(tmp_path)
    steps = {
        "steps": [
            {
                "key": "build",
                "label": "构建",
                "engine": "fe-engine",
                "prompt": "构建前端",
                "dependsOn": [],
            },
            {
                "key": "check",
                "label": "验证",
                "engine": "check-engine",
                "prompt": "验证产物",
                "dependsOn": ["build"],
                "review": {
                    "auto": True,
                    "maxRetries": 1,
                    "engine": "check-engine",
                    "model": "",
                    "prompt": "检查产物",
                },
                "reworkUpstream": ["build"],
            },
        ]
    }
    producer_calls: list[str] = []
    verifier_calls: list[str] = []
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["fe-engine"] = lambda: ReworkProducerEngine(producer_calls)
    ENGINE_REGISTRY["check-engine"] = lambda: ReworkVerifierEngine(verifier_calls)
    try:
        await TaskRunner(EventBus()).run_pipeline(
            task,
            steps,
            tmp_path / "artifacts",
            workflow_run=workflow_run,
        )

        assert Task.get_by_id(task.id).status == "ready"
        assert TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "build")
        ).status == "passed"
        check_step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "check")
        )
        assert check_step.status == "passed"
        assert check_step.rework_feedback is None

        # Each stage ran exactly twice (initial + rework/re-verify).
        assert (
            StepRun.select().where(
                (StepRun.run == workflow_run) & (StepRun.step_key == "build")
            ).count()
            == 2
        )
        assert (
            StepRun.select().where(
                (StepRun.run == workflow_run) & (StepRun.step_key == "check")
            ).count()
            == 2
        )

        reviews = list(
            ReviewRun.select()
            .where(ReviewRun.workflow_run == workflow_run)
            .order_by(ReviewRun.started_at, ReviewRun.id)
        )
        assert sorted(review.status for review in reviews) == ["passed", "rejected"]

        # The producer's second prompt carries the verifier's feedback.
        assert len(producer_calls) == 2
        assert "## Previous review feedback" in producer_calls[1]
        assert "接口返回错误" in producer_calls[1]
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_rework_exhausts_max_retries_and_pauses(tmp_path):
    db, task, workflow_run = _make_task(tmp_path, task_id="rework-exhaust")
    steps = {
        "steps": [
            {
                "key": "build",
                "label": "构建",
                "engine": "fe-engine",
                "prompt": "构建前端",
                "dependsOn": [],
            },
            {
                "key": "check",
                "label": "验证",
                "engine": "check-engine",
                "prompt": "验证产物",
                "dependsOn": ["build"],
                "review": {
                    "auto": True,
                    "maxRetries": 1,
                    "engine": "check-engine",
                    "model": "",
                    "prompt": "检查产物",
                },
                "reworkUpstream": ["build"],
            },
        ]
    }
    producer_calls: list[str] = []
    verifier_calls: list[str] = []
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["fe-engine"] = lambda: ReworkProducerEngine(producer_calls)
    ENGINE_REGISTRY["check-engine"] = lambda: ReworkAlwaysRejectEngine(verifier_calls)
    try:
        await TaskRunner(EventBus()).run_pipeline(
            task,
            steps,
            tmp_path / "artifacts",
            workflow_run=workflow_run,
        )

        assert Task.get_by_id(task.id).status == "paused"
        assert TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "check")
        ).status == "awaiting_review"
        assert (
            StepRun.select().where(
                (StepRun.run == workflow_run) & (StepRun.step_key == "build")
            ).count()
            == 2
        )
        assert (
            StepRun.select().where(
                (StepRun.run == workflow_run) & (StepRun.step_key == "check")
            ).count()
            == 2
        )
        reviews = list(
            ReviewRun.select()
            .where(ReviewRun.workflow_run == workflow_run)
        )
        # 重跑次数耗尽后转入人工审核：两次自动驳回 + 一次待人工确认
        assert len(reviews) == 3
        assert sorted(review.status for review in reviews) == [
            "pending", "rejected", "rejected",
        ]
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()
