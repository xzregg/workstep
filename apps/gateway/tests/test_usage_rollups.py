"""Durable incremental and rebuildable usage summaries."""

import asyncio
import sqlite3
from datetime import datetime, timedelta, timezone

from alembic import command
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import func, select

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.database import GatewayDatabase, migration_config
from gateway.models import UsageDailyRollup, UsageRollupQueue
from gateway.services.usage_ledger import record_usage_batch
from gateway.services.usage_rollups import advance_rollups, rebuild_rollups


def _event(event_id: str, when: datetime, *, tokens: int | None = 10) -> dict:
    event = {"usage_event_id": event_id, "device_id": "device-1",
             "user_id": "user-1", "project_id": "project-1",
             "provider_id": "provider-1", "model": "model-a",
             "occurred_at": when.isoformat()}
    if tokens is None:
        return {**event, "metering_status": "unmetered"}
    return {**event, "input_tokens": tokens, "output_tokens": 2,
            "total_tokens": tokens + 2, "estimated_cost": "0.000020",
            "currency": "USD"}


def test_usage_rollup_watermark_rebuild_and_late_arrival(tmp_path, monkeypatch):
    async def idle_worker(_database, stop):
        await stop.wait()
    monkeypatch.setattr("gateway.app.run_usage_rollups", idle_worker)
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    now = datetime.now(timezone.utc)
    yesterday = now - timedelta(days=1)
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "closed",
        })
        accepted = client.portal.call(record_usage_batch, app.state.database,
                                      "device-1", "batch-1", [
                                          _event("one", now),
                                          _event("unknown", now, tokens=None),
                                      ])
        assert len(accepted["accepted"]) == 2
        assert client.portal.call(advance_rollups, app.state.database) == 2
        assert client.portal.call(advance_rollups, app.state.database) == 0
        summary = client.get("/api/admin/usage").json()
        assert summary["event_count"] == 2
        assert summary["unmetered_count"] == 1
        assert summary["input_tokens"] == 10
        assert summary["estimated_cost"] == "0.000020"
        assert summary["summary_source"] == "rollup"

        client.portal.call(record_usage_batch, app.state.database,
                           "device-1", "batch-2", [_event("late", yesterday)])
        assert client.get("/api/admin/usage").json()["summary_source"] == "events"
        assert client.portal.call(advance_rollups, app.state.database) == 1
        assert client.get("/api/admin/usage").json()["event_count"] == 3

        async def state():
            async with app.state.database.session() as session:
                return (
                    await session.scalar(select(func.count()).select_from(UsageRollupQueue)),
                    await session.scalar(select(func.sum(UsageDailyRollup.event_count))),
                )
        assert client.portal.call(state) == (0, 3)
        assert client.portal.call(rebuild_rollups, app.state.database) == 3
        assert client.portal.call(state) == (0, 3)
        assert client.get("/api/admin/usage?group_by=day").json()["group_total"] == 2
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        aligned = client.get("/api/admin/usage", params={
            "from_time": day_start.isoformat(),
            "to_time": (day_start + timedelta(days=1)).isoformat(),
        }).json()
        assert aligned["summary_source"] == "rollup"
        assert aligned["event_count"] == 2
        partial = client.get("/api/admin/usage", params={
            "from_time": (day_start + timedelta(hours=1)).isoformat(),
        }).json()
        assert partial["summary_source"] == "events"
        assert setup.status_code == 201


@pytest.mark.asyncio
async def test_usage_rollup_migration_queues_existing_events(tmp_path):
    settings = GatewaySettings(data_dir=tmp_path)
    database = GatewayDatabase(settings)
    await database.start()
    await database.close()
    await asyncio.to_thread(command.downgrade,
                            migration_config(settings.effective_database_url),
                            "0030_usage_reconciliation")
    with sqlite3.connect(tmp_path / "workstep_platform.db") as connection:
        connection.execute(
            "INSERT INTO usage_events "
            "(id, device_id, source, metering_status, occurred_at, received_at, "
            "input_tokens, output_tokens, currency, estimated_cost) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("historical", "device-1", "reported_by_device", "metered",
             datetime.now(timezone.utc).isoformat(), datetime.now(timezone.utc).isoformat(),
             7, 3, "USD", "0.000010"),
        )
    await database.start()
    try:
        assert await advance_rollups(database) == 1
        async with database.session() as session:
            assert await session.scalar(select(func.sum(UsageDailyRollup.input_tokens))) == 7
    finally:
        await database.close()
