"""Tests for project service: init, register, list."""

import json
import pytest
from pathlib import Path
from unittest.mock import patch

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


def test_save_config_persists_paths(tmp_path, manager):
    """init_project saves {path: name} to config store."""
    m, store, config_file = manager
    proj_dir = tmp_path / "my-project"
    proj_dir.mkdir()
    m.init_project(proj_dir, name="我的项目")

    projects = store.get("projects")
    assert str(proj_dir.resolve()) in projects
    assert projects[str(proj_dir.resolve())] == "我的项目"


def test_rename_project(tmp_path, manager):
    """rename updates project name and persists to config."""
    m, store, _ = manager
    proj_dir = tmp_path / "rename-me"
    proj_dir.mkdir()
    m.init_project(proj_dir, name="旧名字")

    proj = m.rename(proj_dir, "新名字")
    assert proj.name == "新名字"

    projects = store.get("projects")
    assert projects[str(proj_dir.resolve())] == "新名字"

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
