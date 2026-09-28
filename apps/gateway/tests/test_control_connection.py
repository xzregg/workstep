import base64
import hashlib
import json
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
import pytest

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from gateway.app import create_app
from gateway.config import GatewaySettings


def _active_device(client):
    setup = client.post("/api/platform/setup", json={
        "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
        "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
        "registration_mode": "closed",
    })
    csrf = setup.json()["csrf_token"]
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()

    def redeem():
        verifier = "desktop-verifier-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        state = "state-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        nonce = "nonce-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        authorize = client.post("/api/desktop/authorize", headers={"X-CSRF-Token": csrf}, json={
            "state": state, "nonce": nonce, "code_challenge": challenge,
            "app_instance_id": "app-instance-12345", "gateway_id": "gateway-test",
        })
        from urllib.parse import parse_qs, urlparse
        code = parse_qs(urlparse(authorize.json()["callback_url"]).query)["code"][0]
        return client.post("/api/desktop/token", json={
            "code": code, "state": state, "nonce": nonce, "code_verifier": verifier,
            "app_instance_id": "app-instance-12345", "gateway_id": "gateway-test",
            "device_public_key": public_key, "device_name": "Alice PC", "version": "1.0.0",
        }).json()

    pending = redeem()
    device_id = pending["device"]["id"]
    client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"},
                headers={"X-CSRF-Token": csrf})
    assert client.post(f"/api/admin/devices/{device_id}/approve",
                       headers={"X-CSRF-Token": csrf}).status_code == 204
    active = redeem()
    token = active["device_authorization"]
    return device_id, token, private_key, csrf


def _handshake(ws, token, device_key, *, wrong_challenge=False, wrong_delegation=False,
               wrong_config_proof=False):
    challenge = ws.receive_json()
    assert challenge["kind"] == "challenge"
    control_key = Ed25519PrivateKey.generate()
    public_key = control_key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    fingerprint = hashlib.sha256(control_key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
    )).hexdigest()
    signing_key = Ed25519PrivateKey.generate() if wrong_delegation else device_key
    delegation = base64.urlsafe_b64encode(signing_key.sign(
        f"workstep-control-delegate-v1:{token}:{fingerprint}".encode(),
    )).rstrip(b"=").decode()
    nonce = "wrong-nonce" if wrong_challenge else challenge["nonce"]
    proof = base64.urlsafe_b64encode(control_key.sign(
        f"workstep-control-challenge-v1:{nonce}:{token}".encode(),
    )).rstrip(b"=").decode()
    config_key = X25519PrivateKey.generate()
    config_public_key = config_key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    config_fingerprint = hashlib.sha256(config_key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
    )).hexdigest()
    config_signer = Ed25519PrivateKey.generate() if wrong_config_proof else control_key
    config_proof = base64.urlsafe_b64encode(config_signer.sign(
        f"workstep-config-key-v1:{nonce}:{token}:{config_fingerprint}".encode(),
    )).rstrip(b"=").decode()
    ws.send_json({"authorization": token, "control_public_key_pem": public_key,
                  "control_delegation_signature": delegation,
                  "control_challenge_proof": proof,
                  "config_public_key_pem": config_public_key,
                  "config_key_proof": config_proof})
    return config_key


