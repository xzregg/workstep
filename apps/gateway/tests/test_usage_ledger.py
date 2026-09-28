from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import Device
from gateway.usage_ledger import record_usage_batch


def _event(event_id="usage-1"):
    return {"usage_event_id": event_id, "request_id": "request-1",
            "user_id": "user-1", "initiated_by_user_id": "user-1",
            "project_id": "project-1", "task_id": "task-1", "session_id": "session-1",
            "provider_id": "provider-1", "provider_revision": 3,
            "model": "model-a", "input_tokens": 120, "output_tokens": 30,
            "cache_read_tokens": 10, "cache_write_tokens": 0,
            "total_tokens": 150, "pricing_version": "v1", "currency": "USD",
            "estimated_cost": "0.00018", "occurred_at": datetime.now(timezone.utc).isoformat()}


def test_usage_batch_is_idempotent_and_admin_can_query_dimensions(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        })
        owner_id = setup.json()["user"]["id"]

        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id="device-1", name="PC", public_key="test",
                                       app_instance_id="app", version="1.0", status="active"))

        client.portal.call(seed)
        event = {**_event(), "user_id": owner_id, "initiated_by_user_id": owner_id}
        first = client.portal.call(record_usage_batch, app.state.database,
                                   "device-1", "batch-1", [event])
        assert first == {"batch_id": "batch-1", "accepted": ["usage-1"],
                         "duplicates": [], "rejected": []}
        replay = client.portal.call(record_usage_batch, app.state.database,
                                    "device-1", "batch-1", [event])
        assert replay["duplicates"] == ["usage-1"]
        assert replay["accepted"] == []
        changed = client.portal.call(record_usage_batch, app.state.database,
                                     "device-1", "batch-2", [
                                         {**event, "input_tokens": 999},
                                     ])
        assert changed["rejected"] == ["usage-1"]
        unmetered = client.portal.call(record_usage_batch, app.state.database,
                                       "device-1", "batch-3", [{
                                           "usage_event_id": "usage-2", "model": "model-b",
                                           "metering_status": "unmetered",
                                           "occurred_at": datetime.now(timezone.utc).isoformat(),
                                       }])
        assert unmetered["accepted"] == ["usage-2"]
        summary = client.get("/api/admin/usage?device_id=device-1&provider_id=provider-1")
        assert summary.status_code == 200, summary.text
        assert summary.json()["event_count"] == 1
        assert summary.json()["input_tokens"] == 120
        assert summary.json()["total_tokens"] == 150
        assert summary.json()["estimated_cost"] == "0.000180"
        assert summary.json()["currency"] == "USD"
        total = client.get("/api/admin/usage").json()
        assert total["unmetered_count"] == 1
        grouped = client.get("/api/admin/usage?group_by=model").json()
        assert grouped["group_total"] == 2
        assert {item["value"]: item["event_count"] for item in grouped["groups"]} == {
            "model-a": 1, "model-b": 1,
        }
        assert next(item for item in grouped["groups"] if item["value"] == "model-b")[
            "unmetered_count"] == 1
        detail = client.get("/api/admin/usage/events?page_size=1&source=reported_by_device")
        assert detail.status_code == 200, detail.text
        assert detail.json()["total"] == 2
        assert detail.json()["events"][0]["metering_status"] == "unmetered"
        assert detail.json()["events"][0]["total_tokens"] is None
        second = client.get("/api/admin/usage/events?page_size=1&page=2")
        assert second.json()["events"][0]["request_id"] == "request-1"
        assert second.json()["events"][0]["task_id"] == "task-1"
        assert second.json()["events"][0]["estimated_cost"] == "0.000180"
        assert client.get("/api/admin/usage/events?model=model-b&metering_status=unmetered").json()[
            "total"] == 1
        assert client.get("/api/admin/usage/events?model=model-b&metering_status=metered").json()[
            "total"] == 0
        assert client.get("/api/admin/usage?source=provider_reconciled").json()["event_count"] == 0
        assert client.get("/api/admin/usage/events?page_size=101").status_code == 422
        assert client.get("/api/admin/usage?from_time=2026-01-01T00:00:00").status_code == 422
        assert client.get("/api/admin/usage/events?from_time=2026-01-02T00:00:00Z"
                          "&to_time=2026-01-01T00:00:00Z").status_code == 422
        assert "api_key" not in second.text


def test_usage_batch_rejects_invalid_or_cross_device_events(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        })
        response = client.portal.call(record_usage_batch, app.state.database,
                                      "device-1", "batch-2", [
                                          {**_event("bad-1"), "device_id": "device-2"},
                                          {**_event("bad-2"), "input_tokens": -1},
                                          {"usage_event_id": "bad-3", "metering_status": "unmetered",
                                           "cache_read_tokens": 1,
                                           "occurred_at": datetime.now(timezone.utc).isoformat()},
                                      ])
        assert response["accepted"] == []
        assert set(response["rejected"]) == {"bad-1", "bad-2", "bad-3"}


def test_usage_summary_does_not_add_costs_from_different_currencies(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "closed",
        })
        accepted = client.portal.call(record_usage_batch, app.state.database,
                                      "device-1", "batch-1", [
                                          {**_event("usd"), "currency": "USD"},
                                          {**_event("cny"), "currency": "CNY"},
                                      ])
        assert accepted["accepted"] == ["usd", "cny"]
        summary = client.get("/api/admin/usage").json()
        assert summary["event_count"] == 2
        assert summary["total_tokens"] == 300
        assert summary["estimated_cost"] is None
        assert summary["currency"] == "mixed"


def test_usage_detail_requires_administrator_role(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "closed",
        })
        csrf = setup.json()["csrf_token"]
        assert client.post("/api/admin/users", headers={"X-CSRF-Token": csrf}, json={
            "username": "member", "display_name": "Member", "password": "MemberPassphrase-2026!",
        }).status_code == 201
        client.cookies.clear()
        assert client.get("/api/admin/usage/events").status_code == 401
        login = client.post("/api/auth/login", json={
            "username": "member", "password": "MemberPassphrase-2026!",
        })
        assert login.status_code == 200
        assert client.post("/api/auth/password", headers={
            "X-CSRF-Token": login.json()["csrf_token"],
        }, json={
            "current_password": "MemberPassphrase-2026!",
            "new_password": "MemberNewPassphrase-2026!",
        }).status_code == 204
        assert client.get("/api/admin/usage").status_code == 403
        assert client.get("/api/admin/usage/events").status_code == 403
