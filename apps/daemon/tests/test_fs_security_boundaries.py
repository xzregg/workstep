"""Security boundary regressions using synthetic files and in-process HTTP."""

import asyncio
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from api.fs import router, uploads_router
from api.desktop_security import DesktopSecurityMiddleware
from api.remote_access_guard import RemoteAccessGuardMiddleware


@pytest.fixture
def filesystem_app(tmp_path, monkeypatch):
    import main
    root = tmp_path / "project"
    data = root / ".workstep"
    (data / "uploads").mkdir(parents=True)
    (data / "uploads" / "known.txt").write_text("private attachment")
    project = SimpleNamespace(id="p1", path=root, workstep_dir=data)
    monkeypatch.setattr(main, "project_manager", SimpleNamespace(
        get_project_by_id=lambda pid: project if pid == "p1" else None,
        get_project_by_name=lambda name: project if name == "demo" else None,
    ))
    monkeypatch.delenv("WORKSTEP_DESKTOP_RUNTIME", raising=False)
    app = FastAPI()
    app.include_router(router)
    app.include_router(uploads_router)
    @app.get("/api/health")
    async def health():
        return {"ok": True}
    return app, data


@pytest.mark.asyncio
async def test_root_upload_requires_desktop_auth_and_retains_original_url(filesystem_app, monkeypatch):
    app, _ = filesystem_app
    monkeypatch.setenv("WORKSTEP_DESKTOP_RUNTIME", "1")
    monkeypatch.setenv("WORKSTEP_DESKTOP_TOKEN", "synthetic-token")
    app.add_middleware(DesktopSecurityMiddleware)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://local") as client:
        anonymous = await client.get("/demo/.workstep/uploads/known.txt")
        print("PPV_REACHED", flush=True)
        assert anonymous.status_code == 401
        response = await client.get("/demo/.workstep/uploads/known.txt", headers={
            "X-WorkStep-Desktop-Token": "synthetic-token",
        })
        assert response.status_code == 200
        assert response.text == "private attachment"


@pytest.mark.asyncio
async def test_root_upload_remote_password_and_local_access(filesystem_app):
    app, _ = filesystem_app
    service = SimpleNamespace(access_password_required=lambda: True,
        verify_access_token=lambda token: token == "synthetic-access")
    app.add_middleware(RemoteAccessGuardMiddleware, access_service=service)
    path = "/demo/.workstep/uploads/known.txt"
    async with AsyncClient(transport=ASGITransport(app=app, client=("198.51.100.1", 1)), base_url="http://remote") as client:
        anonymous = await client.get(path)
        print("PPV_REACHED", flush=True)
        assert anonymous.status_code == 401
        response = await client.get(path, headers={"X-WorkStep-Access": "synthetic-access"})
        assert response.status_code == 200
        assert response.text == "private attachment"
        assert (await client.get("/api/health")).status_code == 200
    async with AsyncClient(transport=ASGITransport(app=app, client=("127.0.0.1", 1)), base_url="http://localhost") as client:
        assert (await client.get(path)).status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize("dangling", [False, True])
async def test_memory_rejects_outside_symlinks_without_disclosure_or_overwrite(filesystem_app, tmp_path, dangling):
    app, data = filesystem_app
    outside = tmp_path / "outside.txt"
    if not dangling:
        outside.write_text("outside secret")
    (data / "MEMORY.md").symlink_to(outside)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://local") as client:
        read = await client.get("/api/fs/memory?project_id=p1")
        print("PPV_REACHED", flush=True)
        assert read.status_code == 403
        assert (await client.put("/api/fs/memory?project_id=p1", json={"content": "overwrite"})).status_code == 403
    assert outside.exists() is not dangling
    if not dangling:
        assert outside.read_text() == "outside secret"


