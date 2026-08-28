"""Tests for project service: init, register, list."""

import asyncio
import json
import threading
import pytest
from pathlib import Path
from unittest.mock import patch

from models import (
    Task,
    TaskStep,
    Message,
    Workflow,
    WorkflowRun,
    StepRun,
    ReviewRun,
    CoordinatorSession,
    CoordinatorTurn,
    ActionProposal,
    StageSupplement,
)
from services.project import ProjectManager, DEFAULT_STEPS
from services.config import ConfigStore


@pytest.fixture
def manager(tmp_path):
    """Fresh ProjectManager with temp config store."""
    config_dir = tmp_path / ".workstep"
    config_dir.mkdir()
    config_file = config_dir / "config.json"

    store = ConfigStore()
    with patch("services.config.CONFIG_DIR", config_dir), \
         patch("services.config.CONFIG_FILE", config_file), \
         patch("services.project.config_store", store):
        m = ProjectManager()
        yield m, store, config_file
    m.close_all()


def test_init_project_creates_workstep_dir(tmp_path, manager):
    """init_project creates .workstep/ with steps.json and workstep.db."""
    m, _, _ = manager
    proj = m.init_project(tmp_path)

    ws_dir = tmp_path / ".workstep"
    assert ws_dir.exists()
    assert (ws_dir / "steps.json").exists()
    assert (ws_dir / "workstep.db").exists()

    steps = json.loads((ws_dir / "steps.json").read_text())
    assert steps == DEFAULT_STEPS


def test_init_project_adds_workstep_to_git_and_docker_ignore_files(tmp_path, manager):
    """Project initialization keeps WorkStep runtime data out of Git and Docker contexts."""
    m, _, _ = manager
    (tmp_path / ".gitignore").write_text("dist\n")
    (tmp_path / ".dockerignore").write_text("node_modules")

    m.init_project(tmp_path)
    m.init_project(tmp_path)

    assert (tmp_path / ".gitignore").read_text() == "dist\n.workstep/\n"
    assert (tmp_path / ".dockerignore").read_text() == "node_modules\n.workstep/\n"


def test_init_project_returns_project(tmp_path, manager):
    """init_project returns a Project with correct attributes."""
    m, _, _ = manager
    proj = m.init_project(tmp_path)

    assert proj.path == tmp_path.resolve()
    assert proj.steps == DEFAULT_STEPS
    assert proj.db is not None
    assert not proj.db.is_closed()


def test_init_project_idempotent(tmp_path, manager):
    """Calling init twice returns the same project, doesn't overwrite."""
    m, _, _ = manager
    proj1 = m.init_project(tmp_path)
    proj2 = m.init_project(tmp_path)

    assert proj1 is proj2
    steps_path = tmp_path / ".workstep" / "steps.json"
    assert steps_path.exists()


def test_register_existing_project(tmp_path, manager):
    """register opens an existing project's DB."""
    m, _, _ = manager
    m.init_project(tmp_path)
    m.close_all()

    store = ConfigStore()
    m2 = ProjectManager()
    with patch("services.project.config_store", store):
        proj = m2.register(tmp_path)
        assert proj.path == tmp_path.resolve()
        assert proj.steps == DEFAULT_STEPS
    m2.close_all()


def test_register_nonexistent_raises(tmp_path, manager):
    """register raises if no .workstep/ directory."""
    m, _, _ = manager
    empty_dir = tmp_path / "empty"
    empty_dir.mkdir()
    with pytest.raises(ValueError, match="No .workstep"):
        m.register(empty_dir)


def test_list_projects(tmp_path, manager):
    """list_projects returns all registered projects."""
    m, _, _ = manager
    p1 = tmp_path / "proj-a"
    p2 = tmp_path / "proj-b"
    p1.mkdir()
    p2.mkdir()

    m.init_project(p1)
    m.init_project(p2)

    projects = m.list_projects()
    assert len(projects) == 2
    names = {p["name"] for p in projects}
    assert names == {"proj-a", "proj-b"}


def test_get_project(tmp_path, manager):
    """get_project returns a project by path."""
    m, _, _ = manager
    m.init_project(tmp_path)

    proj = m.get_project(tmp_path)
    assert proj is not None
    assert proj.path == tmp_path.resolve()

    assert m.get_project(tmp_path / "nope") is None


