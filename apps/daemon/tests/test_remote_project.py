"""Remote-project transport behavior through the public RPC seam."""

import asyncio
import base64
import json
from types import SimpleNamespace

from fastapi import APIRouter, FastAPI, WebSocket
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from pydantic import BaseModel

from services.remote_project import (
    ACCESS_COOKIE_NAME,
    REMOTE_REQUEST_BODY_LIMIT,
    ActorSnapshot,
    BrowserActorMiddleware,
    RemoteAccessService,
    RemoteAccessGuardMiddleware,
    RemoteHttpRequest,
    RemotePrincipal,
    RemoteRouteDispatcher,
    RemoteProjectRegistry,
    RemoteProjectProxyMiddleware,
    RemoteProjectClientManager,
    RemoteHttpResponse,
    serve_remote_project_socket,
    get_current_actor,
    current_actor_event_fields,
    _select_network_ipv4,
    _is_loopback,
)
from services.messages import current_actor_message_fields
from streaming.bus import EventBus
import api.remote_project as remote_project_api


async def test_remote_model_selection_read_routes_are_project_scoped():
    import api.engine as engine_api
    import api.provider as provider_api

    app = FastAPI()
    app.include_router(engine_api.router)
    app.include_router(provider_api.router)
    dispatcher = RemoteRouteDispatcher(app)

    try:
        assert dispatcher._resolve("GET", "/api/engine/coordinator/config")
        assert dispatcher._resolve("GET", "/api/provider/list")
        assert dispatcher._resolve("GET", "/api/engine/codex/models")
    finally:
        await dispatcher.aclose()


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


def test_access_password_hashing_and_token_roundtrip():
    config = MemoryConfig()
    service = RemoteAccessService(config)

    assert service.access_password_required() is False
    assert service.verify_access_password("secret") is False
    service.set_access_password("s3cret")

    raw = config.get("remote_access", {})
    assert "s3cret" not in json.dumps(raw)
    assert raw.get("access_password_hash")
    assert service.access_password_required() is True
    assert service.verify_access_password("s3cret") is True
    assert service.verify_access_password("wrong") is False

    token = service.issue_access_token()
    assert service.verify_access_token(token) is True
    assert service.verify_access_token("garbage") is False
    assert service.verify_access_token("0.deadbeef") is False

    # Rotating the password invalidates previously issued tokens.
    old = service.issue_access_token()
    service.set_access_password("changed")
    assert service.verify_access_token(old) is False

    service.set_access_password("")
    assert service.access_password_required() is False


def test_loopback_detection_handles_ipv4_ipv6_and_hostnames():
    assert _is_loopback("127.0.0.1") is True
    assert _is_loopback("::1") is True
    assert _is_loopback("::ffff:127.0.0.1") is True
    assert _is_loopback("localhost") is True
    assert _is_loopback("192.168.1.20") is False
    assert _is_loopback("") is False


async def test_remote_access_guard_blocks_non_local_api_until_unlocked(monkeypatch):
    config = MemoryConfig()
    access = RemoteAccessService(config)
    access.set_access_password("letmein")
    monkeypatch.setattr(remote_project_api, "remote_access_service", access)

    app = FastAPI()
    app.add_middleware(RemoteAccessGuardMiddleware, access_service=access)
    router = APIRouter(prefix="/api")
    app.include_router(remote_project_api.router)

    @router.get("/secret")
    async def secret():
        return {"ok": True}

    app.include_router(router)

    async with AsyncClient(
        transport=ASGITransport(app=app, client=("203.0.113.9", 5000)),
        base_url="http://test",
    ) as client:
        blocked = await client.get("/api/secret")
        assert blocked.status_code == 401
        assert blocked.json()["code"] == "remote_access_locked"

        wrong = await client.post(
            "/api/remote-project/access/unlock", json={"password": "nope"}
        )
        assert wrong.status_code == 401

        unlocked = await client.post(
            "/api/remote-project/access/unlock", json={"password": "letmein"}
        )
        assert unlocked.status_code == 200
        assert ACCESS_COOKIE_NAME in unlocked.cookies

        allowed = await client.get("/api/secret")
        assert allowed.status_code == 200
        assert allowed.json() == {"ok": True}

    async with AsyncClient(
        transport=ASGITransport(app=app, client=("127.0.0.1", 5000)),
        base_url="http://test",
    ) as local_client:
        local = await local_client.get("/api/secret")
        assert local.status_code == 200


