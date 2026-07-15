"""Tests for project service: init, register, list."""

import json
import pytest
from pathlib import Path

from services.project import ProjectManager, DEFAULT_STEPS


@pytest.fixture
def manager():
    """Fresh ProjectManager per test."""
    m = ProjectManager()
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
    with pytest.raises(ValueError, match="No .workstep"):
        manager.register(tmp_path)


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