def test_control_socket_authenticates_device_and_tracks_connection(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, device_key, csrf = _active_device(client)
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, device_key)
            hello = ws.receive_json()
            assert hello["kind"] == "hello"
            assert hello["device_id"] == device_id
            assert hello["policy_snapshot"]
            assert app.state.gateway_signer.verify_skill_manifest(
                hello["skill_manifest"], gateway_id="gateway-test",
                device_id=device_id, user_id=json.loads(base64.urlsafe_b64decode(
                    token.split(".")[1] + "==="))["user_id"],
            )["projects"] == []
            signing_input = ".".join(hello["policy_snapshot"].split(".")[:2]).encode()
            signature = base64.urlsafe_b64decode(hello["policy_snapshot"].split(".")[2] + "==")
            serialization.load_pem_public_key(hello["gateway_public_key_pem"].encode()).verify(
                signature, signing_input,
            )
            policy = json.loads(base64.urlsafe_b64decode(hello["policy_snapshot"].split(".")[1] + "=="))
            assert policy["device_id"] == device_id
            assert policy["user_id"]
            assert policy["allow_local_providers"] is False
            ws.send_json({"kind": "policy_applied", "revision": policy["policy_revision"]})
            assert ws.receive_json()["kind"] == "policy_applied_ack"
            with sqlite3.connect(tmp_path / "workstep_platform.db") as database:
                assert database.execute("SELECT applied_policy_revision FROM device_connections").fetchone() == (0,)
            listed = client.get("/api/admin/devices", headers={"X-CSRF-Token": csrf}).json()["devices"]
            assert listed[0]["online"] is True
            assert listed[0]["daemon_health"] is None
            ws.send_json({"kind": "heartbeat", "daemon_health": True})
            heartbeat = ws.receive_json()
            assert heartbeat["kind"] == "heartbeat_ack"
            assert heartbeat["skill_manifest"]
            assert client.get("/api/admin/devices").json()["devices"][0]["daemon_health"] is True
            ws.send_json({"kind": "heartbeat", "daemon_health": False})
            assert ws.receive_json()["kind"] == "heartbeat_ack"
            assert client.get("/api/admin/devices").json()["devices"][0]["daemon_health"] is False
        listed = client.get("/api/admin/devices").json()["devices"]
        assert listed[0]["online"] is False
        assert listed[0]["daemon_health"] is None


def test_control_delivers_signed_device_command_and_records_result(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, device_key, csrf = _active_device(client)
        created = client.post("/api/admin/device-operations", headers={"X-CSRF-Token": csrf}, json={
            "action": "refresh", "engine_id": "codex", "device_ids": [device_id],
            "max_concurrency": 1,
        })
        assert created.status_code == 200, created.text
        command_id = created.json()["commands"][0]["id"]
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, device_key)
            hello = ws.receive_json()
            assert hello["command"]["kind"] == "device_command"
            claims = json.loads(base64.urlsafe_b64decode(
                hello["command"]["token"].split(".")[1] + "===",
            ))
            assert claims["command_id"] == command_id
            assert claims["device_id"] == device_id
            ws.send_json({"kind": "command_status", "command_id": command_id,
                          "status": "succeeded"})
            assert ws.receive_json()["kind"] == "command_status_ack"
        status = client.get(f"/api/admin/device-operations/{created.json()['id']}")
        assert status.json()["commands"][0]["status"] == "succeeded"


def test_project_runtime_snapshot_is_scoped_to_live_device_and_published_projects(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, device_key, _ = _active_device(client)
        with sqlite3.connect(tmp_path / "workstep_platform.db") as database:
            database.execute("""INSERT INTO platform_projects
                (id,device_id,host_project_id,name,access_mode,status)
                VALUES ('published-1',?,'host-1','Published','remote_published','active')""", (device_id,))
            database.execute("""INSERT INTO platform_projects
                (id,device_id,host_project_id,name,access_mode,status)
                VALUES ('private-1',?,'host-2','Private','policy_only','active')""", (device_id,))
        assert client.get("/api/admin/projects").json()["projects"][0]["running_tasks"] is None
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, device_key)
            assert ws.receive_json()["kind"] == "hello"
            ws.send_json({"kind": "project_runtime", "version": 1, "device_id": device_id,
                          "projects": [{"id": "host-1", "running_tasks": 3},
                                       {"id": "host-2", "running_tasks": 99}]})
            ws.send_json({"kind": "heartbeat", "daemon_health": True})
            assert ws.receive_json()["kind"] == "heartbeat_ack"
            listed = client.get("/api/admin/projects").json()["projects"]
            assert len(listed) == 1
            assert listed[0]["running_tasks"] == 3
            assert client.get("/api/admin/overview").json()["tasks"] == {
                "running": 3, "unknown_projects": 0,
            }
            app.state.control_connections._project_runtime[device_id] = (
                time.monotonic() - 61, {"host-1": 3},
            )
            assert client.get("/api/admin/projects").json()["projects"][0]["running_tasks"] is None
            ws.send_json({"kind": "project_runtime", "version": 1, "device_id": device_id,
                          "projects": [{"id": "host-2", "running_tasks": 99}]})
            ws.send_json({"kind": "heartbeat", "daemon_health": True})
            assert ws.receive_json()["kind"] == "heartbeat_ack"
            assert client.get("/api/admin/projects").json()["projects"][0]["running_tasks"] is None
            assert client.get("/api/admin/overview").json()["tasks"] == {
                "running": None, "unknown_projects": 1,
            }
        assert client.get("/api/admin/projects").json()["projects"][0]["running_tasks"] is None


