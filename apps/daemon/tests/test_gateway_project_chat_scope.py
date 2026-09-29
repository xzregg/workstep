"""A project-only Gateway session can write chats only in its bound project."""

import asyncio
import base64
import json
import threading
import time
from unittest.mock import AsyncMock

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

    async def request(path, body=None, *, method="POST", query_project=visible,
                      level="edit", extra_headers=None):
        frames = []

        async def capture(frame):
            frames.append(frame)

        headers = [["content-type", "application/json"], *(extra_headers or [])]
        bridge = ManagedHttpBridge(main.app, "project-chat", {
            "method": method, "path": path, "query": f"project_id={query_project}",
            "headers": headers, "user_id": "worker", "username": "worker",
            "project_id": visible, "access_level": level,
        }, capture, "device-1")
        bridge.start_task()
        if body is not None:
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

    session_path = f"/api/chat-sessions/{session_id}"
    assert (await request(session_path, {"project_id": private, "title": "Escape"},
                          method="PATCH"))[0] == 403
    assert (await request(session_path, {"project_id": visible, "title": "Visible"},
                          method="PATCH", level="read"))[0] == 403
    code, renamed = await request(session_path, {"project_id": visible, "title": "Visible"},
                                  method="PATCH")
    assert code == 200 and renamed["title"] == "Visible"
    permission_path = session_path + "/permission-mode"
    assert (await request(permission_path, {"project_id": private,
                                            "permission_mode": "read-only"},
                          method="PATCH"))[0] == 403
    assert (await request(permission_path, {"project_id": visible,
                                            "permission_mode": "read-only"},
                          method="PATCH"))[0] == 200
    archive_path = session_path + "/archive"
    assert (await request(archive_path, {"project_id": private, "archived": True},
                          method="PATCH"))[0] == 403

    live_path = session_path + "/live-message"
    live = AsyncMock(return_value={"message_id": "live-1", "status": "queued",
                                  "created_at": "2026-09-29T00:00:00Z"})
    monkeypatch.setattr(module, "send_live_message", live)
    assert (await request(live_path, {"project_id": private, "content": "escape"}))[0] == 403
    assert (await request(live_path, {"project_id": visible, "content": "visible"}))[0] == 200
    live.assert_awaited_once()

    stop_path = session_path + "/stop"
    assert (await request(stop_path, query_project=private))[0] == 403
    assert (await request("/api/chat-sessions/missing/stop"))[0] == 404
    from api import chat_session as chat_api

    stop_entered = threading.Event()
    run_db = chat_api._run_db

    async def slow_stop_lookup(project_id, operation):
        def delayed_operation():
            stop_entered.set()
            time.sleep(0.7)
            return operation()

        return await run_db(project_id, delayed_operation)

    monkeypatch.setattr(chat_api, "_run_db", slow_stop_lookup)
    pending_stop = asyncio.create_task(request(stop_path))
    assert await asyncio.to_thread(stop_entered.wait, 2)
    started = time.monotonic()
    async with AsyncClient(transport=ASGITransport(app=main.app),
                           base_url="http://test") as client:
        assert (await client.get("/api/health")).status_code == 200
    assert time.monotonic() - started < 0.5
    assert (await pending_stop)[0] == 200
    monkeypatch.setattr(chat_api, "_run_db", run_db)
    assert (await request(archive_path, {"project_id": visible, "archived": True},
                          method="PATCH"))[0] == 200

    assert (await request("/api/chat-sessions/reorder", {"ordered_ids": [session_id]},
                          level="read"))[0] == 403
    assert (await request("/api/chat-sessions/reorder", {"ordered_ids": [session_id]}))[0] == 200
    assert (await request(session_path, method="DELETE", level="read"))[0] == 403
    assert (await request(session_path, method="DELETE"))[0] == 200
    other = await manager.run_db(visible, lambda _project: module.create_session(visible))
    bulk_path = "/api/chat-sessions/bulk-delete"
    assert (await request(bulk_path, {"session_ids": [other["id"]]}, level="read"))[0] == 403
    code, deleted = await request(bulk_path, {"session_ids": [other["id"]]})
    assert code == 200 and other["id"] in deleted["deleted"]

    for path in ("/api/chat-sessions/quick-buttons", "/api/chat-sessions/system-prompt"):
        assert (await request(path, method="GET", level="read"))[0] == 200
        assert (await request(path, method="GET", query_project=private))[0] == 403
    for path, body in (
        ("/api/chat-sessions/quick-buttons", {"buttons": []}),
        ("/api/chat-sessions/system-prompt", {"prompt": "Work here"}),
    ):
        assert (await request(path, {"project_id": private, **body}, method="PUT"))[0] == 403
        assert (await request(path, {"project_id": visible, **body},
                              method="PUT", level="read"))[0] == 403
        assert (await request(path, {"project_id": visible, **body}, method="PUT"))[0] == 200
    enhance = AsyncMock(return_value="Improved")
    monkeypatch.setattr(module, "enhance_prompt", enhance)
    enhance_path = "/api/chat-sessions/enhance-prompt"
    assert (await request(enhance_path, {"project_id": private, "prompt": "draft"}))[0] == 403
    assert (await request(enhance_path, {"project_id": visible, "prompt": "draft"},
                          level="read"))[0] == 403
    code, enhanced = await request(enhance_path, {"project_id": visible, "prompt": "draft"})
    assert code == 200 and enhanced["prompt"] == "Improved"
    enhance.assert_awaited_once_with(visible, "draft")

    source = await manager.run_db(
        visible, lambda _project: module.create_session(visible, engine="claude")
    )
    fork_path = f"/api/chat-sessions/{source['id']}/fork"
    fork_body = {"project_id": visible, "title": "Branch", "engine": "pydantic_ai",
                 "context_mode": "none"}
    assert (await request(fork_path, {**fork_body, "project_id": private}))[0] == 403
    assert (await request(fork_path, fork_body, level="read"))[0] == 403
    assert (await request("/api/chat-sessions/missing/fork", fork_body))[0] == 404
    code, forked = await request(fork_path, fork_body)
    assert code == 200 and forked["parent_session_id"] == source["id"]
    handoff_path = f"/api/chat-sessions/{source['id']}/handoff"
    handoff_body = {"project_id": visible, "engine": "pydantic_ai",
                    "context_mode": "none"}
    assert (await request(handoff_path, {**handoff_body, "project_id": private}))[0] == 403
    assert (await request(handoff_path, handoff_body, level="read"))[0] == 403
    code, handed_off = await request(handoff_path, handoff_body)
    assert code == 200 and handed_off["engine"] == "pydantic_ai"
