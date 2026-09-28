import asyncio
import json
import time
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from services.gateway_client.control import GatewayControlClient
from services.gateway_client.policy import ManagedPolicyCache


@pytest.mark.asyncio
async def test_control_project_publication_waits_for_matching_ack():
    class Socket:
        sent = None

        async def send(self, raw):
            self.sent = json.loads(raw)

    socket = Socket()
    client = GatewayControlClient("https://gateway.test", gateway_id="gateway-test",
                                  public_key_fingerprint="pin", user_id="user-1",
                                  policy_cache=ManagedPolicyCache())
    client.online = True
    client._active_socket = socket
    client._project_ack_messages = asyncio.Queue()
    client._project_ack_messages.put_nowait({
        "kind": "project_publish_ack", "version": 1,
        "device_id": "device-1", "host_project_id": "host-1",
        "project_id": "platform-1", "status": "published",
    })
    result = await client.publish_project("device-1", "host-1", "Backend", "publish")
    assert result["project_id"] == "platform-1"
    assert socket.sent == {"kind": "project_publish", "version": 1,
                           "action": "publish", "host_project_id": "host-1",
                           "name": "Backend"}


@pytest.mark.asyncio
async def test_control_project_catalog_sends_only_ids_and_names(monkeypatch):
    from services.project import project_manager

    class Socket:
        sent = None

        async def send(self, raw):
            self.sent = json.loads(raw)

    monkeypatch.setattr(project_manager, "list_project_catalog", lambda: [
        {"id": "host-1", "name": "Backend", "path": "/private/project"},
    ])
    socket = Socket()
    client = GatewayControlClient("https://gateway.test", gateway_id="gateway-test",
                                  public_key_fingerprint="pin", user_id="user-1",
                                  policy_cache=ManagedPolicyCache())
    await client._send_project_catalog(socket, "device-1", "a" * 32)
    assert socket.sent == {"kind": "project_catalog_response", "version": 1,
                           "device_id": "device-1", "request_id": "a" * 32,
                           "status": "ok", "projects": [{"id": "host-1", "name": "Backend"}]}


@pytest.mark.asyncio
async def test_slow_project_catalog_does_not_block_control_loop(monkeypatch):
    from services.project import project_manager

    class Socket:
        async def send(self, _raw):
            pass

    def slow_catalog():
        time.sleep(0.2)
        return []

    monkeypatch.setattr(project_manager, "list_project_catalog", slow_catalog)
    client = GatewayControlClient("https://gateway.test", gateway_id="gateway-test",
                                  public_key_fingerprint="pin", user_id="user-1",
                                  policy_cache=ManagedPolicyCache())
    pending = asyncio.create_task(client._send_project_catalog(Socket(), "device-1", "a" * 32))
    await asyncio.wait_for(asyncio.sleep(0.02), timeout=0.1)
    assert not pending.done()
    await pending


@pytest.mark.asyncio
async def test_project_runtime_counts_running_tasks_without_blocking_loop(tmp_path, monkeypatch):
    from models import Task
    from services.project import ProjectManager
    import services.project as project_module

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    now = datetime.now(timezone.utc)
    await manager.run_db(project.id, lambda _project: [Task.create(
        id=f"task-{status}", title=status, cwd=str(project.path),
        status=status, created_at=now, updated_at=now,
    ) for status in ("running", "queued")])
    monkeypatch.setattr(project_module, "project_manager", manager)
    original_run_db = manager.run_db

    async def slow_run_db(project_id, operation):
        def slow_operation(project):
            time.sleep(0.2)
            return operation(project)
        return await original_run_db(project_id, slow_operation)

    monkeypatch.setattr(manager, "run_db", slow_run_db)

    class Socket:
        sent = None

        async def send(self, raw):
            self.sent = json.loads(raw)

    socket = Socket()
    client = GatewayControlClient("https://gateway.test", gateway_id="gateway-test",
                                  public_key_fingerprint="pin", user_id="user-1",
                                  policy_cache=ManagedPolicyCache())
    try:
        pending = asyncio.create_task(client._send_project_runtime(socket, "device-1"))
        await asyncio.wait_for(asyncio.sleep(0.02), timeout=0.1)
        assert not pending.done()
        await pending
        assert socket.sent == {"kind": "project_runtime", "version": 1,
                               "device_id": "device-1", "projects": [
                                   {"id": project.id, "running_tasks": 1},
                               ]}
    finally:
        manager.close_all()


@pytest.mark.asyncio
async def test_project_publication_api_maps_gateway_results(monkeypatch):
    import api.project as project_api
    import main

    called = []

    async def publish(project_id, *, published):
        called.append((project_id, published))
        return {"project_id": "platform-1", "status": "published"}

    monkeypatch.setattr(main.gateway_client, "publish_project", publish)
    app = FastAPI()
    app.include_router(project_api.router)
    async with AsyncClient(transport=ASGITransport(app=app),
                           base_url="http://test") as client:
        response = await client.post("/api/project/host-1/publication", json={
            "published": True,
        })
        assert response.status_code == 200
        assert response.json()["project_id"] == "platform-1"
        assert called == [("host-1", True)]

        async def denied(_project_id, *, published):
            raise PermissionError("Managed capability denied: project.publish")

        monkeypatch.setattr(main.gateway_client, "publish_project", denied)
        assert (await client.post("/api/project/host-1/publication", json={
            "published": True,
        })).status_code == 403