@pytest.mark.asyncio
async def test_memory_normal_behavior_and_slow_io_health(filesystem_app, monkeypatch):
    import api.fs as fs
    app, data = filesystem_app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://local") as client:
        assert (await client.get("/api/fs/memory?project_id=p1")).json()["content"] == ""
        assert (await client.put("/api/fs/memory?project_id=p1", json={"content": "正常记忆"})).status_code == 200
        assert (await client.get("/api/fs/memory?project_id=p1")).json()["content"] == "正常记忆"
        original = fs.read_memory_bytes
        started = threading.Event()
        def slow_read(path):
            started.set()
            time.sleep(.2)
            return original(path)
        monkeypatch.setattr(fs, "read_memory_bytes", slow_read)
        pending = asyncio.create_task(client.get("/api/fs/memory?project_id=p1"))
        assert await asyncio.to_thread(started.wait, 1)
        assert (await asyncio.wait_for(client.get("/api/health"), .1)).status_code == 200
        assert (await pending).json()["content"] == "正常记忆"


@pytest.mark.asyncio
async def test_upload_directory_link_cannot_escape_project(filesystem_app, tmp_path):
    app, data = filesystem_app
    outside = tmp_path / "outside-uploads"
    outside.mkdir()
    (outside / "private.txt").write_text("outside secret")
    (data / "uploads" / "known.txt").unlink()
    (data / "uploads").rmdir()
    (data / "uploads").symlink_to(outside, target_is_directory=True)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://local") as client:
        for path in ("/demo/.workstep/uploads/private.txt", "/api/fs/serve/private.txt?project_id=p1"):
            read = await client.get(path)
            print("PPV_REACHED", flush=True)
            assert read.status_code == 403
        for kind, media in (("file", "text/plain"), ("image", "image/png")):
            response = await client.post(f"/api/fs/upload/{kind}?project_id=p1", json={
                "filename": "a.txt", "data_url": f"data:{media};base64,aGVsbG8=",
            })
            assert response.status_code == 403
    assert list(outside.iterdir()) == [outside / "private.txt"]


@pytest.mark.asyncio
async def test_upload_directory_link_within_data_root_still_works(filesystem_app):
    app, data = filesystem_app
    relocated = data / "stored-uploads"
    (data / "uploads").rename(relocated)
    (data / "uploads").symlink_to(relocated, target_is_directory=True)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://local") as client:
        assert (await client.get("/demo/.workstep/uploads/known.txt")).text == "private attachment"
        uploaded = await client.post("/api/fs/upload/file?project_id=p1", json={
            "filename": "a.txt", "data_url": "data:text/plain;base64,aGVsbG8=",
        })
        assert uploaded.status_code == 200
        assert (relocated / uploaded.json()["filename"]).read_text() == "hello"


@pytest.mark.asyncio
async def test_memory_internal_alias_and_original_response_path(filesystem_app):
    app, data = filesystem_app
    target = data / "stored-memory.md"
    target.write_text("line 1\r\nline 2\r")
    (data / "MEMORY.md").symlink_to(target)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://local") as client:
        response = await client.get("/api/fs/memory?project_id=p1")
        assert response.json() == {"path": str(data / "MEMORY.md"), "content": "line 1\nline 2\n"}
        saved = await client.put("/api/fs/memory?project_id=p1", json={"content": "new memory"})
        assert saved.json() == {"path": str(data / "MEMORY.md"), "saved": True}
    assert (data / "MEMORY.md").is_symlink()
    assert target.read_text() == "new memory"
    print("memory alias preserved", flush=True)


@pytest.mark.asyncio
async def test_root_upload_managed_browser_cookie(filesystem_app, monkeypatch):
    from services.gateway_client.identity import ManagedActor, ManagedLocalSessions
    from services.gateway_client.browser_login import local_session_cookie_name
    app, _ = filesystem_app
    monkeypatch.setenv("WORKSTEP_DESKTOP_RUNTIME", "1")
    monkeypatch.setenv("WORKSTEP_DESKTOP_TOKEN", "synthetic-token")
    sessions = ManagedLocalSessions()
    token = sessions.create(ManagedActor("user", "demo", "device", "instance", 1))
    app.state.gateway_client = SimpleNamespace(managed_config=object(), local_sessions=sessions)
    app.add_middleware(DesktopSecurityMiddleware)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://local") as client:
        client.cookies.set(local_session_cookie_name(app), token)
        assert (await client.get("/demo/.workstep/uploads/known.txt")).text == "private attachment"


