"""Recovered artifact routes remain durable without blocking the event loop."""

import asyncio
import json
import threading
import time
from pathlib import Path

import pytest

from models import Task, WorkflowRun, init_db
from services.pipeline import DAGScheduler, Step
from services.step_artifact_routes import StepArtifactRoutes
from services.step_rework import StepRework


@pytest.mark.anyio
async def test_reused_forward_edge_is_persisted_off_event_loop(tmp_path, monkeypatch):
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="route-owner-task", title="产物路由", cwd=str(tmp_path),
        created_at=1, updated_at=1,
    )
    run = WorkflowRun.create(
        id="route-owner-run", task=task, status="running",
        workflow_schema_version=1, workflow_snapshot_json="{}",
        started_at=1,
    )
    edge = {"id": "build-to-check", "from": "build", "to": "check",
            "kind": "solid"}
    scheduler = DAGScheduler([
        Step(key="build", label="构建", outgoing_connections=[edge]),
        Step(key="check", label="审核", depends_on=["build"],
             incoming_connections=[edge]),
    ])

    async def run_db(operation):
        return await asyncio.to_thread(operation)

    async def publish(_task_id, _step_key, _event):
        return None

    routes = StepArtifactRoutes(
        input_rounds_by_step={}, execution_scope=None, entry_step_key=None,
        run_db=run_db, publish=publish,
        rework=StepRework(run_db, publish),
    )
    routes.restore(None)
    saving = threading.Event()
    original_save = WorkflowRun.save

    def slow_save(row, *args, **kwargs):
        saving.set()
        time.sleep(0.2)
        return original_save(row, *args, **kwargs)

    monkeypatch.setattr(WorkflowRun, "save", slow_save)
    try:
        seeding = asyncio.create_task(routes.seed_completed_forward_routes(
            task, scheduler, tmp_path / "artifacts", run, {"build"},
        ))
        assert await asyncio.wait_for(asyncio.to_thread(saving.wait), 1)
        assert not seeding.done()
        await asyncio.wait_for(asyncio.sleep(0.01), 0.1)
        await seeding
        state = json.loads(WorkflowRun.get_by_id(run.id).routing_state_json)
        assert state["active_edges"] == ["build-to-check"]
        assert [step.key for step in scheduler.get_ready_steps(
            {"build"}, active_edges=routes.active_edges,
        )] == ["check"]
    finally:
        db.close()


@pytest.mark.anyio
async def test_output_path_probe_does_not_block_event_loop(tmp_path, monkeypatch):
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="route-probe-task", title="路由探测", cwd=str(tmp_path),
        created_at=1, updated_at=1,
    )
    run = WorkflowRun.create(
        id="route-probe-run", task=task, status="running",
        workflow_schema_version=1, workflow_snapshot_json="{}",
        started_at=1,
    )
    edge = {"id": "build-to-check", "from": "build", "to": "check",
            "fromPort": 0, "kind": "solid"}
    step = Step(
        key="build", label="构建", outputs=[{"name": "result", "type": "md"}],
        outgoing_connections=[edge],
    )
    scheduler = DAGScheduler([step, Step(key="check", label="审核",
                                           depends_on=["build"])])

    async def run_db(operation):
        return await asyncio.to_thread(operation)

    async def publish(_task_id, _step_key, _event):
        return None

    routes = StepArtifactRoutes(
        input_rounds_by_step={}, execution_scope=None, entry_step_key=None,
        run_db=run_db, publish=publish,
        rework=StepRework(run_db, publish),
    )
    routes.restore(None)
    probing = threading.Event()
    original_is_dir = Path.is_dir

    def slow_is_dir(path):
        if path.name == "result.md":
            probing.set()
            time.sleep(0.2)
        return original_is_dir(path)

    monkeypatch.setattr(Path, "is_dir", slow_is_dir)
    try:
        routing = asyncio.create_task(routes.apply(
            task=task, step=step, scheduler=scheduler, workflow_run=run,
            artifacts_dir=tmp_path / "artifacts", artifact_round=1,
            manifest={"outputs": [{
                "port": 0, "nonempty": True, "path": "result.md",
                "name": "result", "size": 1,
            }]},
            completed={"build"}, failed=set(),
        ))
        assert await asyncio.wait_for(asyncio.to_thread(probing.wait), 1)
        assert not routing.done()
        await asyncio.wait_for(asyncio.sleep(0.01), 0.1)
        await routing
        assert routes.active_edges == {"build-to-check"}
    finally:
        db.close()
