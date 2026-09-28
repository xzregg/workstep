"""The managed share route is task scoped and keeps Peewee off the event loop."""

import asyncio
import base64
import json
import threading
import time

import pytest

from services.gateway_client.bridge import ManagedHttpBridge
from tests.test_api_contracts import _create_test_workflow, api_context
from tests.test_gateway_share_ticket import _ticket
from workstep_gateway_protocol import FrameType, ProxyFrame


@pytest.mark.anyio
async def test_platform_share_task_read_scope_and_slow_db_health(api_context, monkeypatch):
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "shared-task"
    project_dir.mkdir()
    project_id = (await client.post("/api/project/init", json={
        "path": str(project_dir),
    })).json()["id"]
    workflow_id = (await _create_test_workflow(client, project_id))["id"]
    created = await client.post(f"/api/task/create?project_id={project_id}", json={
        "title": "Visible title", "description": "Visible description",
        "workflow_id": workflow_id, "auto_start": False,
    })
    assert created.status_code == 200, created.text
    task_id = created.json()["id"]
    monkeypatch.setattr(main.gateway_client, "managed_config", object())
    ticket, key, fingerprint = _ticket(task_id=task_id,
                                       host_project_id=project_id)

    entered = threading.Event()
    project = main.project_manager.get_project_by_id(project_id)
    original_execute = project.db.execute_sql

    def slow_execute(sql, *args, **kwargs):
        if sql.lstrip().upper().startswith("SELECT") and '"tasks"' in sql:
            entered.set()
            time.sleep(0.7)
        return original_execute(sql, *args, **kwargs)

    monkeypatch.setattr(project.db, "execute_sql", slow_execute)

    async def request_share(credential):
        frames = []

        async def capture(frame):
            frames.append(frame)

        bridge = ManagedHttpBridge(main.app, "share-task", {
            "method": "GET", "path": "/api/platform-share/task", "query": "",
            "headers": [], "share_ticket": credential,
        }, capture, "device-1", gateway_key=key,
            gateway_fingerprint=fingerprint, gateway_id="gateway-1")
        bridge.start_task()
        await bridge.feed(ProxyFrame(
            stream_id="share-task", type=FrameType.http_request,
            payload={"phase": "end"},
        ))
        await asyncio.wait_for(bridge._task, timeout=3)
        body = b"".join(base64.b64decode(frame.payload["data"])
                        for frame in frames if frame.payload.get("phase") == "body")
        return frames[0].payload["status"], json.loads(body) if body else None

    pending = asyncio.create_task(request_share(ticket))
    assert await asyncio.to_thread(entered.wait, 2)
    started = time.monotonic()
    health = await client.get("/api/health")
    assert health.status_code == 200
    assert time.monotonic() - started < 0.5
    status, body = await pending
    assert status == 200
    assert body["id"] == task_id
    assert body["title"] == "Visible title"
    assert body["description"] == "Visible description"
    assert "cwd" not in body
    assert "engine" not in body


@pytest.mark.anyio
async def test_platform_share_history_excludes_private_channel_and_slow_sql(api_context, monkeypatch):
    import main
    from models import Message
    from models.fields import utc_now

    client, tmp_path = api_context
    project_dir = tmp_path / "shared-history"
    project_dir.mkdir()
    project_id = (await client.post("/api/project/init", json={
        "path": str(project_dir),
    })).json()["id"]
    workflow_id = (await _create_test_workflow(client, project_id))["id"]
    created = await client.post(f"/api/task/create?project_id={project_id}", json={
        "title": "Shared history", "workflow_id": workflow_id, "auto_start": False,
    })
    assert created.status_code == 200
    task_id = created.json()["id"]

    def seed(_project):
        for index, channel, content in ((1, "execution", "Visible message"),
                                        (2, "coordinator", "Private planning")):
            Message.create(id=f"message-{index}", task=task_id, step_key="step-1",
                           channel=channel, sequence=index, position=index,
                           role="assistant", content=content, created_at=utc_now())

    await main.project_manager.run_db(project_id, seed)
    monkeypatch.setattr(main.gateway_client, "managed_config", object())
    ticket, key, fingerprint = _ticket(task_id=task_id, host_project_id=project_id)
    project = main.project_manager.get_project_by_id(project_id)
    original_execute = project.db.execute_sql
    entered = threading.Event()

    def slow_execute(sql, *args, **kwargs):
        if sql.lstrip().upper().startswith("SELECT") and '"message"' in sql:
            entered.set()
            time.sleep(0.7)
        return original_execute(sql, *args, **kwargs)

    monkeypatch.setattr(project.db, "execute_sql", slow_execute)

    async def read_history():
        frames = []

        async def capture(frame):
            frames.append(frame)

        bridge = ManagedHttpBridge(main.app, "share-history", {
            "method": "GET", "path": "/api/platform-share/history", "query": "",
            "headers": [], "share_ticket": ticket,
        }, capture, "device-1", gateway_key=key,
            gateway_fingerprint=fingerprint, gateway_id="gateway-1")
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id="share-history", type=FrameType.http_request,
                                     payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, timeout=3)
        body = b"".join(base64.b64decode(frame.payload["data"])
                        for frame in frames if frame.payload.get("phase") == "body")
        return frames[0].payload["status"], json.loads(body) if body else None

    pending = asyncio.create_task(read_history())
    assert await asyncio.to_thread(entered.wait, 2)
    started = time.monotonic()
    assert (await client.get("/api/health")).status_code == 200
    assert time.monotonic() - started < 0.5
    status, body = await pending
    assert status == 200
    assert [item["content"] for item in body["messages"]] == ["Visible message"]
    assert "Private planning" not in json.dumps(body)
