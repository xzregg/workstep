from fastapi.testclient import TestClient
import base64
import json
from cryptography.hazmat.primitives import serialization
from gateway.contracts import JsonValue as JSONResponse

from gateway.app import create_app
from gateway.config import GatewaySettings


def test_user_sees_only_assigned_pc_and_admin_can_revoke(tmp_path, monkeypatch):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test",
                                     public_origin="https://gateway.test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        })
        csrf = setup.json()["csrf_token"]
        created = client.post("/api/auth/register", json={
            "username": "alice", "display_name": "Alice", "password": "AlicePassphrase-2026!",
        })
        user_id = created.json()["user"]["id"]
        assert client.get("/api/devices").json() == {"devices": []}
        client.post("/api/auth/logout", headers={"X-CSRF-Token": created.json()["csrf_token"]})
        login = client.post("/api/auth/login", json={"username": "owner",
                                                   "password": "OwnerPassphrase-2026!"})
        csrf = login.json()["csrf_token"]
        # Device registration is covered by the authorization tests; this test starts
        # with a registered PC to isolate assignment and visibility behavior.
        from gateway.models import Device
        async def insert_device():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id="device-1", name="Office PC", public_key="test",
                                       status="active", app_instance_id="instance-1",
                                       version="1.0.0"))
        client.portal.call(insert_device)
        assert client.get("/api/devices").json() == {"devices": []}
        headers = {"X-CSRF-Token": csrf}
        assert client.post(f"/api/admin/devices/device-1/users", json={"user_id": user_id},
                           headers=headers).status_code == 403
        assert client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"},
                           headers=headers).status_code == 200
        assigned = client.post(f"/api/admin/devices/device-1/users", json={"user_id": user_id},
                               headers=headers)
        assert assigned.status_code == 200, assigned.text
        client.post("/api/auth/logout", headers=headers)
        alice = client.post("/api/auth/login", json={"username": "alice",
                                                   "password": "AlicePassphrase-2026!"})
        assert alice.status_code == 200
        visible = client.get("/api/devices")
        assert visible.status_code == 200
        assert visible.json()["devices"] == [{"id": "device-1", "name": "Office PC",
                                               "status": "active", "online": False,
                                               "version": "1.0.0"}]
        assert client.get("/api/devices/device-1/access").status_code == 409
        monkeypatch.setattr(app.state.control_connections, "is_online", lambda _id: True)
        access = client.get("/api/devices/device-1/access")
        assert access.status_code == 200, access.text
        issued = access.json()
        assert issued["url"] == "https://d-device-1.gateway.test/"
        header, payload, signature = issued["ticket"].split(".")
        key = client.get("/api/platform/gateway-key").json()["public_key_pem"]
        serialization.load_pem_public_key(key.encode()).verify(
            base64.urlsafe_b64decode(signature + "=="), f"{header}.{payload}".encode(),
        )
        claims = json.loads(base64.urlsafe_b64decode(payload + "=="))
        assert claims["device_id"] == "device-1"
        assert claims["user_id"] == user_id
        assert claims["aud"] == "d-device-1.gateway.test"
        remote_url = "https://d-device-1.gateway.test"
        wrong_host = client.post("/api/remote/redeem", data={"ticket": issued["ticket"]})
        assert wrong_host.status_code == 403
        assert client.post("https://d-device-2.gateway.test/api/remote/redeem",
                           data={"ticket": issued["ticket"]}).status_code == 403
        assert client.post(f"{remote_url}/api/remote/redeem",
                           data={"ticket": issued["ticket"] + "x"}).status_code == 403
        redeemed = client.post(f"{remote_url}/api/remote/redeem", data={"ticket": issued["ticket"]},
                               follow_redirects=False)
        assert redeemed.status_code == 303, redeemed.text
        assert redeemed.headers["location"] == "/"
        assert "workstep_gateway_session=" in redeemed.headers["set-cookie"]
        assert client.post(f"{remote_url}/api/remote/redeem",
                           data={"ticket": issued["ticket"]}).status_code == 409
        assert client.get(f"{remote_url}/api/remote/session").json()["device_id"] == "device-1"
        assert client.get(f"{remote_url}/api/remote/project-grants").status_code == 403
        class FakeData:
            async def proxy_http(self, request, *, user_id, username, display_name,
                                 provider_ids, provider_grant_expires_at, authorization_check):
                await authorization_check()
                assert provider_ids == []
                assert provider_grant_expires_at > 0
                assert display_name == "Alice"
                assert user_id == claims["user_id"]
                assert username == "alice"
                return JSONResponse({"proxied": request.target.path})
            async def proxy_websocket(self, ws, *, user_id, username, display_name,
                                      provider_ids, provider_grant_expires_at, authorization_check):
                await authorization_check()
                assert provider_ids == []
                assert provider_grant_expires_at > 0
                assert display_name == "Alice"
                assert user_id == claims["user_id"]
                assert username == "alice"
                await ws.accept()
                await ws.send_text("remote-ready")
                await ws.close(code=1000)
        async def request_data(device_id):
            assert device_id == "device-1"
            return FakeData()
        monkeypatch.setattr(app.state.control_connections, "request_data", request_data)
        assert client.get(f"{remote_url}/api/health").json() == {"proxied": "/api/health"}
        assert client.get(f"{remote_url}/").json() == {"proxied": "/"}
        assert client.get(f"{remote_url}/assets/main.js").json() == {"proxied": "/assets/main.js"}
        with client.websocket_connect("wss://d-device-1.gateway.test/ws",
                                      headers={"origin": remote_url}) as socket:
            assert socket.receive_text() == "remote-ready"
        with client.websocket_connect("wss://d-device-1.gateway.test/ws",
                                      headers={"origin": "https://proxy.example"}) as socket:
            assert socket.receive_text() == "remote-ready"
        assert client.get("https://d-device-2.gateway.test/api/remote/session").status_code == 403
        assert client.get("/api/devices").status_code == 200
        client.post("/api/auth/logout", headers={"X-CSRF-Token": alice.json()["csrf_token"]})
        owner = client.post("/api/auth/login", json={"username": "owner",
                                                   "password": "OwnerPassphrase-2026!"})
        headers = {"X-CSRF-Token": owner.json()["csrf_token"]}
        client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"}, headers=headers)
        closed = []
        async def close_data(device_id):
            closed.append(device_id)
        monkeypatch.setattr(app.state.control_connections, "close_data", close_data)
        assert client.post(f"/api/admin/devices/device-1/users/{user_id}/revoke",
                           headers=headers).status_code == 204
        assert closed == ["device-1"]
        client.post("/api/auth/logout", headers=headers)
        client.post("/api/auth/login", json={"username": "alice",
                                               "password": "AlicePassphrase-2026!"})
        assert client.get("/api/devices").json() == {"devices": []}
        assert client.get("/api/devices/device-1/access").status_code == 403
        assert client.get(f"{remote_url}/api/remote/session").status_code == 403
