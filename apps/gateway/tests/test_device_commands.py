import base64
import json
import sqlite3
import time
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import Device, DeviceCommand, DeviceOperationBatch
from gateway.device_commands import next_command_for_device, record_command_result


def test_batch_freezes_targets_and_dispatches_with_one_slot(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        })
        csrf = setup.json()["csrf_token"]
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    for index in range(1, 3):
                        session.add(Device(id=f"device-{index}", name=f"PC {index}",
                                           public_key="test", app_instance_id=f"app-{index}",
                                           version="1.0", status="active"))
        client.portal.call(seed)
        client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"},
                    headers={"X-CSRF-Token": csrf})
        body = {"action": "refresh", "engine_id": "codex", "device_ids": [
            "device-1", "device-2"], "max_concurrency": 1}
        created = client.post("/api/admin/device-operations", json=body,
                              headers={"X-CSRF-Token": csrf})
        assert created.status_code == 200, created.text
        batch_id = created.json()["id"]
        listed = client.get("/api/admin/device-operations?limit=1&offset=0")
        assert listed.status_code == 200
        assert listed.json()["batches"][0]["id"] == batch_id
        assert [item["device_id"] for item in created.json()["commands"]] == body["device_ids"]
        assert client.post("/api/admin/device-operations", json={
            **body, "action": "shell"}, headers={"X-CSRF-Token": csrf}).status_code == 422
        assert client.post("/api/admin/device-operations", json={
            **body, "action": "install", "version": "1.2.3",
        }, headers={"X-CSRF-Token": csrf}).status_code == 422
        first = client.portal.call(next_command_for_device, app.state.database,
                                   app.state.command_scheduler_lock, "device-1")
        assert first and first["action"] == "refresh"
        signed = app.state.gateway_signer.sign_device_command(
            gateway_id="gateway-test", **first,
        )
        assert json.loads(base64.urlsafe_b64decode(signed.split(".")[1] + "==="))["action"] == "refresh"
        assert client.portal.call(next_command_for_device, app.state.database,
                                  app.state.command_scheduler_lock, "device-2") is None
        assert client.portal.call(next_command_for_device, app.state.database,
                                  app.state.command_scheduler_lock, "device-1")["id"] == first["id"]
        client.portal.call(record_command_result, app.state.database, first["id"],
                           "device-1", "succeeded", None)
        second = client.portal.call(next_command_for_device, app.state.database,
                                    app.state.command_scheduler_lock, "device-2")
        assert second and second["id"] != first["id"]
        client.portal.call(record_command_result, app.state.database, second["id"],
                           "device-2", "failed", "Engine unavailable")
        status = client.get(f"/api/admin/device-operations/{batch_id}")
        assert status.status_code == 200
        assert status.json()["status"] == "finished"
        assert [item["status"] for item in status.json()["commands"]] == [
            "succeeded", "failed"]
        retried = client.post(f"/api/admin/device-operations/{batch_id}/retry-failed",
                              headers={"X-CSRF-Token": csrf})
        assert retried.status_code == 200
        assert len(retried.json()["commands"]) == 1
        assert retried.json()["commands"][0]["device_id"] == "device-2"
        retry_id = retried.json()["commands"][0]["id"]

        async def expire_retry():
            async with app.state.database.session() as session:
                async with session.begin():
                    command = await session.get(DeviceCommand, retry_id)
                    command.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)

        client.portal.call(expire_retry)
        expired = client.get('/api/admin/device-operations')
        retry_batch = next(batch for batch in expired.json()['batches'] if batch['id'] == retried.json()['id'])
        assert retry_batch['commands'][0]['status'] == 'expired'
        assert retry_batch['status'] == 'finished'
        assert client.portal.call(next_command_for_device, app.state.database,
                                  app.state.command_scheduler_lock, "device-2") is None


def test_running_command_can_reconcile_after_original_delivery_ttl(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id="device-1", name="PC", public_key="test",
                                       app_instance_id="app", version="1.0", status="active"))
                    session.add(DeviceOperationBatch(id="batch-1", action="install", status="running",
                        max_concurrency=1, parameters_json=json.dumps({"engine_id": "codex",
                            "version": "1.2.3", "accept_third_party_terms": True})))
                    session.add(DeviceCommand(id="command-1", batch_id="batch-1",
                        device_id="device-1", idempotency_key="idempotent-1", status="running",
                        target_order=0, expires_at=datetime.now(timezone.utc) - timedelta(minutes=1)))
        client.portal.call(seed)
        command = client.portal.call(next_command_for_device, app.state.database,
                                     app.state.command_scheduler_lock, "device-1")
        assert command is not None
        assert command["id"] == "command-1"
        assert command["expires_at"] > int(time.time())
        token = app.state.gateway_signer.sign_device_command(gateway_id="gateway-test", **command)
        claims = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "==="))
        assert claims["kind"] == "device.command.reconcile"
        assert client.portal.call(record_command_result, app.state.database, "command-1",
                                  "device-1", "succeeded", None)
        assert client.portal.call(next_command_for_device, app.state.database,
                                  app.state.command_scheduler_lock, "device-1") is None


def test_locked_command_database_does_not_block_gateway_health(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id="device-1", name="PC", public_key="test",
                                       app_instance_id="app", version="1.0", status="active"))
                    session.add(DeviceOperationBatch(
                        id="batch-1", action="refresh", status="queued",
                        max_concurrency=1, parameters_json=json.dumps({
                            "engine_id": "codex", "version": None,
                            "accept_third_party_terms": False,
                        }),
                    ))
                    session.add(DeviceCommand(
                        id="command-1", batch_id="batch-1", device_id="device-1",
                        idempotency_key="key-1", status="queued", target_order=0,
                        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
                    ))
        client.portal.call(seed)
        with sqlite3.connect(tmp_path / "workstep_platform.db", timeout=5) as holder:
            holder.execute("BEGIN IMMEDIATE")
            pending = client.portal.start_task_soon(
                next_command_for_device, app.state.database,
                app.state.command_scheduler_lock, "device-1",
            )
            time.sleep(0.04)
            assert not pending.done()
            started = time.monotonic()
            assert client.get("/api/health").json() == {"status": "ok"}
            assert time.monotonic() - started < 0.5
            holder.rollback()
            assert pending.result(timeout=5)["id"] == "command-1"
