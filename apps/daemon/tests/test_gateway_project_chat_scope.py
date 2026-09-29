"""A project-only Gateway session can write chats only in its bound project."""

import asyncio
import base64
import json
import threading
import time

import pytest
from httpx import ASGITransport, AsyncClient

from services.gateway_client.bridge import ManagedHttpBridge
from tests.test_chat_session import chat_module
from workstep_gateway_protocol import FrameType, ProxyFrame


@pytest.mark.anyio
async def test_project_proxy_chat_creation_and_message_are_project_scoped(chat_module, monkeypatch):
    import main

    module, _bus, manager, project, _config = chat_module
    monkeypatch.setattr(main, "project_manager", manager)
    monkeypatch.setattr(main, "chat_session_module", module)
    visible, private = project.id, "other-project"
    monkeypatch.setattr(main.gateway_client, "managed_config", object())

    async def request(path, body, *, query_project=visible, level="edit", extra_headers=None):
        frames = []

        async def capture(frame):
            frames.append(frame)

        headers = [["content-type", "application/json"], *(extra_headers or [])]
        bridge = ManagedHttpBridge(main.app, "project-chat", {
            "method": "POST", "path": path, "query": f"project_id={query_project}",
            "headers": headers, "user_id": "worker", "username": "worker",
            "project_id": visible, "access_level": level,
        }, capture, "device-1")
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id="project-chat", type=FrameType.http_request,
            payload={"phase": "body", "data": base64.b64encode(json.dumps(body).encode()).decode()}))
        await bridge.feed(ProxyFrame(stream_id="project-chat", type=FrameType.http_request,
            payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, timeout=3)
        raw = b"".join(base64.b64decode(frame.payload["data"])
                       for frame in frames if frame.payload.get("phase") == "body")
        return frames[0].payload["status"], json.loads(raw) if raw else None

    assert (await request("/api/chat-sessions", {"project_id": visible}, level="read"))[0] == 403
    assert (await request("/api/chat-sessions", {"project_id": private}))[0] == 403
    assert (await request("/api/chat-sessions", {"project_id": visible},
                          query_project=private))[0] == 403

    entered = threading.Event()
    create_session = main.chat_session_module.create_session

    def slow_create(*args, **kwargs):
        entered.set()
        time.sleep(0.7)
        return create_session(*args, **kwargs)

    monkeypatch.setattr(main.chat_session_module, "create_session", slow_create)
    pending = asyncio.create_task(request("/api/chat-sessions", {"project_id": visible}))
    assert await asyncio.to_thread(entered.wait, 2)
    started = time.monotonic()
    async with AsyncClient(transport=ASGITransport(app=main.app),
                           base_url="http://test") as client:
        assert (await client.get("/api/health")).status_code == 200
    assert time.monotonic() - started < 0.5
    code, session = await pending
    assert code == 200
    session_id = session["id"]

    chat_path = f"/api/chat-sessions/{session_id}/chat"
    chat_headers = [["idempotency-key", "project-chat-1"]]
    assert (await request(chat_path, {"project_id": visible, "content": "hello"},
                          level="read", extra_headers=chat_headers))[0] == 403
    assert (await request(chat_path, {"project_id": private, "content": "hello"},
                          extra_headers=chat_headers))[0] == 403
    monkeypatch.setattr(main.chat_session_module, "start_queued_turn", lambda _id: None)
    code, accepted = await request(chat_path, {"project_id": visible, "content": "hello"},
                                   extra_headers=chat_headers)
    assert code == 200
    assert accepted["turn_id"]
