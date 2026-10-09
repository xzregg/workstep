import base64
import json

from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings
from test_control_connection import _active_device, _handshake, _ordinary_device_owner


def test_group_permissions_reach_signed_policy_and_follow_membership(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, key, csrf = _active_device(client)
        user_id = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))["user_id"]
        csrf = _ordinary_device_owner(client, user_id, csrf)
        headers = {"X-CSRF-Token": csrf}
        group_id = client.post("/api/groups", headers=headers, json={
            "name": "Engineers", "slug": "engineers",
        }).json()["id"]
        assert client.post(f"/api/groups/{group_id}/members", headers=headers,
                           json={"user_id": user_id}).status_code == 200
        for permission in ("task.create", "engine.install", "provider.local", "share.create"):
            result = client.post("/api/admin/permissions", headers=headers, json={
                "subject_type": "group", "subject_id": group_id,
                "permission": permission, "scope_type": "global", "effect": "allow",
            })
            assert result.status_code == 200, result.text
        listing = client.get(f"/api/admin/permissions?subject_type=group&subject_id={group_id}")
        assert listing.status_code == 200
        assert len(listing.json()["assignments"]) == 4
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, key)
            policy = json.loads(base64.urlsafe_b64decode(
                ws.receive_json()["policy_snapshot"].split(".")[1] + "=="))
            for field in ("task_create", "engine_install", "allow_local_providers", "task_share"):
                assert policy[field] is True, field
            assert client.delete(f"/api/groups/{group_id}/members/{user_id}",
                                 headers=headers).status_code == 204
            ws.send_json({"kind": "heartbeat"})
            removed = json.loads(base64.urlsafe_b64decode(
                ws.receive_json()["policy_snapshot"].split(".")[1] + "=="))
            assert removed["policy_revision"] > policy["policy_revision"]
            for field in ("task_create", "engine_install", "allow_local_providers", "task_share"):
                assert removed[field] is False, field


def test_group_administrator_role_applies_to_current_members_only(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, key, csrf = _active_device(client)
        user_id = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))["user_id"]
        csrf = _ordinary_device_owner(client, user_id, csrf)
        headers = {"X-CSRF-Token": csrf}
        group_id = client.post("/api/groups", headers=headers, json={
            "name": "Administrators", "slug": "administrators",
        }).json()["id"]
        assert client.post(f"/api/groups/{group_id}/members", headers=headers,
                           json={"user_id": user_id}).status_code == 200
        response = client.post("/api/admin/permissions", headers=headers, json={
            "subject_type": "group", "subject_id": group_id,
            "permission": "admin.super_admin", "scope_type": "platform",
        })
        assert response.status_code == 200, response.text
        assignment_id = response.json()["id"]
        client.cookies.clear()
        assert client.post("/api/auth/login", json={
            "username": "owner", "password": "OwnerPassphrase-2026!",
        }).status_code == 200
        assert "super_admin" in client.get("/api/auth/admin-access").json()["roles"]
        assert client.get("/api/admin/overview").status_code == 200
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, key)
            policy = json.loads(base64.urlsafe_b64decode(
                ws.receive_json()["policy_snapshot"].split(".")[1] + "=="))
            assert policy["task_create"] is True
            client.cookies.clear()
            recovery = client.post("/api/auth/login", json={
                "username": "recovery", "password": "RecoveryPassphrase-2026!",
            })
            headers = {"X-CSRF-Token": recovery.json()["csrf_token"]}
            assert client.post("/api/auth/step-up", headers=headers, json={
                "password": "RecoveryPassphrase-2026!",
            }).status_code == 200
            assert client.delete(f"/api/admin/permissions/{assignment_id}", headers=headers).status_code == 204
            ws.send_json({"kind": "heartbeat"})
            revoked = json.loads(base64.urlsafe_b64decode(
                ws.receive_json()["policy_snapshot"].split(".")[1] + "=="))
            assert revoked["task_create"] is False
            assert revoked["policy_revision"] > policy["policy_revision"]
        client.cookies.clear()
        client.post("/api/auth/login", json={"username": "owner", "password": "OwnerPassphrase-2026!"})
        assert client.get("/api/admin/overview").status_code == 403


