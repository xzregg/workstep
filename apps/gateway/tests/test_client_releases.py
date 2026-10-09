import hashlib
import asyncio
import threading

from fastapi.testclient import TestClient
import httpx
import pytest

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.database import GatewayDatabase
from gateway.services.signing import GatewaySigner
from gateway.models import Device
from gateway.services import client_releases


def test_admin_publishes_gateway_scoped_release_and_all_users_share_download(tmp_path):
    releases = tmp_path / "releases"
    releases.mkdir()
    artifact = releases / "WorkStep-macos-arm64.dmg"
    artifact.write_bytes(b"signed managed installer")
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        assert client.get("/api/client-releases").json() == {"releases": [], "public_origin": None}
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        })
        csrf = setup.json()["csrf_token"]
        body = {"os": "macos", "arch": "arm64", "version": "1.0.0",
                "filename": artifact.name, "minimum_protocol_version": 1}
        headers = {"X-CSRF-Token": csrf}
        assert client.post("/api/admin/client-releases", json=body, headers=headers).status_code == 403
        assert client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"}, headers=headers).status_code == 200
        publish = client.post("/api/admin/client-releases", json=body, headers=headers)
        assert publish.status_code == 201, publish.text
        release = publish.json()
        assert release["gateway_id"] == "gateway-test"
        assert release["sha256"] == hashlib.sha256(artifact.read_bytes()).hexdigest()
        assert release["file_size"] == artifact.stat().st_size
        assert release["download_url"].startswith("/api/client-releases/")
        client.cookies.clear()
        public = client.get("/api/client-releases?os=macos&arch=arm64")
        assert public.status_code == 200
        assert public.json()["releases"] == [release]
        assert client.get(release["download_url"]).content == artifact.read_bytes()
        assert client.post("/api/admin/client-releases", json=body).status_code == 401


def test_release_rejects_path_traversal_and_changed_artifact(tmp_path):
    releases = tmp_path / "releases"
    releases.mkdir()
    artifact = releases / "installer.dmg"
    artifact.write_bytes(b"original")
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test")),
                    base_url="https://gateway.test") as client:
        csrf = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "closed",
        }).json()["csrf_token"]
        headers = {"X-CSRF-Token": csrf}
        client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"}, headers=headers)
        body = {"os": "macos", "arch": "arm64", "version": "1.0.0",
                "filename": "../installer.dmg", "minimum_protocol_version": 1}
        assert client.post("/api/admin/client-releases", json=body, headers=headers).status_code == 422
        body["filename"] = artifact.name
        release = client.post("/api/admin/client-releases", json=body, headers=headers).json()
        artifact.write_bytes(b"modified")
        assert client.get(release["download_url"]).content == b"original"


def test_device_admin_projects_latest_compatible_release_per_platform(tmp_path):
    releases = tmp_path / "releases"
    releases.mkdir()
    (releases / "installer.dmg").write_bytes(b"installer")
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "closed",
        })
        headers = {"X-CSRF-Token": setup.json()["csrf_token"]}
        assert client.post("/api/auth/step-up", json={
            "password": "OwnerPassphrase-2026!",
        }, headers=headers).status_code == 200
        for version in ("1.10.0", "1.2.0"):
            response = client.post("/api/admin/client-releases", json={
                "os": "macos", "arch": "arm64", "version": version,
                "filename": "installer.dmg", "minimum_protocol_version": 1,
            }, headers=headers)
            assert response.status_code == 201, response.text

        async def seed_devices():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add_all([
                        Device(id="old", name="Old", public_key="test", status="active",
                               app_instance_id="old", version="1.2.0", os="macos", arch="arm64"),
                        Device(id="current", name="Current", public_key="test", status="active",
                               app_instance_id="current", version="1.10.0", os="macos", arch="arm64"),
                        Device(id="legacy", name="Legacy", public_key="test", status="active",
                               app_instance_id="legacy", version="1.0.0"),
                        Device(id="other", name="Other", public_key="test", status="active",
                               app_instance_id="other", version="1.0.0", os="windows", arch="x64"),
                    ])

        client.portal.call(seed_devices)
        response = client.get("/api/admin/devices?status=active")
        assert response.status_code == 200, response.text
        devices = {device["id"]: device for device in response.json()["devices"]}
        assert devices["old"]["latest_version"] == "1.10.0"
        assert devices["old"]["update_available"] is True
        assert devices["current"]["update_available"] is False
        assert devices["legacy"]["update_available"] is None
        assert devices["other"]["update_available"] is None
        assert devices["other"]["latest_version"] is None


@pytest.mark.asyncio
async def test_slow_release_copy_keeps_health_responsive(tmp_path, monkeypatch):
    releases = tmp_path / "releases"
    releases.mkdir()
    (releases / "installer.dmg").write_bytes(b"installer")
    settings = GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test")
    app = create_app(settings)
    database = GatewayDatabase(settings)
    await database.start()
    app.state.database = database
    app.state.gateway_signer = GatewaySigner.load_or_create(tmp_path / "gateway-signing-key.pem")
    started = threading.Event()
    finish = threading.Event()
    copy_release = client_releases._copy_release

    def slow_copy(*args):
        started.set()
        assert finish.wait(timeout=3)
        return copy_release(*args)

    monkeypatch.setattr(client_releases, "_copy_release", slow_copy)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="https://gateway.test") as client:
            setup = await client.post("/api/platform/setup", json={
                "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
                "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
                "registration_mode": "closed",
            })
            headers = {"X-CSRF-Token": setup.json()["csrf_token"]}
            await client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"}, headers=headers)
            publish = asyncio.create_task(client.post("/api/admin/client-releases", json={
                "os": "macos", "arch": "arm64", "version": "1.0.0",
                "filename": "installer.dmg", "minimum_protocol_version": 1,
            }, headers=headers))
            assert await asyncio.to_thread(started.wait, 2)
            assert (await asyncio.wait_for(client.get("/api/health"), timeout=0.2)).status_code == 200
            finish.set()
            assert (await publish).status_code == 201
    finally:
        finish.set()
        await database.close()
