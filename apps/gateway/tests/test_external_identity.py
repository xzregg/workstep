"""Enterprise identity must bind by stable subject, never by display name."""

from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.services.external_identity import ExternalProfile


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


def test_callback_secrets_are_configured_by_environment_reference(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client)
        body = {"provider": "dingtalk", "tenant_id": "tenant-a", "client_id": "app-key",
                "secret_env": "OAUTH_SECRET", "callback_token_env": "CALLBACK_TOKEN",
                "callback_aes_key_env": "CALLBACK_AES_KEY"}
        one_key = client.post("/api/admin/identity-sources", headers={"X-CSRF-Token": csrf},
                              json={**body, "callback_aes_key_env": None})
        assert one_key.status_code == 422
        source = client.post("/api/admin/identity-sources", headers={"X-CSRF-Token": csrf}, json=body)
        assert source.status_code == 201, source.text
        assert source.json()["callback_configured"] is True
        assert "CALLBACK_TOKEN" not in source.text


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

        async def fetch_directory(self, source, *, selected_department_ids=None):
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
        from gateway.models import PlatformSetting
        from gateway.services.organization_settings import option_key
        async def choose_scope():
            async with app.state.database.session() as session:
                async with session.begin():
                    row = await session.get(PlatformSetting, option_key(source_id))
                    options = __import__('json').loads(row.value_json)
                    options['selected_department_ids'] = ['dept-1']
                    row.value_json = __import__('json').dumps(options)
        client.portal.call(choose_scope)
        reconcile_url = f"/api/admin/identity-sources/{source_id}/reconcile"
        reconciled = client.post(reconcile_url, headers={"X-CSRF-Token": csrf})
        assert reconciled.status_code == 200, reconciled.text
        assert reconciled.json()["departments"] == 1
        assert reconciled.json()["people"] == 1
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
        assert client.post(f"/api/auth/external/{source_id}/start", json={
            "return_to": "/auth?next=%2F%2Fevil.test",
        }).status_code == 422
        portal_return = "/auth?next=%2Fdevices"
        portal_start = client.post(f"/api/auth/external/{source_id}/start", json={
            "return_to": portal_return,
        })
        assert portal_start.status_code == 200
        portal_state = parse_qs(urlparse(portal_start.json()["authorization_url"]).query)["state"][0]
        portal_callback = client.get(
            f"/api/auth/external/{source_id}/callback?state={portal_state}&code=valid-code",
            follow_redirects=False,
        )
        assert portal_callback.headers["location"] == portal_return
        client.cookies.clear()
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