def test_existing_and_new_project_permissions_share_one_assignment_entry(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test", public_origin="https://gateway.test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, key, csrf = _active_device(client)
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, key)
            ws.receive_json()
            ws.send_json({"kind": "project_publish", "version": 1, "action": "publish",
                          "host_project_id": "host-1", "name": "Project"})
            project_id = ws.receive_json()["project_id"]
            user_id = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))["user_id"]
            csrf = _ordinary_device_owner(client, user_id, csrf)
            headers = {"X-CSRF-Token": csrf}
            group_id = client.post("/api/groups", headers=headers, json={
                "name": "Editors", "slug": "editors",
            }).json()["id"]
            client.post(f"/api/groups/{group_id}/members", headers=headers, json={"user_id": user_id})
            # Existing project rules must appear and remain editable in the unified entry.
            assert client.post(f"/api/admin/projects/{project_id}/task-create-groups/{group_id}",
                               headers=headers, json={"effect": "deny"}).status_code == 200
            listed = client.get(f"/api/admin/permissions?subject_type=group&subject_id={group_id}").json()
            assert [row["permission"] for row in listed["assignments"]] == ["task.create"]
            ids = {}
            for permission in ("project.edit", "task.create", "share.create"):
                response = client.post("/api/admin/permissions", headers=headers, json={
                    "subject_type": "group", "subject_id": group_id,
                    "permission": permission, "scope_type": "project", "scope_id": project_id,
                })
                assert response.status_code == 200, response.text
                ids[permission] = response.json()["id"]
            listing = client.get(f"/api/admin/permissions?subject_type=group&subject_id={group_id}").json()
            assert len(listing["assignments"]) == 3
            ws.send_json({"kind": "heartbeat"})
            snapshot = json.loads(base64.urlsafe_b64decode(
                ws.receive_json()["policy_snapshot"].split(".")[1] + "=="))
            assert snapshot["task_share"] is False
            assert snapshot["task_share_project_ids"] == ["host-1"]
            assert snapshot["task_share_denied_project_ids"] == []
            client.cookies.clear()
            client.post("/api/auth/login", json={"username": "owner", "password": "OwnerPassphrase-2026!"})
            assert client.get("/api/projects").json()["projects"][0]["access_level"] == "edit"
            issued = client.get(f"/api/projects/{project_id}/access")
            assert issued.status_code == 200, issued.text
            host = f"https://d-{device_id}.gateway.test"
            assert client.post(f"{host}/api/remote/redeem", data={"ticket": issued.json()["ticket"]},
                               follow_redirects=False).status_code == 303
            remote = client.get(f"{host}/api/remote/session").json()
            assert remote["task_create"] is True
            assert remote["share_create"] is True
            client.cookies.clear()
            recovery = client.post("/api/auth/login", json={
                "username": "recovery", "password": "RecoveryPassphrase-2026!",
            }).json()
            headers = {"X-CSRF-Token": recovery["csrf_token"]}
            client.post("/api/auth/step-up", headers=headers, json={
                "password": "RecoveryPassphrase-2026!",
            })
            for subject_type, subject_id, scope_type, scope_id, effect in (
                ("group", group_id, "global", None, "allow"),
                ("user", user_id, "project", project_id, "deny"),
            ):
                response = client.post("/api/admin/permissions", headers=headers, json={
                    "subject_type": subject_type, "subject_id": subject_id,
                    "permission": "share.create", "scope_type": scope_type,
                    "scope_id": scope_id, "effect": effect,
                })
                assert response.status_code == 200, response.text
            ws.send_json({"kind": "heartbeat"})
            denied = json.loads(base64.urlsafe_b64decode(
                ws.receive_json()["policy_snapshot"].split(".")[1] + "=="))
            assert denied["task_share"] is True
            assert denied["task_share_project_ids"] == []
            assert denied["task_share_denied_project_ids"] == ["host-1"]