async def test_remote_access_guard_is_open_when_no_password_is_set():
    access = RemoteAccessService(MemoryConfig())
    app = FastAPI()
    app.add_middleware(RemoteAccessGuardMiddleware, access_service=access)

    @app.get("/api/secret")
    async def secret():
        return {"ok": True}

    async with AsyncClient(
        transport=ASGITransport(app=app, client=("203.0.113.9", 5000)),
        base_url="http://test",
    ) as client:
        response = await client.get("/api/secret")
        assert response.status_code == 200


async def test_remote_access_guard_ignores_spoofed_forwarded_header_from_remote_peer():
    access = RemoteAccessService(MemoryConfig())
    access.set_access_password("letmein")
    app = FastAPI()
    app.add_middleware(RemoteAccessGuardMiddleware, access_service=access)

    @app.get("/api/secret")
    async def secret():
        return {"ok": True}

    async with AsyncClient(
        transport=ASGITransport(app=app, client=("203.0.113.9", 5000)),
        base_url="http://test",
    ) as client:
        response = await client.get(
            "/api/secret",
            headers={"X-Forwarded-For": "127.0.0.1"},
        )
        assert response.status_code == 401


async def test_remote_access_guard_trusts_forwarded_header_from_local_proxy():
    access = RemoteAccessService(MemoryConfig())
    access.set_access_password("letmein")
    app = FastAPI()
    app.add_middleware(RemoteAccessGuardMiddleware, access_service=access)

    @app.get("/api/secret")
    async def secret():
        return {"ok": True}

    async with AsyncClient(
        transport=ASGITransport(app=app, client=("127.0.0.1", 5000)),
        base_url="http://test",
    ) as client:
        response = await client.get(
            "/api/secret",
            headers={"X-Forwarded-For": "203.0.113.9"},
        )
        assert response.status_code == 401


def test_local_user_identity_is_attached_to_messages_and_live_events(monkeypatch):
    class LocalIdentityConfig:
        @staticmethod
        def get_user_name():
            return "电脑 A 使用者"

        @staticmethod
        def get_device_identity():
            return {
                "device_id": "device-a",
                "device_name": "电脑 A",
            }

    import services.config as config_module

    monkeypatch.setattr(config_module, "config_store", LocalIdentityConfig())

    assert current_actor_message_fields() == {
        "author_id": "device-a",
        "author_name": "电脑 A 使用者",
        "author_device_id": "device-a",
        "author_device_name": "电脑 A",
    }
    assert current_actor_event_fields() == {
        "actor": {
            "id": "device-a",
            "name": "电脑 A 使用者",
            "device_id": "device-a",
            "device_name": "电脑 A",
        }
    }


async def test_browser_actor_headers_are_attached_to_request_context():
    app = FastAPI()
    app.add_middleware(BrowserActorMiddleware)
    router = APIRouter(prefix="/api")

    @router.get("/whoami")
    async def whoami():
        actor = get_current_actor()
        return {
            "id": actor.actor_id if actor else None,
            "name": actor.user_name if actor else None,
            "source": actor.source if actor else None,
        }

    app.include_router(router)
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        response = await client.get(
            "/api/whoami",
            headers={
                "X-WorkStep-Actor-Id": "browser-1",
                "X-WorkStep-Actor-Name": "%E6%B5%8F%E8%A7%88%E5%99%A8%E7%94%A8%E6%88%B7",
                "X-WorkStep-Actor-Device-Id": "browser-device-1",
                "X-WorkStep-Actor-Device-Name": "Chrome",
            },
        )

    assert response.status_code == 200
    assert response.json() == {
        "id": "browser-1",
        "name": "浏览器用户",
        "source": "browser",
    }


