"""Tests for project service: init, register, list."""

import json
import pytest
from pathlib import Path
from unittest.mock import patch

from services.project import ProjectManager, DEFAULT_STEPS


@pytest.fixture
def manager(tmp_path):
    """Fresh ProjectManager with temp config dir."""
    config_dir = tmp_path / ".workstep"
    config_dir.mkdir()
    config_file = config_dir / "config.json"
    m = ProjectManager()
    with patch("services.project.GLOBAL_CONFIG_DIR", config_dir), \
         patch("services.project.GLOBAL_CONFIG_FILE", config_file):
        yield m
    m.close_all()


def test_init_project_creates_workstep_dir(tmp_path, manager):
    """init_project creates .workstep/ with steps.json and workstep.db."""
    proj = manager.init_project(tmp_path)

    ws_dir = tmp_path / ".workstep"
    assert ws_dir.exists()
    assert (ws_dir / "steps.json").exists()
    assert (ws_dir / "workstep.db").exists()

    steps = json.loads((ws_dir / "steps.json").read_text())
    assert steps == DEFAULT_STEPS


def test_init_project_returns_project(tmp_path, manager):
    """init_project returns a Project with correct attributes."""
    proj = manager.init_project(tmp_path)

    assert proj.path == tmp_path.resolve()
    assert proj.steps == DEFAULT_STEPS
    assert proj.db is not None
    assert not proj.db.is_closed()


def test_init_project_idempotent(tmp_path, manager):
    """Calling init twice returns the same project, doesn't overwrite."""
    proj1 = manager.init_project(tmp_path)
    proj2 = manager.init_project(tmp_path)

    assert proj1 is proj2
    # steps.json should not be overwritten
    steps_path = tmp_path / ".workstep" / "steps.json"
    assert steps_path.exists()


def test_register_existing_project(tmp_path, manager):
    """register opens an existing project's DB."""
    # First init it
    manager.init_project(tmp_path)
    manager.close_all()

    # Now register it fresh
    m2 = ProjectManager()
    proj = m2.register(tmp_path)
    assert proj.path == tmp_path.resolve()
    assert proj.steps == DEFAULT_STEPS
    m2.close_all()


def test_register_nonexistent_raises(tmp_path, manager):
    """register raises if no .workstep/ directory."""
    empty_dir = tmp_path / "empty"
    empty_dir.mkdir()
    with pytest.raises(ValueError, match="No .workstep"):
        manager.register(empty_dir)


def test_list_projects(tmp_path, manager):
    """list_projects returns all registered projects."""
    p1 = tmp_path / "proj-a"
    p2 = tmp_path / "proj-b"
    p1.mkdir()
    p2.mkdir()

    manager.init_project(p1)
    manager.init_project(p2)

    projects = manager.list_projects()
    assert len(projects) == 2
    names = {p["name"] for p in projects}
    assert names == {"proj-a", "proj-b"}


def test_get_project(tmp_path, manager):
    """get_project returns a project by path."""
    manager.init_project(tmp_path)

    proj = manager.get_project(tmp_path)
    assert proj is not None
    assert proj.path == tmp_path.resolve()

    # Non-existent returns None
    assert manager.get_project(tmp_path / "nope") is None


def test_close_all(tmp_path, manager):
    """close_all closes all DB connections."""
    manager.init_project(tmp_path)
    manager.close_all()

    assert manager.list_projects() == []


def test_save_config_persists_paths(tmp_path, manager):
    """init_project saves {path: name} to config.json."""
    from services.project import GLOBAL_CONFIG_FILE
    proj_dir = tmp_path / "my-project"
    proj_dir.mkdir()
    manager.init_project(proj_dir, name="我的项目")

    config = json.loads(GLOBAL_CONFIG_FILE.read_text())
    projects = config["projects"]
    assert str(proj_dir.resolve()) in projects
    assert projects[str(proj_dir.resolve())] == "我的项目"


def test_rename_project(tmp_path, manager):
    """rename updates project name and persists to config."""
    from services.project import GLOBAL_CONFIG_FILE
    proj_dir = tmp_path / "rename-me"
    proj_dir.mkdir()
    manager.init_project(proj_dir, name="旧名字")

    proj = manager.rename(proj_dir, "新名字")
    assert proj.name == "新名字"

    config = json.loads(GLOBAL_CONFIG_FILE.read_text())
    assert config["projects"][str(proj_dir.resolve())] == "新名字"

    # Rename non-existent returns None
    assert manager.rename(tmp_path / "nope", "x") is None


def test_load_saved_projects_restores(tmp_path, manager):
    """_load_saved_projects restores projects from config.json on startup."""
    from services.project import GLOBAL_CONFIG_FILE

    # Create and init a project
    proj_dir = tmp_path / "restore-me"
    proj_dir.mkdir()
    manager.init_project(proj_dir)

    # Simulate restart: new manager, load saved
    manager.close_all()
    m2 = ProjectManager()

    with patch("services.project.GLOBAL_CONFIG_DIR", GLOBAL_CONFIG_FILE.parent), \
         patch("services.project.GLOBAL_CONFIG_FILE", GLOBAL_CONFIG_FILE):
        m2._load_saved_projects()
        assert len(m2.list_projects()) == 1
        assert m2.list_projects()[0]["name"] == "restore-me"
        m2.close_all()
