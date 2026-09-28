"""Enterprise identity must bind by stable subject, never by display name."""

from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.external_identity import ExternalProfile


class FakeConnector:
    profile = ExternalProfile(tenant_id="tenant-a", subject="employee-1", display_name="张三")

    def authorization_url(self, source, state, nonce, redirect_uri):
        return f"https://identity.test/authorize?state={state}&nonce={nonce}"

    async def exchange_code(self, source, code, nonce):
        if code != "valid-code":
            raise ValueError("Invalid code")
        return self.profile


def _setup(client):
    response = client.post("/api/platform/setup", json={
        "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
        "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
        "registration_mode": "closed",
    })
    assert response.status_code == 201
    return response.json()["csrf_token"]


def _source(client, csrf, tenant="tenant-a"):
    response = client.post("/api/admin/identity-sources", headers={"X-CSRF-Token": csrf}, json={
        "provider": "dingtalk", "tenant_id": tenant, "client_id": "test-client",
        "secret_env": "WORKSTEP_TEST_DINGTALK_SECRET",
    })
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _start(client, source_id):
    response = client.post(f"/api/auth/external/{source_id}/start")
    assert response.status_code == 200, response.text
    return parse_qs(urlparse(response.json()["authorization_url"]).query)["state"][0]


def test_closed_registration_requires_presynced_subject_and_rejects_replay(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    connector = FakeConnector()
    app.state.identity_connectors = {"dingtalk": connector}
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client)
        source_id = _source(client, csrf)
        state = _start(client, source_id)
        url = f"/api/auth/external/{source_id}/callback?state={state}&code=valid-code"
        assert client.get(url).status_code == 403
        assert client.get(url).status_code == 409
        synced = client.post(f"/api/admin/identity-sources/{source_id}/sync", headers={
            "X-CSRF-Token": csrf,
        }, json={"departments": [], "people": [{"subject": "employee-1", "display_name": "张三", "department_ids": []}]})
        assert synced.status_code == 200, synced.text
        client.cookies.clear()
        state = _start(client, source_id)
        logged_in = client.get(f"/api/auth/external/{source_id}/callback?state={state}&code=valid-code")
        assert logged_in.status_code == 200, logged_in.text
        assert logged_in.json()["user"]["display_name"] == "张三"
        assert logged_in.json()["user"]["username"] != "owner"
        assert client.get("/api/auth/session").status_code == 200


def test_cross_tenant_and_same_name_do_not_link_accounts(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    connector = FakeConnector()
    app.state.identity_connectors = {"dingtalk": connector}
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client)
        source_a = _source(client, csrf)
        source_b = _source(client, csrf, "tenant-b")
        assert client.post(f"/api/admin/identity-sources/{source_a}/sync", headers={
            "X-CSRF-Token": csrf,
        }, json={"departments": [], "people": [
            {"subject": "employee-1", "display_name": "张三", "department_ids": []},
            {"subject": "employee-2", "display_name": "张三", "department_ids": []},
        ]}).status_code == 200
        client.cookies.clear()
        state = _start(client, source_b)
        assert client.get(f"/api/auth/external/{source_b}/callback?state={state}&code=valid-code").status_code == 403
        state = _start(client, source_a)
        first = client.get(f"/api/auth/external/{source_a}/callback?state={state}&code=valid-code")
        assert first.status_code == 200
        first_id = first.json()["user"]["id"]
        connector.profile = ExternalProfile(tenant_id="tenant-a", subject="employee-2", display_name="张三")
        client.cookies.clear()
        state = _start(client, source_a)
        second = client.get(f"/api/auth/external/{source_a}/callback?state={state}&code=valid-code")
        assert second.status_code == 200
        assert second.json()["user"]["id"] != first_id