def test_close_all(tmp_path, manager):
    """close_all closes all DB connections."""
    m, _, _ = manager
    m.init_project(tmp_path)
    m.close_all()

    assert m.list_projects() == []


async def test_database_work_runs_concurrently_across_projects(tmp_path, manager):
    """Independent project databases do not share a global writer."""
    m, _, _ = manager
    first_path = tmp_path / "writer-a"
    second_path = tmp_path / "writer-b"
    first_path.mkdir()
    second_path.mkdir()
    first = m.init_project(first_path)
    second = m.init_project(second_path)
    both_writers_started = threading.Barrier(2)

    def identify(project):
        both_writers_started.wait(timeout=1)
        return project.id

    results = await asyncio.gather(
        m.run_db(first.id, identify),
        m.run_db(second.id, identify),
    )

    assert results == [first.id, second.id]


async def test_database_work_is_ordered_within_one_project(tmp_path, manager):
    """One project's complete database work units never interleave."""
    m, _, _ = manager
    project = m.init_project(tmp_path)
    first_started = threading.Event()
    release_first = threading.Event()
    second_started = threading.Event()

    def first(_project):
        first_started.set()
        assert release_first.wait(timeout=1)
        return "first"

    def second(_project):
        second_started.set()
        return "second"

    first_task = asyncio.create_task(m.run_db(project.id, first))
    assert await asyncio.to_thread(first_started.wait, 1)
    second_task = asyncio.create_task(m.run_db(project.id, second))
    await asyncio.sleep(0.05)
    assert not second_started.is_set()

    release_first.set()
    assert await asyncio.gather(first_task, second_task) == ["first", "second"]


async def test_bind_project_is_isolated_between_interleaved_async_tasks(tmp_path, manager):
    """Each asyncio task keeps querying the project it bound before awaiting."""
    m, _, _ = manager
    project_a_path = tmp_path / "project-a"
    project_b_path = tmp_path / "project-b"
    project_a_path.mkdir()
    project_b_path.mkdir()
    project_a = m.init_project(project_a_path)
    project_b = m.init_project(project_b_path)

    project_a_bound = asyncio.Event()
    project_b_written = asyncio.Event()

    async def use_project_a():
        m.bind_project_by_id(project_a.id)
        Task.create(
            id="task-a",
            title="Only in A",
            cwd=str(project_a.path),
            created_at=1,
            updated_at=1,
        )
        project_a_bound.set()
        await project_b_written.wait()
        return [task.id for task in Task.select().order_by(Task.id)]

    async def use_project_b():
        await project_a_bound.wait()
        m.bind_project_by_id(project_b.id)
        Task.create(
            id="task-b",
            title="Only in B",
            cwd=str(project_b.path),
            created_at=1,
            updated_at=1,
        )
        project_b_written.set()
        await asyncio.sleep(0)
        return [task.id for task in Task.select().order_by(Task.id)]

    project_a_tasks, project_b_tasks = await asyncio.gather(
        use_project_a(),
        use_project_b(),
    )

    assert project_a_tasks == ["task-a"]
    assert project_b_tasks == ["task-b"]


async def test_activate_project_by_id_scopes_and_restores_the_binding(tmp_path, manager):
    """ProjectContext restores the caller's prior database after its scope."""
    m, _, _ = manager
    project_a_path = tmp_path / "scoped-a"
    project_b_path = tmp_path / "scoped-b"
    project_a_path.mkdir()
    project_b_path.mkdir()
    project_a = m.init_project(project_a_path)
    project_b = m.init_project(project_b_path)

    m.bind_project_by_id(project_a.id)
    async with m.activate_project_by_id(project_b.id) as active_project:
        assert active_project is project_b
        Task.create(
            id="task-b",
            title="B",
            cwd=str(project_b.path),
            created_at=1,
            updated_at=1,
        )

    Task.create(
        id="task-a",
        title="A",
        cwd=str(project_a.path),
        created_at=1,
        updated_at=1,
    )

    m.bind_project_by_id(project_a.id)
    assert [task.id for task in Task.select()] == ["task-a"]
    m.bind_project_by_id(project_b.id)
    assert [task.id for task in Task.select()] == ["task-b"]


