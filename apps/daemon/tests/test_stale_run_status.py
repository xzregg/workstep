"""A stale ``paused``/``failed`` row must not outlive the stage that keeps running.

An interrupted duplicate dispatch (e.g. startup recovery in a second daemon
instance) can stamp ``paused`` onto the task and ``failed`` onto the run while
the original pipeline is still executing its own retry loop. Every stage
attempt must therefore re-assert ``running`` on both rows, otherwise the card
keeps showing 暂停 for the whole re-run.
"""

import json

import pytest

from engines.core.events import InternalEvent
from engines.core.registry import ENGINE_REGISTRY
from models import StepRun, Task, TaskStep, WorkflowRun, init_db
from models.fields import utc_now
from services.task_runner import TaskRunner
from streaming.bus import EventBus


class StaleStatusStageEngine:
    """Stage engine that emulates a stale writer clobbering the run mid-flight.

    The first attempt writes ``paused``/``failed`` onto the shared task and run
    rows while this pipeline is still executing. The retry attempt then records
    what the rows actually say, which is the user-visible card status.
    """

    observed: list[tuple[str, str, object]] = []
    # A fresh engine instance is created per attempt, so the attempt counter
    # has to live on the class.
    calls = 0

    def __init__(self, task_id: str, run_id: str):
        self.task_id = task_id
        self.run_id = run_id

    @property
    def supports_resume(self):
        return False

    async def spawn(self, prompt, cwd, **kwargs):
        StaleStatusStageEngine.calls += 1
        if StaleStatusStageEngine.calls == 1:
            Task.update(
                status="paused",
                updated_at=utc_now(),
            ).where(Task.id == self.task_id).execute()
            WorkflowRun.update(
                status="failed",
                ended_at=utc_now(),
            ).where(WorkflowRun.id == self.run_id).execute()
        else:
            row = Task.get_by_id(self.task_id)
            run = WorkflowRun.get_by_id(self.run_id)
            StaleStatusStageEngine.observed.append(
                (row.status, run.status, run.ended_at)
            )
        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": "阶段产物已生成"}},
        )

    async def stop(self):
        return None


class RejectOnceEngine:
    """Reviewer engine: rejects the first attempt, accepts the retry."""

    def __init__(self, calls: list[str]):
        self.calls = calls

    @property
    def supports_resume(self):
        return False

    async def spawn(self, prompt, cwd, **kwargs):
        self.calls.append(prompt)
        accepted = len(self.calls) > 1
        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": json.dumps({
                "passed": accepted,
                "score": 90 if accepted else 30,
                "summary": "已修复" if accepted else "存在缺陷",
                "issues": [] if accepted else [{
                    "severity": "error",
                    "category": "bug",
                    "description": "缺少错误处理",
                    "suggestion": "补齐错误处理",
                }],
            }, ensure_ascii=False)}},
        )

    async def stop(self):
        return None


@pytest.mark.anyio
async def test_retry_restores_stale_paused_rows_while_stage_runs(tmp_path):
    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(
        id="stale-status",
        title="Stale status task",
        cwd=str(tmp_path),
        engine="stage-engine",
        created_at=now,
        updated_at=now,
        status="running",
    )
    workflow_run = WorkflowRun.create(
        id="run-stale",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=now,
    )
    steps = {
        "steps": [
            {
                "key": "check",
                "label": "验证",
                "engine": "stage-engine",
                "prompt": "生成产物",
                "dependsOn": [],
                "review": {
                    "auto": True,
                    "maxRetries": 1,
                    "engine": "review-engine",
                    "model": "",
                    "prompt": "检查产物",
                },
            },
        ]
    }
    StaleStatusStageEngine.observed = []
    StaleStatusStageEngine.calls = 0
    review_calls: list[str] = []
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["stage-engine"] = lambda: StaleStatusStageEngine(
        task.id, workflow_run.id
    )
    ENGINE_REGISTRY["review-engine"] = lambda: RejectOnceEngine(review_calls)
    try:
        await TaskRunner(EventBus()).run_pipeline(
            task,
            steps,
            tmp_path / "artifacts",
            workflow_run=workflow_run,
        )

        # The retry ran with both rows back in ``running`` and the stale
        # ``ended_at`` cleared, so the card shows 运行中 instead of 暂停.
        assert StaleStatusStageEngine.observed == [("running", "running", None)]
        assert Task.get_by_id(task.id).status == "ready"
        # 收尾状态由 WorkflowRuntime 负责，这里只要求不被留在 failed。
        assert WorkflowRun.get_by_id(workflow_run.id).status != "failed"
        assert TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "check")
        ).status == "passed"
        assert (
            StepRun.select().where(
                (StepRun.run == workflow_run) & (StepRun.step_key == "check")
            ).count()
            == 2
        )
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()
