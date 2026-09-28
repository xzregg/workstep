import asyncio
import base64

import httpx
import pytest
from fastapi import FastAPI, Request
from workstep_gateway_protocol import FrameType, ProxyFrame

from services.desktop_security import DesktopSecurityMiddleware
from services.gateway_client.bridge import ManagedHttpBridge
from services.remote_access import get_current_actor


@pytest.mark.asyncio
async def test_gateway_bridge_streams_body_and_attaches_remote_actor_without_blocking_health(monkeypatch):
    monkeypatch.setenv("WORKSTEP_DESKTOP_RUNTIME", "1")
    monkeypatch.setenv("WORKSTEP_DESKTOP_TOKEN", "desktop-secret")
    app = FastAPI()
    app.state.gateway_client = type("Client", (), {"managed_config": object()})()
    app.add_middleware(DesktopSecurityMiddleware)

    @app.post("/api/echo")
    async def echo(request: Request):
        actor = get_current_actor()
        return {"body": (await request.body()).decode(), "user_id": actor.actor_id,
                "source": actor.source, "device_id": request.state.managed_actor.device_id}

    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    frames = []
    async def send_frame(frame):
        frames.append(frame)

    bridge = ManagedHttpBridge(app, "stream-1", {
        "method": "POST", "path": "/api/echo", "query": "",
        "headers": [["content-type", "text/plain"], ["x-workstep-actor-name", "spoof"]],
        "user_id": "user-remote", "username": "alice",
    }, send_frame, "device-1")
    bridge.start_task()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://127.0.0.1") as client:
        health_response = await asyncio.wait_for(client.get(
            "/api/health", headers={"X-WorkStep-Desktop-Token": "desktop-secret",
                             "X-WorkStep-Actor-Name": "spoof"}), timeout=0.2)
        assert health_response.status_code == 200
    await bridge.feed(ProxyFrame(stream_id="stream-1", type=FrameType.http_request,
                                 payload={"phase": "body", "data": base64.b64encode(b"hello").decode()}))
    await bridge.feed(ProxyFrame(stream_id="stream-1", type=FrameType.http_request,
                                 payload={"phase": "end"}))
    await asyncio.wait_for(bridge._task, timeout=1)
    assert frames[0].payload["status"] == 200
    body = b"".join(base64.b64decode(frame.payload["data"])
                    for frame in frames if frame.payload.get("phase") == "body")
    assert b'"user_id":"user-remote"' in body
    assert b'"body":"hello"' in body
    assert b'"source":"managed"' in body
    assert frames[-1].payload == {"phase": "end"}
