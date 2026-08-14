"""Remote-project transport behavior through the public RPC seam."""

import asyncio
import base64
import json

from fastapi import APIRouter, FastAPI, WebSocket
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from pydantic import BaseModel

from services.remote_project import (
    ActorSnapshot,
    RemoteAccessService,
    RemoteHttpRequest,
    RemotePrincipal,
    RemoteRouteDispatcher,
    RemoteProjectRegistry,
    RemoteProjectProxyMiddleware,
    RemoteProjectClientManager,
    RemoteHttpResponse,
    serve_remote_project_socket,
    get_current_actor,
    _select_network_ipv4,
)
from streaming.bus import EventBus
import api.remote_project as remote_project_api


def test_network_address_selection_prefers_lan_card_over_vpn_adapter():
    assert _select_network_ipv4(
        ["198.18.0.1", "127.0.0.1", "192.168.52.147"]
    ) == "192.168.52.147"


async def test_dispatcher_runs_existing_fastapi_route_with_bound_project_and_actor():
    app = FastAPI()
    router = APIRouter(prefix="/api")

    @router.get("/sessions")
    async def sessions(project_id: str | None = None):
        actor = get_current_actor()
        return {
            "project_id": project_id,
            "actor_name": actor.user_name if actor else None,
        }

    app.include_router(router)
    dispatcher = RemoteRouteDispatcher(app)
    principal = RemotePrincipal(
        project_id="owner-project",
        actor=ActorSnapshot(
            actor_id="device-b",
            user_name="张三",
            device_id="device-b",
            device_name="张三的 MacBook",
            source="remote",
        ),
    )

    response = await dispatcher.dispatch(
        RemoteHttpRequest(
            request_id="req-1",
            method="GET",
            path="/api/sessions",
            query={"project_id": "forged-project"},
        ),
        principal,
    )

    assert response.request_id == "req-1"
    assert response.status == 200
    assert response.json() == {
        "project_id": "owner-project",
        "actor_name": "张三",
    }

    await dispatcher.aclose()


class MemoryConfig:
    def __init__(self):
        self.values: dict = {}

    def get(self, key, default=None):
        return self.values.get(key, default)

    def set(self, key, value):
        self.values[key] = value


def test_external_share_invite_is_one_time_and_issues_device_credential():
    config = MemoryConfig()
    service = RemoteAccessService(config)
    service.update_settings(
        enabled=True,
        internal_base_url="http://192.168.1.20:8765",
        external_base_url="https://workstep.example.com",
    )

    shared = service.create_share(
        project_id="owner-project",
        project_name="demo",
        access="external",
    )
    parsed = service.parse_share_string(shared["share_string"])

    assert parsed["endpoint"] == "wss://workstep.example.com/ws/remote-project"
    assert parsed["project_id"] == "owner-project"
    assert parsed["project_name"] == "demo"

    authenticated = service.authenticate(
        project_id="owner-project",
        invite_token=parsed["invite_token"],
        credential=None,
        actor=ActorSnapshot("device-b", "张三", "device-b", "MacBook", "remote"),
    )
    assert authenticated.project_id == "owner-project"
    assert authenticated.credential

    try:
        service.authenticate(
            project_id="owner-project",
            invite_token=parsed["invite_token"],
            credential=None,
            actor=authenticated.actor,
        )
    except PermissionError:
        pass
    else:
        raise AssertionError("an invite token must only authenticate once")


async def test_dispatcher_overwrites_project_id_in_json_body():
    app = FastAPI()
    router = APIRouter(prefix="/api")

    class CreateSessionRequest(BaseModel):
        project_id: str
        title: str

    @router.post("/chat-sessions")
    async def create_session(req: CreateSessionRequest):
        return req.model_dump()

    app.include_router(router)
    dispatcher = RemoteRouteDispatcher(app)
    principal = RemotePrincipal(
        project_id="owner-project",
        actor=ActorSnapshot("device-b", "张三", "device-b", "MacBook", "remote"),
    )

    response = await dispatcher.dispatch(
        RemoteHttpRequest(
            request_id="req-2",
            method="POST",
            path="/api/chat-sessions",
            headers={"content-type": "application/json"},
            body=json.dumps({"project_id": "forged", "title": "会话"}).encode(),
        ),
        principal,
    )

    assert response.status == 200
    assert response.json() == {"project_id": "owner-project", "title": "会话"}
    await dispatcher.aclose()


