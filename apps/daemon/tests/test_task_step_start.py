"""Step startup is one synchronous database work unit, run by the project executor."""

import asyncio
import threading
import time

import pytest

from models import StepRun, Task, TaskStep, WorkflowRun, init_db
from models.fields import utc_now
from services.pipeline import Step
from services.project_database import ProjectDatabaseExecutor
from services.task_runner import TaskRunner
from services.task_step_start import start_step_state
from streaming.bus import EventBus


@pytest.mark.anyio
async def test_step_start_resets_foreign_provider_session_and_restores_running_rows(tmp_path, monkeypatch):
    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(
        id="task-1", title="Step start", cwd=str(tmp_path), workflow_id="workflow-1",
        engine="codex", status="paused", created_at=now, updated_at=now,
    )
    workflow_run = WorkflowRun.create(
        id="run-1", task=task, status="failed", ended_at=now,
        workflow_schema_version=1, workflow_snapshot_json="{}", started_at=now,
    )
    TaskStep.create(
        task=task, step_key="build", status="retrying", started_at=now,
        session_id="old-session", session_provider="provider-a", engine="codex",
        rework_feedback="fix tests", review_feedback="check output",
        pending_handoff_json='{"source": "old-session"}',
    )
    step = Step(key="build", label="Build", engine="codex", outputs=[{"name": "report"}])
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()
    executor = ProjectDatabaseExecutor(db, "project-1")
    runner = TaskRunner(EventBus(), database_executor=executor)
    import services.task_step_start as step_start_module
    original_round = step_start_module.next_artifact_round
    slow_disk_started = threading.Event()

    def slow_round(*args, **kwargs):
        slow_disk_started.set()
        time.sleep(0.2)
        return original_round(*args, **kwargs)

    monkeypatch.setattr(step_start_module, "next_artifact_round", slow_round)
    try:
        starting = asyncio.create_task(runner._run_db(lambda: start_step_state(
            task=task, step=step, workflow_run=workflow_run,
            artifacts_dir=artifacts_dir, effective_provider_id="provider-b",
            resolved_model="model-b", input_rounds={}, input_snapshot={"ports": []},
        )))
        assert await asyncio.to_thread(slow_disk_started.wait, 1)
        heartbeat = asyncio.get_running_loop().time()
        await asyncio.sleep(0.02)
        assert asyncio.get_running_loop().time() - heartbeat < 0.1
        assert not starting.done()
        started = await starting
        current = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "build"))
        assert current.status == "running"
        assert current.session_id is None
        assert current.rework_feedback is None
        assert current.review_feedback is None
        assert started.rework_feedback == "fix tests"
        assert started.manual_review_feedback == "check output"
        assert started.pending_handoff == {"source": "old-session"}
        assert started.artifact_round == 1
        assert started.step_run is not None
        assert StepRun.get_by_id(started.step_run.id).model == "model-b"
        assert Task.get_by_id(task.id).status == "running"
        current_run = WorkflowRun.get_by_id(workflow_run.id)
        assert current_run.status == "running"
        assert current_run.ended_at is None
    finally:
        await runner.close()
        executor.close()
        db.close()
