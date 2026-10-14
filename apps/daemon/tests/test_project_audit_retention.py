"""Maintenance must yield between bounded DB work and avoid startup contention."""
import asyncio
from types import SimpleNamespace

import pytest

from services.project_audit_retention import ProjectAuditRetention


@pytest.mark.anyio
async def test_retention_yields_between_small_batches_and_close_interrupts_pause(monkeypatch):
    calls = []
    entered = asyncio.Event()

    def prune(project_id, *, batch_size):
        calls.append((project_id, batch_size))
        entered.set()
        return batch_size

    async def run_db(project_id, operation):
        return operation(None)

    monkeypatch.setattr("services.project_audit_retention.prune_project_audit", prune)
    manager = SimpleNamespace(iter_projects=lambda: [SimpleNamespace(id="p1")], run_db=run_db)
    retention = ProjectAuditRetention(manager, startup_delay=0, batch_pause=60)
    retention.start()
    await asyncio.wait_for(entered.wait(), 1)
    await asyncio.sleep(0)
    assert calls == [("p1", 100)]
    await asyncio.wait_for(retention.close(), 0.2)
    assert calls == [("p1", 100)]


@pytest.mark.anyio
async def test_retention_waits_for_startup_and_close_skips_all_sql():
    calls = []
    async def run_db(project_id, operation):
        calls.append(project_id)
    manager = SimpleNamespace(iter_projects=lambda: [SimpleNamespace(id="p1")], run_db=run_db)
    retention = ProjectAuditRetention(manager, startup_delay=60)
    retention.start()
    await asyncio.sleep(0)
    assert calls == []
    await asyncio.wait_for(retention.close(), 0.2)
    assert calls == []
