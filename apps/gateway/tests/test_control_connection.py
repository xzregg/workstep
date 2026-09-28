import base64
import hashlib

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
            listed = client.get("/api/admin/devices", headers={"X-CSRF-Token": csrf}).json()["devices"]
            assert listed[0]["online"] is True
            ws.send_json({"kind": "heartbeat"})
            assert ws.receive_json()["kind"] == "heartbeat_ack"
        listed = client.get("/api/admin/devices").json()["devices"]
        assert listed[0]["online"] is False


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
