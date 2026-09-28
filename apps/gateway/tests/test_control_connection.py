import base64
import hashlib
import json
import sqlite3

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
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


def _handshake(ws, token, device_key, *, wrong_challenge=False, wrong_delegation=False):
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
    ws.send_json({"authorization": token, "control_public_key_pem": public_key,
                  "control_delegation_signature": delegation,
                  "control_challenge_proof": proof})


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
            ws.send_json({"kind": "heartbeat"})
            assert ws.receive_json()["kind"] == "heartbeat_ack"
        listed = client.get("/api/admin/devices").json()["devices"]
        assert listed[0]["online"] is False


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
