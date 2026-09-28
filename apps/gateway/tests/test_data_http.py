import asyncio
import base64

import httpx
import pytest
from fastapi import FastAPI, Request
from types import SimpleNamespace
from workstep_gateway_protocol import (FrameType, ProxyFrame,
                                       WebSocketMessageAssembler, websocket_payloads)

from gateway.control_connection import DataConnection


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
        return await connection.proxy_http(request, user_id="user-1", username="alice")

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
    ), timeout=2)
    assert browser.accepted
    assert browser.sent == ["echo:" + "hello" * 20000]