async def test_dispatcher_denies_global_routes_without_project_scope():
    app = FastAPI()

    @app.get("/api/system-settings")
    async def system_settings():
        return {"secret": True}

    dispatcher = RemoteRouteDispatcher(app)
    principal = RemotePrincipal(
        project_id="owner-project",
        actor=ActorSnapshot("device-b", "张三", "device-b", "MacBook", "remote"),
    )
    try:
        await dispatcher.dispatch(
            RemoteHttpRequest("req-global", "GET", "/api/system-settings"),
            principal,
        )
    except PermissionError:
        pass
    else:
        raise AssertionError("global routes must never be available to remote projects")
    await dispatcher.aclose()


def test_remote_project_registry_uses_local_id_and_keeps_host_id_private():
    config = MemoryConfig()
    access = RemoteAccessService(config)
    access.update_settings(
        enabled=True,
        internal_base_url="http://192.168.1.20:8765",
        external_base_url="",
    )
    shared = access.create_share(
        project_id="owner-project",
        project_name="demo",
        access="internal",
    )

    registry = RemoteProjectRegistry(config)
    saved = registry.add_from_share(shared["share_string"])

    assert saved["id"].startswith("remote:")
    assert saved["host_project_id"] == "owner-project"
    assert saved["name"] == "demo"
    assert saved["type"] == "remote"
    assert saved["connection_status"] == "disconnected"
    assert registry.get(saved["id"])["invite_token"]

    registry.mark_authenticated(
        saved["id"],
        credential="device-secret",
        project={"name": "宿主名称", "steps": {"nodes": []}, "workflows": []},
    )
    stored = registry.get(saved["id"])
    assert stored["credential"] == "device-secret"
    assert "invite_token" not in stored
    assert registry.list_public()[0] == {
        "id": saved["id"],
        "path": "",
        "name": "宿主名称",
        "steps": {"nodes": []},
        "workflows": [],
        "type": "remote",
        "connection_status": "connected",
        "endpoint": "ws://192.168.1.20:8765/ws/remote-project",
        "host_project_id": "owner-project",
    }


def test_remote_websocket_authenticates_and_dispatches_requests_concurrently():
    config = MemoryConfig()
    access = RemoteAccessService(config)
    access.update_settings(
        enabled=True,
        internal_base_url="http://127.0.0.1:8765",
        external_base_url="",
    )
    shared = access.create_share(
        project_id="owner-project",
        project_name="demo",
        access="internal",
    )
    parsed = access.parse_share_string(shared["share_string"])

    app = FastAPI()

    @app.get("/api/sessions")
    async def sessions(project_id: str, delay: float = 0):
        await asyncio.sleep(delay)
        actor = get_current_actor()
        return {"project_id": project_id, "actor": actor.user_name if actor else None}

    bus = EventBus()

    @app.websocket("/ws/remote-project")
    async def remote_socket(ws: WebSocket):
        dispatcher = RemoteRouteDispatcher(app)
        try:
            await serve_remote_project_socket(
                ws,
                dispatcher=dispatcher,
                access_service=access,
                event_bus=bus,
                project_summary=lambda project_id: {
                    "id": project_id,
                    "name": "demo",
                    "steps": {},
                    "workflows": [],
                },
            )
        finally:
            await dispatcher.aclose()

    with TestClient(app) as client:
        with client.websocket_connect("/ws/remote-project") as ws:
            ws.send_json(
                {
                    "type": "auth",
                    "project_id": "owner-project",
                    "invite_token": parsed["invite_token"],
                    "actor": {
                        "actor_id": "device-b",
                        "user_name": "张三",
                        "device_id": "device-b",
                        "device_name": "MacBook",
                    },
                }
            )
            authenticated = ws.receive_json()
            assert authenticated["type"] == "auth_ok"
            assert authenticated["credential"]
            assert access.list_devices("owner-project")[0]["connected"] is True

            for request_id, delay in (("slow", 0.05), ("fast", 0)):
                ws.send_json(
                    {
                        "type": "http.request",
                        "request_id": request_id,
                        "method": "GET",
                        "path": "/api/sessions",
                        "query": {"project_id": "forged", "delay": str(delay)},
                        "headers": {},
                        "body_b64": base64.b64encode(b"").decode(),
                    }
                )

            first = ws.receive_json()
            second = ws.receive_json()
            assert [first["request_id"], second["request_id"]] == ["fast", "slow"]
            assert json.loads(base64.b64decode(first["body_b64"])) == {
                "project_id": "owner-project",
                "actor": "张三",
            }
    assert access.list_devices("owner-project")[0]["connected"] is False


