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


def test_platform_address_saved_live_and_restored_on_restart(tmp_path):
    from test_external_identity import _setup
    settings = GatewaySettings(data_dir=tmp_path, public_origin="https://gateway.test")
    app = create_app(settings)
    with TestClient(app, base_url="https://gateway.test") as client:
        headers = {"X-CSRF-Token": _setup(client)}
        assert client.put('/api/admin/platform-address', headers=headers, json={'public_origin':'https://workstep.example.com'}).status_code == 403
        assert client.post('/api/auth/step-up', headers=headers, json={'password':'OwnerPassphrase-2026!'}).status_code == 200
        body = {"public_origin": "https://workstep.example.com/"}
        assert client.put('/api/admin/platform-address', json=body).status_code == 403
        response = client.put('/api/admin/platform-address', headers=headers, json=body)
        assert response.status_code == 200, response.text
        assert settings.public_origin == "https://workstep.example.com"
        assert client.get('/api/client-releases').json()['public_origin'] == settings.public_origin
        for origin in ('https://example.com/path', 'javascript:bad', 'http://public.example.com', 'https://user:pass@example.com'):
            assert client.put('/api/admin/platform-address', headers=headers, json={'public_origin': origin}).status_code == 422
        assert settings.public_origin == "https://workstep.example.com"
        assert client.put('/api/admin/registration-policy', headers=headers, json={'mode':'open'}).status_code == 200
        client.post('/api/auth/register', json={'username':'alice','display_name':'Alice','password':'AlicePassphrase-2026!'})
        token = client.get('/api/auth/session').json()['csrf_token']
        assert client.put('/api/admin/platform-address', headers={'X-CSRF-Token':token}, json=body).status_code == 403
    restored = create_app(GatewaySettings(data_dir=tmp_path, public_origin='http://localhost:8700'))
    with TestClient(restored) as client:
        assert client.get('/api/client-releases').json()['public_origin'] == 'https://workstep.example.com'
        assert restored.state.settings.device_url('pc') == 'https://workstep.example.com/workspace/pc/'


def test_platform_address_write_lock_keeps_health_responsive(tmp_path):
    import asyncio
    import sqlite3
    import threading
    from httpx import AsyncClient, ASGITransport
    from sqlalchemy import event

    from test_external_identity import _setup
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client)
        assert client.post('/api/auth/step-up', headers={'X-CSRF-Token':csrf}, json={'password':'OwnerPassphrase-2026!'}).status_code == 200
        reached_write = threading.Event()
        engine = app.state.database.engine.sync_engine
        def before_execute(_connection, _cursor, statement, _parameters, _context, _many):
            if statement.startswith(('INSERT', 'UPDATE')):
                reached_write.set()
        event.listen(engine, 'before_cursor_execute', before_execute)
        async def scenario():
            async with AsyncClient(transport=ASGITransport(app=app), base_url='https://gateway.test', cookies=client.cookies) as actor:
                pending = asyncio.create_task(actor.put('/api/admin/platform-address', headers={'X-CSRF-Token': csrf}, json={'public_origin': 'https://workstep.example.com'}))
                try:
                    assert await asyncio.to_thread(reached_write.wait, 2)
                    assert (await asyncio.wait_for(actor.get('/api/health'), .5)).status_code == 200
                    assert not pending.done()
                finally:
                    await asyncio.to_thread(lock.rollback)
                assert (await pending).status_code == 200
        try:
            with sqlite3.connect(tmp_path/'workstep_platform.db', check_same_thread=False) as lock:
                lock.execute('BEGIN IMMEDIATE')
                client.portal.call(scenario)
        finally:
            event.remove(engine, 'before_cursor_execute', before_execute)

