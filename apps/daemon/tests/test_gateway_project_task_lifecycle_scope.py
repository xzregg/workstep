"""Project-only tickets restrict task lifecycle writes and task copies."""

import asyncio
import base64
import json
import threading
import time

import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient

from models import Task
from models.fields import utc_now
from services.gateway_client.bridge import ManagedHttpBridge
from services.remote_access import ActorSnapshot, actor_context
from tests.test_api_contracts import api_context
from workstep_gateway_protocol import FrameType, ProxyFrame


@pytest.mark.anyio
async def test_project_proxy_task_archive_delete_and_copy_require_scope_and_capability(
    api_context, monkeypatch,
):
    import main

    client, tmp_path = api_context
    projects = []
    for name in ("visible-lifecycle", "private-lifecycle"):
        directory = tmp_path / name
        directory.mkdir()
        initialized = await client.post("/api/project/init", json={"path": str(directory)})
        assert initialized.status_code == 200
        projects.append((initialized.json()["id"], directory))
    (visible, visible_dir), (private, private_dir) = projects

    def seed(task_id, cwd):
        now = utc_now()
        Task.create(id=task_id, title=task_id, cwd=str(cwd),
                    created_at=now, updated_at=now)

    await main.project_manager.run_db(
        visible, lambda _project: seed("archive-task", visible_dir)
    )
    await main.project_manager.run_db(
        visible, lambda _project: seed("copy-source", private_dir)
    )
    await main.project_manager.run_db(
        private, lambda _project: seed("private-task", private_dir)
    )
    monkeypatch.setattr(main.gateway_client, "managed_config", object())

    async def request(method, path, body, *, query_project=visible,
                      level="edit", task_create=False):
        frames = []

        async def capture(frame):
            frames.append(frame)

        bridge = ManagedHttpBridge(main.app, "project-lifecycle", {
            "method": method, "path": path, "query": f"project_id={query_project}",
            "headers": [["content-type", "application/json"]],
            "user_id": "worker", "username": "worker", "project_id": visible,
            "access_level": level, "task_create": task_create,
        }, capture, "device-1")
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id="project-lifecycle", type=FrameType.http_request,
            payload={"phase": "body", "data": base64.b64encode(json.dumps(body).encode()).decode()}))
        await bridge.feed(ProxyFrame(stream_id="project-lifecycle", type=FrameType.http_request,
            payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, timeout=3)
        raw = b"".join(base64.b64decode(frame.payload["data"])
                       for frame in frames if frame.payload.get("phase") == "body")
        return frames[0].payload["status"], json.loads(raw) if raw else None

    for path, method in (("/api/task/archive", "POST"),
                         ("/api/task/unarchive", "POST"),
                         ("/api/task/delete", "DELETE")):
        assert (await request(method, path, {"task_id": "archive-task"}, level="read"))[0] == 403
        assert (await request(method, path, {"task_id": "archive-task"},
                              query_project=private))[0] == 403
        assert (await request(method, path, {"task_id": "private-task"}))[0] == 404
    assert (await request("POST", "/api/task/archive", {"task_id": "archive-task"}))[0] == 200
    assert (await request("POST", "/api/task/unarchive", {"task_id": "archive-task"}))[0] == 200
    assert (await request("DELETE", "/api/task/delete", {"task_id": "archive-task"}))[0] == 200

    copy_path = "/api/task/copy"
    copy_body = {"task_id": "copy-source", "newTitle": "Copied"}
    assert (await request("POST", copy_path, copy_body))[0] == 403
    assert (await request("POST", copy_path, copy_body,
                          level="read", task_create=True))[0] == 403
    assert (await request("POST", copy_path, copy_body,
                          query_project=private, task_create=True))[0] == 403
    assert (await request("POST", copy_path, {"task_id": "private-task", "newTitle": "Escape"},
                          task_create=True))[0] == 404
    code, copied = await request("POST", copy_path, copy_body, task_create=True)
    assert code == 200 and copied["title"] == "Copied"
    assert copied["cwd"] == str(visible_dir)

    from api.task import CopyTaskRequest, copy_task

    actor = ActorSnapshot(actor_id="worker", user_name="worker", device_id="device-1",
                          device_name="Device", source="managed", project_id=visible,
                          access_level="edit", remote_task_create=False)
    with actor_context(actor), pytest.raises(HTTPException) as denied:
        await copy_task(CopyTaskRequest(**copy_body), pid=visible)
    assert denied.value.status_code == 403


@pytest.mark.anyio
async def test_task_copy_slow_local_identity_lookup_does_not_block_health(
    api_context, monkeypatch,
):
    import main
    from services.config import config_store

    client, tmp_path = api_context
    project_dir = tmp_path / "copy-identity-canary"
    project_dir.mkdir()
    initialized = await client.post("/api/project/init", json={"path": str(project_dir)})
    assert initialized.status_code == 200
    project_id = initialized.json()["id"]

    def seed(_project):
        now = utc_now()
        Task.create(id="copy-canary-source", title="Source", cwd=str(project_dir),
                    created_at=now, updated_at=now)

    await main.project_manager.run_db(project_id, seed)
    entered = threading.Event()

    def slow_user_name():
        entered.set()
        time.sleep(0.7)
        return ""

    monkeypatch.setattr(config_store, "get_user_name", slow_user_name)
    started = time.monotonic()
    pending = asyncio.create_task(client.post(
        f"/api/task/copy?project_id={project_id}",
        json={"task_id": "copy-canary-source", "newTitle": "Copied"},
    ))
    assert await asyncio.to_thread(entered.wait, 2)
    async with AsyncClient(transport=ASGITransport(app=main.app),
                           base_url="http://test") as health_client:
        assert (await health_client.get("/api/health")).status_code == 200
    assert time.monotonic() - started < 0.5
    assert (await pending).status_code == 200
