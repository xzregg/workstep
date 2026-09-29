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
        assert client.get(f"/api/public/shares/{token}/host-status").status_code == 401
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
            "csrf_token": unlocked.json()["csrf_token"],
        }
        assert client.get(f"/api/public/shares/{token}/host-status").json() == {
            "connected": False, "daemon_health": None,
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
                if target_path.startswith("/api/platform-share/history"):
                    return JSONResponse({"messages": [{"id": "message-1", "content": "Visible"}]})
                if target_path.startswith("/api/platform-share/events/"):
                    return JSONResponse({"events": [{"type": "TEXT_MESSAGE_CHUNK"}],
                                         "next_cursor": None})
                if target_path == "/api/platform-share/artifacts":
                    return JSONResponse({"artifacts": [{"id": "a" * 64, "name": "result.txt"}]})
                if target_path == "/api/platform-share/git/workspace":
                    return JSONResponse({"worktrees": [{"id": "a" * 24, "alias": "app"}]})
                if target_path.endswith("/status"):
                    return JSONResponse({"branch": "feature", "files": []})
                if target_path.endswith("/preview"):
                    return JSONResponse({"type": "text", "content": "visible preview"})
                if target_path.endswith("/content"):
                    return JSONResponse({"content": "visible"})
                return JSONResponse({"id": "task-1", "title": "Shared task"})

        async def request_data(device_id):
            assert device_id == "device-1"
            return ShareConnection()

        monkeypatch.setattr(app.state.control_connections, "is_online", lambda _id: True)
        monkeypatch.setattr(app.state.control_connections, "daemon_health", lambda _id: False)
        monkeypatch.setattr(app.state.control_connections, "request_data", request_data)
        status = client.get(f"/api/public/shares/{token}/host-status")
        assert status.json() == {"connected": True, "daemon_health": False}
        assert status.headers["cache-control"] == "no-store"
        assert "device-1" not in status.text and "host-1" not in status.text
        task = client.get(f"/api/public/shares/{token}/task")
        assert task.status_code == 200, task.text
        assert task.json()["id"] == "task-1"
        assert captured["path"] == "/api/platform-share/task"
        history = client.get(f"/api/public/shares/{token}/history")
        assert history.status_code == 200, history.text
        assert history.json()["messages"][0]["content"] == "Visible"
        assert captured["path"] == "/api/platform-share/history"
        older = client.get(f"/api/public/shares/{token}/history/100")
        assert older.status_code == 200
        assert captured["path"] == "/api/platform-share/history/100"
        assert client.get(f"/api/public/shares/{token}/history/1000000").status_code == 404
        events = client.get(f"/api/public/shares/{token}/events/message-1/0")
        assert events.status_code == 200
        assert events.json()["events"][0]["type"] == "TEXT_MESSAGE_CHUNK"
        assert captured["path"] == "/api/platform-share/events/message-1/0"
        assert client.get(f"/api/public/shares/{token}/events/invalid.id/0").status_code == 404
        artifacts = client.get(f"/api/public/shares/{token}/artifacts")
        assert artifacts.status_code == 200
        assert artifacts.json()["artifacts"][0]["name"] == "result.txt"
        assert captured["path"] == "/api/platform-share/artifacts"
        content = client.get(f"/api/public/shares/{token}/artifacts/{'a' * 64}/content")
        assert content.status_code == 200
        assert captured["path"] == f"/api/platform-share/artifacts/{'a' * 64}/content"
        preview = client.get(f"/api/public/shares/{token}/artifacts/{'a' * 64}/preview")
        assert preview.status_code == 200
        assert preview.json()["content"] == "visible preview"
        assert captured["path"] == f"/api/platform-share/artifacts/{'a' * 64}/preview"
        workspace = client.get(f"/api/public/shares/{token}/git/workspace")
        assert workspace.status_code == 200
        assert workspace.json()["worktrees"][0]["alias"] == "app"
        assert captured["path"] == "/api/platform-share/git/workspace"
        git_status = client.get(f"/api/public/shares/{token}/git/worktrees/{'a' * 24}/status")
        assert git_status.status_code == 200
        assert git_status.json()["branch"] == "feature"
        assert captured["path"] == f"/api/platform-share/git/worktrees/{'a' * 24}/status"
        assert client.get(f"/api/public/shares/{token}/git/worktrees/invalid/status").status_code == 404
        assert client.get(f"/api/public/shares/{token}/artifacts/invalid/content").status_code == 404
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
        assert client.get(f"/api/public/shares/{token}/history").status_code == 401
        assert client.get(f"/api/public/shares/{token}/artifacts").status_code == 401

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
        assert client.get(f"/api/public/shares/{token}/history").status_code == 404
        assert client.get(f"/api/public/shares/{token}/artifacts").status_code == 404

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


def test_interactive_platform_share_requires_session_csrf_and_mode(tmp_path, monkeypatch):
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
        tokens = {}
        for mode in ("read_only", "interactive"):
            created = client.post("/api/platform-shares", json={
                "project_id": "project-1", "task_id": "task-1", "mode": mode,
            }, headers=headers)
            assert created.status_code == 201, created.text
            tokens[mode] = created.json()["url"].rsplit("/", 1)[1]

        captured = []
        upload_name = f"t{'a' * 24}-{'b' * 32}.txt"

        class ShareConnection:
            async def proxy_http(self, request, *, share_ticket, target_path,
                                 authorization_check, share_body=None):
                await authorization_check()
                captured.append((target_path, share_body))
                from fastapi.responses import JSONResponse
                if target_path == "/api/platform-share/reviews":
                    return JSONResponse({"reviews": [{"id": "review-1", "step_key": "build",
                                                      "report": {"summary": "Check output"}}]})
                if target_path == "/api/platform-share/interventions":
                    return JSONResponse({"interventions": [{"interaction_id": "interaction-1",
                        "step_key": "build", "request": {"method": "session/request_permission"}}]})
                if target_path == "/api/platform-share/uploads" and request.method == "POST":
                    return JSONResponse({"filename": upload_name, "size": len(share_body),
                                         "url": f".workstep/uploads/{upload_name}"})
                return JSONResponse({"message_id": "accepted"})

        async def request_data(device_id):
            assert device_id == "device-1"
            return ShareConnection()

        monkeypatch.setattr(app.state.control_connections, "is_online", lambda _id: True)
        monkeypatch.setattr(app.state.control_connections, "request_data", request_data)
        client.cookies.clear()
        token = tokens["read_only"]
        unlocked = client.post(f"/api/public/shares/{token}/unlock", json={"password": ""})
        assert unlocked.status_code == 200
        read_csrf = unlocked.json()["csrf_token"]
        assert client.post(f"/api/public/shares/{token}/steps/build/message",
                           headers={"X-Share-CSRF": read_csrf},
                           json={"content": "hello"}).status_code == 403
        assert client.post(f"/api/public/shares/{token}/uploads",
                           headers={"X-Share-CSRF": read_csrf, "X-Share-Filename": "report.txt"},
                           content=b"visible").status_code == 403
        commit_path = f"/api/public/shares/{token}/git/worktrees/{'a' * 24}/commit"
        commit_body = {"paths": ["README.md"], "message": "Share commit", "snapshot": "d" * 64}
        assert client.post(commit_path, headers={"X-Share-CSRF": read_csrf},
                           json=commit_body).status_code == 403
        sync_body = {"branch": "feature", "snapshot": "d" * 64}
        assert client.post(f"/api/public/shares/{token}/git/worktrees/{'a' * 24}/push",
                           headers={"X-Share-CSRF": read_csrf}, json=sync_body).status_code == 403
        assert client.get(f"/api/public/shares/{token}/reviews").status_code == 200
        assert client.post(f"/api/public/shares/{token}/steps/build/review/approve",
                           headers={"X-Share-CSRF": read_csrf},
                           json={"review_run_id": "review-1"}).status_code == 403
        assert client.get(f"/api/public/shares/{token}/interventions").status_code == 403
        assert captured == [("/api/platform-share/reviews", None)]
        captured.clear()

        token = tokens["interactive"]
        unlocked = client.post(f"/api/public/shares/{token}/unlock", json={"password": ""})
        assert unlocked.status_code == 200
        csrf = unlocked.json()["csrf_token"]
        assert client.get(f"/api/public/shares/{token}/session").json()["csrf_token"] == csrf
        upload_path = f"/api/public/shares/{token}/uploads"
        assert client.post(upload_path, headers={"X-Share-Filename": "report.txt"},
                           content=b"visible").status_code == 403
        uploaded = client.post(upload_path, headers={"X-Share-CSRF": csrf,
                                                    "X-Share-Filename": "report.txt"},
                               content=b"visible")
        assert uploaded.status_code == 200, uploaded.text
        assert uploaded.json()["size"] == 7
        assert captured == [("/api/platform-share/uploads", b"visible")]
        asset = client.get(f"{upload_path}/{upload_name}")
        assert asset.status_code == 200
        assert asset.headers["content-security-policy"] == "sandbox"
        assert asset.headers["x-content-type-options"] == "nosniff"
        assert captured[-1] == (f"/api/platform-share/uploads/{upload_name}", None)
        assert client.post(upload_path, headers={"X-Share-CSRF": csrf,
                                                "X-Share-Filename": "report.txt"},
                           content=b"x" * 25_000_001).status_code == 413
        captured.clear()
        path = f"/api/public/shares/{token}/steps/build/message"
        assert client.post(path, json={"content": "hello"}).status_code == 403
        assert client.post(path, headers={"X-Share-CSRF": "wrong"},
                           json={"content": "hello"}).status_code == 403
        sent = client.post(path, headers={"X-Share-CSRF": csrf},
                           json={"content": "hello"})
        assert sent.status_code == 200, sent.text
        assert captured == [("/api/platform-share/steps/build/message", b'{"content":"hello"}')]
        assert client.post(f"/api/public/shares/{token}/steps/build/resume",
                           headers={"X-Share-CSRF": csrf},
                           json={"content": "again"}).status_code == 200
        assert client.post(f"/api/public/shares/{token}/steps/build/cancel",
                           headers={"X-Share-CSRF": csrf}).status_code == 200
        interventions = client.get(f"/api/public/shares/{token}/interventions")
        assert interventions.status_code == 200
        assert interventions.json()["interventions"][0]["interaction_id"] == "interaction-1"
        interaction_path = f"/api/public/shares/{token}/interventions/interaction-1/respond"
        assert client.post(interaction_path, json={"data": {"action": "cancel"}}).status_code == 403
        replied = client.post(interaction_path, headers={"X-Share-CSRF": csrf},
                              json={"data": {"action": "cancel"}})
        assert replied.status_code == 200
        assert captured[-1] == ("/api/platform-share/interventions/interaction-1/respond",
                                b'{"data":{"action":"cancel"}}')
        review_path = f"/api/public/shares/{token}/steps/build/review/approve"
        assert client.post(review_path, json={"review_run_id": "review-1"}).status_code == 403
        review = client.post(review_path, headers={"X-Share-CSRF": csrf},
                             json={"review_run_id": "review-1", "comment": "Approved"})
        assert review.status_code == 200
        assert captured[-1] == ("/api/platform-share/steps/build/review/approve",
                                b'{"review_run_id":"review-1","comment":"Approved"}')
        assert client.post(f"/api/public/shares/{token}/steps/build/review/unknown",
                           headers={"X-Share-CSRF": csrf},
                           json={"review_run_id": "review-1"}).status_code == 404
        commit_path = f"/api/public/shares/{token}/git/worktrees/{'a' * 24}/commit"
        assert client.post(commit_path, json=commit_body).status_code == 403
        committed = client.post(commit_path, headers={"X-Share-CSRF": csrf}, json=commit_body)
        assert committed.status_code == 200
        assert captured[-1] == (
            f"/api/platform-share/git/worktrees/{'a' * 24}/commit",
            b'{"paths":["README.md"],"message":"Share commit","snapshot":"' + b"d" * 64 + b'"}',
        )
        for action in ("pull", "push"):
            sync_path = f"/api/public/shares/{token}/git/worktrees/{'a' * 24}/{action}"
            assert client.post(sync_path, json=sync_body).status_code == 403
            synced = client.post(sync_path, headers={"X-Share-CSRF": csrf}, json=sync_body)
            assert synced.status_code == 200
            assert captured[-1] == (
                f"/api/platform-share/git/worktrees/{'a' * 24}/{action}",
                b'{"branch":"feature","snapshot":"' + b"d" * 64 + b'","set_upstream":false}',
            )
        assert client.post(f"/api/public/shares/{token}/steps/../message",
                           headers={"X-Share-CSRF": csrf},
                           json={"content": "escape"}).status_code != 200


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