def test_project_runtime_rejects_invalid_counts(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, device_key, _ = _active_device(client)
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, device_key)
            assert ws.receive_json()["kind"] == "hello"
            ws.send_json({"kind": "project_runtime", "version": 1, "device_id": device_id,
                          "projects": [{"id": "host-1", "running_tasks": -1}]})
            with pytest.raises(WebSocketDisconnect) as error:
                ws.receive_json()
            assert error.value.code == 4400


def test_control_accepts_usage_batch_and_acks_after_commit(tmp_path):
    from datetime import datetime, timezone

    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, device_key, _ = _active_device(client)
        user_id = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "==="))["user_id"]
        usage = {"usage_event_id": "usage-1", "request_id": "request-1",
                 "device_id": device_id, "user_id": user_id, "model": "model-a",
                 "input_tokens": 10, "output_tokens": 2, "total_tokens": 12,
                 "occurred_at": datetime.now(timezone.utc).isoformat()}
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, device_key)
            assert ws.receive_json()["kind"] == "hello"
            ws.send_json({"kind": "usage_batch", "version": 1,
                          "batch_id": "batch-1", "events": [usage]})
            ack = ws.receive_json()
            assert ack["kind"] == "usage_ack"
            assert ack["accepted"] == ["usage-1"]
            ws.send_json({"kind": "usage_batch", "version": 1,
                          "batch_id": "batch-1", "events": [usage]})
            assert ws.receive_json()["duplicates"] == ["usage-1"]


def test_control_accepts_audit_batch_and_acks_after_commit(tmp_path):
    from datetime import datetime, timezone

    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, device_key, _ = _active_device(client)
        audit = {
            "audit_event_id": "audit-1", "device_id": device_id,
            "project_id": "project-1", "task_id": "task-1",
            "action": "task.start", "result": "succeeded", "mode": "managed",
            "actor_id": "user-1", "actor_username": "alice",
            "actor_type": "user", "metadata": {"source": "manual"},
            "occurred_at": datetime.now(timezone.utc).isoformat(),
        }
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, device_key)
            assert ws.receive_json()["kind"] == "hello"
            ws.send_json({"kind": "audit_batch", "version": 1,
                          "batch_id": "audit-batch-1", "events": [audit]})
            ack = ws.receive_json()
            assert ack["kind"] == "audit_ack"
            assert ack["accepted"] == ["audit-1"]
            ws.send_json({"kind": "audit_batch", "version": 1,
                          "batch_id": "audit-batch-1", "events": [audit]})
            assert ws.receive_json()["duplicates"] == ["audit-1"]


def test_control_records_project_skill_application_for_own_device(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, device_key, _ = _active_device(client)
        with sqlite3.connect(tmp_path / "workstep_platform.db") as database:
            database.execute(
                "INSERT INTO platform_projects (id,device_id,host_project_id,name,"
                "access_mode,status,skill_revision) VALUES (?,?,?,?,?,?,?)",
                ("platform-1", device_id, "host-1", "Project", "policy_only", "active", 1),
            )
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, device_key)
            assert ws.receive_json()["kind"] == "hello"
            ws.send_json({"kind": "skill_applied", "version": 1, "projects": [{
                "project_id": "platform-1", "revision": 1,
                "status": "applied", "error_code": None,
            }]})
            ack = ws.receive_json()
            assert ack["kind"] == "skill_applied_ack"
            assert ack["projects"] == ["platform-1"]
        with sqlite3.connect(tmp_path / "workstep_platform.db") as database:
            assert database.execute(
                "SELECT desired_revision,applied_revision,status FROM "
                "device_project_skill_state WHERE device_id=? AND host_project_id=?",
                (device_id, "host-1"),
            ).fetchone() == (1, 1, "applied")
        applications = client.get("/api/admin/skills/applications")
        assert applications.status_code == 200
        assert applications.json()["projects"][0]["applied_revision"] == 1


