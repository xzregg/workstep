"""Share service tests — session tokens and per-project DB contexts."""

import pytest

from models import db_proxy
from services.project import ProjectManager
from services.task import TaskService
from streaming.bus import EventBus
import services.project as project_service
import services.share as share_service


class MemoryConfigStore:
    """In-memory stand-in for the shared config store."""

    def __init__(self):
        self.values = {}

    def get(self, key, default=None):
        return self.values.get(key, default)

    def set(self, key, value):
        self.values[key] = value


@pytest.fixture
def manager(tmp_path, monkeypatch):
    store = MemoryConfigStore()
    monkeypatch.setattr(project_service, "config_store", store)
    pm = ProjectManager()
    # share_service resolves projects via the module-global manager.
    monkeypatch.setattr(project_service, "project_manager", pm)
    return pm


def _create_task_in_project(manager, path):
    project = manager.init_project(path)
    ts = TaskService(EventBus())
    task = ts.create_task(title="Share me", cwd=str(path))
    return project, task


def _bind(project):
    """Activate a project's DB and return the previous context token."""
    return db_proxy.activate(project.db)


def test_resolve_share_session_finds_share_across_project_dbs(manager, tmp_path):
    """A minted session resolves even when the proxy is bound to another project."""
    project_a, task_a = _create_task_in_project(manager, tmp_path / "proj-a")
    project_b = manager.init_project(tmp_path / "proj-b")

    ctx = _bind(project_a)
    try:
        share = share_service.create_share(task_a["id"])
    finally:
        db_proxy.reset(ctx)

    session_token = share_service.verify_share_password(share["token"], "")
    assert session_token is not None

    # The global db_proxy is bound to a project that does NOT contain the
    # share — resolution must still find it (regression: previously this
    # returned None and the share page failed with 401).
    ctx = _bind(project_b)
    try:
        resolved = share_service.resolve_share_session(session_token)
    finally:
        db_proxy.reset(ctx)

    assert resolved is not None
    assert resolved["task_id"] == task_a["id"]
    assert resolved["token"] == share["token"]


def test_resolve_share_session_rejects_revoked_share(manager, tmp_path):
    """A session whose share was revoked is invalidated."""
    project_a, task_a = _create_task_in_project(manager, tmp_path / "proj-a")

    ctx = _bind(project_a)
    try:
        share = share_service.create_share(task_a["id"])
        session_token = share_service.verify_share_password(share["token"], "")
        assert session_token is not None
        share_service.revoke_share(task_a["id"])
        resolved = share_service.resolve_share_session(session_token)
    finally:
        db_proxy.reset(ctx)

    assert resolved is None


def test_resolve_share_session_unknown_token(manager, tmp_path):
    """Unknown or expired tokens resolve to None."""
    assert share_service.resolve_share_session("does-not-exist") is None