def test_directory_rename_keeps_identity_and_explicit_bind_requires_session(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    connector = FakeConnector()
    app.state.identity_connectors = {"dingtalk": connector}
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client)
        owner_id = client.get("/api/auth/session").json()["user"]["id"]
        source_id = _source(client, csrf)
        bound = client.post(f"/api/auth/external/{source_id}/bind/start", headers={"X-CSRF-Token": csrf})
        assert bound.status_code == 200
        state = parse_qs(urlparse(bound.json()["authorization_url"]).query)["state"][0]
        client.cookies.clear()
        assert client.get(f"/api/auth/external/{source_id}/callback?state={state}&code=valid-code").status_code == 401
        owner = client.post("/api/auth/login", json={
            "username": "owner", "password": "OwnerPassphrase-2026!",
        })
        assert owner.status_code == 200
        csrf = owner.json()["csrf_token"]
        bound = client.post(f"/api/auth/external/{source_id}/bind/start", headers={"X-CSRF-Token": csrf})
        state = parse_qs(urlparse(bound.json()["authorization_url"]).query)["state"][0]
        linked = client.get(f"/api/auth/external/{source_id}/callback?state={state}&code=valid-code")
        assert linked.status_code == 200
        assert linked.json()["user"]["id"] == owner_id
        connector.profile = ExternalProfile(tenant_id="tenant-a", subject="employee-1", display_name="李四")
        client.cookies.clear()
        state = _start(client, source_id)
        renamed = client.get(f"/api/auth/external/{source_id}/callback?state={state}&code=valid-code")
        assert renamed.status_code == 200
        assert renamed.json()["user"]["id"] == owner_id
        assert renamed.json()["user"]["username"] == "owner"
        assert renamed.json()["user"]["display_name"] == "Owner"


def test_directory_event_replay_and_departed_member(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    app.state.identity_connectors = {"dingtalk": FakeConnector()}
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client)
        source_id = _source(client, csrf)
        event_url = f"/api/admin/identity-sources/{source_id}/events"
        event = {"event_id": "event-1", "kind": "person_upsert", "subject": "employee-1",
                 "display_name": "张三", "department_ids": []}
        first = client.post(event_url, headers={"X-CSRF-Token": csrf}, json=event)
        assert first.status_code == 200, first.text
        assert first.json()["applied"] is True
        assert client.post(event_url, headers={"X-CSRF-Token": csrf}, json=event).json()["applied"] is False
        changed = {**event, "event_id": "event-2", "display_name": "李四"}
        assert client.post(event_url, headers={"X-CSRF-Token": csrf}, json=changed).json()["applied"] is True
        client.cookies.clear()
        state = _start(client, source_id)
        assert client.get(f"/api/auth/external/{source_id}/callback?state={state}&code=valid-code").status_code == 200
        owner = client.post("/api/auth/login", json={
            "username": "owner", "password": "OwnerPassphrase-2026!",
        })
        csrf = owner.json()["csrf_token"]
        deleted = {"event_id": "event-3", "kind": "person_delete", "subject": "employee-1"}
        assert client.post(event_url, headers={"X-CSRF-Token": csrf}, json=deleted).status_code == 200
        client.cookies.clear()
        state = _start(client, source_id)
        assert client.get(f"/api/auth/external/{source_id}/callback?state={state}&code=valid-code").status_code == 403
        assert client.post("/api/auth/login", json={
            "username": "owner", "password": "OwnerPassphrase-2026!",
        }).status_code == 200


def test_disabling_identity_source_preserves_password_login(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    app.state.identity_connectors = {"dingtalk": FakeConnector()}
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client)
        source_id = _source(client, csrf)
        assert client.post(f"/api/admin/identity-sources/{source_id}/disable", headers={
            "X-CSRF-Token": csrf,
        }).status_code == 204
        assert client.post(f"/api/auth/external/{source_id}/start").status_code == 403
        client.cookies.clear()
        assert client.post("/api/auth/login", json={
            "username": "owner", "password": "OwnerPassphrase-2026!",
        }).status_code == 200


