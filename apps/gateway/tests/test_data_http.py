import asyncio
import base64

import httpx
import pytest
from fastapi import FastAPI, Request
from starlette.requests import Request as StarletteRequest
from types import SimpleNamespace
from workstep_gateway_protocol import (FrameType, ProxyFrame,
                                       WebSocketMessageAssembler, websocket_payloads)

from gateway.control_connection import DataConnection


@pytest.mark.asyncio
async def test_share_proxy_forwards_only_ticket_and_fixed_task_path():
    starts = []

    class Socket:
        async def send_json(self, message):
            frame = ProxyFrame.model_validate(message)
            if frame.type != FrameType.http_request:
                return
            if frame.payload.get("phase") == "start":
                starts.append(frame.payload)
            if frame.payload.get("phase") == "end":
                await connection.deliver(ProxyFrame(
                    stream_id=frame.stream_id, type=FrameType.http_response,
                    payload={"phase": "start", "status": 200, "headers": []},
                ))
                await connection.deliver(ProxyFrame(
                    stream_id=frame.stream_id, type=FrameType.http_response,
                    payload={"phase": "end"},
                ))

    connection = DataConnection("device-1", Socket())
    app = FastAPI()

    @app.get("/api/public/shares/token/task")
    async def guest_task(request: Request):
        return await connection.proxy_http(
            request, share_ticket="signed-ticket",
            target_path="/api/platform-share/task",
        )

    @app.get("/api/public/shares/token/history")
    async def guest_history(request: Request):
        return await connection.proxy_http(
            request, share_ticket="signed-ticket",
            target_path="/api/platform-share/history",
        )

    @app.get("/api/public/shares/token/history/100")
    async def guest_older_history(request: Request):
        return await connection.proxy_http(
            request, share_ticket="signed-ticket",
            target_path="/api/platform-share/history/100",
        )

    @app.get("/api/public/shares/token/artifacts")
    async def guest_artifacts(request: Request):
        return await connection.proxy_http(
            request, share_ticket="signed-ticket",
            target_path="/api/platform-share/artifacts",
        )

    @app.get("/api/public/shares/token/artifacts/content")
    async def guest_artifact_content(request: Request):
        return await connection.proxy_http(
            request, share_ticket="signed-ticket",
            target_path=f"/api/platform-share/artifacts/{'a' * 64}/content",
        )

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="https://gateway.test") as client:
        response = await client.get("/api/public/shares/token/task",
                                    headers={"Cookie": "guest=private"})
        assert response.status_code == 200
        assert (await client.get("/api/public/shares/token/history")).status_code == 200
        assert (await client.get("/api/public/shares/token/history/100")).status_code == 200
        assert (await client.get("/api/public/shares/token/artifacts")).status_code == 200
        assert (await client.get("/api/public/shares/token/artifacts/content")).status_code == 200
    assert starts[0]["path"] == "/api/platform-share/task"
    assert starts[0]["share_ticket"] == "signed-ticket"
    assert "user_id" not in starts[0]
    assert "username" not in starts[0]
    assert all(name.lower() != "cookie" for name, _ in starts[0]["headers"])
    assert starts[1]["path"] == "/api/platform-share/history"
    assert starts[2]["path"] == "/api/platform-share/history/100"
    assert starts[3]["path"] == "/api/platform-share/artifacts"
    assert starts[4]["path"] == f"/api/platform-share/artifacts/{'a' * 64}/content"


@pytest.mark.asyncio
async def test_data_connection_multiplexes_large_http_body_and_streamed_response():
    received = {}
    tasks = []

    class Socket:
        async def send_json(self, message):
            frame = ProxyFrame.model_validate(message)
            if frame.type == FrameType.cancel:
                return
            stream = received.setdefault(frame.stream_id, {"body": bytearray()})
            phase = frame.payload["phase"]
            if phase == "start":
                stream["headers"] = frame.payload["headers"]
                stream["user_id"] = frame.payload["user_id"]
                stream["display_name"] = frame.payload.get("display_name")
                stream["project_id"] = frame.payload.get("project_id")
                stream["access_level"] = frame.payload.get("access_level")
                stream["task_create"] = frame.payload.get("task_create")
            elif phase == "body":
                stream["body"].extend(base64.b64decode(frame.payload["data"]))
            elif phase == "end":
                async def reply():
                    await connection.deliver(ProxyFrame(
                        stream_id=frame.stream_id, type=FrameType.http_response,
                        payload={"phase": "start", "status": 201,
                                 "headers": [["content-type", "application/octet-stream"]]},
                    ))
                    body = b"reply:" + bytes(stream["body"])
                    for offset in range(0, len(body), 10000):
                        await connection.deliver(ProxyFrame(
                            stream_id=frame.stream_id, type=FrameType.http_response,
                            payload={"phase": "body", "data": base64.b64encode(
                                body[offset:offset + 10000],
                            ).decode()},
                        ))
                    await connection.deliver(ProxyFrame(
                        stream_id=frame.stream_id, type=FrameType.http_response,
                        payload={"phase": "end"},
                    ))
                tasks.append(asyncio.create_task(reply()))

    connection = DataConnection("device-1", Socket())
    app = FastAPI()

    @app.post("/echo")
    async def echo(request: Request):
        return await connection.proxy_http(request, user_id="user-1", username="alice",
                                           display_name="Alice Display",
                                           project_id="host-1", access_level="edit",
                                           task_create=True)

    upload = b"x" * 70000
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="https://gateway.test") as client:
        response = await client.post("/echo", content=upload,
                                     headers={"Cookie": "secret=never-forward",
                                              "X-WorkStep-Actor-Name": "spoof"})
    await asyncio.gather(*tasks)
    assert response.status_code == 201
    assert response.content == b"reply:" + upload
    assert len(received) == 1
    stream = next(iter(received.values()))
    assert stream["user_id"] == "user-1"
    assert stream["display_name"] == "Alice Display"
    assert stream["project_id"] == "host-1"
    assert stream["access_level"] == "edit"
    assert stream["task_create"] is True
    assert all(name.lower() not in ("cookie", "x-workstep-actor-name")
               for name, _ in stream["headers"])


