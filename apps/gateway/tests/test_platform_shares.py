import hashlib
import sqlite3
import threading
import time
from types import SimpleNamespace
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import Device, PlatformProject
from gateway import platform_shares


def test_gateway_owns_public_share_credentials_and_revocation(tmp_path, monkeypatch):
    app = create_app(GatewaySettings(
        data_dir=tmp_path, public_origin="https://gateway.test",
    ))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner",
            "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery",
            "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "closed",
        })
        assert setup.status_code == 201
        headers = {"X-CSRF-Token": setup.json()["csrf_token"]}

        async def seed_project():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id="device-1", name="PC", public_key="test",
                                       status="active", app_instance_id="app", version="1.0"))
                    session.add(PlatformProject(
                        id="project-1", device_id="device-1", host_project_id="host-1",
                        name="Project", status="active", access_mode="remote_published",
                    ))

        client.portal.call(seed_project)
        assert client.post("/api/platform-shares", json={
            "project_id": "project-1", "task_id": "task-1", "mode": "read_only",
            "title": "Demo", "password": "correct horse battery staple",
        }).status_code == 403
        created = client.post("/api/platform-shares", json={
            "project_id": "project-1", "task_id": "task-1", "mode": "read_only",
            "title": "Demo", "password": "correct horse battery staple",
            "expires_at": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
        }, headers=headers)
        assert created.status_code == 201, created.text
        share = created.json()
        assert share["url"].startswith("https://gateway.test/share/")
        token = share["url"].rsplit("/", 1)[1]
        assert share["status"] == "active"
        with sqlite3.connect(tmp_path / "workstep_platform.db") as db:
            token_hash, password_hash = db.execute(
                "SELECT token_hash, password_hash FROM platform_shares WHERE id=?",
                (share["id"],),
            ).fetchone()
        assert token_hash == hashlib.sha256(token.encode()).hexdigest()
        assert token not in password_hash
        assert "correct horse battery staple" not in password_hash
        own = client.get("/api/platform-shares?project_id=project-1&task_id=task-1")
        assert own.status_code == 200, own.text
        assert len(own.json()["shares"]) == 1
        assert {key: own.json()["shares"][0][key] for key in (
            "id", "title", "mode", "status",
        )} == {"id": share["id"], "title": "Demo",
               "mode": "read_only", "status": "active"}
        assert token not in own.text and "token_hash" not in own.text

        client.cookies.clear()
        meta = client.get(f"/api/public/shares/{token}/meta")
        assert meta.status_code == 200, meta.text
        assert meta.json() == {"title": "Demo", "mode": "read_only",
                               "has_password": True, "status": "active"}
        assert client.get(f"/api/public/shares/{token}/task").status_code == 401
        assert client.post(f"/api/public/shares/{token}/unlock", json={
            "password": "wrong",
        }).status_code == 403
        unlocked = client.post(f"/api/public/shares/{token}/unlock", json={
            "password": "correct horse battery staple",
        })
        assert unlocked.status_code == 200, unlocked.text
        assert "platform_share_session" in client.cookies
        visitor_cookie = client.cookies["platform_share_session"]
        assert client.get(f"/api/public/shares/{token}/session").json() == {
            "share_id": share["id"], "mode": "read_only", "task_id": "task-1",
        }
        with sqlite3.connect(tmp_path / "workstep_platform.db") as db:
            assert db.execute("SELECT last_seen_at FROM platform_share_sessions WHERE share_id=?",
                              (share["id"],)).fetchone()[0] is not None
        from fastapi.responses import JSONResponse
        captured = {}

        class ShareConnection:
            async def proxy_http(self, request, *, share_ticket, target_path,
                                 authorization_check):
                await authorization_check()
                captured["ticket"] = share_ticket
                captured["path"] = target_path
                return JSONResponse({"id": "task-1", "title": "Shared task"})

        async def request_data(device_id):
            assert device_id == "device-1"
            return ShareConnection()

        monkeypatch.setattr(app.state.control_connections, "is_online", lambda _id: True)
        monkeypatch.setattr(app.state.control_connections, "request_data", request_data)
        task = client.get(f"/api/public/shares/{token}/task")
        assert task.status_code == 200, task.text
        assert task.json()["id"] == "task-1"
        assert captured["path"] == "/api/platform-share/task"
        import base64
        import json
        claims = json.loads(base64.urlsafe_b64decode(captured["ticket"].split(".")[1] + "==="))
        assert (claims["share_id"], claims["device_id"], claims["project_id"],
                claims["host_project_id"], claims["task_id"], claims["mode"]) == (
                    share["id"], "device-1", "project-1", "host-1", "task-1", "read_only",
                )
        client.cookies.clear()
        assert client.get(f"/api/public/shares/{token}/session").status_code == 401
        assert client.get(f"/api/public/shares/{token}/task").status_code == 401

        login = client.post("/api/auth/login", json={
            "username": "owner", "password": "OwnerPassphrase-2026!",
        })
        owner_headers = {"X-CSRF-Token": login.json()["csrf_token"]}
        revoked = client.post(f"/api/platform-shares/{share['id']}/revoke",
                              headers=owner_headers)
        assert revoked.status_code == 204, revoked.text
        client.cookies.clear()
        assert client.get(f"/api/public/shares/{token}/meta").status_code == 404
        assert client.post(f"/api/public/shares/{token}/unlock", json={
            "password": "correct horse battery staple",
        }).status_code == 404
        client.cookies.set("platform_share_session", visitor_cookie,
                           domain="gateway.test", path="/")
        assert client.get(f"/api/public/shares/{token}/session").status_code == 404
        assert client.get(f"/api/public/shares/{token}/task").status_code == 404

        client.cookies.clear()
        owner_login = client.post("/api/auth/login", json={
            "username": "owner", "password": "OwnerPassphrase-2026!",
        })
        owner_headers = {"X-CSRF-Token": owner_login.json()["csrf_token"]}
        second = client.post("/api/platform-shares", json={
            "project_id": "project-1", "task_id": "task-2",
        }, headers=owner_headers)
        assert second.status_code == 201, second.text
        second_token = second.json()["url"].rsplit("/", 1)[1]
        async def disable_device():
            async with app.state.database.session() as session:
                async with session.begin():
                    device = await session.get(Device, "device-1")
                    device.status = "disabled"
        client.portal.call(disable_device)
        client.cookies.clear()
        assert client.get(f"/api/public/shares/{second_token}/meta").status_code == 503

        async def expire_share():
            from gateway.models import PlatformShare
            async with app.state.database.session() as session:
                async with session.begin():
                    device = await session.get(Device, "device-1")
                    device.status = "active"
                    existing = await session.get(PlatformShare, second.json()["id"])
                    existing.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        client.portal.call(expire_share)
        assert client.get(f"/api/public/shares/{second_token}/meta").status_code == 404