async def test_browser_actor_headers_do_not_override_remote_principal():
    app = FastAPI()
    router = APIRouter(prefix="/api")

    @router.get("/actor")
    async def actor(project_id: str | None = None):
        current = get_current_actor()
        return {
            "id": current.actor_id if current else None,
            "source": current.source if current else None,
        }

    app.include_router(router)
    dispatcher = RemoteRouteDispatcher(app)
    response = await dispatcher.dispatch(
        RemoteHttpRequest(
            request_id="req-browser-header",
            method="GET",
            path="/api/actor",
            headers={
                "x-workstep-actor-id": "browser-1",
                "x-workstep-actor-name": "浏览器用户",
                "x-workstep-actor-device-id": "browser-device-1",
                "x-workstep-actor-device-name": "Chrome",
            },
        ),
        RemotePrincipal(
            project_id="owner-project",
            actor=ActorSnapshot(
                actor_id="remote-1",
                user_name="远端用户",
                device_id="remote-device-1",
                device_name="远端设备",
                source="remote",
            ),
        ),
    )
    await dispatcher.aclose()

    assert response.status == 200
    assert response.json() == {"id": "remote-1", "source": "remote"}


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


def test_share_defaults_to_permanent_device_access_and_supports_expiry(monkeypatch):
    import services.remote_project as remote_project_service

    now = 1_800_000_000
    monkeypatch.setattr(remote_project_service.time, "time", lambda: now)
    config = MemoryConfig()
    service = RemoteAccessService(config)
    service.update_settings(
        enabled=True,
        internal_base_url="http://host:8765",
        external_base_url="",
    )

    permanent = service.create_share(
        project_id="owner-project",
        project_name="demo",
        access="internal",
    )
    permanent_payload = service.parse_share_string(permanent["share_string"])
    service.authenticate(
        project_id="owner-project",
        actor=ActorSnapshot("device-a", "张三", "device-a", "MacBook", "remote"),
        invite_token=permanent_payload["invite_token"],
        credential=None,
    )

    expiring = service.create_share(
        project_id="owner-project",
        project_name="demo",
        access="internal",
        access_expires_at=now + 3600,
    )
    expiring_payload = service.parse_share_string(expiring["share_string"])
    service.authenticate(
        project_id="owner-project",
        actor=ActorSnapshot("device-b", "李四", "device-b", "PC", "remote"),
        invite_token=expiring_payload["invite_token"],
        credential=None,
    )

    devices = service.list_devices("owner-project")
    assert devices[0]["status"] == "active"
    assert devices[0]["expires_at"] is None
    assert devices[1]["status"] == "active"
    assert devices[1]["expires_at"] == now + 3600

    monkeypatch.setattr(remote_project_service.time, "time", lambda: now + 3601)
    assert service.list_devices("owner-project")[1]["status"] == "expired"


def test_owner_can_change_active_device_expiry_but_not_restore_revoked_device(monkeypatch):
    import services.remote_project as remote_project_service

    now = 1_800_000_000
    monkeypatch.setattr(remote_project_service.time, "time", lambda: now)
    config = MemoryConfig()
    service = RemoteAccessService(config)
    service.update_settings(
        enabled=True,
        internal_base_url="http://host:8765",
        external_base_url="",
    )
    shared = service.create_share(
        project_id="owner-project",
        project_name="demo",
        access="internal",
    )
    payload = service.parse_share_string(shared["share_string"])
    service.authenticate(
        project_id="owner-project",
        actor=ActorSnapshot("device-a", "张三", "device-a", "MacBook", "remote"),
        invite_token=payload["invite_token"],
        credential=None,
    )

    updated = service.update_device_expiry(
        "owner-project", "device-a", now + 7200
    )
    assert updated is not None
    assert updated["expires_at"] == now + 7200

    updated = service.update_device_expiry("owner-project", "device-a", None)
    assert updated is not None
    assert updated["expires_at"] is None

    assert service.revoke_device("owner-project", "device-a") is True
    assert service.update_device_expiry("owner-project", "device-a", now + 7200) is None