def test_admin_publishes_from_live_catalog_and_unpublishes_offline(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, device_key, csrf = _active_device(client)
        headers = {"X-CSRF-Token": csrf}
        with ThreadPoolExecutor(max_workers=1) as pool:
            with client.websocket_connect("/api/control/ws") as ws:
                _handshake(ws, token, device_key)
                assert ws.receive_json()["kind"] == "hello"
                listing = pool.submit(client.get,
                    f"/api/admin/devices/{device_id}/publishable-projects")
                requested = ws.receive_json()
                assert requested["kind"] == "project_catalog_request"
                ws.send_json({"kind": "project_catalog_response", "version": 1,
                              "device_id": device_id, "request_id": requested["request_id"],
                              "status": "ok", "projects": [{"id": "host-1", "name": "Backend"}]})
                available = listing.result(timeout=5)
                assert available.status_code == 200, available.text
                assert available.json()["projects"] == [{
                    "host_project_id": "host-1", "name": "Backend", "published": False,
                }]
                missing = pool.submit(client.post,
                    f"/api/admin/devices/{device_id}/projects/host-2/publish", headers=headers)
                requested = ws.receive_json()
                ws.send_json({"kind": "project_catalog_response", "version": 1,
                              "device_id": device_id, "request_id": requested["request_id"],
                              "status": "ok", "projects": [{"id": "host-1", "name": "Backend"}]})
                assert missing.result(timeout=5).status_code == 404
                published = pool.submit(client.post,
                    f"/api/admin/devices/{device_id}/projects/host-1/publish", headers=headers)
                requested = ws.receive_json()
                ws.send_json({"kind": "project_catalog_response", "version": 1,
                              "device_id": device_id, "request_id": requested["request_id"],
                              "status": "ok", "projects": [{"id": "host-1", "name": "Backend"}]})
                result = published.result(timeout=5)
                assert result.status_code == 200, result.text
                project_id = result.json()["project_id"]
                assert client.get("/api/admin/projects").json()["projects"][0]["id"] == project_id
        assert client.get(f"/api/admin/devices/{device_id}/publishable-projects").status_code == 503
        removed = client.post(f"/api/admin/projects/{project_id}/unpublish", headers=headers)
        assert removed.status_code == 200, removed.text
        assert removed.json()["status"] == "unpublished"
        assert client.get("/api/admin/projects").json()["projects"] == []
        worker = client.post("/api/admin/users", headers=headers, json={
            "username": "worker", "display_name": "Worker",
            "password": "WorkerPassphrase-2026!",
        })
        assert worker.status_code == 201, worker.text
        client.cookies.clear()
        login = client.post("/api/auth/login", json={
            "username": "worker", "password": "WorkerPassphrase-2026!",
        })
        assert login.status_code == 200
        assert client.get(f"/api/admin/devices/{device_id}/publishable-projects").status_code == 403
        assert client.post(f"/api/admin/projects/{project_id}/unpublish", headers={
            "X-CSRF-Token": login.json()["csrf_token"],
        }).status_code == 403


def test_project_catalog_rejects_host_paths(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, device_key, _ = _active_device(client)
        with ThreadPoolExecutor(max_workers=1) as pool:
            with client.websocket_connect("/api/control/ws") as ws:
                _handshake(ws, token, device_key)
                assert ws.receive_json()["kind"] == "hello"
                listing = pool.submit(client.get,
                    f"/api/admin/devices/{device_id}/publishable-projects")
                requested = ws.receive_json()
                ws.send_json({"kind": "project_catalog_response", "version": 1,
                              "device_id": device_id, "request_id": requested["request_id"],
                              "status": "ok", "projects": [{"id": "host-1", "name": "Backend",
                                                        "path": "/private/project"}]})
                with pytest.raises(WebSocketDisconnect) as closed:
                    ws.receive_json()
                assert closed.value.code == 4400
                assert listing.result(timeout=5).status_code == 503


def test_device_explicitly_publishes_and_unpublishes_its_project(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, device_key, csrf = _active_device(client)
        owner_id = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "==="))["user_id"]
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, device_key)
            assert ws.receive_json()["kind"] == "hello"
            ws.send_json({"kind": "project_publish", "version": 1,
                          "action": "publish", "host_project_id": "host-1",
                          "name": "Backend"})
            assert ws.receive_json()["status"] == "denied"
        denied = client.post(f"/api/admin/capabilities/{owner_id}", json={
            "capability": "project.publish", "scope_type": "device",
            "scope_id": device_id, "effect": "allow",
        }, headers={"X-CSRF-Token": csrf})
        assert denied.status_code == 200, denied.text
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, device_key)
            assert ws.receive_json()["kind"] == "hello"
            ws.send_json({"kind": "project_publish", "version": 1,
                          "action": "publish", "host_project_id": "host-1",
                          "name": "Backend"})
            published = ws.receive_json()
            assert published["kind"] == "project_publish_ack"
            assert published["status"] == "published"
            platform_id = published["project_id"]
            with sqlite3.connect(tmp_path / "workstep_platform.db") as database:
                assert database.execute(
                    "SELECT device_id,host_project_id,name,access_mode FROM platform_projects "
                    "WHERE id=?", (platform_id,),
                ).fetchone() == (device_id, "host-1", "Backend", "remote_published")
            ws.send_json({"kind": "project_publish", "version": 1,
                          "action": "unpublish", "host_project_id": "host-1",
                          "name": "Backend"})
            unpublished = ws.receive_json()
            assert unpublished["status"] == "unpublished"
            with sqlite3.connect(tmp_path / "workstep_platform.db") as database:
                assert database.execute(
                    "SELECT access_mode FROM platform_projects WHERE id=?", (platform_id,),
                ).fetchone() == ("policy_only",)