def test_save_config_persists_paths(tmp_path, manager):
    """init_project saves [{path, name}] to config store."""
    m, store, _ = manager
    proj_dir = tmp_path / "my-project"
    proj_dir.mkdir()
    m.init_project(proj_dir, name="我的项目")

    projects = store.get("projects")
    assert len(projects) == 1
    assert projects[0]["path"] == str(proj_dir.resolve())
    assert projects[0]["name"] == "我的项目"


def test_rename_project(tmp_path, manager):
    """rename updates project name and persists to config."""
    m, store, _ = manager
    proj_dir = tmp_path / "rename-me"
    proj_dir.mkdir()
    m.init_project(proj_dir, name="旧名字")

    proj = m.rename(proj_dir, "新名字")
    assert proj.name == "新名字"

    projects = store.get("projects")
    assert projects[0]["name"] == "新名字"

    assert m.rename(tmp_path / "nope", "x") is None


def test_unregister_project_only_removes_config_entry(tmp_path, manager):
    """Unregistering forgets a project without deleting its workspace data."""
    m, store, config_file = manager
    first_dir = tmp_path / "first"
    second_dir = tmp_path / "second"
    first_dir.mkdir()
    second_dir.mkdir()
    first = m.init_project(first_dir, name="First")
    second = m.init_project(second_dir, name="Second")

    removed = m.unregister(first.id)

    assert removed is first
    assert m.get_project_by_id(first.id) is None
    assert m.get_project_by_id(second.id) is second
    assert store.get("projects") == [
        {"id": second.id, "path": str(second_dir.resolve()), "name": "Second", "sort_order": 0}
    ]
    assert json.loads(config_file.read_text())["projects"] == [
        {"id": second.id, "path": str(second_dir.resolve()), "name": "Second", "sort_order": 0}
    ]
    assert (first_dir / ".workstep" / "workstep.db").exists()
    assert (first_dir / ".workstep" / "steps.json").exists()


def test_unregister_unknown_project_does_nothing(manager):
    m, store, _ = manager

    assert m.unregister("missing") is None
    assert store.get("projects") is None


def test_load_saved_projects_restores(tmp_path, manager):
    """_load_saved_projects restores projects from config store on startup."""
    m, store, _ = manager
    proj_dir = tmp_path / "restore-me"
    proj_dir.mkdir()
    m.init_project(proj_dir, name="恢复测试")

    m.close_all()

    # Simulate restart: new manager, same config store
    m2 = ProjectManager()
    with patch("services.project.config_store", store):
        m2._load_saved_projects()
        projects = m2.list_projects()
        assert len(projects) == 1
        assert projects[0]["name"] == "恢复测试"
    m2.close_all()


