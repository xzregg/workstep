"""Dispatch trusted Gateway HTTP frames into the existing ASGI application."""

import asyncio
import base64
from urllib.parse import unquote

from workstep_gateway_protocol import FrameType, ProxyFrame

from .identity import ManagedActor


class ManagedHttpBridge:
    def __init__(self, app, stream_id: str, start: dict, send_frame, device_id: str):
        self.app = app
        self.stream_id = stream_id
        self.send_frame = send_frame
        self.device_id = device_id
        self._inbound: asyncio.Queue = asyncio.Queue(maxsize=32)
        self._task: asyncio.Task | None = None
        self.start = start

    def start_task(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def feed(self, frame: ProxyFrame) -> None:
        await self._inbound.put(frame)

    def cancel(self) -> None:
        if self._task:
            self._task.cancel()

    @property
    def done(self) -> bool:
        return self._task is not None and self._task.done()

    async def _run(self) -> None:
        started = False
        try:
            method = self.start.get("method")
            path = self.start.get("path")
            query = self.start.get("query", "")
            username = self.start.get("username")
            user_id = self.start.get("user_id")
            raw_headers = self.start.get("headers", [])
            if (not isinstance(method, str) or not method.isascii() or not method.isalpha()
                    or not isinstance(path, str) or not path.startswith("/")
                    or path.startswith("//") or path.startswith("/api/managed")
                    or not isinstance(query, str) or not isinstance(username, str)
                    or not isinstance(user_id, str) or not user_id or not username
                    or not isinstance(raw_headers, list)):
                raise ValueError("Invalid managed HTTP request")
            headers = [(b"host", b"127.0.0.1")]
            for pair in raw_headers:
                if not isinstance(pair, list) or len(pair) != 2 or not all(isinstance(v, str) for v in pair):
                    raise ValueError("Invalid managed HTTP headers")
                name = pair[0].lower()
                if (not name.isascii() or not name.replace("-", "").isalnum()
                        or name in ("host", "cookie", "connection", "authorization")
                        or name.startswith("x-workstep-")):
                    continue
                headers.append((name.encode("ascii"), pair[1].encode("latin1")))
            actor = ManagedActor(user_id, username, self.device_id, "gateway-remote", 0)
            scope = {
                "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                "method": method.upper(), "scheme": "http", "path": unquote(path),
                "raw_path": path.encode("utf-8"), "query_string": query.encode("utf-8"),
                "root_path": "", "headers": headers, "client": ("127.0.0.1", 0),
                "server": ("127.0.0.1", 80), "gateway_remote_actor": actor,
            }

            async def receive():
                frame = await self._inbound.get()
                if frame.type == FrameType.cancel:
                    return {"type": "http.disconnect"}
                if frame.type != FrameType.http_request:
                    raise ValueError("Invalid managed HTTP body")
                phase = frame.payload.get("phase")
                if phase == "end":
                    return {"type": "http.request", "body": b"", "more_body": False}
                if phase != "body":
                    raise ValueError("Invalid managed HTTP body")
                data = frame.payload.get("data")
                if not isinstance(data, str) or len(data) > 32768:
                    raise ValueError("Invalid managed HTTP body size")
                return {"type": "http.request", "body": base64.b64decode(data, validate=True),
                        "more_body": True}

            async def send(message):
                nonlocal started
                if message["type"] == "http.response.start":
                    started = True
                    await self.send_frame(ProxyFrame(
                        stream_id=self.stream_id, type=FrameType.http_response,
                        payload={"phase": "start", "status": message["status"],
                                 "headers": [[key.decode("latin1"), value.decode("latin1")]
                                             for key, value in message.get("headers", [])]},
                    ))
                elif message["type"] == "http.response.body":
                    body = message.get("body", b"")
                    for offset in range(0, len(body), 16384):
                        await self.send_frame(ProxyFrame(
                            stream_id=self.stream_id, type=FrameType.http_response,
                            payload={"phase": "body", "data": base64.b64encode(
                                body[offset:offset + 16384],
                            ).decode()},
                        ))
                    if not message.get("more_body", False):
                        await self.send_frame(ProxyFrame(
                            stream_id=self.stream_id, type=FrameType.http_response,
                            payload={"phase": "end"},
                        ))

            await self.app(scope, receive, send)
        except asyncio.CancelledError:
            raise
        except Exception:
            if not started:
                await self.send_frame(ProxyFrame(
                    stream_id=self.stream_id, type=FrameType.http_response,
                    payload={"phase": "start", "status": 502, "headers": []},
                ))
            await self.send_frame(ProxyFrame(
                stream_id=self.stream_id, type=FrameType.http_response,
                payload={"phase": "end"},
            ))
