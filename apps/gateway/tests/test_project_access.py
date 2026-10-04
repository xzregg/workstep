import base64
import json

from fastapi.testclient import TestClient
from fastapi.responses import JSONResponse

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import Device, PlatformProject


def test_project_grants_require_publication_and_follow_current_group_membership(tmp_path, monkeypatch):
    web_dist = tmp_path / "dist"
    (web_dist / "assets").mkdir(parents=True)
    (web_dist / "index.html").write_text("<main>Gateway project workspace</main>")
    (web_dist / "assets" / "app.js").write_text("/* project UI */")
    app = create_app(GatewaySettings(data_dir=tmp_path,
                                     public_origin="https://gateway.test",
                                     web_dist=web_dist))
    with TestClient(app, base_url="https://gateway.test") as client:
        setup = client.post("/api/platform/setup", json={
            "username": "owner", "display_name": "Owner", "password": "OwnerPassphrase-2026!",
            "recovery_username": "recovery", "recovery_password": "RecoveryPassphrase-2026!",
            "registration_mode": "open",
        })
        owner_headers = {"X-CSRF-Token": setup.json()["csrf_token"]}
        client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"},
                    headers=owner_headers)
        worker_id = client.post("/api/admin/users", json={
            "username": "worker", "display_name": "Worker",
            "password": "WorkerPassphrase-2026!",
        }, headers=owner_headers).json()["id"]
        group_id = client.post("/api/groups", json={
            "name": "Backend", "slug": "backend",
        }, headers=owner_headers).json()["id"]
        client.post(f"/api/groups/{group_id}/members", json={
            "user_id": worker_id,
        }, headers=owner_headers)

        async def seed_project():
            async with app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id="device-1", name="PC", public_key="test",
                                       status="active", app_instance_id="app", version="1.0"))
                    session.add(PlatformProject(id="project-1", device_id="device-1",
                                                host_project_id="host-1", name="Project",
                                                access_mode="policy_only"))

        client.portal.call(seed_project)
        grant_url = "/api/admin/projects/project-1/grants"
        assert client.post(grant_url, json={
            "subject_type": "group", "subject_id": group_id, "access_level": "read",
        }, headers=owner_headers).status_code == 409

        async def publish():
            async with app.state.database.session() as session:
                async with session.begin():
                    project = await session.get(PlatformProject, "project-1")
                    project.access_mode = "remote_published"

        client.portal.call(publish)
        assert client.post(grant_url, json={
            "subject_type": "group", "subject_id": group_id, "access_level": "read",
        }, headers=owner_headers).status_code == 200
        client.cookies.clear()
        login = client.post("/api/auth/login", json={
            "username": "worker", "password": "WorkerPassphrase-2026!",
        })
        worker_headers = {"X-CSRF-Token": login.json()["csrf_token"]}
        client.post("/api/auth/password", json={
            "current_password": "WorkerPassphrase-2026!",
            "new_password": "WorkerNewPassphrase-2026!",
        }, headers=worker_headers)
        listing = client.get("/api/projects")
        assert listing.status_code == 200, listing.text
        assert client.get("/api/devices").json() == {"devices": []}
        assert client.get("/api/devices/device-1/access").status_code == 403
        assert listing.json()["projects"] == [{
            "id": "project-1", "name": "Project", "device_id": "device-1",
            "device_name": "PC", "device_online": False,
            "access_level": "read", "grant_sources": ["用户组：Backend"],
        }]
        assert client.get("/api/projects/project-1/access").status_code == 409
        monkeypatch.setattr(app.state.control_connections, "is_online", lambda _id: True)
        issued = client.get("/api/projects/project-1/access")
        assert issued.status_code == 200, issued.text
        ticket = issued.json()["ticket"]
        claims = json.loads(base64.urlsafe_b64decode(ticket.split(".")[1] + "==="))
        assert claims["kind"] == "project.access"
        assert claims["project_id"] == "project-1"
        assert claims["host_project_id"] == "host-1"
        assert claims["access_level"] == "read"
        host = "https://d-device-1.gateway.test"
        assert client.post(f"{host}/api/remote/redeem", data={"ticket": ticket},
                           follow_redirects=False).status_code == 303
        assert client.post(f"{host}/api/remote/redeem", data={"ticket": ticket}).status_code == 409
        assert client.get(f"{host}/api/remote/session").json()["project_id"] == "project-1"
        assert client.get(f"{host}/api/remote/session").json()["host_project_id"] == "host-1"
        assert client.get(f"{host}/api/remote/session").json()["task_create"] is False
        assert client.get(f"{host}/api/remote/session").json()["can_manage_project_access"] is False
        grants = client.get(f"{host}/api/remote/project-grants")
        assert grants.status_code == 200, grants.text
        assert grants.json() == {"grants": [{"subject_type": "group", "subject_id": group_id,
                                             "subject_name": "Backend", "access_level": "read"}]}
        assert client.get(f"{host}/admin").status_code == 403
        assert client.get(f"{host}/api/health").status_code == 403
        class ProjectData:
            async def proxy_http(self, request, *, user_id, username, display_name,
                                 project_id, access_level, task_create,
                                 authorization_check, provider_ids,
                                 provider_grant_expires_at):
                await authorization_check()
                assert user_id == worker_id
                assert provider_ids == []
                assert provider_grant_expires_at > int(__import__('time').time())
                assert display_name == "Worker"
                assert project_id == "host-1"
                if request.url.path in ('/', '/tasks', '/canvas', '/assets/app.js'):
                    from fastapi.responses import HTMLResponse
                    return HTMLResponse('<main>Full WorkStep workspace</main>')
                if request.method not in ("GET", "HEAD"):
                    assert access_level == "edit"
                    assert task_create is (request.url.path in ("/api/task/create", "/api/task/copy"))
                else:
                    assert access_level == "read"
                    assert task_create is False
                return JSONResponse({"project_id": project_id})

        async def project_data(_device_id):
            return ProjectData()

        monkeypatch.setattr(app.state.control_connections, "request_data", project_data)
        for path in ('/', '/tasks?project=Project', '/canvas', '/assets/app.js'):
            workspace = client.get(f'{host}{path}')
            assert workspace.status_code == 200, workspace.text
            assert 'Full WorkStep workspace' in workspace.text
            assert 'Gateway project workspace' not in workspace.text
        assert client.get(f"{host}/api/task/list?project_id=host-1").json() == {
            "project_id": "host-1",
        }
        assert client.get(f"{host}/api/task/task-1?project_id=host-1").json() == {
            "project_id": "host-1",
        }
        assert client.get(f"{host}/api/task/task-1?project_id=host-2").status_code == 403
        assert client.get(f"{host}/api/workflow/list?project_id=host-1").status_code == 200
        assert client.get(f"{host}/api/chat-sessions?project_id=host-1").status_code == 200
        assert client.get(f"{host}/api/search/tasks?projectId=host-1").status_code == 200
        assert client.get(f"{host}/api/search/tasks").status_code == 403
        assert client.get(f"{host}/api/task/task-1/history?project_id=host-1").status_code == 200
        assert client.get(f"{host}/api/task/task-1/messages/msg-1/events?project_id=host-2").status_code == 403
        assert client.get(f"{host}/api/project/host-1/summary").json() == {
            "project_id": "host-1",
        }
        assert client.get(f"{host}/api/project/host-2/summary").status_code == 403
        assert client.get(f"{host}/api/task/list?project_id=host-2").status_code == 403
        assert client.get(f"{host}/api/fs/browse?project_id=host-1").status_code == 200
        assert client.get(f"{host}/api/fs/preview?project_id=host-1&path=README.md&absolute=true").status_code == 403
        assert client.post(f"{host}/api/fs/upload/image?project_id=host-1",
                           headers={"Origin": host}, json={"data_url": "data:image/png;base64,aA=="}).status_code == 403
        assert client.put(f"{host}/api/fs/content?project_id=host-1",
                          headers={"Origin": host}, json={"project_id": "host-1"}).status_code == 403
        assert client.post(f"{host}/api/task/task-1/chat?project_id=host-1",
                           headers={"Origin": host, "Idempotency-Key": "msg-1"},
                           json={"content": "Hello"}).status_code == 403
        remote_cookie = client.cookies.get("workstep_gateway_session", domain="d-device-1.gateway.test")
        client.cookies.clear()
        owner_login = client.post("/api/auth/login", json={
            "username": "owner", "password": "OwnerPassphrase-2026!",
        })
        owner_headers = {"X-CSRF-Token": owner_login.json()["csrf_token"]}
        assert client.delete(f"/api/groups/{group_id}/members/{worker_id}",
                             headers=owner_headers).status_code == 204
        assert client.get(f"{host}/api/remote/session", headers={
            "Cookie": f"workstep_gateway_session={remote_cookie}",
        }).status_code == 403
        assert client.get(f"{host}/api/remote/project-grants", headers={
            "Cookie": f"workstep_gateway_session={remote_cookie}",
        }).status_code == 403
        assert client.get(f"{host}/api/task/list?project_id=host-1", headers={
            "Cookie": f"workstep_gateway_session={remote_cookie}",
        }).status_code == 403
        client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"},
                    headers=owner_headers)
        assert client.post(grant_url, json={
            "subject_type": "user", "subject_id": worker_id, "access_level": "edit",
        }, headers=owner_headers).status_code == 200
        client.cookies.clear()
        client.post("/api/auth/login", json={
            "username": "worker", "password": "WorkerNewPassphrase-2026!",
        })
        editable = client.get("/api/projects").json()["projects"][0]
        assert editable["access_level"] == "edit"
        assert editable["grant_sources"] == ["直接授权"]
        edit_ticket = client.get("/api/projects/project-1/access").json()["ticket"]
        assert client.post(f"{host}/api/remote/redeem", data={"ticket": edit_ticket},
                           follow_redirects=False).status_code == 303
        edit_cookie = client.cookies.get("workstep_gateway_session", domain="d-device-1.gateway.test")
        create_url = f"{host}/api/task/create?project_id=host-1"
        edit_headers = {"Cookie": f"workstep_gateway_session={edit_cookie}", "Origin": host}
        assert client.post(create_url, headers=edit_headers, json={"title": "New task"}).status_code == 403
        copy_url = f"{host}/api/task/copy?project_id=host-1"
        assert client.post(copy_url, headers=edit_headers, json={"task_id": "task-1"}).status_code == 403
        assert client.post(f"{host}/api/task/run?project_id=host-1", headers=edit_headers,
                           json={"task_id": "task-1", "prompt": ""}).status_code == 200
        assert client.post(f"{host}/api/fs/upload/image?project_id=host-1",
                           headers=edit_headers,
                           json={"data_url": "data:image/png;base64,aA=="}).status_code == 200
        assert client.put(f"{host}/api/fs/content?project_id=host-1",
                          headers=edit_headers, json={"project_id": "host-1"}).status_code == 200
        assert client.post(f"{host}/api/task/task-1/chat?project_id=host-1",
                           headers={**edit_headers, "Idempotency-Key": "msg-1"},
                           json={"content": "Hello"}).status_code == 200
        client.cookies.clear()
        owner_login = client.post("/api/auth/login", json={
            "username": "owner", "password": "OwnerPassphrase-2026!",
        })
        owner_headers = {"X-CSRF-Token": owner_login.json()["csrf_token"]}
        client.post("/api/auth/step-up", json={"password": "OwnerPassphrase-2026!"},
                    headers=owner_headers)
        assert client.post(f"/api/admin/capabilities/{worker_id}", json={
            "capability": "task.create", "scope_type": "project",
            "scope_id": "project-1", "effect": "allow",
        }, headers=owner_headers).status_code == 200
        assert client.post(create_url, headers={
            "Cookie": f"workstep_gateway_session={edit_cookie}",
        }, json={"title": "New task"}).status_code == 200
        assert client.post(create_url, headers={
            "Cookie": f"workstep_gateway_session={edit_cookie}",
            "Origin": "https://proxy.example",
        }, json={"title": "New task"}).status_code == 200
        assert client.post(create_url, headers=edit_headers,
                           json={"title": "New task"}).status_code == 200
        assert client.post(copy_url, headers=edit_headers, json={"task_id": "task-1"}).status_code == 200
        assert client.get(f"{host}/api/remote/session", headers={
            "Cookie": f"workstep_gateway_session={edit_cookie}",
        }).json()["task_create"] is True
        assert client.get(f"{host}/api/remote/session", headers={
            "Cookie": f"workstep_gateway_session={edit_cookie}",
        }).json()["share_create"] is False
        assert client.post(f"/api/admin/capabilities/{worker_id}", json={
            "capability": "share.create", "scope_type": "project",
            "scope_id": "project-1", "effect": "allow",
        }, headers=owner_headers).status_code == 200
        assert client.get(f"{host}/api/remote/session", headers={
            "Cookie": f"workstep_gateway_session={edit_cookie}",
        }).json()["share_create"] is True
