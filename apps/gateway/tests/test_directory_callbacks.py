"""Encrypted vendor callbacks verify before touching directory state."""

import asyncio
import json
import sqlite3
from time import monotonic
from time import sleep

from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from gateway.app import create_app
from gateway.services.callback_crypto import CallbackCrypto
from gateway.config import GatewaySettings

AES_KEY = "Yue0EfdN5900c1ce5cf6A152c63DDe1808a60c5ecd7"


def _wait_until(predicate):
    deadline = monotonic() + 2
    while not predicate() and monotonic() < deadline:
        sleep(0.01)
    assert predicate()


class DirectoryConnector:
    calls = 0
    fail = False

    async def fetch_directory(self, source, *, selected_department_ids=None):
        assert selected_department_ids == ['2']
        if self.fail:
            raise TimeoutError("provider unavailable")
        self.calls += 1
        return {"departments": [{"external_id": "2", "display_name": "研发"}], "people": [{
            "subject": "employee-1", "display_name": "张三", "department_ids": ["2"],
        }]}


async def _choose_department(database, source_id):
    from gateway.models import PlatformSetting
    from gateway.services.organization_settings import option_key
    async with database.session() as session:
        async with session.begin():
            row = await session.get(PlatformSetting, option_key(source_id))
            options = json.loads(row.value_json)
            options['selected_department_ids'] = ['2']
            row.value_json = json.dumps(options)


def _source(client, provider, tenant):
    setup = client.post("/api/platform/setup", json={
        "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
        "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
        "registration_mode": "closed",
    })
    source = client.post("/api/admin/identity-sources", headers={
        "X-CSRF-Token": setup.json()["csrf_token"],
    }, json={"provider": provider, "tenant_id": tenant, "client_id": "app-key",
             "secret_env": "OAUTH_SECRET", "agent_id": "agent-1" if provider == "wecom" else None,
             "callback_token_env": "CALLBACK_TOKEN", "callback_aes_key_env": "CALLBACK_AES_KEY"})
    assert source.status_code == 201, source.text
    client.portal.call(_choose_department, client.app.state.database, source.json()["id"])
    return source.json()["id"]


def test_dingtalk_encrypted_event_and_challenge(monkeypatch, tmp_path):
    monkeypatch.setenv("CALLBACK_TOKEN", "callback-token")
    monkeypatch.setenv("CALLBACK_AES_KEY", AES_KEY)
    app = create_app(GatewaySettings(data_dir=tmp_path))
    connector = DirectoryConnector()
    app.state.identity_connectors = {"dingtalk": connector}
    with TestClient(app, base_url="https://gateway.test") as client:
        source_id = _source(client, "dingtalk", "tenant-a")
        crypto = CallbackCrypto(token="callback-token", encoding_aes_key=AES_KEY, owner_key="app-key")
        url = f"/api/auth/external/{source_id}/events"
        challenge = crypto.encrypt(b'{"EventType":"check_url"}', timestamp="123", nonce="nonce")
        checked = client.post(url, params={"signature": challenge["msg_signature"],
                                           "timestamp": "123", "nonce": "nonce"},
                              json={"encrypt": challenge["encrypt"]})
        assert checked.status_code == 200, checked.text
        reply = checked.json()
        assert crypto.decrypt(signature=reply["msg_signature"], timestamp=reply["timeStamp"],
                              nonce=reply["nonce"], encrypted=reply["encrypt"]) == b"success"
        assert connector.calls == 0
        event = crypto.encrypt(json.dumps({"EventType": "user_add_org", "UserId": ["employee-1"]}).encode(),
                               timestamp="124", nonce="nonce-2")
        bad = client.post(url, params={"signature": "bad", "timestamp": "124", "nonce": "nonce-2"},
                          json={"encrypt": event["encrypt"]})
        assert bad.status_code == 403
        assert connector.calls == 0
        wrong_tenant = crypto.encrypt(
            b'{"EventType":"user_add_org","CorpId":"other-tenant"}',
            timestamp="124", nonce="nonce-2",
        )
        rejected = client.post(url, params={"signature": wrong_tenant["msg_signature"],
                                            "timestamp": "124", "nonce": "nonce-2"},
                               json={"encrypt": wrong_tenant["encrypt"]})
        assert rejected.status_code == 403
        connector.fail = True
        unavailable = client.post(url, params={"signature": event["msg_signature"],
                                               "timestamp": "124", "nonce": "nonce-2"},
                                  json={"encrypt": event["encrypt"]})
        assert unavailable.status_code == 200
        connector.fail = False
        applied = client.post(url, params={"signature": event["msg_signature"],
                                           "timestamp": "124", "nonce": "nonce-2"},
                              json={"encrypt": event["encrypt"]})
        assert applied.status_code == 200, applied.text
        _wait_until(lambda: connector.calls == 1)
        assert connector.calls == 1
        duplicate = client.post(url, params={"signature": event["msg_signature"],
                                             "timestamp": "124", "nonce": "nonce-2"},
                                json={"encrypt": event["encrypt"]})
        assert duplicate.status_code == 200
        assert connector.calls == 1


