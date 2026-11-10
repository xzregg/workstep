"""Project file routes expose project-relative paths and enforce ticket scope."""

import asyncio
import base64
import json
import threading

from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
import pytest

from api.fs_paths import _resolve_project_file
from services.gateway_client.bridge import ManagedHttpBridge
from services.remote_access import ActorSnapshot, actor_context
from tests.test_api_contracts import api_context
from workstep_gateway_protocol import FrameType, ProxyFrame


@pytest.mark.anyio
async def test_project_file_routes_hide_host_paths_and_reject_direct_scope_escape(
    api_context, monkeypatch,
):
    import api.fs as fs_api
    import main

    client, tmp_path = api_context
    projects = []
    for name in ("visible-files", "private-files"):
        directory = tmp_path / name
        directory.mkdir()
        response = await client.post("/api/project/init", json={"path": str(directory)})
        assert response.status_code == 200
        projects.append((response.json()["id"], directory))
    (visible, visible_dir), (private, private_dir) = projects
    (visible_dir / "docs").mkdir()
    (visible_dir / "docs" / "readme.md").write_text("visible")
    (private_dir / "secret.md").write_text("private")
    (private_dir / ".workstep" / "uploads").mkdir(exist_ok=True)
    (private_dir / ".workstep" / "uploads" / "secret.png").write_bytes(b"private")
    monkeypatch.setattr(main.gateway_client, "managed_config", object())

    async def request(path, query, *, method="GET", level="read", body=None):
        frames = []

        async def capture(frame):
            frames.append(frame)

        bridge = ManagedHttpBridge(main.app, "project-files", {
            "method": method, "path": path, "query": query,
            "headers": [["content-type", "application/json"]] if body is not None else [],
            "user_id": "worker", "username": "worker",
            "project_id": visible, "access_level": level,
        }, capture, "device-1")
        bridge.start_task()
        if body is not None:
            await bridge.feed(ProxyFrame(
                stream_id="project-files", type=FrameType.http_request,
                payload={"phase": "body", "data": base64.b64encode(json.dumps(body).encode()).decode()},
            ))
        await bridge.feed(ProxyFrame(stream_id="project-files", type=FrameType.http_request,
                                     payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, timeout=3)
        raw = b"".join(base64.b64decode(frame.payload["data"])
                       for frame in frames if frame.payload.get("phase") == "body")
        return frames[0].payload["status"], json.loads(raw) if raw else None

    status, listing = await request("/api/fs/browse", f"project_id={visible}")
    assert status == 200
    assert listing["path"] == ""
    assert listing["entries"][0]["path"] == "docs"
    assert str(visible_dir) not in json.dumps(listing)

    status, found = await request("/api/fs/search", f"project_id={visible}&query=readme")
    assert status == 200
    assert found["entries"][0]["path"] == "docs/readme.md"
    assert str(visible_dir) not in json.dumps(found)

    status, created = await request(
        "/api/fs/entry", f"project_id={visible}", method="POST", level="edit",
        body={"project_id": visible, "parent": "docs", "root": "", "name": "new.txt", "kind": "file"},
    )
    assert status == 200 and created["path"] == "docs/new.txt"
    status, renamed = await request(
        "/api/fs/entry", f"project_id={visible}", method="PATCH", level="edit",
        body={"project_id": visible, "path": "docs/new.txt", "root": "", "name": "renamed.txt"},
    )
    assert status == 200 and renamed["path"] == "docs/renamed.txt"

    for path, query in (
        ("/api/fs/browse", f"project_id={visible}&path=missing"),
        ("/api/fs/preview", f"project_id={visible}&path=missing"),
        ("/api/fs/file", f"project_id={visible}&path=missing"),
        (f"/api/fs/project-raw/{visible}/missing", f"project_id={visible}"),
    ):
        status, body = await request(path, query)
        assert status == 404
        assert str(visible_dir) not in json.dumps(body)

    import api.fs_browser as fs_browser

    entered = threading.Event()
    release = threading.Event()
    original_resolve = fs_browser._resolve_browse_directory

    def slow_browse(*args):
        entered.set()
        release.wait(2)
        return original_resolve(*args)

    monkeypatch.setattr(fs_browser, "_resolve_browse_directory", slow_browse)
    pending = asyncio.create_task(request("/api/fs/browse", f"project_id={visible}"))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        async with AsyncClient(transport=ASGITransport(app=main.app),
                               base_url="http://test") as health_client:
            health = await asyncio.wait_for(health_client.get("/api/health"), timeout=0.2)
        assert health.status_code == 200
    finally:
        release.set()
        status, _ = await pending
    assert status == 200

    actor = ActorSnapshot(actor_id="worker", user_name="worker", device_id="device-1",
                          device_name="Device", source="managed", project_id=visible,
                          access_level="read")
    with actor_context(actor):
        for project_id, allow_absolute in ((visible, True), (None, False), (private, False)):
            with pytest.raises(HTTPException) as denied:
                _resolve_project_file(str(private_dir / "secret.md"), project_id,
                                      allow_absolute=allow_absolute)
            assert denied.value.status_code == 403
        with pytest.raises(HTTPException) as denied:
            await fs_api.serve_upload_by_project_name(private_dir.name, "secret.png")
        assert denied.value.status_code == 403
        with pytest.raises(HTTPException) as denied:
            await fs_api.serve_upload("secret.png", pid="")
        assert denied.value.status_code == 403


    status, saved = await request(
        "/api/fs/memory", f"project_id={visible}", method="PUT", level="edit",
        body={"content": "平台项目记忆"},
    )
    assert status == 200, saved
    status, memory = await request("/api/fs/memory", f"project_id={visible}")
    assert status == 200
    assert memory["content"] == "平台项目记忆"
    status, uploaded = await request(
        "/api/fs/upload/file", f"project_id={visible}", method="POST", level="edit",
        body={"filename": "note.txt", "data_url": "data:text/plain;base64,aGVsbG8="},
    )
    assert status == 200, uploaded
    assert (visible_dir / ".workstep" / "uploads" / uploaded["filename"]).read_bytes() == b"hello"


@pytest.mark.anyio
async def test_markdown_absolute_project_image_delivery(api_context, monkeypatch):
    from urllib.parse import urlencode
    import main
    client, tmp_path = api_context
    directory = tmp_path / "三国塔防小程序"
    directory.mkdir()
    project_id = (await client.post('/api/project/init', json={'path': str(directory)})).json()['id']
    image = directory / 'research' / 'Thronefall' / '1.png'
    image.parent.mkdir(parents=True)
    content = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=')
    image.write_bytes(content)
    private = tmp_path / 'private.png'
    private.write_bytes(content)
    (directory / 'escape.png').symlink_to(private)
    query = {'project_id': project_id, 'path': str(image)}
    local = await client.get('/api/fs/file', params=query)
    assert local.status_code == 200
    assert local.content == content
    assert local.headers['content-type'].startswith('image/png')
    monkeypatch.setattr(main.gateway_client, 'managed_config', object())
    async def request(path):
        frames = []
        async def capture(frame): frames.append(frame)
        bridge = ManagedHttpBridge(main.app, 'image', {
            'method':'GET', 'path':'/api/fs/file',
            'query':urlencode({'project_id':project_id, 'path':str(path)}),
            'headers':[], 'user_id':'viewer', 'username':'viewer',
            'project_id':project_id, 'access_level':'read',
        }, capture, 'device')
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id='image', type=FrameType.http_request, payload={'phase':'end'}))
        await asyncio.wait_for(bridge._task, 3)
        raw = b''.join(base64.b64decode(frame.payload['data']) for frame in frames if frame.payload.get('phase') == 'body')
        return frames[0].payload['status'], raw
    for path in (image, 'research/Thronefall/1.png'):
        assert await request(path) == (200, content)
    for path in (private, directory / 'escape.png', '../private.png'):
        assert (await request(path))[0] == 403
