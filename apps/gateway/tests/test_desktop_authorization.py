import base64
import hashlib
import json
import sqlite3
from urllib.parse import parse_qs, urlparse

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings


VERIFIER = "desktop-verifier-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
CHALLENGE = base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).rstrip(b"=").decode()
STATE = "state-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
NONCE = "nonce-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
APP_INSTANCE = "app-instance-12345"


def _setup(client):
    result = client.post("/api/platform/setup", json={
        "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
        "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
        "registration_mode": "closed",
    })
    assert result.status_code == 201
    return result.json()["csrf_token"]


def _public_key():
    return Ed25519PrivateKey.generate().public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()


def _authorize(client, csrf):
    result = client.post("/api/desktop/authorize", headers={"X-CSRF-Token": csrf}, json={
        "state": STATE, "nonce": NONCE, "code_challenge": CHALLENGE,
        "app_instance_id": APP_INSTANCE, "gateway_id": "gateway-test",
    })
    assert result.status_code == 200, result.text
    callback = urlparse(result.json()["callback_url"])
    assert (callback.scheme, callback.netloc, callback.path) == ("workstep", "auth", "/callback")
    assert set(parse_qs(callback.query)) == {"code", "state"}
    return parse_qs(callback.query)["code"][0]


def _redeem(client, code, public_key, **overrides):
    body = {"code": code, "state": STATE, "nonce": NONCE,
            "code_verifier": VERIFIER, "app_instance_id": APP_INSTANCE,
            "gateway_id": "gateway-test", "device_public_key": public_key,
            "device_name": "Alice PC", "version": "1.0.0"}
    body.update(overrides)
    return client.post("/api/desktop/token", json=body)


def test_desktop_code_is_digest_only_single_use_and_binds_pkce_state_gateway(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client)
        code = _authorize(client, csrf)
        with sqlite3.connect(tmp_path / "workstep_platform.db") as connection:
            stored = connection.execute("SELECT code_hash FROM desktop_auth_codes").fetchone()[0]
        assert stored == hashlib.sha256(code.encode()).hexdigest()
        assert _redeem(client, code, _public_key(), code_verifier="X" * 43).status_code == 403
        assert _redeem(client, code, _public_key(), state="wrong-state-0123456789ABCDEFGHIJKLMNOP").status_code == 403
        assert _redeem(client, code, _public_key(), app_instance_id="other-instance").status_code == 403
        assert _redeem(client, code, _public_key(), gateway_id="wrong-gateway").status_code == 403
        assert _redeem(client, code, _public_key(), os="darwin", arch="arm64").status_code == 422
        result = _redeem(client, code, _public_key(), os="macos", arch="arm64")
        assert result.status_code == 200, result.text
        assert result.json()["device"]["status"] == "pending"
        assert result.json()["user"]["username"] == "owner"
        assert result.json()["device_authorization"] is None
        listed = client.get("/api/admin/devices?status=pending").json()["devices"][0]
        assert (listed["os"], listed["arch"]) == ("macos", "arm64")
        assert _redeem(client, code, _public_key()).status_code == 409