def test_device_last_seen_tracks_authenticated_activity(monkeypatch):
    import services.remote_project as remote_project_service

    now = 1_800_000_000
    monkeypatch.setattr(remote_project_service.time, "time", lambda: now)
    config = MemoryConfig()
    service = RemoteAccessService(config)
    service.update_settings(
        enabled=True,
        internal_base_url="http://host:8765",
        external_base_url="",
    )
    shared = service.create_share(
        project_id="owner-project",
        project_name="demo",
        access="internal",
    )
    payload = service.parse_share_string(shared["share_string"])
    service.authenticate(
        project_id="owner-project",
        actor=ActorSnapshot("device-a", "张三", "device-a", "MacBook", "remote"),
        invite_token=payload["invite_token"],
        credential=None,
    )

    monkeypatch.setattr(remote_project_service.time, "time", lambda: now + 90)
    service.touch_device_activity("owner-project", "device-a")

    assert service.list_devices("owner-project")[0]["last_seen_at"] == now + 90


def test_reauthorizing_same_device_replaces_its_previous_grant():
    config = MemoryConfig()
    service = RemoteAccessService(config)
    service.update_settings(
        enabled=True,
        internal_base_url="http://host:8765",
        external_base_url="",
    )
    actor = ActorSnapshot("device-a", "张三", "device-a", "MacBook", "remote")
    credentials = []
    for _ in range(2):
        shared = service.create_share(
            project_id="owner-project",
            project_name="demo",
            access="internal",
        )
        payload = service.parse_share_string(shared["share_string"])
        principal = service.authenticate(
            project_id="owner-project",
            actor=actor,
            invite_token=payload["invite_token"],
            credential=None,
        )
        credentials.append(principal.credential)

    devices = service.list_devices("owner-project")
    assert len(devices) == 1
    assert credentials[0] != credentials[1]


def test_expired_device_credential_cannot_authenticate_or_make_requests(monkeypatch):
    import services.remote_project as remote_project_service

    now = 1_800_000_000
    monkeypatch.setattr(remote_project_service.time, "time", lambda: now)
    config = MemoryConfig()
    service = RemoteAccessService(config)
    service.update_settings(
        enabled=True,
        internal_base_url="http://host:8765",
        external_base_url="",
    )
    shared = service.create_share(
        project_id="owner-project",
        project_name="demo",
        access="internal",
        access_expires_at=now + 60,
    )
    payload = service.parse_share_string(shared["share_string"])
    actor = ActorSnapshot("device-a", "张三", "device-a", "MacBook", "remote")
    principal = service.authenticate(
        project_id="owner-project",
        actor=actor,
        invite_token=payload["invite_token"],
        credential=None,
    )

    monkeypatch.setattr(remote_project_service.time, "time", lambda: now + 61)
    assert service.is_principal_authorized(principal) is False
    try:
        service.authenticate(
            project_id="owner-project",
            actor=actor,
            invite_token=None,
            credential=principal.credential,
        )
    except PermissionError as exc:
        assert "expired" in str(exc).lower()
    else:
        raise AssertionError("expired device credentials must not authenticate")


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