def test_project_scoped_task_create_is_compiled_for_the_host_project(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, device_key, csrf = _active_device(client)
        user_id = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "==="))["user_id"]
        with sqlite3.connect(tmp_path / "workstep_platform.db") as database:
            database.execute(
                "INSERT INTO platform_projects (id,device_id,host_project_id,name,"
                "access_mode,status) VALUES (?,?,?,?,?,?)",
                ("platform-1", device_id, "host-1", "Project", "remote_published", "active"),
            )
        grant = client.post(f"/api/admin/capabilities/{user_id}", json={
            "capability": "task.create", "scope_type": "project",
            "scope_id": "platform-1", "effect": "allow",
        }, headers={"X-CSRF-Token": csrf})
        assert grant.status_code == 200, grant.text
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, device_key)
            hello = ws.receive_json()
            policy = json.loads(base64.urlsafe_b64decode(
                hello["policy_snapshot"].split(".")[1] + "===",
            ))
            assert policy["task_create"] is False
            assert policy["task_create_project_ids"] == ["host-1"]


def test_locked_usage_ledger_does_not_delay_control_heartbeat(tmp_path):
    from datetime import datetime, timezone

    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, device_key, _ = _active_device(client)
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, device_key)
            assert ws.receive_json()["kind"] == "hello"
            with sqlite3.connect(tmp_path / "workstep_platform.db", timeout=5) as holder:
                holder.execute("BEGIN IMMEDIATE")
                ws.send_json({"kind": "usage_batch", "version": 1, "batch_id": "slow-batch",
                              "events": [{"usage_event_id": "slow-usage", "model": "model-a",
                                          "input_tokens": 10, "output_tokens": 2,
                                          "occurred_at": datetime.now(timezone.utc).isoformat()}]})
                time.sleep(0.04)
                started = time.monotonic()
                ws.send_json({"kind": "heartbeat"})
                assert ws.receive_json()["kind"] == "heartbeat_ack"
                assert time.monotonic() - started < 0.5
                holder.rollback()
                assert ws.receive_json()["kind"] == "usage_ack"


