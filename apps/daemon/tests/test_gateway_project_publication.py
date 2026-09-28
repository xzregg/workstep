import asyncio
import json

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
