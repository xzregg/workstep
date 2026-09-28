import asyncio
import base64

import httpx
import pytest
from fastapi import FastAPI, Request, WebSocket
from workstep_gateway_protocol import (FrameType, ProxyFrame,
                                       WebSocketMessageAssembler, websocket_payloads)

from services.desktop_security import DesktopSecurityMiddleware
from services.gateway_client.bridge import ManagedHttpBridge, ManagedWebSocketBridge
from services.desktop_security import desktop_websocket_allowed
from services.remote_access import get_current_actor
from services.messages import current_actor_message_fields
from tests.test_gateway_share_ticket import _ticket


@pytest.mark.asyncio
async def test_gateway_share_bridge_accepts_only_signed_task_scope():
    app = FastAPI()
    app.state.gateway_client = type("Client", (), {"managed_config": object()})()
    app.add_middleware(DesktopSecurityMiddleware)

    @app.get("/api/platform-share/task")
    async def shared_task(request: Request):
        return request.state.gateway_share_scope

    @app.get("/api/project/private")
    async def private_project():
        return {"secret": True}

    ticket, key, fingerprint = _ticket()

    async def response(path: str, credential: str):
        frames = []
        async def capture(frame):
            frames.append(frame)
        bridge = ManagedHttpBridge(app, "share-stream", {
            "method": "GET", "path": path, "query": "", "headers": [],
            "share_ticket": credential,
        }, capture, "device-1", gateway_key=key,
            gateway_fingerprint=fingerprint, gateway_id="gateway-1")
        bridge.start_task()
        await asyncio.wait_for(bridge._task, timeout=1)
        return frames

    allowed = await response("/api/platform-share/task", ticket)
    assert allowed[0].payload["status"] == 200
    body = b"".join(base64.b64decode(frame.payload["data"])
                    for frame in allowed if frame.payload.get("phase") == "body")
    assert b'"task_id":"task-1"' in body
    assert (await response("/api/project/private", ticket))[0].payload["status"] == 403
    assert (await response("/api/platform-share/task", ticket + "x"))[0].payload["status"] == 502
    ordinary_frames = []
    async def capture(frame):
        ordinary_frames.append(frame)
    ordinary = ManagedHttpBridge(app, "ordinary", {
        "method": "GET", "path": "/api/platform-share/task", "query": "",
        "headers": [], "user_id": "user-1", "username": "alice",
    }, capture, "device-1")
    ordinary.start_task()
    await asyncio.wait_for(ordinary._task, timeout=1)
    assert ordinary_frames[0].payload["status"] == 403


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
                "source": actor.source, "device_id": request.state.managed_actor.device_id,
                "message_author": current_actor_message_fields()}

    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    @app.post("/api/fs/open-directory")
    async def native_open():
        return {"opened": True}

    @app.get("/api/fs/browse")
    async def unscoped_browse():
        return {"path": "/home/private"}

    frames = []
    async def send_frame(frame):
        frames.append(frame)

    bridge = ManagedHttpBridge(app, "stream-1", {
        "method": "POST", "path": "/api/echo", "query": "",
        "headers": [["content-type", "text/plain"], ["x-workstep-actor-name", "spoof"]],
        "user_id": "user-remote", "username": "alice",
        "display_name": "Alice Display",
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
    assert b'"author_username":"alice"' in body
    assert b'"author_name":"Alice Display"' in body
    assert frames[-1].payload == {"phase": "end"}

    for blocked_path in ("/api/fs/open-directory", "/api/fs/browse"):
        blocked_frames = []
        async def capture(frame):
            blocked_frames.append(frame)
        blocked = ManagedHttpBridge(app, "blocked", {
            "method": "GET", "path": blocked_path, "query": "", "headers": [],
            "user_id": "user-remote", "username": "alice",
        }, capture, "device-1")
        blocked.start_task()
        await asyncio.wait_for(blocked._task, timeout=1)
        assert blocked_frames[0].payload["status"] == 403


@pytest.mark.asyncio
async def test_project_scoped_bridge_denies_unknown_and_cross_project_api():
    app = FastAPI()
    app.state.gateway_client = type("Client", (), {"managed_config": object()})()
    app.add_middleware(DesktopSecurityMiddleware)

    @app.get("/api/task/list")
    async def task_list(request: Request):
        return {"project_id": request.query_params.get("project_id")}

    @app.get("/api/task/{task_id}")
    async def task_detail(task_id: str):
        return {"task_id": task_id}

    @app.get("/api/project/{project_id}/summary")
    async def project_summary(project_id: str):
        return {"project_id": project_id}

    @app.get("/api/workflow/list")
    async def workflows():
        return {"workflows": []}

    @app.get("/api/search/tasks")
    async def search_tasks():
        return {"tasks": []}

    @app.post("/api/task/create")
    async def create_task(request: Request):
        return {"task_create": request.state.managed_actor.remote_task_create}

    @app.post("/api/task/run")
    async def run_task():
        return {"started": True}

    @app.get("/api/task/{task_id}/history")
    async def task_history(task_id: str):
        return {"task_id": task_id}

    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    async def response_status(method: str, path: str, query: str) -> int:
        frames = []
        async def capture(frame):
            frames.append(frame)
        bridge = ManagedHttpBridge(app, "project-stream", {
            "method": method, "path": path, "query": query, "headers": [],
            "user_id": "user-1", "username": "alice",
            "project_id": "host-1", "access_level": "read",
        }, capture, "device-1")
        bridge.start_task()
        await asyncio.wait_for(bridge._task, timeout=1)
        return frames[0].payload["status"]

    assert await response_status("GET", "/api/task/list", "project_id=host-1") == 200
    assert await response_status("GET", "/api/task/task-1", "project_id=host-1") == 200
    assert await response_status("GET", "/api/task/task-1", "project_id=host-2") == 403
    assert await response_status("GET", "/api/workflow/list", "project_id=host-1") == 200
    assert await response_status("GET", "/api/search/tasks", "projectId=host-1") == 200
    assert await response_status("GET", "/api/search/tasks", "") == 403
    assert await response_status("GET", "/api/task/task-1/history", "project_id=host-1") == 200
    assert await response_status("GET", "/api/task/task-1/history", "project_id=host-2") == 403

    async def creation_status(level: str, capability: bool,
                              path: str = "/api/task/create") -> int:
        frames = []
        async def capture(frame):
            frames.append(frame)
        bridge = ManagedHttpBridge(app, "create-stream", {
            "method": "POST", "path": path, "query": "project_id=host-1",
            "headers": [], "user_id": "user-1", "username": "alice",
            "project_id": "host-1", "access_level": level,
            "task_create": capability,
        }, capture, "device-1")
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id="create-stream", type=FrameType.http_request,
                                     payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, timeout=1)
        return frames[0].payload["status"]

    assert await creation_status("read", True) == 403
    assert await creation_status("edit", False) == 403
    assert await creation_status("edit", True) == 200
    assert await creation_status("edit", False, "/api/task/run") == 200
    assert await creation_status("read", True, "/api/task/run") == 403
    assert await response_status("GET", "/api/project/host-1/summary", "") == 200
    assert await response_status("GET", "/api/project/host-2/summary", "") == 403
    assert await response_status("GET", "/api/task/list", "project_id=host-2") == 403
    assert await response_status("GET", "/api/task/list", "project_id=host-1&project_id=host-2") == 403
    assert await response_status("POST", "/api/task/list", "project_id=host-1") == 403
    assert await response_status("GET", "/api/health", "project_id=host-1") == 403


@pytest.mark.asyncio
async def test_gateway_websocket_bridge_carries_bidirectional_messages_with_managed_actor():
    app = FastAPI()
    app.state.gateway_client = type("Client", (), {"managed_config": object()})()

    @app.websocket("/ws")
    async def echo(ws: WebSocket):
        if not desktop_websocket_allowed(ws):
            await ws.close(code=4401)
            return
        await ws.accept()
        message = await ws.receive_text()
        await ws.send_text(
            f"{ws.scope['managed_actor'].user_id}:"
            f"{ws.scope['managed_actor'].display_name}:{message}"
        )
        await ws.close()

    frames = []
    emitted = asyncio.Event()
    async def send_frame(frame):
        frames.append(frame)
        emitted.set()

    bridge = ManagedWebSocketBridge(app, "socket-1", {
        "path": "/ws", "query": "", "headers": [],
        "user_id": "remote-user", "username": "alice",
        "display_name": "Alice Display",
    }, send_frame, "device-1")
    bridge.start_task()
    await asyncio.wait_for(emitted.wait(), timeout=1)
    assert frames[0].type == FrameType.websocket_open
    assert frames[0].payload["accepted"] is True
    for payload in websocket_payloads("text", ("hello" * 20000).encode()):
        await bridge.feed(ProxyFrame(stream_id="socket-1", type=FrameType.websocket_data,
                                     payload=payload))
    await asyncio.wait_for(bridge._task, timeout=1)
    assembler = WebSocketMessageAssembler()
    assembled = None
    for frame in frames:
        if frame.type == FrameType.websocket_data:
            assembled = assembler.add(frame.payload)
    assert assembled == (
        "text", ("remote-user:Alice Display:" + "hello" * 20000).encode(),
    )
    assert frames[-1].type == FrameType.websocket_close


@pytest.mark.asyncio
async def test_project_websocket_bridge_only_receives_explicit_project_events():
    import main
    from streaming.ws import register_websocket_routes

    app = FastAPI()
    app.state.gateway_client = type("Client", (), {"managed_config": object()})()
    register_websocket_routes(app)
    frames = []
    opened = asyncio.Event()
    sent = asyncio.Event()

    async def capture(frame):
        frames.append(frame)
        if frame.type == FrameType.websocket_open:
            opened.set()
        if frame.type == FrameType.websocket_data:
            sent.set()

    bridge = ManagedWebSocketBridge(app, "project-ws", {
        "path": "/ws", "query": "", "headers": [],
        "user_id": "remote-user", "username": "alice",
        "project_id": "project-1", "access_level": "read",
    }, capture, "device-1")
    bridge.start_task()
    try:
        await asyncio.wait_for(opened.wait(), timeout=1)
        assert frames[0].payload["accepted"] is True
        await main.event_bus.publish({"type": "RUN_STARTED", "project_id": "project-2"})
        await main.event_bus.publish({"type": "RUN_STARTED", "task_id": "untagged"})
        assert not sent.is_set()
        await main.event_bus.publish({"type": "RUN_STARTED", "project_id": "project-1"})
        await asyncio.wait_for(sent.wait(), timeout=1)
        assembler = WebSocketMessageAssembler()
        messages = [assembler.add(frame.payload) for frame in frames
                    if frame.type == FrameType.websocket_data]
        assert [message for message in messages if message is not None] == [
            ("text", b'{"type":"RUN_STARTED","project_id":"project-1"}')
        ]
    finally:
        await bridge.feed(ProxyFrame(stream_id="project-ws", type=FrameType.websocket_close,
                                     payload={"code": 1000}))
        await asyncio.wait_for(bridge._task, timeout=1)

    blocked = []
    async def capture_blocked(frame):
        blocked.append(frame)
    share_bridge = ManagedWebSocketBridge(app, "project-share", {
        "path": "/ws/share", "query": "", "headers": [],
        "user_id": "remote-user", "username": "alice",
        "project_id": "project-1", "access_level": "read",
    }, capture_blocked, "device-1")
    share_bridge.start_task()
    await asyncio.wait_for(share_bridge._task, timeout=1)
    assert blocked[0].type == FrameType.websocket_close
    assert blocked[0].payload["code"] == 4401