def test_control_opens_one_time_data_connection_on_demand(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, device_key, _ = _active_device(client)
        with client.websocket_connect("/api/control/ws") as control:
            _handshake(control, token, device_key)
            assert control.receive_json()["kind"] == "hello"
            pending = client.portal.start_task_soon(
                app.state.control_connections.request_data, device_id,
            )
            command = control.receive_json()
            assert command["kind"] == "open_data"
            assert command["device_id"] == device_id
            with client.websocket_connect("/api/data/ws") as data:
                data.send_json({"kind": "data_hello", "token": command["token"]})
                assert data.receive_json() == {"kind": "data_ready", "version": 1,
                                               "device_id": device_id}
                assert pending.result(timeout=3).device_id == device_id
                with client.websocket_connect("/api/data/ws") as replay:
                    replay.send_json({"kind": "data_hello", "token": command["token"]})
                    try:
                        replay.receive_json()
                        assert False, "Data token must be single-use"
                    except WebSocketDisconnect as exc:
                        assert exc.code == 4401
                client.portal.call(app.state.control_connections.close_data, device_id)
                try:
                    data.receive_json()
                    assert False, "Permission changes must close active data connection"
                except WebSocketDisconnect as exc:
                    assert exc.code == 4003


def test_slow_data_connection_does_not_delay_gateway_health_or_control_heartbeat(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, device_key, _ = _active_device(client)
        with client.websocket_connect("/api/control/ws") as control:
            _handshake(control, token, device_key)
            assert control.receive_json()["kind"] == "hello"
            pending = client.portal.start_task_soon(
                app.state.control_connections.request_data, device_id,
            )
            assert control.receive_json()["kind"] == "open_data"
            started = time.monotonic()
            assert client.get("/api/health").json() == {"status": "ok"}
            control.send_json({"kind": "heartbeat"})
            assert control.receive_json()["kind"] == "heartbeat_ack"
            assert time.monotonic() - started < 0.5
            pending.cancel()


def test_control_socket_rejects_wrong_proof(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, device_key, csrf = _active_device(client)
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, device_key, wrong_challenge=True)
            try:
                ws.receive_json()
                assert False, "Wrong proof must be rejected"
            except WebSocketDisconnect as exc:
                assert exc.code == 4401
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, device_key, wrong_delegation=True)
            try:
                ws.receive_json()
                assert False, "Undelegated control key must be rejected"
            except WebSocketDisconnect as exc:
                assert exc.code == 4401
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, device_key, wrong_config_proof=True)
            with pytest.raises(WebSocketDisconnect) as exc:
                ws.receive_json()
            assert exc.value.code == 4401


def test_device_revocation_closes_existing_control_socket(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, device_key, csrf = _active_device(client)
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, device_key)
            assert ws.receive_json()["kind"] == "hello"
            assert client.post(f"/api/admin/devices/{device_id}/revoke",
                               headers={"X-CSRF-Token": csrf}).status_code == 204
            try:
                ws.receive_json()
                assert False, "Revocation must close active control socket"
            except WebSocketDisconnect as exc:
                assert exc.code == 4003
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, device_key)
            try:
                ws.receive_json()
                assert False, "Revoked device must be rejected"
            except WebSocketDisconnect as exc:
                assert exc.code == 4401


def test_disabled_account_stops_policy_renewal(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, device_key, _ = _active_device(client)
        user_id = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))["user_id"]
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, device_key)
            assert ws.receive_json()["kind"] == "hello"
            with sqlite3.connect(tmp_path / "workstep_platform.db") as database:
                database.execute("UPDATE users SET status='disabled' WHERE id=?", (user_id,))
            ws.send_json({"kind": "heartbeat"})
            try:
                ws.receive_json()
                assert False, "Disabled account must not renew policy"
            except WebSocketDisconnect as exc:
                assert exc.code == 4003


