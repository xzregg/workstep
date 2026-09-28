import asyncio
import json

import pytest
import httpx
from fastapi import FastAPI

from api.managed import router as managed_router
from services.desktop_security import DesktopSecurityMiddleware
from services.gateway_client import GatewayClientService
from services.gateway_client.identity import ManagedActor
from types import SimpleNamespace

from services.gateway_client.control import GatewayControlClient, control_url


def test_control_url_is_fixed_to_managed_gateway():
    assert control_url("https://gateway.example") == "wss://gateway.example/api/control/ws"


@pytest.mark.asyncio
async def test_control_client_handshake_heartbeat_and_shutdown():
    sent = []
    heartbeat = asyncio.Event()

    class Socket:
        def __init__(self):
            self.messages = asyncio.Queue()
            self.messages.put_nowait(json.dumps({"kind": "hello", "version": 1, "device_id": "device-1"}))

        async def send(self, value):
            message = json.loads(value)
            sent.append(message)
            if message.get("kind") == "heartbeat":
                heartbeat.set()
                self.messages.put_nowait(json.dumps({"kind": "heartbeat_ack", "version": 1,
                                                    "device_id": "device-1"}))

        async def recv(self):
            return await self.messages.get()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

    urls = []

    def connect(url, **kwargs):
        urls.append((url, kwargs))
        return Socket()

    client = GatewayControlClient("https://gateway.example", connector=connect,
                                  heartbeat_seconds=0.01)
    client.start("authorization", "proof", "device-1")
    await asyncio.wait_for(heartbeat.wait(), timeout=1)
    assert client.online is True
    assert sent[0] == {"authorization": "authorization", "device_proof": "proof"}
    assert urls[0][0] == "wss://gateway.example/api/control/ws"
    await client.stop()
    assert client.online is False


@pytest.mark.asyncio
async def test_slow_control_handshake_keeps_daemon_health_responsive(monkeypatch):
    monkeypatch.setenv("WORKSTEP_DESKTOP_RUNTIME", "1")
    monkeypatch.setenv("WORKSTEP_DESKTOP_TOKEN", "desktop-secret")
    started = asyncio.Event()
    release = asyncio.Event()

    class SlowConnection:
        async def __aenter__(self):
            started.set()
            await release.wait()
            raise ConnectionError("Gateway unavailable")

        async def __aexit__(self, *_):
            return None

    def factory(origin):
        return GatewayControlClient(origin, connector=lambda *_args, **_kwargs: SlowConnection())

    service = GatewayClientService(control_client_factory=factory)
    service.managed_config = SimpleNamespace(gateway_origin="https://gateway.test")

    class Verifier:
        async def verify(self, *_):
            return ManagedActor("user-1", "alice", "device-1", "instance-1", 1)

    service.verifier = Verifier()
    app = FastAPI()
    app.add_middleware(DesktopSecurityMiddleware)
    app.include_router(managed_router)
    app.state.gateway_client = service

    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://127.0.0.1") as http:
            bootstrap = await http.post("/api/managed/bootstrap", json={
                "device_authorization": "signed", "device_proof": "proof",
            }, headers={"X-WorkStep-Desktop-Token": "desktop-secret"})
            assert bootstrap.status_code == 200
            await asyncio.wait_for(started.wait(), timeout=1)
            assert (await asyncio.wait_for(http.get("/api/health", headers={
                "X-WorkStep-Desktop-Token": "desktop-secret",
            }), timeout=0.2)).status_code == 200
    finally:
        release.set()
        await service.close()