def test_wecom_url_challenge_and_encrypted_directory_event(monkeypatch, tmp_path):
    monkeypatch.setenv("CALLBACK_TOKEN", "callback-token")
    monkeypatch.setenv("CALLBACK_AES_KEY", AES_KEY)
    app = create_app(GatewaySettings(data_dir=tmp_path))
    connector = DirectoryConnector()
    app.state.identity_connectors = {"wecom": connector}
    with TestClient(app, base_url="https://gateway.test") as client:
        source_id = _source(client, "wecom", "corp-a")
        crypto = CallbackCrypto(token="callback-token", encoding_aes_key=AES_KEY, owner_key="corp-a")
        url = f"/api/auth/external/{source_id}/events"
        challenge = crypto.encrypt(b"challenge", timestamp="123", nonce="nonce")
        verified = client.get(url, params={"msg_signature": challenge["msg_signature"],
                                           "timestamp": "123", "nonce": "nonce",
                                           "echostr": challenge["encrypt"]})
        assert verified.status_code == 200
        assert verified.text == "challenge"
        payload = b"<xml><Event>change_contact</Event><ChangeType>create_user</ChangeType></xml>"
        event = crypto.encrypt(payload, timestamp="124", nonce="nonce-2")
        response = client.post(url, params={"msg_signature": event["msg_signature"],
                                            "timestamp": "124", "nonce": "nonce-2"},
                               content=f"<xml><Encrypt><![CDATA[{event['encrypt']}]]></Encrypt></xml>")
        assert response.status_code == 200, response.text
        _wait_until(lambda: connector.calls == 1)
        assert connector.calls == 1


async def test_slow_directory_callback_keeps_health_responsive(monkeypatch, tmp_path):
    monkeypatch.setenv("CALLBACK_TOKEN", "callback-token")
    monkeypatch.setenv("CALLBACK_AES_KEY", AES_KEY)
    app = create_app(GatewaySettings(data_dir=tmp_path))
    entered = asyncio.Event()
    release = asyncio.Event()

    class SlowConnector(DirectoryConnector):
        async def fetch_directory(self, source, *, selected_department_ids=None):
            entered.set()
            await release.wait()
            return await super().fetch_directory(source, selected_department_ids=selected_department_ids)

    app.state.identity_connectors = {"dingtalk": SlowConnector()}
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="https://gateway.test") as client:
            setup = await client.post("/api/platform/setup", json={
                "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
                "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
                "registration_mode": "closed",
            })
            source = await client.post("/api/admin/identity-sources", headers={
                "X-CSRF-Token": setup.json()["csrf_token"],
            }, json={"provider": "dingtalk", "tenant_id": "tenant-a", "client_id": "app-key",
                     "secret_env": "OAUTH_SECRET", "callback_token_env": "CALLBACK_TOKEN",
                     "callback_aes_key_env": "CALLBACK_AES_KEY"})
            await _choose_department(app.state.database, source.json()["id"])
            crypto = CallbackCrypto(token="callback-token", encoding_aes_key=AES_KEY,
                                    owner_key="app-key")
            event = crypto.encrypt(b'{"EventType":"user_add_org"}', timestamp="123", nonce="nonce")
            started = monotonic()
            accepted = await client.post(
                f"/api/auth/external/{source.json()['id']}/events",
                params={"signature": event["msg_signature"], "timestamp": "123", "nonce": "nonce"},
                json={"encrypt": event["encrypt"]},
            )
            assert accepted.status_code == 200
            assert monotonic() - started < 0.3
            await asyncio.wait_for(entered.wait(), 1)
            started = monotonic()
            health = await client.get("/api/health")
            assert health.status_code == 200
            assert monotonic() - started < 0.3
            release.set()


def test_verified_callback_is_retried_after_gateway_restart(monkeypatch, tmp_path):
    monkeypatch.setenv("CALLBACK_TOKEN", "callback-token")
    monkeypatch.setenv("CALLBACK_AES_KEY", AES_KEY)
    app = create_app(GatewaySettings(data_dir=tmp_path))
    failing = DirectoryConnector()
    failing.fail = True
    app.state.identity_connectors = {"dingtalk": failing}
    with TestClient(app, base_url="https://gateway.test") as client:
        source_id = _source(client, "dingtalk", "tenant-a")
        crypto = CallbackCrypto(token="callback-token", encoding_aes_key=AES_KEY, owner_key="app-key")
        event = crypto.encrypt(b'{"EventType":"user_add_org"}', timestamp="123", nonce="nonce")
        response = client.post(f"/api/auth/external/{source_id}/events", params={
            "signature": event["msg_signature"], "timestamp": "123", "nonce": "nonce",
        }, json={"encrypt": event["encrypt"]})
        assert response.status_code == 200
    with sqlite3.connect(tmp_path / "workstep_platform.db") as connection:
        assert connection.execute("SELECT status FROM directory_event_receipts WHERE event_id LIKE 'callback:%'").fetchone() == ("pending",)

    restarted = create_app(GatewaySettings(data_dir=tmp_path))
    working = DirectoryConnector()
    restarted.state.identity_connectors = {"dingtalk": working}
    with TestClient(restarted, base_url="https://gateway.test"):
        _wait_until(lambda: working.calls == 1)
    with sqlite3.connect(tmp_path / "workstep_platform.db") as connection:
        assert connection.execute("SELECT status FROM directory_event_receipts WHERE event_id LIKE 'callback:%'").fetchone() == ("done",)