async def test_dispatcher_exposes_project_scoped_chat_event_details():
    app = FastAPI()

    @app.get("/api/chat-sessions/{session_id}/messages/{message_id}/events")
    async def message_events(session_id: str, message_id: str, project_id: str):
        return {
            "project_id": project_id,
            "session_id": session_id,
            "message_id": message_id,
        }

    dispatcher = RemoteRouteDispatcher(app)
    principal = RemotePrincipal(
        project_id="owner-project",
        actor=ActorSnapshot("actor", "用户", "device", "设备", "remote"),
    )
    response = await dispatcher.dispatch(
        RemoteHttpRequest(
            request_id="req-events",
            method="GET",
            path="/api/chat-sessions/s1/messages/m1/events",
            query={"project_id": "forged-project"},
        ),
        principal,
    )

    assert response.json()["project_id"] == "owner-project"
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


async def test_dispatcher_denies_owner_only_remote_access_management_routes():
    app = FastAPI()
    app.include_router(remote_project_api.router)
    dispatcher = RemoteRouteDispatcher(app)
    try:
        for method, path in (
            ("POST", "/api/remote-project/devices/revoke"),
            ("PATCH", "/api/remote-project/devices/access"),
        ):
            try:
                dispatcher._resolve(method, path)
            except PermissionError:
                pass
            else:
                raise AssertionError(f"owner-only route must not be remotely accessible: {path}")
    finally:
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
        "access_status": "active",
        "access_expires_at": None,
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

    @app.post("/api/upload")
    async def upload(payload: dict, project_id: str):
        return {"project_id": project_id, "value": payload["value"]}

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

            body = json.dumps({"value": "chunked"}).encode()
            ws.send_json({
                "type": "http.request.start",
                "request_id": "upload",
                "method": "POST",
                "path": "/api/upload",
                "query": {"project_id": "forged"},
                "headers": {"content-type": "application/json"},
                "body_size": len(body),
            })
            for chunk in (body[:5], body[5:]):
                ws.send_json({
                    "type": "http.request.chunk",
                    "request_id": "upload",
                    "body_b64": base64.b64encode(chunk).decode(),
                })
            ws.send_json({"type": "http.request.end", "request_id": "upload"})
            uploaded = ws.receive_json()
            assert uploaded["status"] == 200
            assert json.loads(base64.b64decode(uploaded["body_b64"])) == {
                "project_id": "owner-project",
                "value": "chunked",
            }

            ws.send_json({
                "type": "http.request.start",
                "request_id": "too-large",
                "method": "POST",
                "path": "/api/upload",
                "query": {},
                "headers": {"content-type": "application/json"},
                "body_size": REMOTE_REQUEST_BODY_LIMIT + 1,
            })
            rejected = ws.receive_json()
            assert rejected["request_id"] == "too-large"
            assert rejected["status"] == 413
    assert access.list_devices("owner-project")[0]["connected"] is False


def test_remote_websocket_closes_when_device_access_expires():
    import time as system_time

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
        access_expires_at=int(system_time.time()) + 1,
    )
    parsed = access.parse_share_string(shared["share_string"])
    app = FastAPI()
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
            assert authenticated["access_expires_at"] == shared["access_expires_at"]
            assert ws.receive_json() == {"type": "access_ended", "reason": "expired"}


