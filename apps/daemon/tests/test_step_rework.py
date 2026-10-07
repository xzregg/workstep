"""Persistent DAG rewinds for review rejection and artifact feedback."""

import asyncio
import threading
import time

import pytest

from models import Task, TaskStep, init_db
from services.pipeline import DAGScheduler, Step
from services.step_rework import StepRework


def _setup(tmp_path):
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="rework-owner-task", title="返工", cwd=str(tmp_path),
        created_at=1, updated_at=1,
    )
    scheduler = DAGScheduler([
        Step(key="build", label="构建"),
        Step(key="check", label="审核", depends_on=["build"],
             rework_upstream=["build"], review={"maxRetries": 2}),
        Step(key="publish", label="发布", depends_on=["check"]),
    ])
    for key in scheduler.steps:
        TaskStep.create(task=task, step_key=key, status="passed")
    events = []

    async def publish(task_id, step_key, event):
        events.append((task_id, step_key, event))

    owner = StepRework(lambda operation: asyncio.to_thread(operation), publish)
    return db, task, scheduler, owner, events


@pytest.mark.anyio
async def test_review_rework_persists_feedback_only_on_producer(tmp_path):
    db, task, scheduler, owner, events = _setup(tmp_path)
    try:
        completed = {"build", "check", "publish"}
        await owner.from_review(
            task, scheduler.steps["check"], scheduler,
            completed, "修复接口", 1,
        )

        assert completed == {"check"}
        rows = {row.step_key: row for row in TaskStep.select()}
        assert rows["build"].status == "rework"
        assert rows["build"].rework_feedback == "修复接口"
        assert rows["publish"].status == "rework"
        assert rows["publish"].rework_feedback is None
        assert events[-1][2]["type"] == "step_rework"
        assert events[-1][2]["data"]["rework_targets"] == ["build"]
    finally:
        db.close()


@pytest.mark.anyio
@pytest.mark.parametrize("previous_status", ["passed", "failed", "skipped", "pending"])
async def test_artifact_return_rewinds_downstream_without_stale_feedback(
    tmp_path, previous_status,
):
    db, task, scheduler, owner, events = _setup(tmp_path)
    try:
        TaskStep.update(rework_feedback="旧反馈").where(
            TaskStep.task == task
        ).execute()
        TaskStep.update(status=previous_status).where(
            (TaskStep.task == task) & (TaskStep.step_key == "build")
        ).execute()
        completed = {"build", "check", "publish"}
        if previous_status != "passed":
            completed.discard("build")
        failed = {"publish"}
        await owner.from_artifact(
            task, scheduler.steps["check"], scheduler, completed, failed,
            ({"id": "return-1", "to": "build"},),
        )

        assert completed == set()
        assert failed == set()
        rows = {row.step_key: row for row in TaskStep.select()}
        assert rows["check"].status == "rework_waiting"
        assert rows["build"].status == "rework"
        assert rows["publish"].status == "rework_waiting"
        assert all(row.rework_feedback is None for row in rows.values())
        assert events[-1][2]["type"] == "step_return"
        assert events[-1][2]["data"]["connections"] == ["return-1"]
    finally:
        db.close()


@pytest.mark.anyio
async def test_artifact_return_database_wait_keeps_event_loop_responsive(
    tmp_path, monkeypatch,
):
    db, task, scheduler, owner, _ = _setup(tmp_path)
    started = threading.Event()
    original_save = TaskStep.save

    def slow_save(self, *args, **kwargs):
        started.set()
        time.sleep(0.2)
        return original_save(self, *args, **kwargs)

    monkeypatch.setattr(TaskStep, "save", slow_save)
    try:
        rewind = asyncio.create_task(owner.from_artifact(
            task, scheduler.steps["check"], scheduler,
            {"build", "check", "publish"}, set(),
            ({"id": "return-1", "to": "build"},),
        ))
        assert await asyncio.wait_for(asyncio.to_thread(started.wait), 1)
        assert not rewind.done()
        await asyncio.wait_for(asyncio.sleep(0.01), 0.1)
        await rewind
    finally:
        db.close()
