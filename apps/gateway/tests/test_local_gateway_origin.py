import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import Device, UserDevice
from workstep_gateway_protocol import ManagedGatewayPayload


@pytest.mark.parametrize("origin", ["http://localhost:8700", "http://127.0.0.1:8700",
                                    "http://[::1]:8700", "http://gateway.localhost:8700",
                                    "https://gateway.test:8700", "http://192.168.1.2:8700"])
def test_gateway_and_signed_package_accept_local_origins(origin):
    assert GatewaySettings(public_origin=origin).public_origin == origin
    assert ManagedGatewayPayload(gateway_id="local", gateway_origin=origin,
        gateway_public_key_fingerprint="a" * 64, deployment_channel="test",
        min_protocol_version=1).gateway_origin == origin


@pytest.mark.parametrize("origin", ["http://gateway.test:8700", "http://localhost.evil.test:8700",
                                    "http://0.0.0.0:8700",
                                    "http://user@localhost:8700", "http://localhost:8700/path"])
def test_nonlocal_insecure_origins_are_rejected(origin):
    with pytest.raises(ValidationError):
        GatewaySettings(public_origin=origin)


def test_local_http_login_and_host_bound_device_ticket_keep_port(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, public_origin="http://localhost:8700"))
    with TestClient(app, base_url="http://localhost:8700") as client:
        response = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        })
        assert response.status_code == 201
        cookie = response.headers["set-cookie"].lower()
        assert "secure" not in cookie and "httponly" in cookie and "samesite=lax" in cookie
        assert client.get("/api/auth/session").status_code == 200
        user_id = response.json()["user"]["id"]

        async def seed():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id="device-1", name="PC", public_key="test",
                                       app_instance_id="app", version="1.0", status="active"))
                    session.add(UserDevice(id="assignment", user_id=user_id,
                                           device_id="device-1", access_level="edit"))

        client.portal.call(seed)
        app.state.control_connections.is_online = lambda _device: True
        access = client.get("/api/devices/device-1/access")
        assert access.status_code == 200
        assert access.json()["url"] == "http://d-device-1.localhost:8700/"
        ticket = access.json()["ticket"]
        for host in ("d-device-2.localhost:8700", "d-device-1.localhost:8701"):
            assert client.post("/api/remote/redeem", headers={"Host": host},
                               data={"ticket": ticket}, follow_redirects=False).status_code == 403
        redeemed = client.post("http://d-device-1.localhost:8700/api/remote/redeem",
                               data={"ticket": ticket}, follow_redirects=False)
        assert redeemed.status_code == 303
        assert "secure" not in redeemed.headers["set-cookie"].lower()
        assert client.get("http://d-device-1.localhost:8700/api/remote/session").status_code == 200
