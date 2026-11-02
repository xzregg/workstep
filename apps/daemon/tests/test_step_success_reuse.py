"""Successful step artifacts survive normal traversal, not explicit repair."""

import asyncio
import json
from pathlib import Path

import pytest

from engines.core.events import InternalEvent
from engines.core.registry import ENGINE_REGISTRY
from models import Message, StepRun, Task, TaskStep, WorkflowRun, init_db
from models.fields import utc_now
from services.artifact_rounds import step_round_dir, write_round_manifest
from services.task_runner import TaskRunner
from services.pipeline import DAGScheduler, Step
from services.step_rework import StepRework
from services.workflow_definition import WorkflowDefinition, WorkflowValidationError
from streaming.bus import EventBus


def definition(enabled=True):
    return {
        "nodes": [
            {"id": 1, "type": "a", "title": "需求", "engine": "reuse-test", "outputs": [{"name": "req", "type": "md"}]},
            {"id": 2, "type": "b", "title": "分支名", "engine": "reuse-test", "reuseSuccess": enabled,
             "inputs": [{"name": "req", "type": "md"}], "outputs": [{"name": "branch", "type": "md"}]},
            {"id": 3, "type": "c", "title": "开发", "engine": "reuse-test",
             "inputs": [{"name": "branch", "type": "md"}], "outputs": [{"name": "result", "type": "md"}]},
        ],
        "connections": [{"from": 1, "to": 2, "fromPort": 0, "toPort": 0},
                        {"from": 2, "to": 3, "fromPort": 0, "toPort": 0}],
    }


def test_step_reuse_option_survives_compile_and_rejects_non_boolean():
    config = WorkflowDefinition.load(definition()).compile().to_steps_config()
    assert config["steps"][1]["reuseSuccess"] is True
    for invalid in ("false", 1, None):
        raw = definition()
        raw["nodes"][1]["reuseSuccess"] = invalid
        with pytest.raises(WorkflowValidationError, match="reuseSuccess"):
            WorkflowDefinition.load(raw).compile()


def setup_task(tmp_path, enabled=True):
    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(id="reuse-task", title="Task", cwd=str(tmp_path), workflow_id="flow", created_at=utc_now(), updated_at=utc_now())
    root = tmp_path / "artifacts"
    raw = definition(enabled)
    config = WorkflowDefinition.load(raw).compile().to_steps_config()
    old = WorkflowRun.create(id="old", task=task, workflow_schema_version=1, status="completed", started_at=utc_now())
    source = StepRun.create(id="source-b", run=old, step_key="b", attempt=1, artifact_round=1,
                            status="succeeded", engine="reuse-test", started_at=utc_now(), ended_at=utc_now())
    directory = step_round_dir(root, "flow", task.id, "b", 1)
    directory.mkdir(parents=True)
    (directory / "branch.md").write_text("task/branch-stable")
    write_round_manifest(artifacts_root=root, workflow_id="flow", task_id=task.id, step_key="b",
                         artifact_round=1, status="passed", eligible_for_downstream=True,
                         outputs=config["steps"][1]["outputs"], step_run_id=source.id)
    for key in ("a", "b", "c"):
        TaskStep.create(task=task, step_key=key, status="passed" if key == "b" else "pending")
    return db, task, root, config, source