def test_portal_scan_failures_return_to_login_without_authenticating(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    app.state.identity_connectors = {"dingtalk": FakeConnector()}
    with TestClient(app, base_url="https://gateway.test") as client:
        csrf = _setup(client)
        source_id = _source(client, csrf)
        client.cookies.clear()

        def begin():
            started = client.post(f"/api/auth/external/{source_id}/start", json={
                "return_to": "/auth?next=%2Fdevices",
            })
            assert started.status_code == 200
            return parse_qs(urlparse(started.json()["authorization_url"]).query)["state"][0]

        cancelled = begin()
        cancel = client.get(
            f"/api/auth/external/{source_id}/callback?state={cancelled}&error=access_denied",
            follow_redirects=False,
        )
        assert cancel.status_code == 303
        assert cancel.headers["location"] == "/auth?next=%2Fdevices&scan_error=cancelled"

        failed = begin()
        unavailable = client.get(
            f"/api/auth/external/{source_id}/callback?state={failed}&code=invalid-code",
            follow_redirects=False,
        )
        assert unavailable.headers["location"] == "/auth?next=%2Fdevices&scan_error=unavailable"

        denied_state = begin()
        denied = client.get(
            f"/api/auth/external/{source_id}/callback?state={denied_state}&code=valid-code",
            follow_redirects=False,
        )
        assert denied.headers["location"] == "/auth?next=%2Fdevices&scan_error=denied"

        expired = begin()
        with __import__("sqlite3").connect(tmp_path / "workstep_platform.db") as connection:
            connection.execute("UPDATE external_login_attempts SET expires_at='2000-01-01 00:00:00' WHERE consumed_at IS NULL")
        timeout = client.get(
            f"/api/auth/external/{source_id}/callback?state={expired}&code=valid-code",
            follow_redirects=False,
        )
        assert timeout.headers["location"] == "/auth?next=%2Fdevices&scan_error=expired"
        unknown = client.get(
            f"/api/auth/external/{source_id}/callback?state=unknown&error=access_denied",
            follow_redirects=False,
        )
        assert unknown.status_code == 400
        assert client.get("/api/auth/session").status_code == 401


def test_oauth_callback_uses_saved_platform_domain_for_web_and_desktop(tmp_path):
    from urllib.parse import urlencode
    class CallbackConnector(FakeConnector):
        def authorization_url(self, source, state, nonce, redirect_uri):
            return 'https://identity.test/authorize?' + urlencode({'redirect_uri':redirect_uri})
    app = create_app(GatewaySettings(data_dir=tmp_path, public_origin='https://gateway.test'))
    app.state.identity_connectors = {'dingtalk':CallbackConnector()}
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client)
        source = _source(client, csrf)
        headers = {'X-CSRF-Token':csrf}
        client.post('/api/auth/step-up', headers=headers, json={'password':'OwnerPassphrase-2026!'})
        assert client.put('/api/admin/platform-address', headers=headers, json={'public_origin':'https://workstep.example.com'}).status_code == 200
        for target in ('/', '/desktop/login?state=test'):
            result = client.post(f'/api/auth/external/{source}/start', json={'return_to':target})
            assert result.status_code == 200, result.text
            callback = parse_qs(urlparse(result.json()['authorization_url']).query)['redirect_uri'][0]
            assert callback == f'https://workstep.example.com/api/auth/external/{source}/callback'


def test_scan_admin_mutations_do_not_require_password_but_keep_csrf_and_roles(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path))
    app.state.identity_connectors = {'dingtalk': FakeConnector()}
    with TestClient(app, base_url='https://gateway.test') as client:
        csrf = _setup(client)
        source = _source(client, csrf)
        bound = client.post(f'/api/auth/external/{source}/bind/start', headers={'X-CSRF-Token':csrf})
        state = parse_qs(urlparse(bound.json()['authorization_url']).query)['state'][0]
        assert client.get(f'/api/auth/external/{source}/callback?state={state}&code=valid-code').status_code == 200
        # Binding alone must not change a password-authenticated session.
        assert client.get('/api/auth/session').json()['password_confirmation_required'] is True
        assert client.put('/api/admin/registration-policy',headers={'X-CSRF-Token':csrf},json={'mode':'open'}).status_code == 403
        client.cookies.clear()
        state = _start(client, source)
        assert client.get(f'/api/auth/external/{source}/callback?state={state}&code=valid-code').status_code == 200
        session = client.get('/api/auth/session').json()
        assert session['password_confirmation_required'] is False
        assert client.get('/api/auth/admin-access').json()['password_confirmation_required'] is False
        assert client.put('/api/admin/registration-policy',json={'mode':'open'}).status_code == 403
        headers={'X-CSRF-Token':session['csrf_token']}
        assert client.put('/api/admin/registration-policy',headers=headers,json={'mode':'open'}).status_code == 200
        assert client.post('/api/auth/step-up',headers=headers,json={'password':''}).status_code == 200
        assert client.post('/api/auth/password',headers=headers,json={'current_password':'','new_password':'UpdatedOwnerPass-2026!'}).status_code == 204
        client.post('/api/auth/logout', headers=headers)
        login = client.post('/api/auth/login',json={'username':'owner','password':'UpdatedOwnerPass-2026!'})
        assert login.status_code == 200
        assert client.get('/api/auth/session').json()['password_confirmation_required'] is True
        assert client.put('/api/admin/registration-policy',headers={'X-CSRF-Token':login.json()['csrf_token']},json={'mode':'closed'}).status_code == 403
