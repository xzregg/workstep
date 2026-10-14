"""Login method comes from the authenticated session, never the desktop request."""
import json
import pytest
from fastapi.testclient import TestClient
from gateway.app import create_app
from gateway.config import GatewaySettings
from test_desktop_authorization import _setup, _authorize, _redeem, _public_key
from test_external_identity import FakeConnector, _start

@pytest.mark.parametrize("method", ["password", "dingtalk", "wecom"])
def test_login_and_desktop_authorization_have_user_method_and_device_snapshots(tmp_path, method):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test", public_origin="https://gateway.test"))
    app.state.identity_connectors = {method: FakeConnector()}
    with TestClient(app, base_url="https://gateway.test", client=("198.51.100.42", 50000)) as client:
        owner_csrf = _setup(client)
        if method == "password":
            logged = client.post("/api/auth/login", json={"username": "owner", "password": "OwnerPassphrase-2026!"})
        else:
            source = client.post("/api/admin/identity-sources", headers={"X-CSRF-Token": owner_csrf}, json={"provider": method, "tenant_id": "tenant-a", "client_id": "client", "secret_env": "TEST_LOGIN_SECRET", **({"agent_id": "1"} if method == "wecom" else {})})
            assert source.status_code == 201, source.text
            sid = source.json()["id"]
            synced = client.post(f"/api/admin/identity-sources/{sid}/sync", headers={"X-CSRF-Token": owner_csrf}, json={"departments": [], "people": [{"subject": "employee-1", "display_name": "张三", "department_ids": []}]})
            assert synced.status_code == 200, synced.text
            client.cookies.clear()
            state = _start(client, sid)
            logged = client.get(f"/api/auth/external/{sid}/callback", params={"state": state, "code": "valid-code"})
        assert logged.status_code == 200, logged.text
        uid = logged.json()["user"]["id"]
        code = _authorize(client, logged.json()["csrf_token"])
        key = _public_key()
        redeemed = _redeem(client, code, key)
        assert redeemed.status_code == 200, redeemed.text
        did = redeemed.json()["device"]["id"]
        assert _redeem(client, code, _public_key()).status_code == 409
        from gateway.models import Device
        async def approve():
            async with app.state.database.session() as session:
                async with session.begin():
                    device = await session.get(Device, did)
                    device.status = "active"
        client.portal.call(approve)
        second = _redeem(client, _authorize(client, logged.json()["csrf_token"]), key)
        assert second.status_code == 200 and second.json()["device_authorization"]
        app.state.control_connections.is_online = lambda device_id: True
        issued = client.get(f"/api/devices/{did}/access").json()
        entered = client.post(issued["url"].rstrip("/") + "/api/remote/redeem", data={"ticket": issued["ticket"]}, follow_redirects=False)
        assert entered.status_code == 303, entered.text
        assert client.post(issued["url"].rstrip("/") + "/api/remote/redeem", data={"ticket": issued["ticket"]}, follow_redirects=False).status_code == 409
        client.cookies.clear()
        assert client.post("/api/auth/login", json={"username": "owner", "password": "OwnerPassphrase-2026!"}).status_code == 200
        events = client.get("/api/admin/audit", params={"user_id": uid}).json()["items"]
        login = next(item for item in events if item["action"] == "auth.login" and item["metadata"].get("login_method") == method)
        desktop = [item for item in events if item["action"] == "auth.desktop.login"]
        assert login["actor_id"] == uid
        assert login['request_ip'] == '198.51.100.42'
        user_rows = client.get('/api/admin/users', params={'q': logged.json()['user']['username']}).json()['users']
        assert next(user for user in user_rows if user['id'] == uid)['last_login_at'].endswith('+00:00')
        assert len(desktop) == 2
        remote = [item for item in events if item["action"] == "auth.device.login"]
        assert len(remote) == 1
        assert remote[0]["metadata"]["login_method"] == method
        assert remote[0]["device_id"] == did
        assert remote[0]["result"] == "success"
        assert any(item["result"] == "success" for item in desktop)
        assert desktop[0]["device_id"] == did
        assert desktop[0]["metadata"]["device_name"] == "Alice PC"
        assert desktop[0]["metadata"]["login_method"] == method
        pending = next(item for item in desktop if item["result"] == "denied")
        assert pending["metadata"]["device_status"] == "pending"
        assert code not in json.dumps(events) and "valid-code" not in json.dumps(events)
        assert "OwnerPassphrase" not in json.dumps(events)


def test_failed_password_login_does_not_claim_an_authenticated_user_or_log_password(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        _setup(client)
        assert client.post("/api/auth/login", json={"username": "owner", "password": "invalid-secret"}).status_code == 401
        result = client.get("/api/admin/audit", params={"action": "auth.login", "result": "failed"})
        rows = result.json()["items"]
        assert len(rows) == 1
        assert rows[0]["actor_id"] == "anonymous"
        assert rows[0]["actor_type"] == "anonymous"
        assert rows[0]["actor_username"] == "owner"
        assert rows[0]["metadata"]["login_method"] == "password"
        assert "invalid-secret" not in result.text


def test_login_with_audit_waiting_for_sqlite_keeps_health_responsive(tmp_path):
    import sqlite3
    import time
    from concurrent.futures import ThreadPoolExecutor
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        _setup(client)
        with ThreadPoolExecutor(max_workers=1) as pool:
            with sqlite3.connect(tmp_path / "workstep_platform.db") as holder:
                holder.execute("BEGIN EXCLUSIVE")
                pending = pool.submit(client.post, "/api/auth/login", json={"username": "owner", "password": "OwnerPassphrase-2026!"})
                time.sleep(0.1)
                assert not pending.done()
                started = time.monotonic()
                assert client.get("/api/health").status_code == 200
                assert time.monotonic() - started < 0.3
                holder.rollback()
            assert pending.result(timeout=5).status_code == 200
        assert len(client.get("/api/admin/audit", params={"action": "auth.login"}).json()["items"]) == 1


def test_audit_ip_uses_transport_peer_and_isolates_concurrent_requests(tmp_path):
    import asyncio
    from httpx import ASGITransport, AsyncClient
    from gateway.audit_context import request_ip
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url='https://gateway.test') as client:
        _setup(client)
        async def attempt(name, address):
            async with AsyncClient(transport=ASGITransport(app=app, client=(address, 12345)), base_url='https://gateway.test') as actor:
                response = await actor.post('/api/auth/login', json={'username': name, 'password': 'incorrect'},
                    headers={'X-Forwarded-For': '192.0.2.99', 'X-Real-IP': '192.0.2.98'})
                assert response.status_code == 401
        async def scenario():
            await asyncio.gather(attempt('first', '198.51.100.1'), attempt('second', '198.51.100.2'))
            assert request_ip.get() is None
        client.portal.call(scenario)
        rows = client.get('/api/admin/audit', params={'action': 'auth.login', 'result': 'failed'}).json()['items']
        assert {row['actor_username']: row['request_ip'] for row in rows} == {'first': '198.51.100.1', 'second': '198.51.100.2'}