def test_project_editor_needs_live_share_create_capability(tmp_path):
    app = create_app(GatewaySettings(
        data_dir=tmp_path, public_origin="https://gateway.test",
    ))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner",
            "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery",
            "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "closed",
        })
        owner_headers = {"X-CSRF-Token": setup.json()["csrf_token"]}
        client.post("/api/auth/step-up", json={
            "password": "OwnerPassphrase-2026!",
        }, headers=owner_headers)
        user = client.post("/api/admin/users", json={
            "username": "editor", "display_name": "Editor",
            "password": "EditorPassphrase-2026!",
        }, headers=owner_headers)
        assert user.status_code == 201, user.text
        editor_id = user.json()["id"]

        async def seed_project():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id="device-1", name="PC", public_key="test",
                                       status="active", app_instance_id="app", version="1.0"))
                    session.add(PlatformProject(
                        id="project-1", device_id="device-1", host_project_id="host-1",
                        name="Project", status="active", access_mode="remote_published",
                    ))

        client.portal.call(seed_project)
        assert client.post("/api/admin/projects/project-1/grants", json={
            "subject_type": "user", "subject_id": editor_id, "access_level": "edit",
        }, headers=owner_headers).status_code == 200
        client.cookies.clear()
        login = client.post("/api/auth/login", json={
            "username": "editor", "password": "EditorPassphrase-2026!",
        })
        editor_headers = {"X-CSRF-Token": login.json()["csrf_token"]}
        assert client.post("/api/auth/password", json={
            "current_password": "EditorPassphrase-2026!",
            "new_password": "EditorNewPassphrase-2026!",
        }, headers=editor_headers).status_code == 204
        body = {"project_id": "project-1", "task_id": "task-1"}
        assert client.post("/api/platform-shares", json=body,
                           headers=editor_headers).status_code == 403

        client.cookies.clear()
        owner_login = client.post("/api/auth/login", json={
            "username": "owner", "password": "OwnerPassphrase-2026!",
        })
        owner_headers = {"X-CSRF-Token": owner_login.json()["csrf_token"]}
        client.post("/api/auth/step-up", json={
            "password": "OwnerPassphrase-2026!",
        }, headers=owner_headers)
        capability = {"capability": "share.create", "scope_type": "project",
                      "scope_id": "project-1"}
        assert client.post(f"/api/admin/capabilities/{editor_id}", json={
            **capability, "effect": "allow",
        }, headers=owner_headers).status_code == 200
        client.cookies.clear()
        editor_login = client.post("/api/auth/login", json={
            "username": "editor", "password": "EditorNewPassphrase-2026!",
        })
        editor_headers = {"X-CSRF-Token": editor_login.json()["csrf_token"]}
        assert client.post("/api/platform-shares", json=body,
                           headers=editor_headers).status_code == 201

        client.cookies.clear()
        owner_login = client.post("/api/auth/login", json={
            "username": "owner", "password": "OwnerPassphrase-2026!",
        })
        owner_headers = {"X-CSRF-Token": owner_login.json()["csrf_token"]}
        client.post("/api/auth/step-up", json={
            "password": "OwnerPassphrase-2026!",
        }, headers=owner_headers)
        assert client.post(f"/api/admin/capabilities/{editor_id}/revoke",
                           json=capability, headers=owner_headers).status_code == 204
        client.cookies.clear()
        editor_login = client.post("/api/auth/login", json={
            "username": "editor", "password": "EditorNewPassphrase-2026!",
        })
        editor_headers = {"X-CSRF-Token": editor_login.json()["csrf_token"]}
        assert client.post("/api/platform-shares", json={**body, "task_id": "task-2"},
                           headers=editor_headers).status_code == 403


