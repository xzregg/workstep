"""Owner-side sharing device metadata from real WebSocket peers."""
import threading
import time

from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient

from services.remote_access import RemoteAccessService
from streaming.remote_host import RemoteRouteDispatcher, serve_remote_project_socket
from streaming.bus import EventBus
class MemoryConfig:
    def __init__(self):
        self.values = {}

    def get(self, key, default=None):
        return self.values.get(key, default)

    def set(self, key, value):
        self.values[key] = value


def test_remote_device_ip_persists_and_slow_auth_does_not_block_health(monkeypatch):
    service = RemoteAccessService(MemoryConfig())
    service.update_settings(enabled=True, internal_base_url="http://host:8765", external_base_url="")
    shared = service.create_share(project_id="project", project_name="demo", access="internal")
    invite = service.parse_share_string(shared["share_string"])["invite_token"]
    original = service.authenticate
    started = threading.Event()
    release = threading.Event()

    def slow_authenticate(**kwargs):
        started.set()
        assert release.wait(2)
        return original(**kwargs)

    monkeypatch.setattr(service, "authenticate", slow_authenticate)
    app = FastAPI()

    @app.get("/health")
    async def health():
        return {"ok": True}

    @app.websocket("/remote")
    async def remote(ws: WebSocket):
        dispatcher = RemoteRouteDispatcher(app)
        try:
            await serve_remote_project_socket(ws, dispatcher=dispatcher, access_service=service,
                event_bus=EventBus(), project_summary=lambda _: {"id": "project"})
        finally:
            await dispatcher.aclose()

    actor = {"actor_id": "user", "user_name": "张三", "device_id": "device", "device_name": "办公室电脑"}
    with TestClient(app, client=("192.168.1.23", 50000)) as client:
        with client.websocket_connect("/remote") as ws:
            ws.send_json({"type": "auth", "project_id": "project", "invite_token": invite,
                          "actor": actor, "ip_address": "forged"})
            assert started.wait(1)
            try:
                health_started = time.monotonic()
                assert client.get("/health").json() == {"ok": True}
                assert time.monotonic() - health_started < 0.2
                assert not release.is_set()
            finally:
                release.set()
            response = ws.receive_json()
            assert response["type"] == "auth_ok"
            credential = response["credential"]
            device = service.list_devices("project")[0]
            assert device["device_name"] == "办公室电脑"
            assert device["ip_address"] == "192.168.1.23"
    assert service.list_devices("project")[0]["ip_address"] == "192.168.1.23"
    with TestClient(app, client=("2001:db8::12", 50001)) as client:
        with client.websocket_connect("/remote") as ws:
            ws.send_json({"type": "auth", "project_id": "project", "credential": credential, "actor": actor})
            assert ws.receive_json()["type"] == "auth_ok"
            assert service.list_devices("project")[0]["ip_address"] == "2001:db8::12"
