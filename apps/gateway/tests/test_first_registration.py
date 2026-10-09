import asyncio
import sqlite3

from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from gateway.app import create_app
from gateway.config import GatewaySettings

ACCOUNT = {"username": "first", "display_name": "首位用户", "password": "FirstPassphrase-2026!"}


def test_first_registration_password_minimum_is_eight_characters(tmp_path):
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)), base_url="https://gateway.test") as client:
        assert client.post('/api/auth/register', json={**ACCOUNT, 'password': '1234567'}).status_code == 422
        assert client.post('/api/auth/register', json={**ACCOUNT, 'password': '12345678'}).status_code == 201
        assert client.get('/api/auth/session').json()['admin_roles'] == ['super_admin']


def test_first_registration_initializes_and_grants_super_admin(tmp_path):
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)), base_url="https://gateway.test") as client:
        result = client.post("/api/auth/register", json={**ACCOUNT, "role": "super_admin"})
        assert result.status_code == 201
        assert client.get("/api/platform/status").json() == {"initialized": True}
        assert client.get("/api/auth/session").json()["admin_roles"] == ["super_admin"]
        client.cookies.clear()
        assert client.post("/api/auth/register", json={**ACCOUNT, "username": "second", "role": "super_admin"}).status_code == 201
        assert client.get("/api/auth/session").json()["admin_roles"] == []


def test_concurrent_first_registrations_create_exactly_one_super_admin(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app) as client:
        async def scenario():
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as registrar:
                responses = await asyncio.gather(*(registrar.post("/api/auth/register", json={**ACCOUNT, "username": name}) for name in ("alice", "bob")))
                assert [r.status_code for r in responses] == [201, 201]
        client.portal.call(scenario)
    with sqlite3.connect(tmp_path / "workstep_platform.db") as db:
        assert db.execute("SELECT COUNT(*) FROM admin_assignments WHERE role='super_admin'").fetchone() == (1,)
        assert db.execute("SELECT COUNT(*) FROM users").fetchone() == (2,)


def test_first_registration_does_not_promote_a_legacy_nonempty_database(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app) as client:
        with sqlite3.connect(tmp_path / "workstep_platform.db") as db:
            db.execute("INSERT INTO users(id,username,display_name,status) VALUES('legacy','legacy','Legacy','active')")
        assert client.post("/api/auth/register", json=ACCOUNT).status_code == 409
        assert client.get("/api/platform/status").json() == {"initialized": False}
