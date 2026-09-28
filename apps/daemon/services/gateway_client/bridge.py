"""Dispatch trusted Gateway HTTP frames into the existing ASGI application."""

import asyncio
import base64
from urllib.parse import unquote

from workstep_gateway_protocol import (FrameType, ProxyFrame,
                                       WebSocketMessageAssembler, websocket_payloads)

from .identity import ManagedActor
from .share_ticket import verify_share_ticket


class ManagedHttpBridge:
    def __init__(self, app, stream_id: str, start: dict, send_frame, device_id: str,
                 *, gateway_key: str | None = None,
                 gateway_fingerprint: str | None = None,
                 gateway_id: str | None = None):
        self.app = app
        self.stream_id = stream_id
        self.send_frame = send_frame
        self.device_id = device_id
        self.gateway_key = gateway_key
        self.gateway_fingerprint = gateway_fingerprint
        self.gateway_id = gateway_id
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
            display_name = self.start.get("display_name", username)
            user_id = self.start.get("user_id")
            project_id = self.start.get("project_id")
            access_level = self.start.get("access_level")
            task_create = self.start.get("task_create", False)
            share_ticket = self.start.get("share_ticket")
            share_scope = None
            if share_ticket is not None:
                if (not isinstance(share_ticket, str)
                        or not self.gateway_key or not self.gateway_fingerprint
                        or not self.gateway_id
                        or any(self.start.get(name) is not None for name in (
                            "user_id", "username", "display_name", "project_id",
                            "access_level")) or task_create is not False):
                    raise ValueError("Invalid managed share request")
                share_scope = verify_share_ticket(
                    share_ticket, self.gateway_key, self.gateway_fingerprint,
                    self.gateway_id, self.device_id,
                )
                user_id = f"share:{share_scope['share_id']}"
                username = "share-visitor"
                display_name = "Share visitor"
            raw_headers = self.start.get("headers", [])
            if (not isinstance(method, str) or not method.isascii() or not method.isalpha()
                    or not isinstance(path, str) or not path.startswith("/")
                    or path.startswith("//") or path.startswith("/api/managed")
                    or not isinstance(query, str) or not isinstance(username, str)
                    or not isinstance(user_id, str) or not user_id or not username
                    or not isinstance(display_name, str) or not display_name.strip()
                    or len(display_name) > 256
                    or (project_id is not None and (
                        not isinstance(project_id, str) or not project_id
                        or len(project_id) > 128 or access_level not in ("read", "edit")))
                    or (project_id is None and access_level is not None)
                    or type(task_create) is not bool
                    or (project_id is None and task_create)
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
            actor = ManagedActor(user_id, username, self.device_id, "gateway-remote", 0,
                                 project_id, access_level, task_create, display_name)
            scope = {
                "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                "method": method.upper(), "scheme": "http", "path": unquote(path),
                "raw_path": path.encode("utf-8"), "query_string": query.encode("utf-8"),
                "root_path": "", "headers": headers, "client": ("127.0.0.1", 0),
                "server": ("127.0.0.1", 80), "gateway_remote_actor": actor,
            }
            if share_scope is not None:
                scope["gateway_share_scope"] = share_scope

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


class ManagedWebSocketBridge:
    def __init__(self, app, stream_id: str, start: dict, send_frame, device_id: str):
        self.app = app
        self.stream_id = stream_id
        self.start = start
        self.send_frame = send_frame
        self.device_id = device_id
        self._inbound: asyncio.Queue = asyncio.Queue(maxsize=32)
        self._task: asyncio.Task | None = None

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
        accepted = False
        closed = False
        first_receive = True
        assembler = WebSocketMessageAssembler()
        try:
            path = self.start.get("path")
            query = self.start.get("query", "")
            username = self.start.get("username")
            display_name = self.start.get("display_name", username)
            user_id = self.start.get("user_id")
            project_id = self.start.get("project_id")
            access_level = self.start.get("access_level")
            task_create = self.start.get("task_create", False)
            raw_headers = self.start.get("headers", [])
            if (not isinstance(path, str) or not path.startswith("/") or path.startswith("//")
                    or not isinstance(query, str) or not isinstance(username, str)
                    or not isinstance(user_id, str) or not username or not user_id
                    or not isinstance(display_name, str) or not display_name.strip()
                    or len(display_name) > 256
                    or (project_id is not None and (
                        not isinstance(project_id, str) or not project_id
                        or len(project_id) > 128 or access_level not in ("read", "edit")))
                    or (project_id is None and access_level is not None)
                    or type(task_create) is not bool
                    or (project_id is None and task_create)
                    or not isinstance(raw_headers, list)):
                raise ValueError("Invalid managed WebSocket request")
            headers = [(b"host", b"127.0.0.1")]
            for pair in raw_headers:
                if not isinstance(pair, list) or len(pair) != 2 or not all(isinstance(v, str) for v in pair):
                    raise ValueError("Invalid managed WebSocket headers")
                name = pair[0].lower()
                if (not name.isascii() or not name.replace("-", "").isalnum()
                        or name in ("host", "cookie", "authorization", "origin")
                        or name.startswith("x-workstep-")):
                    continue
                headers.append((name.encode("ascii"), pair[1].encode("latin1")))
            actor = ManagedActor(user_id, username, self.device_id, "gateway-remote", 0,
                                 project_id, access_level, task_create, display_name)
            scope = {
                "type": "websocket", "asgi": {"version": "3.0"}, "scheme": "ws",
                "path": unquote(path), "raw_path": path.encode("utf-8"),
                "query_string": query.encode("utf-8"), "root_path": "",
                "headers": headers, "client": ("127.0.0.1", 0),
                "server": ("127.0.0.1", 80), "subprotocols": [],
                "gateway_remote_actor": actor,
            }

            async def receive():
                nonlocal first_receive
                if first_receive:
                    first_receive = False
                    return {"type": "websocket.connect"}
                while True:
                    frame = await self._inbound.get()
                    if frame.type in (FrameType.websocket_close, FrameType.cancel):
                        return {"type": "websocket.disconnect", "code": frame.payload.get("code", 1000)}
                    if frame.type != FrameType.websocket_data:
                        raise ValueError("Invalid managed WebSocket data")
                    message = assembler.add(frame.payload)
                    if message is None:
                        continue
                    kind, data = message
                    if kind == "text":
                        return {"type": "websocket.receive", "text": data.decode("utf-8")}
                    return {"type": "websocket.receive", "bytes": data}

            async def send(message):
                nonlocal accepted, closed
                if message["type"] == "websocket.accept":
                    accepted = True
                    await self.send_frame(ProxyFrame(
                        stream_id=self.stream_id, type=FrameType.websocket_open,
                        payload={"accepted": True,
                                 "subprotocol": message.get("subprotocol")},
                    ))
                elif message["type"] == "websocket.send":
                    if message.get("text") is not None:
                        kind, data = "text", message["text"].encode("utf-8")
                    else:
                        kind, data = "bytes", message.get("bytes") or b""
                    for payload in websocket_payloads(kind, data):
                        await self.send_frame(ProxyFrame(
                            stream_id=self.stream_id, type=FrameType.websocket_data,
                            payload=payload,
                        ))
                elif message["type"] == "websocket.close":
                    closed = True
                    await self.send_frame(ProxyFrame(
                        stream_id=self.stream_id, type=FrameType.websocket_close,
                        payload={"code": message.get("code", 1000)},
                    ))

            await self.app(scope, receive, send)
        except asyncio.CancelledError:
            raise
        except Exception:
            if not accepted:
                await self.send_frame(ProxyFrame(
                    stream_id=self.stream_id, type=FrameType.websocket_open,
                    payload={"accepted": False},
                ))
        finally:
            if accepted and not closed:
                try:
                    await self.send_frame(ProxyFrame(
                        stream_id=self.stream_id, type=FrameType.websocket_close,
                        payload={"code": 1000},
                    ))
                except Exception:
                    pass