def test_desktop_code_expiry_and_device_approval(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    key = _public_key()
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client)
        code = _authorize(client, csrf)
        with sqlite3.connect(tmp_path / "workstep_platform.db") as connection:
            connection.execute("UPDATE desktop_auth_codes SET expires_at='2000-01-01 00:00:00'")
        assert _redeem(client, code, key).status_code == 410
        code = _authorize(client, csrf)
        first = _redeem(client, code, key)
        device_id = first.json()["device"]["id"]
        assert client.post(f"/api/admin/devices/{device_id}/approve", headers={"X-CSRF-Token": csrf}).status_code == 403
        assert client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"}, headers={
            "X-CSRF-Token": csrf,
        }).status_code == 200
        assert client.post(f"/api/admin/devices/{device_id}/approve", headers={"X-CSRF-Token": csrf}).status_code == 204
        code = _authorize(client, csrf)
        second = _redeem(client, code, key)
        assert second.status_code == 200
        assert second.json()["device"]["id"] == device_id
        assert second.json()["device"]["status"] == "active"
        signed = second.json()["device_authorization"]
        assert signed and len(signed.split(".")) == 3
        claims = json.loads(base64.urlsafe_b64decode(signed.split(".")[1] + "=="))
        assert claims["gateway_id"] == "gateway-test"
        assert claims["device_id"] == device_id
        assert claims["username"] == "owner"
        assert claims["display_name"] == "Owner"
        assert claims["app_instance_id"] == APP_INSTANCE
        assert claims["device_public_key"] == key
        public_key = client.get("/api/platform/gateway-key").json()
        signature = base64.urlsafe_b64decode(signed.split(".")[2] + "==")
        serialization.load_pem_public_key(public_key["public_key_pem"].encode()).verify(
            signature, ".".join(signed.split(".")[:2]).encode(),
        )
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test")),
                    base_url="https://gateway.test") as client:
        assert client.get("/api/platform/gateway-key").json()["fingerprint"] == public_key["fingerprint"]


def test_device_disable_reenable_and_revoke(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    key = _public_key()
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client)
        device_id = _redeem(client, _authorize(client, csrf), key).json()["device"]["id"]
        assert client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"}, headers={
            "X-CSRF-Token": csrf,
        }).status_code == 200
        assert client.post(f"/api/admin/devices/{device_id}/approve", headers={"X-CSRF-Token": csrf}).status_code == 204
        assert client.post(f"/api/admin/devices/{device_id}/disable", headers={"X-CSRF-Token": csrf}).status_code == 204
        assert _redeem(client, _authorize(client, csrf), key).status_code == 403
        assert client.post(f"/api/admin/devices/{device_id}/approve", headers={"X-CSRF-Token": csrf}).status_code == 204
        assert _redeem(client, _authorize(client, csrf), key).json()["device"]["status"] == "active"
        assert client.post(f"/api/admin/devices/{device_id}/revoke", headers={"X-CSRF-Token": csrf}).status_code == 204
        assert _redeem(client, _authorize(client, csrf), key).status_code == 403
        assert client.post(f"/api/admin/devices/{device_id}/approve", headers={"X-CSRF-Token": csrf}).status_code == 409


def test_device_rotation_requires_old_key_proof_and_reapproval(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    old_private = Ed25519PrivateKey.generate()
    old_public = old_private.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    new_private = Ed25519PrivateKey.generate()
    new_public = new_private.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    new_fingerprint = hashlib.sha256(new_private.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
    )).hexdigest()
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client)
        device_id = _redeem(client, _authorize(client, csrf), old_public).json()["device"]["id"]
        assert client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"}, headers={
            "X-CSRF-Token": csrf,
        }).status_code == 200
        assert client.post(f"/api/admin/devices/{device_id}/approve", headers={"X-CSRF-Token": csrf}).status_code == 204
        code = _authorize(client, csrf)
        assert _redeem(client, code, new_public).status_code == 403
        signature = base64.urlsafe_b64encode(old_private.sign(
            f"workstep-device-rotate-v1:{code}:{new_fingerprint}".encode(),
        )).rstrip(b"=").decode()
        rotated = _redeem(client, code, new_public, rotation_signature=signature)
        assert rotated.status_code == 200, rotated.text
        assert rotated.json()["device"] == {"id": device_id, "status": "pending"}
        assert client.post(f"/api/admin/devices/{device_id}/approve", headers={"X-CSRF-Token": csrf}).status_code == 204
        assert _redeem(client, _authorize(client, csrf), new_public).json()["device_authorization"]