def test_revoked_device_can_no_longer_authorize_requests():
    config = MemoryConfig()
    access = RemoteAccessService(config)
    access.update_settings(
        enabled=True,
        internal_base_url="http://host:8765",
        external_base_url="",
    )
    shared = access.create_share(
        project_id="owner-project", project_name="demo", access="internal"
    )
    parsed = access.parse_share_string(shared["share_string"])
    principal = access.authenticate(
        project_id="owner-project",
        actor=ActorSnapshot("device-b", "张三", "device-b", "MacBook", "remote"),
        invite_token=parsed["invite_token"],
        credential=None,
    )

    assert access.is_principal_authorized(principal) is True
    assert access.revoke_device("owner-project", "device-b") is True
    assert access.is_principal_authorized(principal) is False


def test_internal_access_address_defaults_to_primary_network_card_and_daemon_port():
    config = MemoryConfig()
    access = RemoteAccessService(
        config,
        daemon_host="0.0.0.0",
        daemon_port=18765,
        network_address_resolver=lambda: "192.168.50.24",
    )

    assert access.settings()["internal_base_url"] == "http://192.168.50.24:18765"

    access.set_runtime_port(18766)
    assert access.settings()["internal_base_url"] == "http://192.168.50.24:18766"

    access.update_settings(
        enabled=True,
        internal_base_url="http://192.168.50.24:18766",
        external_base_url="",
    )
    assert config.get("remote_access")["internal_base_url"] == ""

    shared = access.create_share(
        project_id="owner-project",
        project_name="demo",
        access="internal",
    )
    assert shared["endpoint"] == "ws://192.168.50.24:18766/ws/remote-project"


def test_manual_internal_access_address_overrides_generated_default():
    config = MemoryConfig()
    access = RemoteAccessService(
        config,
        daemon_host="0.0.0.0",
        daemon_port=8765,
        network_address_resolver=lambda: "192.168.50.24",
    )

    access.update_settings(
        enabled=True,
        internal_base_url="http://workstep.lan:9000",
        external_base_url="",
    )

    assert access.settings()["internal_base_url"] == "http://workstep.lan:9000"


async def test_proxy_middleware_forwards_existing_api_when_project_is_remote():
    config = MemoryConfig()
    config.set(
        "remote_projects",
        [
            {
                "id": "remote:abc",
                "host_project_id": "owner-project",
                "name": "demo",
                "endpoint": "ws://host/ws/remote-project",
            }
        ],
    )
    registry = RemoteProjectRegistry(config)

    class FakeManager:
        def __init__(self):
            self.requests = []

        async def request(self, project_id, request):
            self.requests.append((project_id, request))
            return RemoteHttpResponse(
                request_id=request.request_id,
                status=200,
                headers={"content-type": "application/json"},
                body=json.dumps({"source": "remote"}).encode(),
            )

    manager = FakeManager()
    app = FastAPI()
    app.add_middleware(
        RemoteProjectProxyMiddleware,
        registry=registry,
        client_manager=manager,
    )

    @app.get("/api/sessions")
    async def local_sessions(project_id: str):
        return {"source": "local"}

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/api/sessions?project_id=remote%3Aabc")

    assert response.json() == {"source": "remote"}
    project_id, forwarded = manager.requests[0]
    assert project_id == "remote:abc"
    assert forwarded.path == "/api/sessions"
    assert forwarded.query["project_id"] == "remote:abc"


