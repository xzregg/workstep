"""Remote HTML previews use the real file routes and retain project scope."""

import asyncio
import threading
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

import api.fs as fs_api
import main
from api.remote_project_proxy import RemoteProjectProxyMiddleware
from services.remote_access import ActorSnapshot, RemotePrincipal
from services.remote_registry import RemoteProjectRegistry
from streaming.remote_host import RemoteRouteDispatcher
from tests.test_remote_project import MemoryConfig


@pytest.fixture
async def remote_files(tmp_path, monkeypatch):
    root = tmp_path / "project"
    from services.project import ProjectManager
    manager = ProjectManager()
    registered = await asyncio.to_thread(manager.init_project, root)
    site = root / ".workstep/artifacts/task/ui/2"
    site.mkdir(parents=True)
    (site / "UI 设计稿.html").write_text(
        '<link rel="stylesheet" href="./theme.css">'
        '<script src="./app.js"></script><img src="./image.svg"><h1>预览</h1>'
    )
    (site / "theme.css").write_text("h1 { color: blue; }")
    (site / "app.js").write_text("document.title = '预览';")
    (site / "image.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
    outside = tmp_path / "secret.html"
    outside.write_text("private")
    (site / "escape.html").symlink_to(outside)
    project = SimpleNamespace(id="owner-project", path=root, workstep_dir=root / '.workstep', db=registered.db)

    async def run_db(project_id, operation):
        assert project_id == project.id
        return await manager.run_db(registered.id, lambda _project: operation(project))

    monkeypatch.setattr(main, "project_manager", SimpleNamespace(
        get_project_by_id=lambda project_id: project if project_id == project.id else None,
        run_db=run_db,
    ))
    host = FastAPI()
    host.include_router(fs_api.router)
    dispatcher = RemoteRouteDispatcher(host)
    principal = RemotePrincipal(
        project_id=project.id,
        actor=ActorSnapshot("device", "用户", "device", "手机", "remote"),
    )

    class Manager:
        async def request(self, project_id, request):
            assert project_id == "remote:abc"
            return await dispatcher.dispatch(request, principal)

    config = MemoryConfig()
    config.set("remote_projects", [{"id": "remote:abc", "name": "demo"}])
    client_app = FastAPI()
    client_app.add_middleware(
        RemoteProjectProxyMiddleware,
        registry=RemoteProjectRegistry(config),
        client_manager=Manager(),
    )

    @client_app.get("/api/health")
    async def health():
        return {"ok": True}

    try:
        async with AsyncClient(
            transport=ASGITransport(app=client_app), base_url="http://client",
        ) as client:
            yield client, root, outside
    finally:
        await dispatcher.aclose()
        await asyncio.to_thread(manager.close_all)


@pytest.mark.parametrize("query", ["?project_id=remote%3Aabc", ""])
async def test_remote_html_preview_and_relative_assets(remote_files, query):
    client, _, _ = remote_files
    base = "/api/fs/project-raw/remote%3Aabc/.workstep/artifacts/task/ui/2/"
    for filename, content_type, content in (
        ("UI%20设计稿.html", "text/html", "<h1>预览</h1>"),
        ("theme.css", "text/css", "h1 { color: blue; }"),
        ("app.js", "text/javascript", "document.title = '预览';"),
        ("image.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"/>'),
    ):
        response = await client.get(base + filename + query)
        assert response.status_code == 200, response.text
        assert response.headers["content-type"].startswith(content_type)
        assert content in response.text


async def test_remote_raw_files_bind_authenticated_project_and_reject_escape(remote_files):
    client, root, outside = remote_files
    base = "/api/fs/project-raw/forged-project/"
    query = {"project_id": "remote:abc"}
    valid = await client.get(base + ".workstep/artifacts/task/ui/2/theme.css", params=query)
    assert valid.status_code == 200
    missing = await client.get(base + "docs/missing.html", params=query)
    assert missing.status_code == 404
    symlink = await client.get(base + ".workstep/artifacts/task/ui/2/escape.html", params=query)
    assert symlink.status_code == 403
    raw = await client.get(
        "/api/fs/raw/" + str(root / ".workstep/artifacts/task/ui/2/theme.css").lstrip("/"),
        params=query,
    )
    assert raw.status_code == 200
    escaped = await client.get("/api/fs/raw/" + str(outside).lstrip("/"), params=query)
    assert escaped.status_code == 403


async def test_remote_preview_ticket_and_security_headers_survive_both_dispatchers(remote_files):
    client, _, _ = remote_files
    preview = await client.get('/api/fs/preview', params={
        'project_id': 'remote:abc', 'path': '.workstep/artifacts/task/ui/2/UI 设计稿.html',
    })
    assert preview.status_code == 200, preview.text
    grant = preview.json()['html_preview']
    prefix = f"/api/fs/html-resource/remote%3Aabc/{grant['token']}/"
    for filename in ('UI%20设计稿.html', 'theme.css', 'app.js', 'image.svg'):
        response = await client.get(prefix + filename)
        assert response.status_code == 200, response.text
        assert 'sandbox allow-scripts' in response.headers['content-security-policy']
        assert 'allow-same-origin' not in response.headers['content-security-policy']
        assert response.headers['access-control-allow-origin'] == 'null'
        assert response.headers['cache-control'] == 'no-store'
        assert 'workstep.internal' not in response.headers['content-security-policy']
        assert 'connect-src http://client/api/fs/html-resource/' in response.headers['content-security-policy']
    assert (await client.get(prefix + 'escape.html')).status_code == 403


async def test_remote_html_slow_file_resolution_keeps_health_responsive(remote_files, monkeypatch):
    client, _, _ = remote_files
    started = threading.Event()
    release = threading.Event()
    resolve = fs_api._resolve_project_file

    def slow_resolve(*args, **kwargs):
        started.set()
        assert release.wait(2)
        return resolve(*args, **kwargs)

    monkeypatch.setattr(fs_api, "_resolve_project_file", slow_resolve)
    pending = asyncio.create_task(client.get(
        "/api/fs/project-raw/remote%3Aabc/.workstep/artifacts/task/ui/2/UI%20设计稿.html",
    ))
    try:
        assert await asyncio.to_thread(started.wait, 1)
        health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
        assert health.status_code == 200
        assert not pending.done()
    finally:
        release.set()
        response = await pending
    assert response.status_code == 200


@pytest.mark.parametrize("detached_storage", [False, True], ids=["project-data", "detached-data"])
async def test_remote_upload_and_memory_round_trip_preserves_storage_mode(
    remote_files, detached_storage,
):
    client, root, _ = remote_files
    project = main.project_manager.get_project_by_id("owner-project")
    if detached_storage:
        detached = root.parent / "project-data"
        project.workstep_dir.rename(detached)
        project.workstep_dir = detached
        await asyncio.to_thread(project.db.init, str(detached / "workstep.db"))
    query = {"project_id": "remote:abc"}
    for kind, media, filename in (
        ("file", "text/plain", "notes.txt"),
        ("image", "image/png", "screen.png"),
    ):
        uploaded = await client.post(f"/api/fs/upload/{kind}", params=query, json={
            "filename": filename, "data_url": f"data:{media};base64,aGVsbG8=",
        })
        assert uploaded.status_code == 200, uploaded.text
        data = uploaded.json()
        assert data["url"] == f".workstep/uploads/{data['filename']}"
        served = await client.get(f"/api/fs/serve/{data['filename']}", params=query)
        assert served.status_code == 200, served.text
        assert served.content == b"hello"
        assert (project.workstep_dir / "uploads" / data["filename"]).read_bytes() == b"hello"
    assert (await client.get("/api/fs/memory", params=query)).json()["content"] == ""
    saved = await client.put("/api/fs/memory", params=query, json={"content": "远程项目记忆"})
    assert saved.status_code == 200, saved.text
    assert (await client.get("/api/fs/memory", params=query)).json()["content"] == "远程项目记忆"
    assert (project.workstep_dir / "MEMORY.md").read_text() == "远程项目记忆"