def test_remote_status_event_sends_refreshed_project_summary():
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
    running = False
    app = FastAPI()
    bus = EventBus()

    @app.post("/api/start")
    async def start(project_id: str):
        nonlocal running
        running = True
        await bus.publish(
            {
                "type": "CUSTOM",
                "name": "workstep.status",
                "project_id": project_id,
                "task_id": "task-1",
                "value": {"status": "running"},
            }
        )
        return {"task_id": "task-1"}

    def project_summary(project_id: str):
        return {
            "id": project_id,
            "name": "demo",
            "steps": {},
            "workflows": [
                {
                    "id": "workflow-1",
                    "name": "开发流程",
                    "is_default": True,
                    "nodeCount": 2,
                    "running": running,
                }
            ],
        }

    @app.websocket("/ws/remote-project")
    async def remote_socket(ws: WebSocket):
        dispatcher = RemoteRouteDispatcher(app)
        try:
            await serve_remote_project_socket(
                ws,
                dispatcher=dispatcher,
                access_service=access,
                event_bus=bus,
                project_summary=project_summary,
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
            assert ws.receive_json()["type"] == "auth_ok"
            ws.send_json(
                {
                    "type": "subscribe",
                    "status_only_task_ids": ["task-1"],
                }
            )
            ws.send_json(
                {
                    "type": "http.request",
                    "request_id": "start",
                    "method": "POST",
                    "path": "/api/start",
                    "query": {},
                    "headers": {},
                    "body_b64": "",
                }
            )

            messages = [ws.receive_json(), ws.receive_json()]
            refreshed = next(
                (message for message in messages if message["type"] == "project.updated"),
                None,
            )
            assert refreshed is not None
            assert refreshed["project"]["workflows"][0]["running"] is True


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


async def test_owner_can_disconnect_all_live_sockets_for_a_device():
    config = MemoryConfig()
    access = RemoteAccessService(config)

    class FakeSocket:
        def __init__(self):
            self.sent = []
            self.closed = []

        async def send_json(self, message):
            self.sent.append(message)

        async def close(self, **kwargs):
            self.closed.append(kwargs)

    first = FakeSocket()
    second = FakeSocket()
    access.register_connection("owner-project", "device-b", first)
    access.register_connection("owner-project", "device-b", second)

    await access.disconnect_device("owner-project", "device-b", reason="revoked")

    for socket in (first, second):
        assert socket.sent == [{"type": "access_ended", "reason": "revoked"}]
        assert socket.closed == [{"code": 4403, "reason": "revoked"}]


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


async def test_proxy_middleware_keeps_remote_scope_for_html_relative_assets():
    config = MemoryConfig()
    config.set(
        "remote_projects",
        [{
            "id": "remote:abc",
            "host_project_id": "owner-project",
            "name": "demo",
            "endpoint": "ws://host/ws/remote-project",
        }],
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
                headers={"content-type": "text/css"},
                body=b"body { color: blue; }",
            )

    manager = FakeManager()
    app = FastAPI()
    app.add_middleware(
        RemoteProjectProxyMiddleware,
        registry=registry,
        client_manager=manager,
    )

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get(
            "/api/fs/project-raw/remote%3Aabc/docs/theme.css"
        )

    assert response.status_code == 200
    project_id, forwarded = manager.requests[0]
    assert project_id == "remote:abc"
    assert forwarded.path == "/api/fs/project-raw/remote:abc/docs/theme.css"


async def test_client_manager_reuses_authenticated_socket_for_rpc(monkeypatch):
    import services.remote_project as remote_project_service

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
            elif message["type"] == "http.request.end":
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
    monkeypatch.setattr(remote_project_service, "REMOTE_REQUEST_CHUNK_BYTES", 4)
    large_response = await manager.request(
        project["id"],
        RemoteHttpRequest(
            "req-large",
            "POST",
            "/api/sessions",
            {"project_id": project["id"]},
            body=b"0123456789",
        ),
    )

    assert response.json() == {"ok": True}
    assert large_response.json() == {"ok": True}
    assert connects == 1
    assert [message["type"] for message in socket.sent] == [
        "auth",
        "http.request",
        "http.request.start",
        "http.request.chunk",
        "http.request.chunk",
        "http.request.chunk",
        "http.request.end",
    ]
    chunks = [
        base64.b64decode(message["body_b64"])
        for message in socket.sent
        if message["type"] == "http.request.chunk"
    ]
    assert b"".join(chunks) == b"0123456789"
    assert registry.get(project["id"])["credential"] == "issued-secret"
    await manager.close()


async def test_client_applies_remote_project_updates_and_forwards_status_events():
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

        async def send(self, raw):
            message = json.loads(raw)
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
                                "workflows": [
                                    {
                                        "id": "workflow-1",
                                        "name": "开发流程",
                                        "is_default": True,
                                        "nodeCount": 2,
                                        "running": False,
                                    }
                                ],
                            },
                        }
                    )
                )

        async def recv(self):
            return await self.incoming.get()

        async def close(self):
            return None

    socket = FakeSocket()
    events = []
    registry = RemoteProjectRegistry(config)
    manager = RemoteProjectClientManager(
        registry=registry,
        actor_provider=lambda: ActorSnapshot(
            "device-b", "张三", "device-b", "MacBook", "local"
        ),
        event_sink=events.append,
        connect_factory=lambda endpoint, **kwargs: asyncio.sleep(0, result=socket),
    )
    project = await manager.add_share(shared["share_string"])
    await socket.incoming.put(
        json.dumps(
            {
                "type": "project.updated",
                "project": {
                    "name": "demo",
                    "steps": {},
                    "workflows": [
                        {
                            "id": "workflow-1",
                            "name": "开发流程",
                            "is_default": True,
                            "nodeCount": 2,
                            "running": True,
                        }
                    ],
                },
            }
        )
    )
    await socket.incoming.put(
        json.dumps(
            {
                "type": "event",
                "event": {
                    "type": "CUSTOM",
                    "name": "workstep.status",
                    "project_id": "owner-project",
                    "task_id": "task-1",
                    "value": {"status": "running"},
                },
            }
        )
    )
    for _ in range(100):
        if (
            events
            and registry.list_public()[0]["workflows"][0]["running"] is True
        ):
            break
        await asyncio.sleep(0.001)

    assert registry.list_public()[0]["workflows"][0]["running"] is True
    status_event = next(
        event for event in events if event.get("name") == "workstep.status"
    )
    assert status_event == {
        "type": "CUSTOM",
        "name": "workstep.status",
        "project_id": project["id"],
        "task_id": "task-1",
        "value": {"status": "running"},
    }
    await socket.incoming.put(
        json.dumps({"type": "access_ended", "reason": "revoked"})
    )
    for _ in range(100):
        if registry.list_public()[0].get("access_status") == "revoked":
            break
        await asyncio.sleep(0.001)
    assert registry.list_public()[0]["access_status"] == "revoked"
    assert registry.list_public()[0]["connection_status"] == "disconnected"
    await manager.close()


