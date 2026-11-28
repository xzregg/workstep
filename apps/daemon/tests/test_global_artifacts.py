from pathlib import Path
from types import SimpleNamespace

import pytest

from services.artifact_rounds import iter_artifact_rounds, write_round_manifest
from services.artifact_routing import source_for_connection
from services.artifacts import list_task_artifacts
from services.global_artifacts import prepare_global_artifacts
from services.pipeline import Step
from services.prompt import assemble_followup_prompt, assemble_retry_prompt
from services.workflow_definition import WorkflowDefinition, WorkflowValidationError


OUTPUT = {"name": "board", "type": "md", "global": True}


def test_shared_path_survives_rerun_and_lists_once(tmp_path):
    root = tmp_path / "artifacts"
    task = SimpleNamespace(id="task", workflow_id="flow", cwd=str(tmp_path), title="Task")
    producer = Step.from_dict({"key": "plan", "outputs": [OUTPUT]})
    reader = Step.from_dict({"key": "test", "outputs": []})
    references = prepare_global_artifacts(root, "flow", "task", [producer, reader])
    path = root / "flow/task/plan/Global/board.md"
    assert iter_artifact_rounds(root, "flow", "task", "plan") == []
    path.write_text("initial")

    for attempt in (1, 2):
        write_round_manifest(
            artifacts_root=root, workflow_id="flow", task_id="task", step_key="plan",
            artifact_round=attempt, status="passed", eligible_for_downstream=True,
            outputs=producer.outputs,
        )
    path.write_text("updated by test")
    rounds = iter_artifact_rounds(root, "flow", "task", "plan")
    for item in rounds:
        source = source_for_connection({"fromPort": 0}, item, OUTPUT)
        assert Path(source["path"]) == path
        assert source["global"] is True

    artifacts = list_task_artifacts(SimpleNamespace(workstep_dir=tmp_path), "task")
    assert [(item["path"], item["round"], item["global"]) for item in artifacts] == [
        (str(path), 0, True),
    ]

    for prompt in (
        assemble_followup_prompt(task, reader, root, "continue", 2, global_artifacts=references),
        assemble_retry_prompt(task, producer, root, {}, 2, global_artifacts=references),
    ):
        assert "<global_artifacts>" in prompt
        assert "artifacts/flow/task/plan/Global/board.md" in prompt
        assert "/plan/2/board.md" not in prompt
    other = prepare_global_artifacts(root, "flow", "other", [producer])
    assert other != references
    path.unlink()
    assert source_for_connection({"fromPort": 0}, rounds[-1], OUTPUT) is None


def test_existing_unmarked_global_is_legacy_and_not_overwritten(tmp_path):
    folder = tmp_path / "flow/task/plan/Global"
    folder.mkdir(parents=True)
    (folder / "historic.md").write_text("legacy")
    producer = Step.from_dict({"key": "plan", "outputs": [OUTPUT]})
    with pytest.raises(ValueError, match="Global"):
        prepare_global_artifacts(tmp_path, "flow", "task", [producer])
    assert iter_artifact_rounds(tmp_path, "flow", "task", "plan")[0].legacy


@pytest.mark.parametrize("outputs", [
    [{"name": "anything", "global": "yes"}],
    [{"name": "../outside", "global": True}],
    [OUTPUT, {"name": "BOARD", "type": "md", "global": True}],
])
def test_invalid_global_output_definitions(outputs):
    with pytest.raises(WorkflowValidationError):
        WorkflowDefinition.load({"steps": [{"key": "plan", "outputs": outputs}]}).compile()


def test_global_output_cannot_trigger_return():
    raw = {"nodes": [{"id": 1, "key": "plan"}, {"id": 2, "key": "test", "outputs": [OUTPUT]}],
           "connections": [{"from": 1, "to": 2}, {"from": 2, "to": 1, "kind": "dashed"}]}
    with pytest.raises(WorkflowValidationError, match="return"):
        WorkflowDefinition.load(raw).compile()


@pytest.mark.anyio
async def test_workflow_injects_global_path_and_routes_existing_file(tmp_path, monkeypatch):
    import asyncio
    import threading

    from engines.core.events import InternalEvent
    from engines.core.registry import ENGINE_REGISTRY
    from models import StepRun, Task, WorkflowRun, init_db
    from services import task_runner
    from services.config import config_store
    from services.project_database import ProjectDatabaseExecutor
    from streaming.bus import EventBus

    monkeypatch.setattr(config_store, "get_user_name", lambda: "Test User")
    monkeypatch.setattr(config_store, "get_device_identity", lambda: {"device_id": "test", "device_name": "Test"})
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(id="task", workflow_id="flow", cwd=str(tmp_path), title="Global task", created_at=1, updated_at=1)
    root = tmp_path / "artifacts"
    board = root / "flow/task/plan/Global/board.md"
    calls = {}
    started, release = threading.Event(), threading.Event()
    prepare = task_runner.prepare_global_artifacts

    def slow_prepare(*args):
        started.set()
        release.wait(3)
        return prepare(*args)

    monkeypatch.setattr(task_runner, "prepare_global_artifacts", slow_prepare)

    class Engine:
        supports_resume = False

        def __init__(self, step):
            self.step = step

        async def spawn(self, prompt, cwd, **kwargs):
            calls[self.step] = prompt
            if self.step == "plan":
                await asyncio.to_thread(board.write_text, "created")
            elif self.step == "test":
                await asyncio.to_thread(board.write_text, "updated")
            yield InternalEvent("agent_message_chunk", {"content": {"text": "done"}})

    raw = {"nodes": [], "connections": [{"from": 1, "to": 2}]}
    for index, key in enumerate(("plan", "test", "observe"), 1):
        engine = f"global-test-{key}"
        monkeypatch.setitem(ENGINE_REGISTRY, engine, lambda key=key: Engine(key))
        raw["nodes"].append({
            "id": index, "key": key, "engine": engine, "review": {"mode": "skip"},
            "outputs": [OUTPUT] if key == "plan" else [], "reuseSuccess": key == "plan",
        })

    config = WorkflowDefinition.load(raw).compile().to_steps_config()
    run = WorkflowRun.create(id="first", task=task, workflow_schema_version=1, status="running", started_at=1)
    executor = ProjectDatabaseExecutor(db, "global-test")
    runner = task_runner.TaskRunner(EventBus(), database_executor=executor)
    execution = asyncio.create_task(runner.run_pipeline(task, config, root, workflow_run=run))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        assert await asyncio.wait_for(asyncio.sleep(.01, result=True), timeout=.2)
        assert not execution.done()
        release.set()
        await execution
        assert Task.get_by_id(task.id).status == "completed"
        assert set(calls) == {"plan", "test", "observe"}
        assert all("artifacts/flow/task/plan/Global/board.md" in prompt for prompt in calls.values())
        assert "output path: `artifacts/flow/task/plan/Global/board.md`" in calls["plan"]
        assert "<inputs>" in calls["test"]
        assert board.read_text() == "updated"
        assert StepRun.get(StepRun.step_key == "plan").artifact_round == 1
        calls.clear()
        later = WorkflowRun.create(id="next", task=task, workflow_schema_version=1, status="running", started_at=2)
        await runner.run_pipeline(task, config, root, workflow_run=later)
        assert "plan" not in calls
        assert StepRun.get(StepRun.run == later, StepRun.step_key == "plan").status == "reused"
        assert "artifacts/flow/task/plan/Global/board.md" in calls["test"]
        assert board.read_text() == "updated"
    finally:
        release.set()
        await execution
        await runner.close()
        await asyncio.to_thread(executor.close)
        db.close()