def test_slow_share_password_hash_keeps_health_responsive(tmp_path, monkeypatch):
    app = create_app(GatewaySettings(
        data_dir=tmp_path, public_origin="https://gateway.test",
    ))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner",
            "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery",
            "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "closed",
        })
        async def seed_project():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id="device-1", name="PC", public_key="test",
                                       status="active", app_instance_id="app", version="1.0"))
                    session.add(PlatformProject(
                        id="project-1", device_id="device-1", host_project_id="host-1",
                        name="Project", status="active", access_mode="remote_published",
                    ))
        client.portal.call(seed_project)
        started = threading.Event()
        finish = threading.Event()
        original_hash = platform_shares._hasher.hash

        def slow_hash(password):
            started.set()
            assert finish.wait(timeout=3)
            return original_hash(password)

        monkeypatch.setattr(platform_shares, "_hasher", SimpleNamespace(hash=slow_hash))
        result = {}

        def create():
            result["response"] = client.post("/api/platform-shares", json={
                "project_id": "project-1", "task_id": "task-1", "password": "password-1234",
            }, headers={"X-CSRF-Token": setup.json()["csrf_token"]})

        worker = threading.Thread(target=create, daemon=True)
        worker.start()
        try:
            assert started.wait(timeout=2)
            before = time.monotonic()
            assert client.get("/api/health").status_code == 200
            assert time.monotonic() - before < 0.2
        finally:
            finish.set()
            worker.join(timeout=3)
        assert result["response"].status_code == 201