async def test_client_preserves_revoked_state_when_reconnect_authentication_fails():
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

    class FakeSocket:
        async def send(self, _raw):
            return None

        async def recv(self):
            return json.dumps(
                {
                    "type": "auth_error",
                    "detail": "Remote device authorization was revoked",
                }
            )

        async def close(self):
            return None

    registry = RemoteProjectRegistry(config)
    manager = RemoteProjectClientManager(
        registry=registry,
        actor_provider=lambda: ActorSnapshot(
            "device-b", "张三", "device-b", "MacBook", "local"
        ),
        event_sink=lambda _event: None,
        connect_factory=lambda endpoint, **kwargs: asyncio.sleep(
            0, result=FakeSocket()
        ),
    )
    try:
        await manager.add_share(shared["share_string"])
    except PermissionError:
        pass
    else:
        raise AssertionError("revoked credentials must fail to connect")

    assert registry.list_public()[0]["access_status"] == "revoked"


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


async def test_remote_project_share_and_device_expiry_api(monkeypatch):
    import main

    now = int(__import__("time").time())
    config = MemoryConfig()
    access = RemoteAccessService(config)
    access.update_settings(
        enabled=True,
        internal_base_url="http://host:8765",
        external_base_url="",
    )

    class FakeProjectManager:
        @staticmethod
        def get_project_by_id(project_id):
            if project_id != "owner-project":
                return None
            return SimpleNamespace(id=project_id, name="demo")

    monkeypatch.setattr(remote_project_api, "remote_access_service", access)
    monkeypatch.setattr(main, "project_manager", FakeProjectManager())
    app = FastAPI()
    app.include_router(remote_project_api.router)

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        expired_invite_access = await client.post(
            "/api/remote-project/share",
            json={
                "project_id": "owner-project",
                "access": "internal",
                "access_expires_at": now - 1,
            },
        )
        assert expired_invite_access.status_code == 400

        created = await client.post(
            "/api/remote-project/share",
            json={
                "project_id": "owner-project",
                "access": "internal",
                "access_expires_at": now + 3600,
            },
        )
        assert created.status_code == 200
        payload = access.parse_share_string(created.json()["share_string"])
        access.authenticate(
            project_id="owner-project",
            actor=ActorSnapshot("device-a", "张三", "device-a", "MacBook", "remote"),
            invite_token=payload["invite_token"],
            credential=None,
        )

        class FakeSocket:
            def __init__(self):
                self.sent = []
                self.closed = []

            async def send_json(self, message):
                self.sent.append(message)

            async def close(self, **kwargs):
                self.closed.append(kwargs)

        access_changed_socket = FakeSocket()
        access.register_connection(
            "owner-project", "device-a", access_changed_socket
        )

        permanent = await client.patch(
            "/api/remote-project/devices/access",
            json={
                "project_id": "owner-project",
                "device_id": "device-a",
                "expires_at": None,
            },
        )
        assert permanent.status_code == 200
        assert permanent.json()["device"]["expires_at"] is None
        assert access_changed_socket.sent == [
            {"type": "access_ended", "reason": "access_changed"}
        ]

        invalid = await client.patch(
            "/api/remote-project/devices/access",
            json={
                "project_id": "owner-project",
                "device_id": "device-a",
                "expires_at": now - 1,
            },
        )
        assert invalid.status_code == 400

        revoked_socket = FakeSocket()
        access.register_connection("owner-project", "device-a", revoked_socket)
        revoked = await client.post(
            "/api/remote-project/devices/revoke",
            json={"project_id": "owner-project", "device_id": "device-a"},
        )
        assert revoked.status_code == 200
        assert revoked_socket.sent == [
            {"type": "access_ended", "reason": "revoked"}
        ]


