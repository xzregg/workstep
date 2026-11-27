"""Multiplexed ASGI HTTP + WebSocket bridge over a WebRTC DataChannel."""

from __future__ import annotations

import asyncio
import base64
import binascii
import hmac
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import unquote

from workstep_gateway_protocol import (
    FrameType,
    ProxyFrame,
    WebSocketMessageAssembler,
)
from workstep_gateway_protocol.webrtc import (
    DataChannelBinaryKind,
    decode_binary_frame,
    encode_binary_frame,
    valid_pair_key,
)

logger = logging.getLogger(__name__)

STREAM_CHUNK_BYTES = 16384
CREDIT_WINDOW = 32
MAX_STREAMS = 128


@dataclass(frozen=True)
class WebRtcRemoteActor:
    user_id: str
    username: str
    device_id: str
    app_instance_id: str = "webrtc-p2p"
    policy_revision: int = 0
    project_id: str | None = None
    project_access_level: str | None = None
    remote_task_create: bool = False
    display_name: str = "P2P Remote"
    provider_ids: frozenset[str] | None = None
    provider_grant_expires_at: int | None = None


class _BaseDataStream:
    def __init__(self, app: Any, stream_id: str, start: dict[str, Any], bridge: "WebRtcDataBridge") -> None:
        self.app = app
        self.stream_id = stream_id
        self.start = start
        self.bridge = bridge
        self._outbound_credits = asyncio.BoundedSemaphore(CREDIT_WINDOW)
        self._inbound: asyncio.Queue[Any] = asyncio.Queue(maxsize=CREDIT_WINDOW)
        self._task: asyncio.Task | None = None

    def start_task(self) -> None:
        self._task = asyncio.create_task(self._run_wrapper())

    async def _run_wrapper(self) -> None:
        try:
            await self._run()
        finally:
            self.bridge._retire_stream(self.stream_id, self)

    def grant_credit(self, credits: int = 1) -> None:
        for _ in range(max(1, min(credits, CREDIT_WINDOW))):
            try:
                self._outbound_credits.release()
            except ValueError:
                break

    async def feed(self, item: Any) -> None:
        await self._inbound.put(item)

    def cancel(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()

    async def wait_done(self) -> None:
        if self._task is not None:
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _run(self) -> None:
        raise NotImplementedError


def _sanitize_headers(raw_headers: Any, *, websocket: bool = False) -> list[tuple[bytes, bytes]]:
    if not isinstance(raw_headers, list):
        raise ValueError("Invalid headers")
    headers: list[tuple[bytes, bytes]] = [(b"host", b"127.0.0.1")]
    blocked = {"host", "cookie", "connection", "authorization", "forwarded", "x-forwarded-for", "x-forwarded-host"}
    if websocket:
        blocked.add("origin")
    for pair in raw_headers:
        if not isinstance(pair, list) or len(pair) != 2 or not all(isinstance(v, str) for v in pair):
            raise ValueError("Invalid header pair")
        name = pair[0].lower()
        if not name.isascii() or not name.replace("-", "").isalnum():
            continue
        if name in blocked or name.startswith("x-workstep-"):
            continue
        headers.append((name.encode("ascii"), pair[1].encode("latin1")))
    return headers


class _WebRtcHttpStream(_BaseDataStream):
    async def _run(self) -> None:
        started = False
        try:
            method = self.start.get("method")
            path = self.start.get("path")
            query = self.start.get("query", "")
            if (
                not isinstance(method, str)
                or not method.isascii()
                or not method.isalpha()
                or not isinstance(path, str)
                or not path.startswith("/")
                or path.startswith("//")
                or not isinstance(query, str)
            ):
                raise ValueError("Invalid WebRTC HTTP request")
            headers = _sanitize_headers(self.start.get("headers", []))
            actor = self.bridge.actor
            scope = {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": method.upper(),
                "scheme": "http",
                "path": unquote(path),
                "raw_path": path.encode("utf-8"),
                "query_string": query.encode("utf-8"),
                "root_path": "",
                "headers": headers,
                "client": ("192.0.2.1", 0),
                "server": ("127.0.0.1", 80),
                "webrtc_remote_actor": actor,
                "webrtc_device_owner": True,
                "webrtc_bridge_token": self.bridge.scope_token,
            }

            async def receive():
                item = await self._inbound.get()
                if isinstance(item, bytes):
                    return {"type": "http.request", "body": item, "more_body": True}
                if isinstance(item, tuple) and item[0] == "bin_body":
                    _, body, final = item
                    if final:
                        await self._inbound.put(("end",))
                    return {"type": "http.request", "body": body, "more_body": not final}
                if isinstance(item, tuple) and item[0] == "end":
                    return {"type": "http.request", "body": b"", "more_body": False}
                assert isinstance(item, ProxyFrame)
                if item.type == FrameType.cancel:
                    return {"type": "http.disconnect"}
                if item.type != FrameType.http_request:
                    raise ValueError("Invalid HTTP body frame")
                phase = item.payload.get("phase")
                if phase == "end":
                    return {"type": "http.request", "body": b"", "more_body": False}
                if phase != "body":
                    raise ValueError("Invalid HTTP body phase")
                data = item.payload.get("data", "")
                try:
                    body = base64.b64decode(data, validate=True)
                except (ValueError, binascii.Error) as exc:
                    raise ValueError("Invalid HTTP body encoding") from exc
                return {"type": "http.request", "body": body, "more_body": True}

            async def send(message):
                nonlocal started
                if message["type"] == "http.response.start":
                    started = True
                    await self.bridge.send_frame(
                        ProxyFrame(
                            stream_id=self.stream_id,
                            type=FrameType.http_response,
                            payload={
                                "phase": "start",
                                "status": message["status"],
                                "headers": [
                                    [key.decode("latin1"), value.decode("latin1")]
                                    for key, value in message.get("headers", [])
                                ],
                            },
                        )
                    )
                elif message["type"] == "http.response.body":
                    body = message.get("body", b"")
                    more = bool(message.get("more_body", False))
                    for offset in range(0, len(body), STREAM_CHUNK_BYTES):
                        await self._outbound_credits.acquire()
                        chunk = body[offset : offset + STREAM_CHUNK_BYTES]
                        is_last_chunk = (not more) and (offset + STREAM_CHUNK_BYTES >= len(body))
                        await self.bridge.send_binary(
                            DataChannelBinaryKind.http_response_body,
                            self.stream_id,
                            chunk,
                            final=is_last_chunk,
                        )
                    if not more:
                        await self.bridge.send_frame(
                            ProxyFrame(
                                stream_id=self.stream_id,
                                type=FrameType.http_response,
                                payload={"phase": "end"},
                            )
                        )

            await self.app(scope, receive, send)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("WebRTC HTTP bridge failed: %s (started=%s)", type(exc).__name__, started)
            if not started:
                await self.bridge.send_frame(
                    ProxyFrame(
                        stream_id=self.stream_id,
                        type=FrameType.http_response,
                        payload={"phase": "start", "status": 502, "headers": []},
                    )
                )
            await self.bridge.send_frame(
                ProxyFrame(
                    stream_id=self.stream_id,
                    type=FrameType.http_response,
                    payload={"phase": "error" if started else "end"},
                )
            )


class _WebRtcWebSocketStream(_BaseDataStream):
    async def _run(self) -> None:
        accepted = False
        closed = False
        first_receive = True
        assembler = WebSocketMessageAssembler()
        try:
            path = self.start.get("path")
            query = self.start.get("query", "")
            if not isinstance(path, str) or not path.startswith("/") or path.startswith("//") or not isinstance(query, str):
                raise ValueError("Invalid WebRTC WebSocket path")
            headers = _sanitize_headers(self.start.get("headers", []), websocket=True)
            scope = {
                "type": "websocket",
                "asgi": {"version": "3.0"},
                "scheme": "ws",
                "path": unquote(path),
                "raw_path": path.encode("utf-8"),
                "query_string": query.encode("utf-8"),
                "root_path": "",
                "headers": headers,
                "client": ("192.0.2.1", 0),
                "server": ("127.0.0.1", 80),
                "subprotocols": [],
                "webrtc_remote_actor": self.bridge.actor,
                "webrtc_device_owner": True,
                "webrtc_bridge_token": self.bridge.scope_token,
            }

            bin_kind: DataChannelBinaryKind | None = None
            bin_parts: list[bytes] = []

            async def receive():
                nonlocal first_receive, bin_kind, bin_parts
                if first_receive:
                    first_receive = False
                    return {"type": "websocket.connect"}
                while True:
                    item = await self._inbound.get()
                    if isinstance(item, tuple) and item[0] == "ws_bin":
                        _, kind, payload, final = item
                        if bin_kind is not None and kind != bin_kind:
                            raise ValueError("Mismatched binary WebSocket fragments")
                        bin_kind = kind
                        bin_parts.append(payload)
                        if not final:
                            continue
                        full = b"".join(bin_parts)
                        resolved_kind = bin_kind
                        bin_kind = None
                        bin_parts = []
                        if resolved_kind == DataChannelBinaryKind.websocket_data_text:
                            return {"type": "websocket.receive", "text": full.decode("utf-8")}
                        return {"type": "websocket.receive", "bytes": full}

                    assert isinstance(item, ProxyFrame)
                    if item.type in (FrameType.websocket_close, FrameType.cancel):
                        return {"type": "websocket.disconnect", "code": item.payload.get("code", 1000)}
                    if item.type != FrameType.websocket_data:
                        raise ValueError("Invalid WebSocket frame")
                    assembled = assembler.add(item.payload)
                    if assembled is None:
                        continue
                    kind_str, data = assembled
                    if kind_str == "text":
                        return {"type": "websocket.receive", "text": data.decode("utf-8")}
                    return {"type": "websocket.receive", "bytes": data}

            async def send(message):
                nonlocal accepted, closed
                if message["type"] == "websocket.accept":
                    accepted = True
                    await self.bridge.send_frame(
                        ProxyFrame(
                            stream_id=self.stream_id,
                            type=FrameType.websocket_open,
                            payload={"accepted": True, "subprotocol": message.get("subprotocol")},
                        )
                    )
                elif message["type"] == "websocket.send":
                    if message.get("text") is not None:
                        kind = DataChannelBinaryKind.websocket_data_text
                        data = message["text"].encode("utf-8")
                    else:
                        kind = DataChannelBinaryKind.websocket_data_bytes
                        data = message.get("bytes") or b""
                    if not data:
                        await self._outbound_credits.acquire()
                        await self.bridge.send_binary(kind, self.stream_id, b"", final=True)
                    else:
                        for offset in range(0, len(data), STREAM_CHUNK_BYTES):
                            await self._outbound_credits.acquire()
                            chunk = data[offset : offset + STREAM_CHUNK_BYTES]
                            is_final = offset + STREAM_CHUNK_BYTES >= len(data)
                            await self.bridge.send_binary(kind, self.stream_id, chunk, final=is_final)
                elif message["type"] == "websocket.close":
                    closed = True
                    await self.bridge.send_frame(
                        ProxyFrame(
                            stream_id=self.stream_id,
                            type=FrameType.websocket_close,
                            payload={"code": message.get("code", 1000)},
                        )
                    )

            await self.app(scope, receive, send)
        except asyncio.CancelledError:
            raise
        except Exception:
            if not accepted:
                await self.bridge.send_frame(
                    ProxyFrame(
                        stream_id=self.stream_id,
                        type=FrameType.websocket_open,
                        payload={"accepted": False},
                    )
                )
        finally:
            if accepted and not closed:
                try:
                    await self.bridge.send_frame(
                        ProxyFrame(
                            stream_id=self.stream_id,
                            type=FrameType.websocket_close,
                            payload={"code": 1000},
                        )
                    )
                except Exception:
                    pass


class WebRtcDataBridge:
    """Multiplexes HTTP and WebSocket streams over one authenticated DataChannel."""

    def __init__(
        self,
        *,
        app: Any,
        device_id: str,
        expected_ticket: str,
        verify_pair_key: Callable[[str], Awaitable[bool]],
        candidate_info: dict[str, Any],
        send_text: Callable[[str], Awaitable[None]],
        send_bytes: Callable[[bytes], Awaitable[None]],
        scope_token: object | None = None,
    ) -> None:
        self.app = app
        self.device_id = device_id
        self.expected_ticket = expected_ticket
        self._verify_pair_key = verify_pair_key
        self.authenticated = asyncio.Event()
        self.candidate_info = candidate_info
        self._send_text = send_text
        self._send_bytes = send_bytes
        if scope_token is None and hasattr(app, "state"):
            existing_token = getattr(app.state, "webrtc_scope_token", None)
            if existing_token is None:
                existing_token = object()
                app.state.webrtc_scope_token = existing_token
            scope_token = existing_token
        self.scope_token = scope_token
        self.actor = WebRtcRemoteActor(
            user_id="webrtc-p2p",
            username="webrtc-p2p",
            device_id=device_id,
        )
        self._authenticated = False
        self._streams: dict[str, _BaseDataStream] = {}
        self._closed = False

    def _retire_stream(self, stream_id: str, stream: _BaseDataStream) -> None:
        if self._streams.get(stream_id) is stream:
            self._streams.pop(stream_id, None)

    async def send_frame(self, frame: ProxyFrame) -> None:
        if not self._closed:
            await self._send_text(frame.model_dump_json())

    async def send_binary(
        self,
        kind: DataChannelBinaryKind,
        stream_id: str,
        payload: bytes,
        *,
        final: bool,
    ) -> None:
        if not self._closed:
            await self._send_bytes(encode_binary_frame(kind, stream_id, payload, final=final))

    async def handle_text(self, text: str) -> None:
        if self._closed or not text.strip():
            return
        try:
            raw = json.loads(text)
        except json.JSONDecodeError:
            return
        if not isinstance(raw, dict):
            return

        if not self._authenticated:
            if raw.get("type") != "p2p.auth":
                await self._send_text(json.dumps({"type": "p2p.error", "code": "unauthorized", "message": "Authentication required"}))
                return
            supplied = str(raw.get("ticket") or "")
            if not supplied or not hmac.compare_digest(supplied, self.expected_ticket):
                await self._send_text(json.dumps({"type": "p2p.error", "code": "unauthorized", "message": "Invalid P2P session ticket"}))
                return
            pair_key = raw.get("pair_key")
            if not valid_pair_key(pair_key) or not await self._verify_pair_key(pair_key):
                await self._send_text(json.dumps({"type": "p2p.error", "code": "unauthorized", "message": "Invalid device pairing key"}))
                return
            self._authenticated = True
            self.authenticated.set()
            await self._send_text(
                json.dumps({
                    "type": "p2p.ready",
                    "version": 1,
                    "device_id": self.device_id,
                    "candidate_info": self.candidate_info,
                })
            )
            return

        if raw.get("type") == "p2p.ping":
            await self._send_text(json.dumps({"type": "p2p.pong", "nonce": raw.get("nonce")}))
            return

        frame = ProxyFrame.model_validate(raw)
        stream = self._streams.get(frame.stream_id)
        if frame.type == FrameType.window_update:
            if stream is not None:
                stream.grant_credit(int(frame.payload.get("credits", 1)))
            return
        if frame.type == FrameType.cancel:
            if stream is not None:
                await stream.feed(frame)
                stream.cancel()
            return
        if frame.type == FrameType.http_request and frame.payload.get("phase") == "start":
            if len(self._streams) >= MAX_STREAMS:
                await self.send_frame(
                    ProxyFrame(
                        stream_id=frame.stream_id,
                        type=FrameType.http_response,
                        payload={"phase": "start", "status": 503, "headers": []},
                    )
                )
                await self.send_frame(
                    ProxyFrame(stream_id=frame.stream_id, type=FrameType.http_response, payload={"phase": "end"})
                )
                return
            http_stream = _WebRtcHttpStream(self.app, frame.stream_id, frame.payload, self)
            self._streams[frame.stream_id] = http_stream
            http_stream.start_task()
            return
        if frame.type == FrameType.websocket_open:
            if len(self._streams) >= MAX_STREAMS:
                await self.send_frame(
                    ProxyFrame(stream_id=frame.stream_id, type=FrameType.websocket_open, payload={"accepted": False})
                )
                return
            ws_stream = _WebRtcWebSocketStream(self.app, frame.stream_id, frame.payload, self)
            self._streams[frame.stream_id] = ws_stream
            ws_stream.start_task()
            return
        if stream is not None:
            await stream.feed(frame)

    async def handle_bytes(self, raw: bytes) -> None:
        if self._closed or not self._authenticated:
            return
        kind, stream_id, final, payload = decode_binary_frame(raw)
        stream = self._streams.get(stream_id)
        if stream is None:
            return
        if kind == DataChannelBinaryKind.http_request_body:
            await stream.feed(("bin_body", payload, final))
        elif kind in (DataChannelBinaryKind.websocket_data_bytes, DataChannelBinaryKind.websocket_data_text):
            await stream.feed(("ws_bin", kind, payload, final))

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        streams = list(self._streams.values())
        self._streams.clear()
        for stream in streams:
            stream.cancel()
        if streams:
            await asyncio.gather(*(stream.wait_done() for stream in streams), return_exceptions=True)