class FileEngine:
    supports_resume = False

    def __init__(self, root, task, calls):
        self.root, self.task, self.calls = root, task, calls

    async def spawn(self, prompt, cwd, **kwargs):
        def write():
            # The runner creates exactly one running execution row before spawn.
            row = StepRun.select().where(StepRun.status == "running").get()
            self.calls.append((row.step_key, prompt))
            path = step_round_dir(self.root, "flow", self.task.id, row.step_key, row.artifact_round)
            name = {"a": "req", "b": "branch", "c": "result"}[row.step_key]
            (path / f"{name}.md").write_text(f"new-{row.step_key}")
        await asyncio.to_thread(write)
        yield InternalEvent("agent_message_chunk", {"content": {"text": "done"}})


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["normal", "disabled", "manual", "feedback", "missing", "renamed", "failed"])
async def test_step_success_reuse_routes_original_artifact_and_explicit_execution(tmp_path, monkeypatch, mode):
    db, task, root, config, source = setup_task(tmp_path, enabled=mode != "disabled")
    calls = []
    monkeypatch.setitem(ENGINE_REGISTRY, "reuse-test", lambda: FileEngine(root, task, calls))
    state = {"force_execute_steps": ["b"]} if mode == "manual" else {}
    run = WorkflowRun.create(id="new", task=task, workflow_schema_version=1, routing_state_json=json.dumps(state), started_at=utc_now())
    if mode == "feedback":
        TaskStep.update(status="rework").where(TaskStep.step_key == "b").execute()
    if mode == "missing":
        (step_round_dir(root, "flow", task.id, "b", 1) / "branch.md").unlink()
    if mode == "renamed":
        config["steps"][1]["outputs"][0]["name"] = "different-branch"
    if mode == "failed":
        StepRun.update(status="failed").where(StepRun.id == source.id).execute()
        TaskStep.update(status="failed").where(TaskStep.step_key == "b").execute()
    runner = TaskRunner(EventBus())
    try:
        await runner.run_pipeline(task, config, root, workflow_run=run)
        keys = [key for key, _ in calls]
        if mode == "normal":
            assert keys == ["a", "c"]
            reused = StepRun.get((StepRun.run == run) & (StepRun.step_key == "b"))
            assert reused.status == "reused"
            assert reused.artifact_round == 1
            assert reused.source_step_run_id == source.id
            assert "b/1/branch.md" in calls[-1][1]
            assert TaskStep.get(TaskStep.step_key == "b").status == "passed"
            assert not step_round_dir(root, "flow", task.id, "b", 2).exists()
            assert not Message.select().where(Message.step_key == "b").exists()
        elif mode in {"missing", "renamed"}:
            assert keys == ["a"]
            assert TaskStep.get(TaskStep.step_key == "b").status == "failed"
        else:
            assert keys == ["a", "b", "c"]
            assert StepRun.get((StepRun.run == run) & (StepRun.step_key == "b")).artifact_round == 2
            assert "b/2/branch.md" in calls[-1][1]
    finally:
        await runner.close()
        db.close()


@pytest.mark.anyio
@pytest.mark.parametrize("target", ["a", "b"])
async def test_automatic_return_executes_direct_target_and_reuses_incidental_success(tmp_path, monkeypatch, target):
    db, task, root, _, _ = setup_task(tmp_path)
    raw = definition()
    target_node = raw["nodes"][0 if target == "a" else 1]
    target_node.setdefault("inputs", []).append({"name": "feedback", "type": "md"})
    raw["nodes"][2]["outputs"].append({"name": "feedback", "type": "md"})
    raw["connections"].append({"from": 3, "fromPort": 1, "to": target_node["id"],
                               "toPort": len(target_node["inputs"]) - 1, "kind": "dashed"})
    config = WorkflowDefinition.load(raw).compile().to_steps_config()
    calls = []

    class ReturnEngine(FileEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            def write():
                row = StepRun.select().where(StepRun.status == "running").get()
                self.calls.append((row.step_key, prompt))
                path = step_round_dir(root, "flow", task.id, row.step_key, row.artifact_round)
                first_return = row.step_key == "c" and sum(key == "c" for key, _ in calls) == 1
                name = "feedback" if first_return else {"a": "req", "b": "branch", "c": "result"}[row.step_key]
                (path / f"{name}.md").write_text("repair" if first_return else "accepted")
            await asyncio.to_thread(write)
            yield InternalEvent("agent_message_chunk", {"content": {"text": "done"}})

    monkeypatch.setitem(ENGINE_REGISTRY, "reuse-test", lambda: ReturnEngine(root, task, calls))
    run = WorkflowRun.create(id="new", task=task, workflow_schema_version=1, started_at=utc_now())
    runner = TaskRunner(EventBus())
    try:
        await runner.run_pipeline(task, config, root, workflow_run=run)
        assert [key for key, _ in calls] == (["a", "c", "a", "c"] if target == "a" else ["a", "c", "b", "c"])
        assert Task.get_by_id(task.id).status == "completed"
        assert TaskStep.get(TaskStep.step_key == "b").status == "passed"
        assert f"b/{1 if target == 'a' else 2}/branch.md" in calls[-1][1]
    finally:
        await runner.close()
        db.close()


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ["artifact", "review"])
async def test_indirect_rework_preserves_success_but_direct_target_executes(tmp_path, kind):
    db, task, root, config, _ = setup_task(tmp_path)
    scheduler = DAGScheduler([Step.from_dict(item) for item in config["steps"]])
    scheduler.steps["c"].rework_upstream = ["a"]
    events = []
    async def publish(*args):
        events.append(args[-1])
    owner = StepRework(lambda operation: asyncio.to_thread(operation), publish)
    try:
        completed, failed = {"a", "b", "c"}, set()
        if kind == "artifact":
            await owner.from_artifact(task, scheduler.steps["c"], scheduler, completed, failed, ({"to": "a", "id": "return-a"},))
        else:
            await owner.from_review(task, scheduler.steps["c"], scheduler, completed, "fix", 1)
        assert TaskStep.get(TaskStep.step_key == "b").status == "passed"
        assert "b" not in completed  # must still wait for A before routing B
        assert not any(event.get("step_key") == "b" and event["data"].get("status") != "passed" for event in events)
        if kind == "artifact":
            await owner.from_artifact(task, scheduler.steps["c"], scheduler, completed, failed, ({"to": "b", "id": "return-b"},))
        else:
            scheduler.steps["c"].rework_upstream = ["b"]
            await owner.from_review(task, scheduler.steps["c"], scheduler, completed, "fix branch", 2)
        assert TaskStep.get(TaskStep.step_key == "b").status == "rework"
    finally:
        db.close()