@pytest.mark.asyncio
async def test_root_upload_access_cookie_and_wrong_project_scope(filesystem_app):
    from services.remote_access import ACCESS_COOKIE_NAME, ActorSnapshot, actor_context
    app, _ = filesystem_app
    service = SimpleNamespace(access_password_required=lambda: True,
        verify_access_token=lambda token: token == "synthetic-access")
    app.add_middleware(RemoteAccessGuardMiddleware, access_service=service)
    async with AsyncClient(transport=ASGITransport(app=app, client=("198.51.100.1", 1)), base_url="http://remote") as client:
        client.cookies.set(ACCESS_COOKIE_NAME, "synthetic-access")
        path = "/demo/.workstep/uploads/known.txt"
        assert (await client.get(path)).text == "private attachment"
        actor = ActorSnapshot("user", "User", "device", "Device", "remote", project_id="other", access_level="read")
        with actor_context(actor):
            assert (await client.get(path)).status_code == 403


@pytest.mark.asyncio
async def test_benign_upload_and_memory_control(filesystem_app):
    app, _ = filesystem_app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://local") as client:
        response = await client.post("/api/fs/upload/file?project_id=p1", json={
            "filename": "a.txt", "data_url": "data:text/plain;base64,aGVsbG8=",
        })
        assert response.status_code == 200
        upload = await client.get(f"/api/fs/serve/{response.json()['filename']}?project_id=p1")
        assert upload.text == "hello"
        assert (await client.put("/api/fs/memory?project_id=p1", json={"content": "记忆"})).status_code == 200
        assert (await client.get("/api/fs/memory?project_id=p1")).json()["content"] == "记忆"


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["directory", "fifo"])
async def test_memory_non_regular_file_stays_empty_and_responsive(filesystem_app, kind):
    import os
    app, data = filesystem_app
    path = data / "MEMORY.md"
    if kind == "directory":
        path.mkdir()
    else:
        if not hasattr(os, "mkfifo"):
            pytest.skip("Platform has no FIFO support")
        os.mkfifo(path)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://local") as client:
        response = await asyncio.wait_for(client.get("/api/fs/memory?project_id=p1"), .2)
        assert response.status_code == 200
        assert response.json()["content"] == ""


@pytest.mark.asyncio
@pytest.mark.parametrize("authentication", ["desktop-token", "access-header", "access-cookie"])
async def test_root_upload_with_both_guards_preserves_authorized_access(
    filesystem_app, monkeypatch, authentication,
):
    from services.remote_access import ACCESS_COOKIE_NAME
    app, _ = filesystem_app
    monkeypatch.setenv("WORKSTEP_DESKTOP_RUNTIME", "1")
    monkeypatch.setenv("WORKSTEP_DESKTOP_TOKEN", "synthetic-token")
    service = SimpleNamespace(
        settings=lambda: {"enabled": True},
        access_password_required=lambda: True,
        verify_access_token=lambda token: token == "synthetic-access",
    )
    app.state.remote_access_service = service
    app.add_middleware(DesktopSecurityMiddleware)
    app.add_middleware(RemoteAccessGuardMiddleware, access_service=service)
    async with AsyncClient(
        transport=ASGITransport(app=app, client=("198.51.100.1", 1)),
        base_url="http://desktop-host",
    ) as client:
        path = "/demo/.workstep/uploads/known.txt"
        assert (await client.get(path)).status_code == 401
        headers = {}
        if authentication == "desktop-token":
            headers["X-WorkStep-Desktop-Token"] = "synthetic-token"
        elif authentication == "access-header":
            headers["X-WorkStep-Access"] = "synthetic-access"
        else:
            client.cookies.set(ACCESS_COOKIE_NAME, "synthetic-access")
        response = await client.get(path, headers=headers)
        assert response.status_code == 200, response.text
        assert response.text == "private attachment"