async def test_client_manager_reuses_authenticated_socket_for_rpc():
    config = MemoryConfig()
    access = RemoteAccessService(config)
    access.update_settings(
        enabled=True,
        internal_base_url="http://host:8765",
        external_base_url="",
    )
    shared = access.create_share(
        project_id="owner-project",
        project_name="demo",
        access="internal",
    )
    parsed = access.parse_share_string(shared["share_string"])

    class FakeSocket:
        def __init__(self):
            self.incoming = asyncio.Queue()
            self.sent = []

        async def send(self, raw):
            message = json.loads(raw)
            self.sent.append(message)
            if message["type"] == "auth":
                await self.incoming.put(
                    json.dumps(
                        {
                            "type": "auth_ok",
                            "credential": "issued-secret",
                            "host_id": parsed["fingerprint"],
                            "project": {
                                "name": "demo",
                                "steps": {},
                                "workflows": [],
                            },
                        }
                    )
                )
            elif message["type"] == "http.request":
                await self.incoming.put(
                    json.dumps(
                        {
                            "type": "http.response",
                            "request_id": message["request_id"],
                            "status": 200,
                            "headers": {"content-type": "application/json"},
                            "body_b64": base64.b64encode(b'{"ok":true}').decode(),
                        }
                    )
                )

        async def recv(self):
            return await self.incoming.get()

        async def close(self):
            return None

    socket = FakeSocket()
    connects = 0

    async def connect_factory(endpoint, **kwargs):
        nonlocal connects
        connects += 1
        return socket

    registry = RemoteProjectRegistry(config)
    manager = RemoteProjectClientManager(
        registry=registry,
        actor_provider=lambda: ActorSnapshot(
            "device-b", "张三", "device-b", "MacBook", "local"
        ),
        event_sink=lambda event: None,
        connect_factory=connect_factory,
    )
    project = await manager.add_share(shared["share_string"])
    response = await manager.request(
        project["id"],
        RemoteHttpRequest("req", "GET", "/api/sessions", {"project_id": project["id"]}),
    )

    assert response.json() == {"ok": True}
    assert connects == 1
    assert [message["type"] for message in socket.sent] == ["auth", "http.request"]
    assert registry.get(project["id"])["credential"] == "issued-secret"
    await manager.close()


async def test_remote_project_settings_and_add_api(monkeypatch):
    config = MemoryConfig()
    access = RemoteAccessService(config)
    registry = RemoteProjectRegistry(config)

    class FakeClientManager:
        async def add_share(self, value):
            assert value == "workstep://remote-project/v1/test"
            return {
                "id": "remote:test",
                "path": "",
                "name": "demo",
                "steps": {},
                "workflows": [],
                "type": "remote",
                "connection_status": "connected",
            }

    class NamedConfig:
        @staticmethod
        def get_user_name():
            return "张三"

    monkeypatch.setattr(remote_project_api, "remote_access_service", access)
    monkeypatch.setattr(remote_project_api, "remote_project_registry", registry)
    monkeypatch.setattr(remote_project_api, "client_manager", FakeClientManager())
    monkeypatch.setattr(remote_project_api, "config_store", NamedConfig())
    app = FastAPI()
    app.include_router(remote_project_api.router)

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        invalid = await client.put(
            "/api/remote-project/settings",
            json={
                "enabled": True,
                "internal_base_url": "http://host:8765",
                "external_base_url": "http://public.example.com",
            },
        )
        assert invalid.status_code == 400

        saved = await client.put(
            "/api/remote-project/settings",
            json={
                "enabled": True,
                "internal_base_url": "http://host:8765",
                "external_base_url": "https://public.example.com",
            },
        )
        assert saved.status_code == 200
        assert saved.json()["enabled"] is True

        added = await client.post(
            "/api/remote-project/add",
            json={"share_string": "workstep://remote-project/v1/test"},
        )
        assert added.status_code == 200
        assert added.json()["type"] == "remote"
