"""Device audit upload is bounded, idempotent, and scoped to its device."""

from datetime import datetime, timezone

from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import AuditEvent, Device
from gateway.audit_ledger import record_audit_batch


def _event(event_id="audit-1"):
    return {
        "audit_event_id": event_id, "device_id": "device-1",
        "project_id": "project-1", "task_id": "task-1",
        "action": "task.start", "result": "succeeded", "mode": "managed",
        "actor_id": "user-1", "actor_username": "alice",
        "actor_name": "Alice", "actor_type": "user",
        "initiated_by_user_id": "user-1", "initiated_by_username": "alice",
        "metadata": {"source": "manual"},
        "occurred_at": datetime.now(timezone.utc).isoformat(),
    }


def test_audit_batch_replay_and_conflicting_id(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner",
            "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery",
            "recovery_password": "RecoveryPassphrase-2026!",
        })

        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(
                        id="device-1", name="PC", public_key="test",
                        app_instance_id="app", version="1.0", status="active",
                    ))

        client.portal.call(seed)
        event = _event()
        first = client.portal.call(
            record_audit_batch, app.state.database, "device-1", "batch-1",
            [event],
        )
        assert first == {"batch_id": "batch-1", "accepted": ["audit-1"],
                         "duplicates": [], "rejected": []}
        replay = client.portal.call(
            record_audit_batch, app.state.database, "device-1", "batch-2",
            [event],
        )
        assert replay["duplicates"] == ["audit-1"]
        changed = client.portal.call(
            record_audit_batch, app.state.database, "device-1", "batch-3",
            [{**event, "result": "failed"}],
        )
        assert changed["rejected"] == ["audit-1"]

        async def read():
            async with app.state.database.session() as session:
                return await session.get(AuditEvent, "audit-1")

        row = client.portal.call(read)
        assert (row.project_id, row.task_id, row.actor_username,
                row.initiated_by_username, row.result) == (
                    "project-1", "task-1", "alice", "alice", "succeeded",
                )


def test_audit_batch_rejects_cross_device_and_sensitive_metadata(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner",
            "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery",
            "recovery_password": "RecoveryPassphrase-2026!",
        })
        result = client.portal.call(
            record_audit_batch, app.state.database, "device-1", "batch-1", [
                {**_event("bad-device"), "device_id": "device-2"},
                {**_event("bad-secret"), "metadata": {"content": "secret"}},
            ],
        )
        assert result["rejected"] == ["bad-device", "bad-secret"]