async def test_socket_cancellation_does_not_leave_child_tasks_running():
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
    request_started = asyncio.Event()
    request_cancelled = asyncio.Event()
    never = asyncio.Event()

    class CancellationResistantDispatcher:
        async def dispatch(self, request, principal):
            request_started.set()
            try:
                await never.wait()
            except asyncio.CancelledError:
                request_cancelled.set()
                await never.wait()

    class MemoryWebSocket:
        def __init__(self):
            self.incoming = asyncio.Queue()
            self.sent = []

        async def accept(self):
            return None

        async def receive_json(self):
            return await self.incoming.get()

        async def send_json(self, message):
            self.sent.append(message)

        async def close(self, **_kwargs):
            return None

    ws = MemoryWebSocket()
    await ws.incoming.put(
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
    await ws.incoming.put(
        {
            "type": "http.request",
            "request_id": "slow",
            "method": "GET",
            "path": "/api/sessions",
            "query": {},
            "headers": {},
            "body_b64": "",
        }
    )
    socket_task = asyncio.create_task(
        serve_remote_project_socket(
            ws,
            dispatcher=CancellationResistantDispatcher(),
            access_service=access,
            event_bus=EventBus(),
            project_summary=lambda project_id: {
                "id": project_id,
                "name": "demo",
                "steps": {},
                "workflows": [],
            },
        )
    )
    await asyncio.wait_for(request_started.wait(), timeout=1)

    socket_task.cancel()
    await asyncio.wait_for(request_cancelled.wait(), timeout=1)
    socket_task.cancel()
    await asyncio.gather(socket_task, return_exceptions=True)
    await asyncio.sleep(0)

    leaked = [
        task
        for task in asyncio.all_tasks()
        if task is not asyncio.current_task()
        and not task.done()
        and "serve_remote_project_socket.<locals>" in task.get_coro().__qualname__
    ]
    for task in leaked:
        task.cancel()
    await asyncio.gather(*leaked, return_exceptions=True)

    assert leaked == []