def test_capability_assignment_changes_signed_policy_revision(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, device_key, csrf = _active_device(client)
        user_id = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))["user_id"]
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, device_key)
            initial = ws.receive_json()
            initial_policy = json.loads(base64.urlsafe_b64decode(initial["policy_snapshot"].split(".")[1] + "=="))
            assert initial_policy["task_create"] is False
            grant = client.post(f"/api/admin/capabilities/{user_id}", headers={"X-CSRF-Token": csrf}, json={
                "capability": "task.create", "scope_type": "global", "effect": "allow",
            })
            assert grant.status_code == 200, grant.text
            ws.send_json({"kind": "heartbeat"})
            allowed = ws.receive_json()
            allowed_policy = json.loads(base64.urlsafe_b64decode(allowed["policy_snapshot"].split(".")[1] + "=="))
            assert allowed_policy["task_create"] is True
            assert allowed_policy["policy_revision"] > initial_policy["policy_revision"]
            deny = client.post(f"/api/admin/capabilities/{user_id}", headers={"X-CSRF-Token": csrf}, json={
                "capability": "task.create", "scope_type": "device", "scope_id": device_id,
                "effect": "deny",
            })
            assert deny.status_code == 200, deny.text
            ws.send_json({"kind": "heartbeat"})
            denied = ws.receive_json()
            denied_policy = json.loads(base64.urlsafe_b64decode(denied["policy_snapshot"].split(".")[1] + "=="))
            assert denied_policy["task_create"] is False
            assert denied_policy["policy_revision"] > allowed_policy["policy_revision"]
            revoked = client.post(f"/api/admin/capabilities/{user_id}/revoke",
                                  headers={"X-CSRF-Token": csrf}, json={
                "capability": "task.create", "scope_type": "device", "scope_id": device_id,
            })
            assert revoked.status_code == 204
            ws.send_json({"kind": "heartbeat"})
            restored = ws.receive_json()
            restored_policy = json.loads(base64.urlsafe_b64decode(restored["policy_snapshot"].split(".")[1] + "=="))
            assert restored_policy["task_create"] is True
            assert restored_policy["policy_revision"] > denied_policy["policy_revision"]


def test_control_delivers_encrypted_provider_bundle_and_records_application(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, device_key, csrf = _active_device(client)
        user_id = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))["user_id"]
        created = client.post("/api/admin/providers", headers={"X-CSRF-Token": csrf}, json={
            "name": "Company API", "type": "custom", "protocols": ["openai_responses"],
            "protocol_base_urls": {"openai_responses": "https://api.example.test"},
            "api_key": "secret-api-key", "models": ["model-a"],
        })
        assert created.status_code == 200, created.text
        provider_id = created.json()["id"]
        assert client.post(f"/api/admin/providers/{provider_id}/assign",
                           headers={"X-CSRF-Token": csrf}, json={
                               "subject_type": "user", "subject_id": user_id,
                           }).status_code == 200
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, device_key)
            hello = ws.receive_json()
            assert "secret-api-key" not in json.dumps(hello)
            policy = json.loads(base64.urlsafe_b64decode(
                hello["policy_snapshot"].split(".")[1] + "==",
            ))
            assert provider_id in policy["allowed_provider_ids"]
            assert "model-a" in policy["allowed_models"]
            bundle = json.loads(base64.urlsafe_b64decode(
                hello["provider_bundle"].split(".")[1] + "==",
            ))
            ws.send_json({"kind": "provider_applied", "revision": bundle["revision"],
                          "result": "success"})
            assert ws.receive_json()["kind"] == "provider_applied_ack"
            with sqlite3.connect(tmp_path / "workstep_platform.db") as database:
                assert database.execute(
                    "SELECT applied_revision FROM device_provider_applications WHERE device_id=?",
                    (device_id,),
                ).fetchone() == (bundle["revision"],)
            ws.send_json({"kind": "provider_applied", "revision": bundle["revision"],
                          "result": "error", "error": "sk-secret-api-key"})
            assert ws.receive_json()["kind"] == "provider_applied_ack"
            applications = client.get("/api/admin/providers/applications")
            assert applications.json()["devices"][0]["last_error"] == "application_failed"
            assert "sk-secret-api-key" not in applications.text