def test_provider_use_permission_is_inherited_and_revoked_with_group_membership(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, key, csrf = _active_device(client)
        user_id = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))["user_id"]
        csrf = _ordinary_device_owner(client, user_id, csrf)
        headers = {"X-CSRF-Token": csrf}
        provider = client.post("/api/admin/providers", headers=headers, json={
            "name": "Team model", "type": "custom", "protocols": ["openai_responses"],
            "protocol_base_urls": {"openai_responses": "https://api.example.test"},
            "api_key": "test-secret", "models": ["model-1"],
        }).json()["id"]
        group = client.post("/api/groups", headers=headers, json={"name": "Team", "slug": "team"}).json()["id"]
        client.post(f"/api/groups/{group}/members", headers=headers, json={"user_id": user_id})
        grant = client.post("/api/admin/permissions", headers=headers, json={
            "subject_type": "group", "subject_id": group, "permission": "provider.use",
            "scope_type": "provider", "scope_id": provider,
        })
        assert grant.status_code == 200, grant.text
        legacy = client.get(f"/api/admin/providers/{provider}/assignments").json()
        assert legacy["assignments"][0]["subject_name"] == "Team"
        summary = client.get("/api/admin/providers").json()["providers"][0]
        assert summary["target_devices"] == 1
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, key)
            hello = ws.receive_json()
            targets = client.get(f"/api/admin/providers/{provider}/test-targets").json()
            assert [item["id"] for item in targets["devices"]] == [device_id]
            policy = json.loads(base64.urlsafe_b64decode(hello["policy_snapshot"].split(".")[1] + "=="))
            bundle = json.loads(base64.urlsafe_b64decode(hello["provider_bundle"].split(".")[1] + "=="))
            assert policy["allowed_provider_ids"] == [provider]
            assert policy["allowed_models"] == ["model-1"]
            assert "test-secret" not in json.dumps(hello)
            assert client.delete(f"/api/groups/{group}/members/{user_id}", headers=headers).status_code == 204
            ws.send_json({"kind": "heartbeat"})
            removed = ws.receive_json()
            policy = json.loads(base64.urlsafe_b64decode(removed["policy_snapshot"].split(".")[1] + "=="))
            new_bundle = json.loads(base64.urlsafe_b64decode(removed["provider_bundle"].split(".")[1] + "=="))
            assert policy["allowed_provider_ids"] == []
            assert new_bundle["revision"] > bundle["revision"]


def test_personal_and_group_denials_override_all_business_grants(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, key, csrf = _active_device(client)
        user_id = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))["user_id"]
        csrf = _ordinary_device_owner(client, user_id, csrf)
        headers = {"X-CSRF-Token": csrf}
        group = client.post("/api/groups", headers=headers, json={"name": "Team", "slug": "team"}).json()["id"]
        client.post(f"/api/groups/{group}/members", headers=headers, json={"user_id": user_id})
        denials = []
        for permission in ("task.create", "project.publish", "share.create", "engine.install", "provider.local"):
            assert client.post("/api/admin/permissions", headers=headers, json={
                "subject_type": "group", "subject_id": group, "permission": permission,
                "scope_type": "global", "effect": "allow",
            }).status_code == 200
            denial = client.post("/api/admin/permissions", headers=headers, json={
                "subject_type": "user", "subject_id": user_id, "permission": permission,
                "scope_type": "device", "scope_id": device_id, "effect": "deny",
            })
            assert denial.status_code == 200, denial.text
            denials.append(denial.json()["id"])
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, key)
            denied = json.loads(base64.urlsafe_b64decode(ws.receive_json()["policy_snapshot"].split(".")[1] + "=="))
            fields = ("task_create", "project_publish", "task_share", "engine_install", "allow_local_providers")
            assert all(denied[field] is False for field in fields)
            for assignment in denials:
                assert client.delete(f"/api/admin/permissions/{assignment}", headers=headers).status_code == 204
            ws.send_json({"kind": "heartbeat"})
            restored = json.loads(base64.urlsafe_b64decode(ws.receive_json()["policy_snapshot"].split(".")[1] + "=="))
            assert all(restored[field] is True for field in fields)
            assert restored["policy_revision"] > denied["policy_revision"]


