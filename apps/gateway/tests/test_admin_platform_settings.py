"""Platform settings expose operational facts without database credentials."""

from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings


def test_super_admin_reads_platform_settings_and_changes_registration(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test",
                                     public_origin="https://gateway.test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        assert client.get("/api/admin/platform-settings").status_code == 401
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner",
            "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery",
            "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        })
        csrf = setup.json()["csrf_token"]
        response = client.get("/api/admin/platform-settings")
        assert response.status_code == 200, response.text
        assert response.json()["gateway_id"] == "gateway-test"
        assert response.json()["public_origin"] == "https://gateway.test"
        assert response.json()["registration_mode"] == "open"
        assert response.json()["session_seconds"] == 86400
        assert response.json()["database"]["healthy"] is True
        assert response.json()["database"]["migration_version"] == app.state.database.head_revision
        assert response.json()["data_dir"] == str(tmp_path)
        assert "database_url" not in response.json()
        assert client.put("/api/admin/registration-policy", json={"mode": "closed"},
                          headers={"X-CSRF-Token": csrf}).status_code == 403
        assert client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"},
                           headers={"X-CSRF-Token": csrf}).status_code == 200
        assert client.put("/api/admin/registration-policy", json={"mode": "closed"},
                          headers={"X-CSRF-Token": csrf}).status_code == 200
        assert client.get("/api/admin/platform-settings").json()["registration_mode"] == "closed"


def test_non_admin_cannot_read_platform_settings(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner",
            "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery",
            "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        })
        client.post("/api/auth/register", json={
            "username": "alice", "display_name": "Alice", "password": "AlicePassphrase-2026!",
        })
        assert client.get("/api/admin/platform-settings").status_code == 403
