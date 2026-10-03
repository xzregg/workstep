"""Task review overrides remain authoritative when a stage runs again."""
import asyncio
import json
from contextlib import nullcontext
from types import SimpleNamespace

import pytest

from engines.core.registry import ENGINE_REGISTRY
from models import ReviewRun, Task, WorkflowRun, init_db
from services.project_database import ProjectDatabaseExecutor
from services.workflow_runtime import WorkflowRuntime
from streaming.bus import EventBus
from tests.test_review_gate import SequencedReviewEngine, review_test_actor


@pytest.fixture
def review_project(tmp_path):
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="manual-override", title="Manual override", cwd=str(tmp_path),
        created_at=1, updated_at=1,
        review_overrides_json=json.dumps({"build": {"mode": "manual", "auto": False}}),
    )
    executor = ProjectDatabaseExecutor(db, "review-project")
    project = SimpleNamespace(
        id="review-project", path=tmp_path, workstep_dir=tmp_path / ".workstep",
        database_executor=executor,
        steps={"nodes": [{
            "id": 1, "type": "build", "title": "构建", "engine": "review-test",
            "prompt": "完成构建", "review": {"mode": "auto", "auto": True},
        }]},
    )
    yield project, task.id
    executor.close()
    db.close()


@pytest.mark.anyio
async def test_manual_task_override_is_used_on_initial_execution_and_rerun(
    review_project, monkeypatch, review_test_actor,
):
    project, task_id = review_project
    calls = []
    monkeypatch.setitem(ENGINE_REGISTRY, "review-test", lambda: SequencedReviewEngine(calls))

    class Manager:
        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

        async def run_db(self, project_id, operation):
            assert project_id == project.id
            return await project.database_executor.run(lambda: operation(project))

    runtime = WorkflowRuntime(EventBus(), Manager())
    try:
        first = await runtime.start(project.id, task_id, "")
        await runtime.wait(first)
        def read_reviews():
            return [(r.mode, r.status) for r in ReviewRun.select().order_by(ReviewRun.started_at)]
        assert await project.database_executor.run(read_reviews) == [("manual", "pending")]
        accepted = await runtime.resume_step_with_message(project.id, task_id, "build", "重新执行一轮")
        await asyncio.gather(*runtime._active_tasks)
        assert await project.database_executor.run(read_reviews) == [
            ("manual", "skipped"), ("manual", "pending"),
        ]
        assert await project.database_executor.run(
            lambda: WorkflowRun.get_by_id(accepted["run_id"]).status,
        ) == "paused"
        assert len(calls) == 2  # execution only; no automatic review engine invocation
    finally:
        await runtime.shutdown()
