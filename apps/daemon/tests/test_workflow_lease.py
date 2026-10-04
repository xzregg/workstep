"""Run lease ownership, heartbeat and event-loop isolation."""

import asyncio
import threading
import time

import pytest

from models import Task, WorkflowRun
from models.fields import utc_now
from services.project import ProjectManager
from services.workflow_lease import WorkflowLeaseManager


@pytest.mark.anyio
async def test_lease_heartbeat_renews_only_owned_runs_off_event_loop(
    tmp_path, monkeypatch,
):
    from services import workflow_lease

    pm = ProjectManager()
    project = pm.init_project(tmp_path / "project", name="Lease")

    async def no_op():
        return None

    async def no_recovery(_project):
        return None

    manager = WorkflowLeaseManager(pm.run_db, no_op, no_recovery)
    with pm.activate_project(project.path):
        task = Task.create(
            id="lease-owner-task", title="租约", cwd=str(project.path),
            created_at=1, updated_at=1,
        )
        owned = WorkflowRun.create(
            id="lease-owned", task=task, status="running",
            workflow_schema_version=1, workflow_snapshot_json="{}",
            owner_id=manager.instance_id, heartbeat_at=utc_now(),
            started_at=1,
        )
        peer = WorkflowRun.create(
            id="lease-peer", task=task, status="running",
            workflow_schema_version=1, workflow_snapshot_json="{}",
            owner_id="peer", heartbeat_at=utc_now(), started_at=1,
        )
        initial_owned = owned.heartbeat_at
        initial_peer = peer.heartbeat_at

    started = threading.Event()
    original_update = WorkflowRun.update

    def slow_update(*args, **kwargs):
        started.set()
        time.sleep(0.2)
        return original_update(*args, **kwargs)

    monkeypatch.setattr(WorkflowRun, "update", slow_update)
    monkeypatch.setattr(workflow_lease, "RUN_LEASE_HEARTBEAT_SECONDS", 0.01)
    try:
        manager.register(owned.id, project.id)
        assert await asyncio.wait_for(asyncio.to_thread(started.wait), 1)
        assert manager._heartbeat_task is not None
        assert not manager._heartbeat_task.done()
        await asyncio.wait_for(asyncio.sleep(0.01), 0.1)
        manager.release(owned.id)
        await asyncio.sleep(0.25)
        with pm.activate_project(project.path):
            assert WorkflowRun.get_by_id(owned.id).heartbeat_at > initial_owned
            assert WorkflowRun.get_by_id(peer.id).heartbeat_at == initial_peer
    finally:
        await manager.shutdown()
