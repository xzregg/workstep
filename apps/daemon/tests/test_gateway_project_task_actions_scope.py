"""A project ticket cannot cancel or pause another project's running task."""

import asyncio
import base64
import json
import threading
import time
from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from models import Task
from models.fields import utc_now
from services.gateway_client.bridge import ManagedHttpBridge
from tests.test_api_contracts import api_context
from workstep_gateway_protocol import FrameType, ProxyFrame


@pytest.mark.anyio
async def test_project_proxy_cannot_cancel_or_pause_another_projects_task(
    api_context, monkeypatch,
):
    import main

    client, tmp_path = api_context
    project_ids = []
    for name in ("visible-task", "private-task"):
        project_dir = tmp_path / name
        project_dir.mkdir()
        initialized = await client.post("/api/project/init", json={"path": str(project_dir)})
        assert initialized.status_code == 200
        project_ids.append(initialized.json()["id"])
    visible, private = project_ids

    def seed(task_id, cwd):
        now = utc_now()
        Task.create(id=task_id, title=task_id, cwd=str(cwd),
                    created_at=now, updated_at=now)

    await main.project_manager.run_db(
        visible, lambda _project: seed("visible-task-id", tmp_path / "visible-task")
    )
    await main.project_manager.run_db(
        private, lambda _project: seed("private-task-id", tmp_path / "private-task")
    )
    cancel = AsyncMock(return_value=True)
    monkeypatch.setattr(main.workflow_runtime, "cancel", cancel)
    monkeypatch.setattr(main.gateway_client, "managed_config", object())

    async def request(path, task_id, *, query_project=visible, level="edit"):
        frames = []

        async def capture(frame):
            frames.append(frame)

        bridge = ManagedHttpBridge(main.app, "project-task-action", {
            "method": "POST", "path": path, "query": f"project_id={query_project}",
            "headers": [["content-type", "application/json"]],
            "user_id": "worker", "username": "worker", "project_id": visible,
            "access_level": level,
        }, capture, "device-1")
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id="project-task-action", type=FrameType.http_request,
            payload={"phase": "body", "data": base64.b64encode(json.dumps({"task_id": task_id}).encode()).decode()}))
        await bridge.feed(ProxyFrame(stream_id="project-task-action", type=FrameType.http_request,
            payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, timeout=3)
        return frames[0].payload["status"]

    for path in ("/api/task/cancel", "/api/task/pause"):
        assert await request(path, "private-task-id") == 404
        assert await request(path, "visible-task-id", query_project=private) == 403
        assert await request(path, "visible-task-id", level="read") == 403
        assert await request(path, "visible-task-id") == 200
    assert cancel.await_count == 2

    from api import task_context

    entered = threading.Event()
    run_db = task_context._run_db

    async def slow_scope_lookup(project_id, operation):
        def delayed_operation():
            entered.set()
            time.sleep(0.7)
            return operation()

        return await run_db(project_id, delayed_operation)

    monkeypatch.setattr(task_context, "_run_db", slow_scope_lookup)
    pending = asyncio.create_task(request("/api/task/cancel", "private-task-id"))
    assert await asyncio.to_thread(entered.wait, 2)
    started = time.monotonic()
    async with AsyncClient(transport=ASGITransport(app=main.app),
                           base_url="http://test") as health_client:
        assert (await health_client.get("/api/health")).status_code == 200
    assert time.monotonic() - started < 0.5
    assert await pending == 404
