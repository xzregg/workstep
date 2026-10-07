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
    project = SimpleNamespace(id="owner-project", path=root)
    monkeypatch.setattr(main, "project_manager", SimpleNamespace(
        get_project_by_id=lambda project_id: project if project_id == project.id else None,
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
