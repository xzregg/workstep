"""The managed share route is task scoped and keeps Peewee off the event loop."""

import asyncio
import base64
import hashlib
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


@pytest.mark.anyio
async def test_platform_share_artifacts_are_task_scoped_and_hide_host_paths(api_context, monkeypatch):
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "shared-artifacts"
    project_dir.mkdir()
    project_id = (await client.post("/api/project/init", json={
        "path": str(project_dir),
    })).json()["id"]
    workflow_id = (await _create_test_workflow(client, project_id))["id"]
    task_ids = []
    for title in ("Shared", "Private"):
        created = await client.post(f"/api/task/create?project_id={project_id}", json={
            "title": title, "workflow_id": workflow_id, "auto_start": False,
        })
        task_ids.append(created.json()["id"])
    root = project_dir / ".workstep" / "artifacts" / workflow_id
    for task_id, content in zip(task_ids, ("visible bytes", "private bytes")):
        directory = root / task_id / "build"
        directory.mkdir(parents=True)
        (directory / "result.txt").write_text(content)
    monkeypatch.setattr(main.gateway_client, "managed_config", object())
    ticket, key, fingerprint = _ticket(task_id=task_ids[0], host_project_id=project_id)

    async def read(path, credential=ticket):
        frames = []
        async def capture(frame):
            frames.append(frame)
        bridge = ManagedHttpBridge(main.app, "share-artifacts", {
            "method": "GET", "path": path, "query": "", "headers": [],
            "share_ticket": credential,
        }, capture, "device-1", gateway_key=key,
            gateway_fingerprint=fingerprint, gateway_id="gateway-1")
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id="share-artifacts", type=FrameType.http_request,
                                     payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, timeout=3)
        body = b"".join(base64.b64decode(frame.payload["data"])
                        for frame in frames if frame.payload.get("phase") == "body")
        return frames[0].payload["status"], body

    status, body = await read("/api/platform-share/artifacts")
    assert status == 200
    assert str(project_dir).encode() not in body
    artifacts = json.loads(body)["artifacts"]
    assert len(artifacts) == 1
    artifact_id = artifacts[0]["id"]
    assert artifacts[0]["name"] == "result.txt"
    status, body = await read(f"/api/platform-share/artifacts/{artifact_id}/content")
    assert status == 200 and body == b"visible bytes"
    private_relative = f"{workflow_id}/{task_ids[1]}/build/result.txt"
    private_id = hashlib.sha256(private_relative.encode()).hexdigest()
    assert (await read(f"/api/platform-share/artifacts/{private_id}/content"))[0] == 404
    assert (await read("/api/platform-share/artifacts", ticket + "x"))[0] != 200

    from services import artifacts as artifact_service
    original_list = artifact_service.list_task_artifacts
    entered = threading.Event()

    def slow_list(project, task_id):
        entered.set()
        time.sleep(0.7)
        return original_list(project, task_id)

    monkeypatch.setattr(artifact_service, "list_task_artifacts", slow_list)
    pending = asyncio.create_task(read("/api/platform-share/artifacts"))
    assert await asyncio.to_thread(entered.wait, 2)
    started = time.monotonic()
    assert (await client.get("/api/health")).status_code == 200
    assert time.monotonic() - started < 0.5
    assert (await pending)[0] == 200