def _seed_workflow_task_data(m, project, workflow_id, task_id="task-1"):
    """Create a task plus a full set of FK-dependent rows for one workflow."""
    task = Task.create(
        id=task_id,
        title="Flow task",
        cwd=str(project.path),
        workflow_id=workflow_id,
        status="running",
        created_at=1,
        updated_at=1,
    )
    TaskStep.create(task=task, step_key="req", status="running")
    message = Message.create(
        id=f"{task_id}-msg",
        task=task,
        step_key="req",
        role="assistant",
        content="hello",
        position=1,
        created_at=1,
    )
    run = WorkflowRun.create(
        id=f"{task_id}-run",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    StepRun.create(
        id=f"{task_id}-sr",
        run=run,
        step_key="req",
        attempt=1,
        status="running",
    )
    ReviewRun.create(
        id=f"{task_id}-rv",
        workflow_run=run,
        step_run=StepRun.get_by_id(f"{task_id}-sr"),
        task=task,
        step_key="req",
        mode="auto",
        status="running",
    )
    CoordinatorSession.create(
        task=task,
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    turn = CoordinatorTurn.create(
        id=f"{task_id}-ct",
        task=task,
        user_message=message,
        assistant_message=message,
        idempotency_key="k",
        status="queued",
        created_at=1,
        updated_at=1,
    )
    proposal = ActionProposal.create(
        id=f"{task_id}-ap",
        task=task,
        source_turn=turn,
        source_message=message,
        type="edit",
        payload_json="{}",
        expected_task_version=1,
        status="pending",
        created_at=1,
        updated_at=1,
    )
    StageSupplement.create(
        id=f"{task_id}-ss",
        task=task,
        step_key="req",
        content="guidance",
        source_proposal=proposal,
        created_sequence=1,
        created_at=1,
    )
    return task


def test_workflow_running_flag_reflects_task_status(tmp_path, manager):
    """list_projects marks a workflow running while any of its tasks run."""
    m, _, _ = manager
    proj = m.init_project(tmp_path)
    wf = m.create_workflow(proj, "Flow")

    _seed_workflow_task_data(m, proj, wf["id"])

    assert m.workflow_has_running_tasks(wf["id"]) is True
    workflows = next(p for p in m.list_projects() if p["id"] == proj.id)["workflows"]
    assert next(w for w in workflows if w["id"] == wf["id"])["running"] is True

    Task.update(status="ready").where(Task.id == "task-1").execute()
    assert m.workflow_has_running_tasks(wf["id"]) is False
    workflows = next(p for p in m.list_projects() if p["id"] == proj.id)["workflows"]
    assert next(w for w in workflows if w["id"] == wf["id"])["running"] is False


def test_workflow_running_flag_is_computed_per_project(tmp_path, manager):
    """Running state must come from each project's own database."""
    m, _, _ = manager
    proj_a = tmp_path / "a"
    proj_b = tmp_path / "b"
    proj_a.mkdir()
    proj_b.mkdir()
    pa = m.init_project(proj_a)
    pb = m.init_project(proj_b)
    wf_a = pa.workflows[0]["id"]
    wf_b = pb.workflows[0]["id"]

    with m.activate_project(proj_a):
        _seed_workflow_task_data(m, pa, wf_a, task_id="task-a")

    # Bind to project B (as other API requests would leave the proxy) to
    # ensure list_projects still queries each project's own database.
    with m.activate_project(proj_b):
        listed = m.list_projects()

    running_by_name = {
        p["name"]: next(w for w in p["workflows"] if not w["deleted"])["running"]
        for p in listed
    }
    assert running_by_name["a"] is True
    assert running_by_name["b"] is False


def test_workflow_hard_delete_clears_all_flow_data(tmp_path, manager):
    """Permanent delete removes tasks and every FK-related table row."""
    m, _, _ = manager
    proj = m.init_project(tmp_path)
    wf = m.create_workflow(proj, "Flow")

    _seed_workflow_task_data(m, proj, wf["id"])
    # A task from another workflow must survive the deletion.
    other = m.create_workflow(proj, "Other")
    Task.create(
        id="task-other",
        title="Other",
        cwd=str(proj.path),
        workflow_id=other["id"],
        created_at=1,
        updated_at=1,
    )

    # Soft delete → data stays.
    result = m.delete_workflow(proj, wf["id"])
    assert result == {"deleted": True, "soft": True}
    assert Task.select().where(Task.id == "task-1").count() == 1

    # Hard delete → everything for the flow is gone, other flow untouched.
    result = m.delete_workflow(proj, wf["id"])
    assert result == {"deleted": True, "soft": False}

    assert Task.select().where(Task.id == "task-1").count() == 0
    assert Task.select().where(Task.id == "task-other").count() == 1
    assert TaskStep.select().count() == 0
    assert Message.select().count() == 0
    assert WorkflowRun.select().count() == 0
    assert StepRun.select().count() == 0
    assert ReviewRun.select().count() == 0
    assert CoordinatorSession.select().count() == 0
    assert CoordinatorTurn.select().count() == 0
    assert ActionProposal.select().count() == 0
    assert StageSupplement.select().count() == 0
    assert Workflow.select().where(Workflow.id == wf["id"]).count() == 0
    assert Workflow.select().where(Workflow.id == other["id"]).count() == 1


def test_workflow_restore_brings_it_back_from_recycle_bin(tmp_path, manager):
    """restore_workflow reactivates a soft-deleted workflow."""
    m, _, _ = manager
    proj = m.init_project(tmp_path)
    wf = m.create_workflow(proj, "Flow")
    m.create_workflow(proj, "Other")  # so Flow can be soft-deleted

    assert m.delete_workflow(proj, wf["id"])["soft"] is True
    restored = m.restore_workflow(proj, wf["id"])
    assert restored is not None
    assert restored["deleted"] is False

    # Restoring an already-active workflow is a no-op.
    assert m.restore_workflow(proj, wf["id"]) is None
