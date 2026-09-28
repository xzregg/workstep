from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
import asyncio
import httpx
import pytest

from api.managed import router as managed_router
from services.desktop_security import DesktopSecurityMiddleware
from services.gateway_client import GatewayClientService
from services.gateway_client.identity import ManagedActor
from services.gateway_client.identity import ManagedAuthorizationVerifier
from types import SimpleNamespace


def test_bootstrap_uses_desktop_secret_once_then_local_session(monkeypatch):
    monkeypatch.setenv("WORKSTEP_DESKTOP_RUNTIME", "1")
    monkeypatch.setenv("WORKSTEP_DESKTOP_TOKEN", "desktop-secret")
    app = FastAPI()
    app.add_middleware(DesktopSecurityMiddleware)
    app.include_router(managed_router)
    starts = []

    class FakeControl:
        def __init__(self, origin):
            assert origin == "https://gateway.test"
            self.online = False
            self.authorization_required = False

        def start(self, authorization, proof, device_id):
            starts.append((authorization, proof, device_id))

        async def stop(self):
            pass

    service = GatewayClientService(control_client_factory=FakeControl)
    service.managed_config = SimpleNamespace(gateway_origin="https://gateway.test")

    class Verifier:
        async def verify(self, authorization, proof):
            assert authorization == "signed-authorization"
            assert proof == "device-proof"
            return ManagedActor("user-1", "alice", "device-1", "instance-1", 2)

    service.verifier = Verifier()
    app.state.gateway_client = service

    @app.get("/api/private")
    async def private(request: Request):
        actor = request.state.managed_actor
        return {"user_id": actor.user_id, "device_id": actor.device_id}

    with TestClient(app) as client:
        body = {"device_authorization": "signed-authorization", "device_proof": "device-proof"}
        assert client.post("/api/managed/bootstrap", json=body).status_code == 401
        bootstrapped = client.post("/api/managed/bootstrap", json=body, headers={
            "X-WorkStep-Desktop-Token": "desktop-secret",
        })
        assert bootstrapped.status_code == 200, bootstrapped.text
        session_token = bootstrapped.json()["local_session"]
        assert client.get("/api/private", headers={
            "X-WorkStep-Desktop-Token": "desktop-secret",
            "X-WorkStep-Local-Session": session_token,
        }).json() == {"user_id": "user-1", "device_id": "device-1"}
        assert client.get("/api/private", headers={
            "X-WorkStep-Desktop-Token": "desktop-secret",
        }).status_code == 401
        assert starts == [("signed-authorization", "device-proof", "device-1")]
        assert client.get("/api/managed/control-status", headers={
            "X-WorkStep-Desktop-Token": "desktop-secret",
            "X-WorkStep-Local-Session": session_token,
        }).json() == {"online": False, "authorization_required": False}


@pytest.mark.asyncio
async def test_slow_gateway_key_fetch_keeps_daemon_health_responsive(monkeypatch):
    monkeypatch.setenv("WORKSTEP_DESKTOP_RUNTIME", "1")
    monkeypatch.setenv("WORKSTEP_DESKTOP_TOKEN", "desktop-secret")
    app = FastAPI()
    app.add_middleware(DesktopSecurityMiddleware)
    app.include_router(managed_router)
    service = GatewayClientService()
    service.managed_config = object()
    started = asyncio.Event()
    release = asyncio.Event()

    async def slow_gateway(_request):
        started.set()
        await release.wait()
        return httpx.Response(503)

    service.verifier = ManagedAuthorizationVerifier(
        "gateway-test", "https://gateway.test", "0" * 64,
        client_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(slow_gateway)),
    )
    app.state.gateway_client = service

    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://127.0.0.1") as client:
            bootstrap = asyncio.create_task(client.post("/api/managed/bootstrap", json={
                "device_authorization": "bogus", "device_proof": "bogus",
            }, headers={"X-WorkStep-Desktop-Token": "desktop-secret"}))
            await asyncio.wait_for(started.wait(), timeout=1)
            response = await asyncio.wait_for(client.get("/api/health", headers={
                "X-WorkStep-Desktop-Token": "desktop-secret",
            }), timeout=0.2)
            assert response.json() == {"status": "ok"}
            release.set()
            assert (await bootstrap).status_code == 502
    finally:
        release.set()