def test_admin_lists_pauses_resumes_and_revokes_platform_shares(tmp_path):
    app = create_app(GatewaySettings(
        data_dir=tmp_path, public_origin="https://gateway.test",
    ))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner",
            "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery",
            "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "closed",
        })
        headers = {"X-CSRF-Token": setup.json()["csrf_token"]}
        assert client.post("/api/auth/step-up", json={
            "password": "OwnerPassphrase-2026!",
        }, headers=headers).status_code == 200
        assert client.post("/api/admin/users", json={
            "username": "viewer", "display_name": "Viewer",
            "password": "ViewerPassphrase-2026!",
        }, headers=headers).status_code == 201

        async def seed_project():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id="device-1", name="PC", public_key="test",
                                       status="active", app_instance_id="app", version="1.0"))
                    session.add(PlatformProject(
                        id="project-1", device_id="device-1", host_project_id="host-1",
                        name="Project", status="active", access_mode="remote_published",
                    ))

        client.portal.call(seed_project)
        created = client.post("/api/platform-shares", json={
            "project_id": "project-1", "task_id": "task-1",
            "title": "Review link", "mode": "read_only",
        }, headers=headers)
        assert created.status_code == 201, created.text
        share = created.json()
        token = share["url"].rsplit("/", 1)[1]
        client.cookies.clear()
        assert client.post(f"/api/public/shares/{token}/unlock", json={
            "password": "",
        }).status_code == 200
        client.cookies.clear()
        viewer = client.post("/api/auth/login", json={
            "username": "viewer", "password": "ViewerPassphrase-2026!",
        })
        assert viewer.status_code == 200
        assert client.post("/api/auth/password", json={
            "current_password": "ViewerPassphrase-2026!",
            "new_password": "ViewerNewPassphrase-2026!",
        }, headers={"X-CSRF-Token": viewer.json()["csrf_token"]}).status_code == 204
        assert client.get("/api/admin/shares").status_code == 403
        assert client.get("/api/platform-shares?project_id=project-1&task_id=task-1").json() == {
            "shares": [],
        }
        assert client.post(f"/api/admin/shares/{share['id']}/pause", headers={
            "X-CSRF-Token": viewer.json()["csrf_token"],
        }).status_code == 403
        client.cookies.clear()
        login = client.post("/api/auth/login", json={
            "username": "owner", "password": "OwnerPassphrase-2026!",
        })
        headers = {"X-CSRF-Token": login.json()["csrf_token"]}
        listing = client.get("/api/admin/shares?project_id=project-1&limit=10")
        assert listing.status_code == 200, listing.text
        assert listing.json()["total"] == 1
        row = listing.json()["shares"][0]
        assert row["id"] == share["id"]
        assert row["created_by"] == "owner"
        assert row["device_name"] == "PC"
        assert row["project_name"] == "Project"
        assert row["visit_count"] == 1
        assert row["status"] == "active"
        assert "token_hash" not in row and "password_hash" not in row
        assert token not in listing.text
        assert client.post(f"/api/admin/shares/{share['id']}/pause").status_code == 403
        assert client.post(f"/api/admin/shares/{share['id']}/pause",
                           headers=headers).status_code == 204
        assert client.get(f"/api/public/shares/{token}/meta").status_code == 503
        assert client.get("/api/admin/shares?status=paused").json()["total"] == 1
        assert client.post(f"/api/admin/shares/{share['id']}/resume",
                           headers=headers).status_code == 204
        assert client.get(f"/api/public/shares/{token}/meta").status_code == 200
        assert client.post(f"/api/admin/shares/{share['id']}/revoke",
                           headers=headers).status_code == 204
        assert client.get(f"/api/public/shares/{token}/meta").status_code == 404