def test_admin_can_list_pending_devices_for_approval(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client)
        device_id = _redeem(client, _authorize(client, csrf), _public_key()).json()["device"]["id"]
        pending = client.get("/api/admin/devices?status=pending")
        assert pending.status_code == 200
        assert [device["id"] for device in pending.json()["devices"]] == [device_id]
        assert pending.json()["devices"][0]["name"] == "Alice PC"
        client.cookies.clear()
        assert client.get("/api/admin/devices").status_code == 401


def test_admin_device_list_filters_sorts_and_pages_on_server(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        _setup(client)
        with sqlite3.connect(tmp_path / "workstep_platform.db") as connection:
            connection.executemany(
                "INSERT INTO devices (id, name, public_key, status, created_at) VALUES (?, ?, ?, ?, ?)",
                [(f"device-{index}", f"Team PC {index:02d}", "key", "active", "2026-01-01 00:00:00")
                 for index in range(5)],
            )
            connection.execute(
                "INSERT INTO devices (id, name, public_key, status, created_at) VALUES (?, ?, ?, ?, ?)",
                ("other", "Other PC", "key", "pending", "2026-01-01 00:00:00"),
            )
        result = client.get("/api/admin/devices?status=active&q=Team&sort=name&direction=asc&page=2&page_size=2")
        assert result.status_code == 200, result.text
        assert result.json()["total"] == 5
        assert result.json()["page"] == 2
        assert [device["name"] for device in result.json()["devices"]] == ["Team PC 02", "Team PC 03"]
        assert client.get("/api/admin/devices?page_size=101").status_code == 422


def test_device_approval_policy_controls_new_devices_only(tmp_path):
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path,gateway_id='gateway-test')),base_url='https://gateway.test') as client:
        csrf=_setup(client); headers={'X-CSRF-Token':csrf}
        url='/api/admin/device-approval-policy'
        assert client.get('/api/admin/platform-settings').json()['device_approval_mode']=='manual'
        assert client.put(url,headers=headers,json={'mode':'automatic'}).status_code==403
        client.post('/api/auth/step-up',headers=headers,json={'password':'OwnerPassphrase-2026!'})
        assert client.put(url,headers=headers,json={'mode':'automatic'}).status_code==200
        assert client.put(url,headers=headers,json={'mode':'invalid'}).status_code==422
        key=_public_key()
        result=_redeem(client,_authorize(client,csrf),key)
        assert result.status_code==200,result.text
        assert result.json()['device']['status']=='active'
        assert result.json()['device_authorization']
        assert client.put(url,headers=headers,json={'mode':'manual'}).status_code==200
        assert _redeem(client,_authorize(client,csrf),key).json()['device']['status']=='active'


def test_device_policy_slow_sql_keeps_health_responsive(tmp_path):
    import asyncio
    import threading
    import time
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import event
    app=create_app(GatewaySettings(data_dir=tmp_path,gateway_id='gateway-test'))
    with TestClient(app,base_url='https://gateway.test') as client:
        csrf=_setup(client); headers={'X-CSRF-Token':csrf}
        client.post('/api/auth/step-up',headers=headers,json={'password':'OwnerPassphrase-2026!'})
        reached=threading.Event()
        def before_execute(connection,cursor,statement,parameters,context,many):
            if statement.startswith(('INSERT INTO platform_settings','UPDATE platform_settings')):
                reached.set(); time.sleep(.6)
        engine=app.state.database.engine.sync_engine
        event.listen(engine,'before_cursor_execute',before_execute)
        async def scenario():
            async with AsyncClient(transport=ASGITransport(app=app),base_url='https://gateway.test',cookies=client.cookies) as actor:
                pending=asyncio.create_task(actor.put('/api/admin/device-approval-policy',headers=headers,json={'mode':'automatic'}))
                try:
                    assert await asyncio.to_thread(reached.wait,2)
                    assert (await asyncio.wait_for(actor.get('/api/health'),.5)).status_code==200
                    assert not pending.done()
                finally:
                    response=await pending
                assert response.status_code==200
        try: client.portal.call(scenario)
        finally: event.remove(engine,'before_cursor_execute',before_execute)