def test_external_registration_waits_for_approval(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    app.state.identity_connectors = {"dingtalk": FakeConnector()}
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client)
        source_id = _source(client, csrf)
        with __import__("sqlite3").connect(tmp_path / "workstep_platform.db") as connection:
            connection.execute("UPDATE platform_settings SET value_json='\"open_with_approval\"' WHERE key='registration_mode'")
        client.cookies.clear()
        state = _start(client, source_id)
        pending = client.get(f"/api/auth/external/{source_id}/callback?state={state}&code=valid-code")
        assert pending.status_code == 202, pending.text
        assert pending.json()["user"]["status"] == "pending"
        assert client.get("/api/auth/session").status_code == 401
        owner = client.post("/api/auth/login", json={
            "username": "owner", "password": "OwnerPassphrase-2026!",
        })
        assert client.post(f"/api/admin/users/{pending.json()['user']['id']}/approve", headers={
            "X-CSRF-Token": owner.json()["csrf_token"],
        }).status_code == 204
        client.cookies.clear()
        state = _start(client, source_id)
        assert client.get(f"/api/auth/external/{source_id}/callback?state={state}&code=valid-code").status_code == 200


def test_provider_reconciliation_is_atomic_and_provisions_closed_registration(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))

    class DirectoryConnector(FakeConnector):
        failing = False

        async def fetch_directory(self, source):
            if self.failing:
                raise TimeoutError("provider offline")
            return {"departments": [{"external_id": "dept-1", "display_name": "研发"}],
                    "people": [{"subject": "employee-1", "display_name": "张三",
                                "department_ids": ["dept-1"]}]}

    connector = DirectoryConnector()
    app.state.identity_connectors = {"dingtalk": connector}
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client)
        source_id = _source(client, csrf)
        reconcile_url = f"/api/admin/identity-sources/{source_id}/reconcile"
        reconciled = client.post(reconcile_url, headers={"X-CSRF-Token": csrf})
        assert reconciled.status_code == 200, reconciled.text
        assert reconciled.json() == {"departments": 1, "people": 1}
        connector.failing = True
        assert client.post(reconcile_url, headers={"X-CSRF-Token": csrf}).status_code == 502
        with __import__("sqlite3").connect(tmp_path / "workstep_platform.db") as connection:
            assert connection.execute("SELECT active FROM directory_people WHERE subject='employee-1'").fetchone() == (1,)
        client.cookies.clear()
        state = _start(client, source_id)
        connector.failing = False
        assert client.get(f"/api/auth/external/{source_id}/callback?state={state}&code=valid-code").status_code == 200


def test_external_scan_returns_to_desktop_login_without_open_redirect(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    app.state.identity_connectors = {"dingtalk": FakeConnector()}
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client)
        source_id = _source(client, csrf)
        assert client.post(f"/api/admin/identity-sources/{source_id}/sync", headers={
            "X-CSRF-Token": csrf,
        }, json={"departments": [], "people": [{
            "subject": "employee-1", "display_name": "张三", "department_ids": [],
        }]}).status_code == 200
        sources = client.get("/api/auth/identity-sources")
        assert sources.status_code == 200
        assert sources.json()["sources"][0]["id"] == source_id
        client.cookies.clear()
        return_to = "/desktop/login?gateway_id=gateway-test&state=state-value"
        assert client.post(f"/api/auth/external/{source_id}/start", json={
            "return_to": "//evil.test/steal",
        }).status_code == 422
        start = client.post(f"/api/auth/external/{source_id}/start", json={
            "return_to": return_to,
        })
        assert start.status_code == 200
        state = parse_qs(urlparse(start.json()["authorization_url"]).query)["state"][0]
        callback = client.get(f"/api/auth/external/{source_id}/callback?state={state}&code=valid-code",
                              follow_redirects=False)
        assert callback.status_code == 303
        assert callback.headers["location"] == return_to
        assert client.get("/api/auth/session").status_code == 200
