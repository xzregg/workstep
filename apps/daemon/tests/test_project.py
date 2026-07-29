"""Tests for project service: init, register, list."""

import asyncio
import json
import pytest
from pathlib import Path
from unittest.mock import patch

from models import Task
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