@pytest.mark.anyio
async def test_restart_preserves_success_and_manual_target_overrides_after_restore(tmp_path, monkeypatch):
    from services.workflow_restart import create_restart_run
    db, task, root, config, _ = setup_task(tmp_path)
    calls = []
    monkeypatch.setitem(ENGINE_REGISTRY, "reuse-test", lambda: FileEngine(root, task, calls))
    try:
        # This is the same child-run entry used by @ and the coordinator.
        runner = TaskRunner(EventBus(), entry_step_key="a", execution_scope={"a", "b", "c"})
        def restart_a():
            return create_restart_run(task, WorkflowRun.get_by_id("old"), 1, "a", {"a", "b", "c"},
                                      instance_id="test", reuse_step_keys={"b"})[1]
        child = await runner._run_db(restart_a)
        assert TaskStep.get(TaskStep.step_key == "b").status == "passed"
        await runner.run_pipeline(task, config, root, workflow_run=child)
        await runner.close()
        assert [key for key, _ in calls] == ["a", "c"]
        assert TaskStep.get(TaskStep.step_key == "b").status == "passed"
        # Create the explicit trigger, then use a fresh runner as after restart.
        runner = TaskRunner(EventBus(), entry_step_key="b", execution_scope={"b", "c"})
        manual = await runner._run_db(lambda: create_restart_run(
            task, child, 1, "b", {"b", "c"}, instance_id="test", reuse_step_keys={"b"},
        )[1])
        assert json.loads(manual.routing_state_json)["force_execute_steps"] == ["b"]
        await runner.run_pipeline(task, config, root, workflow_run=manual)
        await runner.close()
        assert [key for key, _ in calls] == ["a", "c", "b", "c"]
        assert StepRun.get((StepRun.run == manual) & (StepRun.step_key == "b")).artifact_round == 2
        assert not json.loads(WorkflowRun.get_by_id(manual.id).routing_state_json)["force_execute_steps"]
        # Another upstream restart adopts the newly accepted round, not round 1.
        runner = TaskRunner(EventBus(), entry_step_key="a", execution_scope={"a", "b", "c"})
        third = await runner._run_db(lambda: create_restart_run(
            task, manual, 1, "a", {"a", "b", "c"}, instance_id="test", reuse_step_keys={"b"},
        )[1])
        await runner.run_pipeline(task, config, root, workflow_run=third)
        await runner.close()
        assert [key for key, _ in calls] == ["a", "c", "b", "c", "a", "c"]
        assert "b/2/branch.md" in calls[-1][1]
    finally:
        db.close()


@pytest.mark.anyio
@pytest.mark.parametrize("slow", ["disk", "sql"])
async def test_reuse_io_and_sql_do_not_block_health(tmp_path, monkeypatch, slow):
    import threading
    from httpx import ASGITransport, AsyncClient
    from main import app
    import services.step_success_reuse as reuse

    db, task, root, config, _ = setup_task(tmp_path)
    calls = []
    monkeypatch.setitem(ENGINE_REGISTRY, "reuse-test", lambda: FileEngine(root, task, calls))
    entered, release = threading.Event(), threading.Event()
    if slow == "disk":
        original = reuse.select_upstream_round
        def slow_read(*args, **kwargs):
            entered.set()
            release.wait(3)
            return original(*args, **kwargs)
        monkeypatch.setattr(reuse, "select_upstream_round", slow_read)
    else:
        original = db.execute_sql
        def slow_sql(sql, params=None, *args, **kwargs):
            if sql.startswith('INSERT INTO "step_runs"') and "reused" in (params or ()):
                entered.set()
                release.wait(3)
            return original(sql, params, *args, **kwargs)
        monkeypatch.setattr(db, "execute_sql", slow_sql)
    run = WorkflowRun.create(id="new", task=task, workflow_schema_version=1, started_at=utc_now())
    runner = TaskRunner(EventBus())
    running = asyncio.create_task(runner.run_pipeline(task, config, root, workflow_run=run))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            assert (await asyncio.wait_for(client.get("/api/health"), .3)).status_code == 200
        assert not running.done()
    finally:
        release.set()
        await running
        await runner.close()
        db.close()
