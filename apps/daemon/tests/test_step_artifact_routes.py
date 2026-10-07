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
@pytest.mark.parametrize("case", [
    "valid", "missing_bug", "empty_baseline", "explicit", "newer_empty",
])
async def test_repair_context_requires_real_baseline_and_keeps_selected_inputs(
    tmp_path, case, monkeypatch,
):
    from services.artifact_rounds import step_round_dir, write_round_manifest

    db = init_db(str(tmp_path / "repair.db"))
    task = Task.create(
        id="repair-context", title="修复", cwd=str(tmp_path), workflow_id="flow",
        created_at=1, updated_at=1,
    )
    baseline_dir = step_round_dir(tmp_path / "artifacts", "flow", task.id, "build", 1)
    baseline_dir.mkdir(parents=True)
    if case != "empty_baseline":
        (baseline_dir / "result.md").write_text("已通过的成果")
    write_round_manifest(
        artifacts_root=tmp_path / "artifacts", workflow_id="flow", task_id=task.id,
        step_key="build", artifact_round=1, status="passed",
        eligible_for_downstream=True, outputs=[{"name": "result", "type": "md"}],
    )
    # A newer rejected/empty round cannot replace the usable repair baseline.
    write_round_manifest(
        artifacts_root=tmp_path / "artifacts", workflow_id="flow", task_id=task.id,
        step_key="build", artifact_round=2,
        status="passed" if case == "newer_empty" else "rejected",
        eligible_for_downstream=case == "newer_empty",
    )
    bug = tmp_path / "bugs.md"
    if case != "missing_bug":
        bug.write_text("BUG-1")
    initial = {"id": "initial", "from": "req", "to": "build", "toPort": 0}
    returned = {"id": "return", "from": "check", "to": "build", "toPort": 1,
                "kind": "dashed"}
    build = Step(key="build", label="开发", depends_on=["req"],
                 inputs=[{"name": "首次开发"}, {"name": "返工"}],
                 incoming_connections=[initial, returned])
    scheduler = DAGScheduler([
        Step(key="req", label="需求"), build,
        Step(key="check", label="检查", depends_on=["build"]),
    ])

    async def run_db(operation):
        return await asyncio.to_thread(operation)

    async def publish(*args):
        pass

    routes = StepArtifactRoutes(
        input_rounds_by_step={"build": {"req": 1}} if case == "explicit" else {},
        execution_scope={"build", "check"}, entry_step_key="check",
        run_db=run_db, publish=publish, rework=StepRework(run_db, publish),
    )
    routes.restore(json.dumps({
        "active_edges": ["return"],
        "feedback_inputs": {"build": {"return": {"path": str(bug)}}},
    }))
    scanning = threading.Event()
    original_stat = Path.stat

    def slow_stat(path, *args, **kwargs):
        if path == bug:
            scanning.set()
            time.sleep(0.1)
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", slow_stat)
    try:
        preparing = asyncio.create_task(routes.prepare_feedback_context(
            task, scheduler, tmp_path / "artifacts",
        ))
        assert await asyncio.wait_for(asyncio.to_thread(scanning.wait), 1)
        assert not preparing.done()
        await asyncio.wait_for(asyncio.sleep(0.01), 0.1)
        await preparing
        context = routes.task_context_edges(scheduler)
        assert ("initial" in context) == (case not in {"missing_bug", "explicit"})
        snapshot = await routes.input_snapshot(
            task, build, scheduler, tmp_path / "artifacts",
        )
        if case in {"valid", "newer_empty"}:
            assert snapshot["baseline_round"] == 1
            assert snapshot["ports"][0]["status"] == "task_context"
            from services.prompt import (
                assemble_followup_prompt, assemble_prompt, assemble_retry_prompt,
            )

            prompts = [
                assemble_prompt(task, build, tmp_path / "artifacts",
                                artifact_round=3, input_snapshot=snapshot),
                assemble_retry_prompt(task, build, tmp_path / "artifacts", snapshot,
                                      artifact_round=3),
                assemble_followup_prompt(task, build, tmp_path / "artifacts", "修复",
                                         artifact_round=3, input_snapshot=snapshot),
            ]
            for prompt in prompts:
                assert "build/1/`" in prompt
                assert "build/2/`" not in prompt
    finally:
        db.close()


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