def test_unified_manager_preserves_admin_csrf_scope_and_recovery_guards(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        _, token, _, csrf = _active_device(client)
        user_id = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))["user_id"]
        headers = {"X-CSRF-Token": csrf}
        body = {"subject_type": "user", "subject_id": user_id, "permission": "task.create", "scope_type": "global"}
        assert client.post("/api/admin/permissions", json=body).status_code == 403
        assert client.post("/api/admin/permissions", headers=headers, json={**body, "scope_type": "device"}).status_code == 422
        assert client.post("/api/admin/permissions", headers=headers, json={**body, "permission": "admin.super_admin", "scope_type": "device", "scope_id": "unknown"}).status_code == 422
        recovery_role = next(row for row in client.get("/api/admin/permissions").json()["assignments"]
                             if row["subject_name"] == "Recovery Administrator" and row["permission"] == "admin.super_admin")
        assert client.delete(f"/api/admin/permissions/{recovery_role['id']}", headers=headers).status_code == 403
        _ordinary_device_owner(client, user_id, csrf)
        client.cookies.clear()
        login = client.post("/api/auth/login", json={"username": "owner", "password": "OwnerPassphrase-2026!"})
        for endpoint in ("", "/catalog", "/subjects", "/resources?scope_type=device"):
            assert client.get(f"/api/admin/permissions{endpoint}").status_code == 403
        assert client.post("/api/admin/permissions", headers={"X-CSRF-Token": login.json()["csrf_token"]}, json=body).status_code == 403


def test_super_admin_can_use_enabled_providers_without_individual_grants(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, key, csrf = _active_device(client)
        provider = client.post("/api/admin/providers", headers={"X-CSRF-Token": csrf}, json={
            "name": "Platform model", "type": "custom", "protocols": ["openai_responses"],
            "protocol_base_urls": {"openai_responses": "https://api.example.test"},
            "api_key": "test-secret", "models": ["model-1"],
        }).json()["id"]
        user = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))["user_id"]
        assert client.get("/api/admin/providers").json()["providers"][0]["target_devices"] == 1
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, key)
            policy = json.loads(base64.urlsafe_b64decode(ws.receive_json()["policy_snapshot"].split(".")[1] + "=="))
            assert policy["allowed_provider_ids"] == [provider]
            assert client.get(f"/api/admin/providers/{provider}/test-targets").json()["devices"][0]["id"] == device_id
            _ordinary_device_owner(client, user, csrf)
            ws.send_json({"kind": "heartbeat"})
            policy = json.loads(base64.urlsafe_b64decode(ws.receive_json()["policy_snapshot"].split(".")[1] + "=="))
            assert policy["allowed_provider_ids"] == []


def test_permission_write_waiting_for_sqlite_lock_keeps_health_responsive(tmp_path):
    import sqlite3
    import time
    from concurrent.futures import ThreadPoolExecutor
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        _, token, _, csrf = _active_device(client)
        user_id = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))["user_id"]
        with ThreadPoolExecutor(max_workers=1) as pool:
            with sqlite3.connect(tmp_path / "workstep_platform.db") as holder:
                holder.execute("BEGIN IMMEDIATE")
                pending = pool.submit(client.post, "/api/admin/permissions", headers={"X-CSRF-Token": csrf}, json={
                    "subject_type": "user", "subject_id": user_id, "permission": "engine.install", "scope_type": "global",
                })
                time.sleep(.1)
                assert not pending.done()
                started = time.monotonic()
                assert client.get("/api/health").status_code == 200
                assert time.monotonic() - started < .3
                holder.rollback()
            result = pending.result(timeout=5)
            assert result.status_code == 200, result.text


def test_super_admin_has_device_and_published_project_access_without_grants(tmp_path):
    app = create_app(GatewaySettings(data_dir=tmp_path, gateway_id="gateway-test", public_origin="https://gateway.test"))
    with TestClient(app, base_url="https://gateway.test") as client:
        device_id, token, key, _ = _active_device(client)
        with client.websocket_connect("/api/control/ws") as ws:
            _handshake(ws, token, key)
            ws.receive_json()
            ws.send_json({"kind": "project_publish", "version": 1, "action": "publish", "host_project_id": "host-1", "name": "Project"})
            project = ws.receive_json()["project_id"]
            client.cookies.clear()
            client.post("/api/auth/login", json={"username": "recovery", "password": "RecoveryPassphrase-2026!"})
            assert [row["id"] for row in client.get("/api/devices").json()["devices"]] == [device_id]
            assert client.get(f"/api/devices/{device_id}/access").status_code == 200
            published = client.get("/api/projects").json()["projects"]
            assert published[0]["id"] == project
            assert published[0]["access_level"] == "edit"
            assert client.get(f"/api/projects/{project}/access").status_code == 200
