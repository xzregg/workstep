from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import AuditEvent, Device
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


def test_provider_bill_import_is_idempotent_and_reports_daily_difference(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    day = datetime.now(timezone.utc).date().isoformat()
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "closed",
        })
        csrf = {"X-CSRF-Token": setup.json()["csrf_token"]}
        event = _event()
        client.portal.call(record_usage_batch, app.state.database,
                           "device-1", "batch-1", [event])
        bill = {"batch_id": "bill-import-1", "lines": [{
            "line_id": "provider-line-1", "provider_id": "provider-1",
            "model": "model-a", "day": day, "input_tokens": 125,
            "output_tokens": 30, "currency": "USD", "billed_cost": "0.00020",
        }]}
        assert client.post("/api/admin/usage/provider-bills", json=bill).status_code == 403
        assert client.post("/api/admin/usage/provider-bills", headers=csrf,
                           json=bill).status_code == 403
        assert client.post("/api/auth/step-up", headers=csrf, json={
            "password": "OwnerPassphrase-2026!",
        }).status_code == 200
        first = client.post("/api/admin/usage/provider-bills", headers=csrf, json=bill)
        assert first.status_code == 200, first.text
        assert first.json()["accepted"] == ["provider-line-1"]
        async def audit_actions():
            from sqlalchemy import select
            async with app.state.database.session() as session:
                return (await session.scalars(select(AuditEvent.action).where(
                    AuditEvent.action == "admin.provider_bill_imported",
                ))).all()
        assert client.portal.call(audit_actions) == ["admin.provider_bill_imported"]
        replay = client.post("/api/admin/usage/provider-bills", headers=csrf, json=bill)
        assert replay.json()["duplicates"] == ["provider-line-1"]
        changed = client.post("/api/admin/usage/provider-bills", headers=csrf,
                              json={**bill, "lines": [{**bill["lines"][0],
                                                        "input_tokens": 999}]})
        assert changed.status_code == 409
        assert client.get("/api/admin/usage").json()["event_count"] == 1
        provider_summary = client.get("/api/admin/usage?source=provider_reconciled").json()
        assert provider_summary["event_count"] == 1
        assert provider_summary["billed_cost"] == "0.000200"
        reconciliation = client.get(
            f"/api/admin/usage/reconciliation?provider_id=provider-1&from_day={day}&to_day={day}"
        )
        assert reconciliation.status_code == 200, reconciliation.text
        row = reconciliation.json()["rows"][0]
        assert row["status"] == "different"
        assert row["input_tokens_difference"] == 5
        assert row["cost_difference"] == "0.000020"
        assert row["billed_cost"] == "0.000200"
        assert client.get(
            f"/api/admin/usage/reconciliation?provider_id=provider-1&from_day={day}"
            "&to_day=2099-01-01"
        ).status_code == 422


def test_provider_reconciliation_distinguishes_missing_unmetered_and_currency(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    day = datetime.now(timezone.utc).date().isoformat()
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "closed",
        })
        csrf = {"X-CSRF-Token": setup.json()["csrf_token"]}
        assert client.post("/api/auth/step-up", headers=csrf, json={
            "password": "OwnerPassphrase-2026!",
        }).status_code == 200
        device_events = [
            {**_event("matched"), "model": "matched", "input_tokens": 10,
             "output_tokens": 2, "total_tokens": 12, "estimated_cost": "0.1"},
            {"usage_event_id": "unmetered", "provider_id": "provider-1",
             "model": "incomplete", "metering_status": "unmetered",
             "occurred_at": datetime.now(timezone.utc).isoformat()},
            {**_event("currency"), "model": "currency", "currency": "CNY"},
            {**_event("no-bill"), "model": "no-bill"},
            {"usage_event_id": "no-model", "provider_id": "provider-1",
             "metering_status": "unmetered",
             "occurred_at": datetime.now(timezone.utc).isoformat()},
        ]
        client.portal.call(record_usage_batch, app.state.database,
                           "device-1", "batch-1", device_events)
        lines = [
            {"line_id": "matched", "provider_id": "provider-1", "model": "matched",
             "day": day, "input_tokens": 10, "output_tokens": 2,
             "currency": "USD", "billed_cost": "0.1"},
            {"line_id": "incomplete", "provider_id": "provider-1",
             "model": "incomplete", "day": day, "input_tokens": 0,
             "output_tokens": 0, "currency": "USD", "billed_cost": "0"},
            {"line_id": "currency", "provider_id": "provider-1", "model": "currency",
             "day": day, "input_tokens": 120, "output_tokens": 30,
             "currency": "USD", "billed_cost": "0.00018"},
            {"line_id": "no-device", "provider_id": "provider-1",
             "model": "no-device", "day": day, "input_tokens": 3,
             "output_tokens": 1, "currency": "USD", "billed_cost": "0.01"},
        ]
        imported = client.post("/api/admin/usage/provider-bills", headers=csrf,
                               json={"batch_id": "bill-1", "lines": lines})
        assert imported.status_code == 200, imported.text
        rows = client.get(
            f"/api/admin/usage/reconciliation?provider_id=provider-1&from_day={day}&to_day={day}"
        ).json()["rows"]
        assert {row["model"]: row["status"] for row in rows} == {
            "matched": "matched", "incomplete": "incomplete",
            "currency": "incomparable", "no-bill": "awaiting_provider",
            "no-device": "missing_device", None: "awaiting_provider",
        }
