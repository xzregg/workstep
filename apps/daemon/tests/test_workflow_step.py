import pytest
import time
import uuid
from contextlib import nullcontext
from types import SimpleNamespace

from services.workflow_definition import WorkflowDefinition, WorkflowValidationError


def test_workflow_step_compiles_as_dispatch_step():
    definition = WorkflowDefinition.load({
        "nodes": [
            {"id": 1, "type": "source", "title": "Source"},
            {
                "id": 2,
                "type": "handoff",
                "title": "流程阶段",
                "kind": "task_dispatch",
                "dispatch": {
                    "targetProjectId": "project-b",
                    "targetWorkflowId": "workflow-b",
                    "targetStartStepKey": "build",
                    "startMode": "immediate",
                },
            },
        ],
        "connections": [{"from": 1, "to": 2}],
    })

    compiled = definition.compile().to_steps_config()["steps"]

    assert compiled[1]["kind"] == "task_dispatch"
    assert compiled[1]["dispatch"]["targetStartStepKey"] == "build"


def test_workflow_step_cannot_have_outgoing_connection():
    definition = WorkflowDefinition.load({
        "nodes": [
            {
                "id": 1,
                "type": "handoff",
                "kind": "task_dispatch",
                "dispatch": {
                    "targetProjectId": "p",
                    "targetWorkflowId": "w",
                    "targetStartStepKey": "s",
                },
            },
            {"id": 2, "type": "after"},
        ],
        "connections": [{"from": 1, "to": 2}],
    })

    with pytest.raises(WorkflowValidationError, match="cannot have outgoing"):
        definition.validate()


@pytest.mark.anyio
async def test_task_runner_dispatch_step_marks_step_passed_without_engine(tmp_path):
    from models import Task, TaskStep, init_db
    from services.task_runner import TaskRunner
    from streaming.bus import EventBus

    init_db(str(tmp_path / "dispatch.db"))
    task = Task.create(
        id=str(uuid.uuid4()),
        title="Parent",
        cwd=str(tmp_path),
        created_at=int(time.time()),
        updated_at=int(time.time()),
    )

    class FakeDispatch:
        def __init__(self):
            self.calls = []

        async def dispatch(self, **kwargs):
            self.calls.append(kwargs)
            return {"task_id": "child-1"}

    dispatch = FakeDispatch()
    await TaskRunner(EventBus(), dispatch_service=dispatch).run_pipeline(
        task,
        {
            "steps": [{
                "key": "handoff",
                "kind": "task_dispatch",
                "dispatch": {
                    "targetProjectId": "project-b",
                    "targetWorkflowId": "workflow-b",
                    "targetStartStepKey": "build",
                },
            }]
        },
        tmp_path / "artifacts",
    )

    assert len(dispatch.calls) == 1
    assert dispatch.calls[0]["step"].key == "handoff"
    assert TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "handoff")).status == "passed"


@pytest.mark.anyio
async def test_dispatch_step_creates_child_task_with_direct_inputs(tmp_path):
    from models import Task, init_db
    from services.task_dispatch import TaskDispatchService
    from services.task import TaskService
    from streaming.bus import EventBus

    init_db(str(tmp_path / "dispatch-real.db"))
    source_root = tmp_path / "source" / ".workstep"
    target_root = tmp_path / "target" / ".workstep"
    (source_root / "artifacts" / "source-wf" / "parent-1" / "design").mkdir(parents=True)
    (source_root / "artifacts" / "source-wf" / "parent-1" / "design" / "brief.md").write_text("brief")
    target_root.mkdir(parents=True)
    target = SimpleNamespace(
        id="project-b",
        path=target_root.parent,
        workstep_dir=target_root,
        workflow_by_id=lambda workflow_id: {
            "id": workflow_id,
            "steps": {"steps": [{"key": "build", "autoStart": False}]},
        } if workflow_id == "workflow-b" else None,
    )

    class Manager:
        def get_project_by_id(self, project_id):
            return target if project_id == "project-b" else None

        def activate_project_by_id(self, project_id):
            return nullcontext(target)

    class Runtime:
        def __init__(self):
            self.started = []

        async def start(self, project_id, task_id, user_input, source="manual"):
            self.started.append((project_id, task_id, user_input))

    task = Task.create(
        id="parent-1",
        title="Parent",
        description="原始任务说明",
        cwd=str(source_root.parent),
        workflow_id="source-wf",
        created_at=int(time.time()),
        updated_at=int(time.time()),
    )
    runtime = Runtime()
    service = TaskDispatchService(Manager(), EventBus(), runtime)
    result = await service.dispatch(
        source_project_id="project-a",
        task=task,
        step=SimpleNamespace(
            key="handoff",
            depends_on=["design"],
            dispatch={
                "targetProjectId": "project-b",
                "targetWorkflowId": "workflow-b",
                "targetStartStepKey": "build",
                "startMode": "immediate",
            },
        ),
        workflow_run=None,
        artifacts_dir=source_root / "artifacts",
    )

    assert result["title"] == "Parent"
    assert result["source_dispatch_id"] == "parent-1:handoff"
    assert result["description"] == "原始任务说明"
    assert "project-a" not in result["description"]
    assert "parent-1" not in result["description"]
    assert "handoff" not in result["description"]
    assert result["input_manifest"][0]["name"] == "brief.md"
    assert runtime.started == [("project-b", result["id"], "")]


def test_local_dispatch_copy_prefers_clone(monkeypatch, tmp_path):
    import services.task_dispatch as task_dispatch

    source = tmp_path / "source.bin"
    destination = tmp_path / "target" / "destination.bin"
    source.write_bytes(b"artifact")
    clone_calls = []

    def clone_file(source_path, destination_path):
        clone_calls.append((source_path, destination_path))
        destination_path.write_bytes(source_path.read_bytes())
        return True

    monkeypatch.setattr(task_dispatch, "_try_clone_file", clone_file)
    monkeypatch.setattr(
        task_dispatch.shutil,
        "copy2",
        lambda *_args, **_kwargs: pytest.fail("copy2 should not run after clone"),
    )

    task_dispatch._copy_local_artifact(source, destination)

    assert clone_calls == [(source, destination)]
    assert destination.read_bytes() == b"artifact"


def test_local_dispatch_copy_falls_back_when_clone_is_unavailable(
    monkeypatch, tmp_path
):
    import services.task_dispatch as task_dispatch

    source = tmp_path / "source.bin"
    destination = tmp_path / "target" / "destination.bin"
    source.write_bytes(b"artifact")
    copy_calls = []
    original_copy2 = task_dispatch.shutil.copy2

    monkeypatch.setattr(task_dispatch, "_try_clone_file", lambda *_args: False)

    def copy_file(source_path, destination_path):
        copy_calls.append((source_path, destination_path))
        return original_copy2(source_path, destination_path)

    monkeypatch.setattr(task_dispatch.shutil, "copy2", copy_file)

    task_dispatch._copy_local_artifact(source, destination)

    assert copy_calls == [(source, destination)]
    assert destination.read_bytes() == b"artifact"
