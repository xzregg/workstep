"""Device audit upload is bounded, idempotent, and scoped to its device."""

from datetime import datetime, timezone

from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import AuditEvent, Device, PlatformProject
from gateway.audit_ledger import record_audit_batch


def _event(event_id="audit-1"):
    return {
        "audit_event_id": event_id, "device_id": "device-1",
        "project_id": "project-1", "task_id": "task-1",
        "action": "task.start", "result": "succeeded", "mode": "managed",
        "actor_id": "user-1", "actor_username": "alice",
        "actor_name": "Alice", "actor_type": "user",
        "actor_device_id": "browser-1", "actor_device_name": "Chrome",
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
                row.initiated_by_username, row.actor_device_id,
                row.actor_device_name, row.result) == (
                    "project-1", "task-1", "alice", "alice",
                    "browser-1", "Chrome", "succeeded",
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


def test_audit_batch_rejects_collision_with_gateway_event(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(AuditEvent(
                        id="gateway-event", action="auth.login", result="success",
                    ))

        client.portal.call(seed)
        result = client.portal.call(
            record_audit_batch, app.state.database, "device-1", "batch-1",
            [_event("gateway-event")],
        )
        assert result["rejected"] == ["gateway-event"]


def test_admin_audit_query_only_exposes_published_project_events(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner",
            "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery",
            "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        })
        assert setup.status_code == 201
        owner_id = setup.json()["user"]["id"]

        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(
                        id="device-1", name="PC", public_key="test",
                        app_instance_id="app", version="1.0", status="active",
                    ))
                    session.add(PlatformProject(
                        id="published-1", device_id="device-1",
                        host_project_id="project-1", name="Public",
                        access_mode="remote_published", status="active",
                    ))
                    session.add(PlatformProject(
                        id="private-1", device_id="device-1",
                        host_project_id="project-2", name="Private",
                        access_mode="policy_only", status="active",
                    ))
                    session.add(AuditEvent(
                        id="global-secret", user_id=owner_id,
                        action="auth.login", result="success",
                        metadata_json='{"token":"secret","user_id":"owner"}',
                    ))

        client.portal.call(seed)
        client.portal.call(record_audit_batch, app.state.database,
                           "device-1", "batch-1", [_event("visible")])
        client.portal.call(record_audit_batch, app.state.database,
                           "device-1", "batch-2", [
                               {**_event("hidden"), "project_id": "project-2"},
                           ])
        visible = client.get("/api/admin/audit", params={"project_id": "published-1"})
        assert visible.status_code == 200, visible.text
        assert [item["id"] for item in visible.json()["items"]] == ["visible"]
        hidden = client.get("/api/admin/audit", params={"project_id": "private-1"})
        assert hidden.status_code == 404
        all_events = client.get("/api/admin/audit")
        assert all_events.status_code == 200
        assert "hidden" not in {item["id"] for item in all_events.json()["items"]}
        legacy = next(item for item in all_events.json()["items"]
                      if item["id"] == "global-secret")
        assert legacy["metadata"] == {"user_id": "owner"}

    with TestClient(app, base_url="https://gateway.test") as anonymous:
        assert anonymous.get("/api/admin/audit").status_code == 401