@pytest.mark.asyncio
async def test_data_connection_forwards_bidirectional_websocket_frames():
    class Browser:
        def __init__(self):
            self.scope = {"headers": [(b"host", b"d-device-1.gateway.test"),
                                       (b"cookie", b"secret=private")]}
            self.url = SimpleNamespace(path="/ws", query="")
            self.incoming = asyncio.Queue()
            self.incoming.put_nowait({"type": "websocket.receive", "text": "hello" * 20000})
            self.accepted = False
            self.sent = []

        async def accept(self, *, subprotocol=None):
            self.accepted = True

        async def receive(self):
            return await self.incoming.get()

        async def send_text(self, value):
            self.sent.append(value)
            self.incoming.put_nowait({"type": "websocket.disconnect", "code": 1000})

        async def close(self, *, code):
            self.incoming.put_nowait({"type": "websocket.disconnect", "code": code})

    class Socket:
        def __init__(self):
            self.assembler = WebSocketMessageAssembler()

        async def send_json(self, message):
            frame = ProxyFrame.model_validate(message)
            if frame.type == FrameType.websocket_open:
                assert frame.payload["user_id"] == "user-1"
                assert frame.payload["display_name"] == "Alice Display"
                assert frame.payload["project_id"] == "host-1"
                assert frame.payload["access_level"] == "edit"
                assert all(name.lower() != "cookie" for name, _ in frame.payload["headers"])
                await connection.deliver(ProxyFrame(
                    stream_id=frame.stream_id, type=FrameType.websocket_open,
                    payload={"accepted": True},
                ))
            elif frame.type == FrameType.websocket_data:
                assembled = self.assembler.add(frame.payload)
                if assembled is not None:
                    kind, data = assembled
                    assert kind == "text"
                    for payload in websocket_payloads("text", b"echo:" + data):
                        await connection.deliver(ProxyFrame(
                            stream_id=frame.stream_id, type=FrameType.websocket_data,
                            payload=payload,
                        ))

    browser = Browser()
    connection = DataConnection("device-1", Socket())
    await asyncio.wait_for(connection.proxy_websocket(
        browser, user_id="user-1", username="alice",
        display_name="Alice Display",
        project_id="host-1", access_level="edit",
    ), timeout=2)
    assert browser.accepted
    assert browser.sent == ["echo:" + "hello" * 20000]


@pytest.mark.asyncio
async def test_project_websocket_closes_after_access_revocation():
    allowed = True

    async def authorize():
        if not allowed:
            raise PermissionError("Project access revoked")

    class Browser:
        scope = {"headers": []}
        url = SimpleNamespace(path="/ws", query="")

        def __init__(self):
            self.accepted = asyncio.Event()
            self.closed = asyncio.Event()
            self.close_code = None

        async def accept(self, *, subprotocol=None):
            self.accepted.set()

        async def receive(self):
            await asyncio.Event().wait()

        async def close(self, *, code):
            self.close_code = code
            self.closed.set()

    class Socket:
        async def send_json(self, message):
            frame = ProxyFrame.model_validate(message)
            if frame.type == FrameType.websocket_open:
                assert frame.payload["project_id"] == "host-1"
                await connection.deliver(ProxyFrame(
                    stream_id=frame.stream_id, type=FrameType.websocket_open,
                    payload={"accepted": True},
                ))

    browser = Browser()
    connection = DataConnection("device-1", Socket())
    task = asyncio.create_task(connection.proxy_websocket(
        browser, user_id="user-1", username="alice",
        project_id="host-1", access_level="read",
        authorization_check=authorize,
    ))
    await asyncio.wait_for(browser.accepted.wait(), timeout=1)
    allowed = False
    await asyncio.wait_for(browser.closed.wait(), timeout=2)
    await asyncio.wait_for(task, timeout=1)
    assert browser.close_code == 4403


@pytest.mark.asyncio
async def test_project_http_stream_stops_when_authorization_is_revoked():
    allowed = True
    frames = []

    async def authorize():
        if not allowed:
            raise PermissionError("Project access revoked")

    class Socket:
        async def send_json(self, message):
            frame = ProxyFrame.model_validate(message)
            frames.append(frame)
            if frame.type == FrameType.http_request and frame.payload["phase"] == "end":
                await connection.deliver(ProxyFrame(
                    stream_id=frame.stream_id, type=FrameType.http_response,
                    payload={"phase": "start", "status": 200, "headers": []},
                ))

    connection = DataConnection("device-1", Socket())
    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}
    request = StarletteRequest({
        "type": "http", "method": "GET", "scheme": "https", "path": "/api/task/list",
        "query_string": b"project_id=host-1", "headers": [], "server": ("gateway.test", 443),
    }, receive)
    response = await connection.proxy_http(
        request, user_id="user-1", username="alice", project_id="host-1",
        access_level="read", authorization_check=authorize,
    )
    allowed = False
    with pytest.raises(PermissionError):
        await anext(response.body_iterator)
    assert any(frame.type == FrameType.cancel for frame in frames)
