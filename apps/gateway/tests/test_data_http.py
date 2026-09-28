import asyncio
import base64

import httpx
import pytest
from fastapi import FastAPI, Request
from workstep_gateway_protocol import FrameType, ProxyFrame

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
