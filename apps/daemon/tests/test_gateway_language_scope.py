"""Language selection works through the authenticated project bridge."""
import asyncio
import base64
import json

import pytest

from services.gateway_client.bridge import ManagedHttpBridge
from services.languages import LanguageManager
from tests.test_api_contracts import api_context
from tests.test_languages import package
from workstep_gateway_protocol import FrameType, ProxyFrame


@pytest.mark.anyio
async def test_project_bridge_language_catalog(api_context, monkeypatch):
    import main
    from api import languages
    client, tmp_path = api_context
    directory = tmp_path / "shared"
    directory.mkdir()
    project_id = (await client.post("/api/project/init", json={"path": str(directory)})).json()["id"]
    manager = LanguageManager(tmp_path / "languages")
    monkeypatch.setattr(languages, "manager", manager)
    await manager.register(str(package(tmp_path / "draft")))
    monkeypatch.setattr(main.gateway_client, "managed_config", object())

    async def request(path, method="GET", query=None):
        frames = []
        async def capture(frame):
            frames.append(frame)
        bridge = ManagedHttpBridge(main.app, "language", {
            "method": method, "path": path,
            "query": query if query is not None else f"project_id={project_id}",
            "headers": [], "user_id": "viewer", "username": "viewer",
            "project_id": project_id, "access_level": "read",
        }, capture, "device")
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id="language", type=FrameType.http_request,
                                     payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, 3)
        raw = b"".join(base64.b64decode(frame.payload["data"])
                       for frame in frames if frame.payload.get("phase") == "body")
        return frames[0].payload["status"], json.loads(raw)

    status, listing = await request("/api/language-packs")
    assert status == 200
    assert listing
    status, pack = await request("/api/language-packs/spanish")
    assert status == 200
    assert pack["manifest"]["native_name"] == "Español"
    assert (await request("/api/language-packs/contract"))[0] == 200
    for query in ("", "project_id=private", f"project_id={project_id}&project_id={project_id}"):
        assert (await request("/api/language-packs", query=query))[0] == 403
    for path, method in (("register", "POST"), ("import", "POST"), ("spanish", "DELETE"), ("spanish/export", "GET")):
        assert (await request("/api/language-packs/" + path, method))[0] == 403
