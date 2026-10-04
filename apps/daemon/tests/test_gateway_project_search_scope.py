"""Project search cannot enumerate other tasks or reveal host paths."""

import asyncio
import base64
import json
import threading

from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
import pytest

from models import Task
from models.fields import utc_now
from services.gateway_client.bridge import ManagedHttpBridge
from services.remote_access import ActorSnapshot, actor_context
from tests.test_api_contracts import api_context
from workstep_gateway_protocol import FrameType, ProxyFrame


@pytest.mark.anyio
async def test_project_search_stays_in_ticket_project(api_context, monkeypatch):
    import api.search as search_api
    import main

    client, tmp_path = api_context
    projects = []
    for name in ("visible-search", "private-search"):
        directory = tmp_path / name
        directory.mkdir()
        response = await client.post("/api/project/init", json={"path": str(directory)})
        assert response.status_code == 200
        projects.append((response.json()["id"], directory))
    (visible, visible_dir), (private, private_dir) = projects

    def seed(task_id, cwd):
        now = utc_now()
        Task.create(id=task_id, title="Shared task", cwd=str(cwd),
                    created_at=now, updated_at=now)

    await main.project_manager.run_db(visible, lambda _: seed("visible-task", visible_dir))
    await main.project_manager.run_db(private, lambda _: seed("private-task", private_dir))
    local = await client.get("/api/search/tasks?query=Shared")
    assert local.status_code == 200
    assert local.json()["total"] == 2
    monkeypatch.setattr(main.gateway_client, "managed_config", object())

    async def request(query):
        frames = []

        async def capture(frame):
            frames.append(frame)

        bridge = ManagedHttpBridge(main.app, "project-search", {
            "method": "GET", "path": "/api/search/tasks", "query": query,
            "headers": [], "user_id": "worker", "username": "worker",
            "project_id": visible, "access_level": "read",
        }, capture, "device-1")
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id="project-search", type=FrameType.http_request,
                                     payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, timeout=3)
        raw = b"".join(base64.b64decode(frame.payload["data"])
                       for frame in frames if frame.payload.get("phase") == "body")
        return frames[0].payload["status"], json.loads(raw) if raw else None

    assert (await request("query=Shared"))[0] == 403
    assert (await request(f"projectId={private}&query=Shared"))[0] == 403
    status, results = await request(f"projectId={visible}&query=Shared")
    assert status == 200
    assert results["total"] == 1
    assert results["tasks"][0]["id"] == "visible-task"
    assert results["tasks"][0]["cwd"] == "."
    assert str(tmp_path) not in json.dumps(results)

    actor = ActorSnapshot(actor_id="worker", user_name="worker", device_id="device-1",
                          device_name="Device", source="managed", project_id=visible,
                          access_level="read")
    with actor_context(actor), pytest.raises(HTTPException) as denied:
        await search_api.search_tasks(project_id=private)
    assert denied.value.status_code == 403
    with actor_context(actor), pytest.raises(HTTPException) as denied:
        await search_api.search_tasks(project_id=None)
    assert denied.value.status_code == 403

    entered = threading.Event()
    release = threading.Event()
    original_select = Task.select

    def slow_select(*args, **kwargs):
        entered.set()
        release.wait(2)
        return original_select(*args, **kwargs)

    monkeypatch.setattr(Task, "select", slow_select)
    pending = asyncio.create_task(request(f"projectId={visible}&query=Shared"))
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
