"""Authenticated outbound PC control WebSocket and connection presence."""

import asyncio
import base64
import binascii
import hashlib
import json
import secrets
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import anyio
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PublicKey
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from fastapi.responses import StreamingResponse
from workstep_gateway_protocol import (FrameType, ProxyFrame,
                                       WebSocketMessageAssembler, websocket_payloads)

from .models import (Device, DeviceConnection, DeviceProjectSkillState,
                     DeviceProviderApplication, PlatformProject, User, UserDevice)
from .capabilities import compiled_device_policy
from .providers_api import compile_provider_bundle, compiled_provider_access
from .device_commands import next_command_for_device, record_command_result
from .usage_ledger import record_usage_batch
from .audit_ledger import record_audit_batch
from .skills_api import compile_skill_manifest
from .project_publication import record_project_publication

router = APIRouter()


def _decode(value: str) -> bytes:
    if not value or len(value) > 8192 or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-" for c in value):
        raise ValueError("Invalid control credential encoding")
    return base64.urlsafe_b64decode(value + "===")


async def binding_active(ws: WebSocket, device_id: str, user_id: str) -> bool:
    async with ws.app.state.database.session() as session:
        device = await session.get(Device, device_id)
        user = await session.get(User, user_id)
        assignment = await session.scalar(select(UserDevice).where(
            UserDevice.device_id == device_id,
            UserDevice.user_id == user_id,
            UserDevice.revoked_at.is_(None),
        ))
    return bool(device and device.status == "active" and user and user.status == "active"
                and assignment)


async def _signed_command(ws: WebSocket, device_id: str) -> dict | None:
    command = await next_command_for_device(
        ws.app.state.database, ws.app.state.command_scheduler_lock, device_id,
    )
    if command is None:
        return None
    token = ws.app.state.gateway_signer.sign_device_command(
        gateway_id=ws.app.state.settings.gateway_id, **command,
    )
    return {"kind": "device_command", "version": 1, "device_id": device_id,
            "token": token}


async def authenticate_device(ws: WebSocket, message: dict, nonce: str) -> tuple[str, str, str]:
    token = message.get("authorization")
    delegation = message.get("control_delegation_signature")
    challenge_proof = message.get("control_challenge_proof")
    control_public_key_pem = message.get("control_public_key_pem")
    config_public_key_pem = message.get("config_public_key_pem")
    config_key_proof = message.get("config_key_proof")
    if (not isinstance(token, str) or not isinstance(delegation, str)
            or not isinstance(challenge_proof, str) or not isinstance(control_public_key_pem, str)
            or not isinstance(config_public_key_pem, str) or not isinstance(config_key_proof, str)
            or len(token) > 16384 or len(control_public_key_pem) > 4096
            or len(config_public_key_pem) > 4096):
        raise ValueError("Missing control credential")
    try:
        header, payload, signature = token.split(".")
        if json.loads(_decode(header)) != {"alg": "EdDSA", "typ": "JWT"}:
            raise ValueError("Invalid control credential header")
        signer = ws.app.state.gateway_signer
        signer.private_key.public_key().verify(_decode(signature), f"{header}.{payload}".encode())
        claims = json.loads(_decode(payload))
        now = int(time.time())
        if (claims.get("gateway_id") != ws.app.state.settings.gateway_id
                or claims.get("iss") != ws.app.state.settings.gateway_id
                or not isinstance(claims.get("iat"), int)
                or not isinstance(claims.get("exp"), int)
                or claims["iat"] > now + 60 or claims["exp"] <= now
                or claims["exp"] - claims["iat"] > 900):
            raise ValueError("Expired control credential")
        device_id = claims["device_id"]
        public_key_pem = claims["device_public_key"]
        device_key = serialization.load_pem_public_key(public_key_pem.encode())
        if not isinstance(device_key, Ed25519PublicKey):
            raise ValueError("Invalid device key")
        control_key = serialization.load_pem_public_key(control_public_key_pem.encode())
        if not isinstance(control_key, Ed25519PublicKey):
            raise ValueError("Invalid delegated control key")
        control_fingerprint = hashlib.sha256(control_key.public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
        )).hexdigest()
        device_key.verify(_decode(delegation),
                          f"workstep-control-delegate-v1:{token}:{control_fingerprint}".encode())
        control_key.verify(_decode(challenge_proof),
                           f"workstep-control-challenge-v1:{nonce}:{token}".encode())
        config_key = serialization.load_pem_public_key(config_public_key_pem.encode())
        if not isinstance(config_key, X25519PublicKey):
            raise ValueError("Invalid config encryption key")
        config_fingerprint = hashlib.sha256(config_key.public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
        )).hexdigest()
        control_key.verify(_decode(config_key_proof),
                           f"workstep-config-key-v1:{nonce}:{token}:{config_fingerprint}".encode())
        fingerprint = hashlib.sha256(device_key.public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
        )).hexdigest()
    except (KeyError, TypeError, ValueError, binascii.Error, InvalidSignature,
            UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Invalid control credential") from exc
    async with ws.app.state.database.session() as session:
        device = await session.get(Device, device_id)
        user = await session.get(User, claims.get("user_id"))
        assignment = await session.scalar(select(UserDevice).where(
            UserDevice.device_id == device_id,
            UserDevice.user_id == claims.get("user_id"),
            UserDevice.revoked_at.is_(None),
        ))
    if (not device or device.status != "active" or device.public_key_fingerprint != fingerprint
            or device.app_instance_id != claims.get("app_instance_id")
            or not user or user.status != "active" or not assignment):
        raise ValueError("Device or user unavailable")
    return device_id, user.id, config_public_key_pem


class ControlConnections:
    def __init__(self):
        self._active: dict[str, tuple[str, WebSocket, asyncio.Task]] = {}
        self._data_active: dict[str, DataConnection] = {}
        self._pending_data: dict[str, tuple[str, float, asyncio.Future]] = {}
        self._device_pending: dict[str, str] = {}
        self._config_keys: dict[str, str] = {}
        self._daemon_health: dict[str, bool] = {}
        self._project_runtime: dict[str, tuple[float, dict[str, int]]] = {}
        self._pending_project_catalog: dict[str, tuple[str, asyncio.Future]] = {}
        self._pending_provider_tests: dict[str, tuple[str, asyncio.Future]] = {}
        self._control_users: dict[str, str] = {}
        self._control_senders: dict[str, Callable[[dict], Awaitable[None]]] = {}
        self._lock = asyncio.Lock()

    def is_online(self, device_id: str) -> bool:
        return device_id in self._active

    def active_user(self, device_id: str) -> str | None:
        return self._control_users.get(device_id) if self.is_online(device_id) else None

    def connected_users(self) -> dict[str, str]:
        return {device_id: user_id for device_id, user_id in self._control_users.items()
                if self.is_online(device_id)}

    def daemon_health(self, device_id: str) -> bool | None:
        if not self.is_online(device_id):
            return None
        return self._daemon_health.get(device_id)

    def update_daemon_health(self, device_id: str, healthy: bool | None) -> None:
        if device_id not in self._active:
            return
        if healthy is None:
            self._daemon_health.pop(device_id, None)
        else:
            self._daemon_health[device_id] = healthy

    def running_tasks(self, device_id: str, host_project_id: str) -> int | None:
        if not self.is_online(device_id):
            return None
        snapshot = self._project_runtime.get(device_id)
        if snapshot is None or time.monotonic() - snapshot[0] > 60:
            return None
        return snapshot[1].get(host_project_id)

    def update_project_runtime(self, device_id: str, connection_id: str,
                               projects: list[dict]) -> None:
        if self._active.get(device_id, (None,))[0] != connection_id:
            return
        self._project_runtime[device_id] = (
            time.monotonic(), {item["id"]: item["running_tasks"] for item in projects},
        )

    async def claim(self, device_id: str, user_id: str, connection_id: str, ws: WebSocket,
                    config_public_key_pem: str,
                    send_json: Callable[[dict], Awaitable[None]]) -> None:
        async with self._lock:
            previous = self._active.get(device_id)
            self._active[device_id] = (connection_id, ws, asyncio.current_task())
            self._control_users[device_id] = user_id
            self._config_keys[device_id] = config_public_key_pem
            self._control_senders[device_id] = send_json
            self._daemon_health.pop(device_id, None)
            self._project_runtime.pop(device_id, None)
            if previous:
                for request_id, (pending_device, future) in list(self._pending_project_catalog.items()):
                    if pending_device == device_id:
                        self._pending_project_catalog.pop(request_id)
                        if not future.done():
                            future.set_exception(ConnectionError("Control connection replaced"))
                for request_id, (pending_device, future) in list(self._pending_provider_tests.items()):
                    if pending_device == device_id:
                        self._pending_provider_tests.pop(request_id)
                        if not future.done():
                            future.set_exception(ConnectionError("Control connection replaced"))
        if previous:
            try:
                await previous[1].close(code=4000, reason="Replaced by new connection")
            except (RuntimeError, anyio.ClosedResourceError):
                pass

    async def release(self, device_id: str, connection_id: str) -> None:
        async with self._lock:
            if self._active.get(device_id, (None,))[0] == connection_id:
                self._active.pop(device_id, None)
                self._control_users.pop(device_id, None)
                self._config_keys.pop(device_id, None)
                self._control_senders.pop(device_id, None)
                self._daemon_health.pop(device_id, None)
                self._project_runtime.pop(device_id, None)
                for request_id, (pending_device, future) in list(self._pending_project_catalog.items()):
                    if pending_device == device_id:
                        self._pending_project_catalog.pop(request_id)
                        if not future.done():
                            future.set_exception(ConnectionError("Control connection closed"))
                for request_id, (pending_device, future) in list(self._pending_provider_tests.items()):
                    if pending_device == device_id:
                        self._pending_provider_tests.pop(request_id)
                        if not future.done():
                            future.set_exception(ConnectionError("Control connection closed"))
                pending_token = self._device_pending.pop(device_id, None)
                if pending_token:
                    pending = self._pending_data.pop(pending_token, None)
                    if pending and not pending[2].done():
                        pending[2].set_exception(ConnectionError("Control connection closed"))
                data = self._data_active.pop(device_id, None)
            else:
                data = None
        if data:
            try:
                await data.socket.close(code=4003, reason="Control connection closed")
            except (RuntimeError, anyio.ClosedResourceError):
                pass

    async def request_data(self, device_id: str) -> "DataConnection":
        async with self._lock:
            if device_id not in self._active:
                raise ConnectionError("Device is offline")
            active = self._data_active.get(device_id)
            if active:
                return active
            pending_token = self._device_pending.get(device_id)
            if pending_token:
                future = self._pending_data[pending_token][2]
                command = None
            else:
                pending_token = secrets.token_urlsafe(32)
                future = asyncio.get_running_loop().create_future()
                self._pending_data[pending_token] = (device_id, time.monotonic() + 10, future)
                self._device_pending[device_id] = pending_token
                command = {"kind": "open_data", "version": 1, "device_id": device_id,
                           "token": pending_token}
            control = self._control_senders[device_id]
        if command:
            try:
                await control(command)
            except Exception:
                async with self._lock:
                    self._pending_data.pop(pending_token, None)
                    self._device_pending.pop(device_id, None)
                if not future.done():
                    future.cancel()
                raise
        try:
            return await asyncio.wait_for(asyncio.shield(future), timeout=10)
        finally:
            if not future.done():
                async with self._lock:
                    self._pending_data.pop(pending_token, None)
                    self._device_pending.pop(device_id, None)
                future.cancel()

    async def request_project_catalog(self, device_id: str) -> list[dict]:
        request_id = uuid4().hex
        future = asyncio.get_running_loop().create_future()
        async with self._lock:
            active = self._active.get(device_id)
            if active is None:
                raise ConnectionError("Device is offline")
            if any(pending_device == device_id for pending_device, _ in self._pending_project_catalog.values()):
                raise ConnectionError("Project catalog request already pending")
            self._pending_project_catalog[request_id] = (device_id, future)
            send_json = self._control_senders[device_id]
        try:
            await send_json({"kind": "project_catalog_request", "version": 1,
                             "device_id": device_id, "request_id": request_id})
            return await asyncio.wait_for(future, timeout=10)
        finally:
            async with self._lock:
                self._pending_project_catalog.pop(request_id, None)
            if not future.done():
                future.cancel()

    async def complete_project_catalog(self, device_id: str, request_id: str,
                                       projects: list[dict] | None) -> None:
        async with self._lock:
            pending = self._pending_project_catalog.get(request_id)
            if pending is None or pending[0] != device_id or pending[1].done():
                return
            if projects is None:
                pending[1].set_exception(ConnectionError("Project catalog unavailable"))
            else:
                pending[1].set_result(projects)

    async def request_provider_test(self, device_id: str, provider_id: str) -> dict:
        request_id = uuid4().hex
        future = asyncio.get_running_loop().create_future()
        async with self._lock:
            if device_id not in self._active:
                raise ConnectionError("Device is offline")
            if any(pending_device == device_id for pending_device, _ in self._pending_provider_tests.values()):
                raise ConnectionError("Provider test already pending")
            self._pending_provider_tests[request_id] = (device_id, future)
            send_json = self._control_senders[device_id]
        try:
            await send_json({"kind": "provider_test_request", "version": 1,
                             "device_id": device_id, "request_id": request_id,
                             "provider_id": provider_id})
            return await asyncio.wait_for(future, timeout=20)
        finally:
            async with self._lock:
                self._pending_provider_tests.pop(request_id, None)
            if not future.done():
                future.cancel()

    async def complete_provider_test(self, device_id: str, request_id: str,
                                     result: dict) -> None:
        async with self._lock:
            pending = self._pending_provider_tests.get(request_id)
            if pending and pending[0] == device_id and not pending[1].done():
                pending[1].set_result(result)

    async def attach_data(self, token: str, socket: WebSocket) -> "DataConnection | None":
        async with self._lock:
            pending = self._pending_data.pop(token, None)
            if not pending:
                return None
            device_id, expires_at, future = pending
            self._device_pending.pop(device_id, None)
            if time.monotonic() > expires_at or device_id not in self._active:
                if not future.done():
                    future.set_exception(ConnectionError("Data token expired"))
                return None
            connection = DataConnection(device_id, socket)
            self._data_active[device_id] = connection
            connection.ready_future = future
            return connection

    def data_ready(self, connection: "DataConnection") -> None:
        if connection.ready_future is not None and not connection.ready_future.done():
            connection.ready_future.set_result(connection)

    async def release_data(self, connection: "DataConnection") -> None:
        async with self._lock:
            if self._data_active.get(connection.device_id) is connection:
                self._data_active.pop(connection.device_id, None)
        if connection.ready_future is not None and not connection.ready_future.done():
            connection.ready_future.set_exception(ConnectionError("Data connection closed"))
        connection.fail_streams(ConnectionError("Data connection closed"))

    async def shutdown(self) -> None:
        async with self._lock:
            active = list(self._active.values())
            data = list(self._data_active.values())
        for connection in data:
            try:
                await connection.socket.close(code=1001, reason="Gateway shutting down")
            except (RuntimeError, anyio.ClosedResourceError):
                pass
        for _, ws, _ in active:
            try:
                await ws.close(code=1001, reason="Gateway shutting down")
            except (RuntimeError, anyio.ClosedResourceError):
                pass
        if active:
            await asyncio.gather(*(task for _, _, task in active), return_exceptions=True)

    async def disconnect(self, device_id: str) -> None:
        async with self._lock:
            active = self._active.get(device_id)
            data = self._data_active.get(device_id)
        if data:
            try:
                await data.socket.close(code=4003, reason="Device disabled or revoked")
            except (RuntimeError, anyio.ClosedResourceError):
                pass
        if active:
            try:
                await active[1].close(code=4003, reason="Device disabled or revoked")
            except (RuntimeError, anyio.ClosedResourceError):
                pass

    async def close_data(self, device_id: str) -> None:
        async with self._lock:
            data = self._data_active.get(device_id)
        if data:
            try:
                await data.socket.close(code=4003, reason="Device access changed")
            except (RuntimeError, anyio.ClosedResourceError):
                pass

    def config_key(self, device_id: str) -> str | None:
        return self._config_keys.get(device_id)


class DataConnection:
    def __init__(self, device_id: str, socket: WebSocket):
        self.device_id = device_id
        self.socket = socket
        self.ready_future: asyncio.Future | None = None
        self._send_lock = asyncio.Lock()
        self._streams: dict[str, asyncio.Queue] = {}

    async def send_frame(self, frame: ProxyFrame) -> None:
        async with self._send_lock:
            await self.socket.send_json(frame.model_dump(mode="json"))

    async def deliver(self, frame: ProxyFrame) -> None:
        queue = self._streams.get(frame.stream_id)
        if queue is not None:
            await queue.put(frame)

    def fail_streams(self, error: Exception) -> None:
        for queue in self._streams.values():
            try:
                queue.put_nowait(error)
            except asyncio.QueueFull:
                queue.get_nowait()
                queue.put_nowait(error)

    async def proxy_http(self, request, *, user_id: str | None = None,
                         username: str | None = None,
                         display_name: str | None = None,
                         project_id: str | None = None,
                         access_level: str | None = None,
                         task_create: bool = False,
                         share_ticket: str | None = None,
                         target_path: str | None = None,
                         authorization_check=None):
        if share_ticket is not None:
            if (not isinstance(share_ticket, str) or not share_ticket
                    or target_path not in ("/api/platform-share/task",
                                           "/api/platform-share/history")
                    or request.method != "GET"
                    or user_id is not None or username is not None
                    or project_id is not None or access_level is not None
                    or task_create):
                raise ValueError("Invalid share proxy scope")
        elif (not user_id or not username or target_path is not None):
            raise ValueError("Invalid managed proxy identity")
        if (project_id is None) != (access_level is None) or (
                access_level is not None and access_level not in ("read", "edit")) or (
                type(task_create) is not bool or (project_id is None and task_create)):
            raise ValueError("Invalid project proxy scope")
        if len(self._streams) >= 32:
            raise ConnectionError("Too many managed data streams")
        if authorization_check is not None:
            await authorization_check()
        stream_id = uuid4().hex
        queue: asyncio.Queue = asyncio.Queue(maxsize=32)
        self._streams[stream_id] = queue

        async def checked_get(timeout: float):
            deadline = asyncio.get_running_loop().time() + timeout
            while True:
                if authorization_check is not None:
                    await authorization_check()
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise asyncio.TimeoutError()
                try:
                    frame = await asyncio.wait_for(queue.get(), timeout=min(1, remaining))
                    if authorization_check is not None:
                        await authorization_check()
                    return frame
                except asyncio.TimeoutError:
                    continue

        async def upload():
            headers = [[key.decode("latin1"), value.decode("latin1")]
                       for key, value in request.scope["headers"]
                       if key.lower() not in (b"host", b"cookie", b"connection",
                                              b"x-workstep-actor-id", b"x-workstep-actor-name",
                                              b"x-workstep-actor-device-id", b"x-workstep-actor-device-name")]
            start_payload = {"phase": "start", "method": request.method,
                             "path": target_path or request.url.path,
                             "query": "" if share_ticket else request.url.query,
                             "headers": headers}
            if share_ticket is not None:
                start_payload["share_ticket"] = share_ticket
            else:
                start_payload.update({
                    "user_id": user_id, "username": username,
                    "display_name": display_name or username,
                    "project_id": project_id, "access_level": access_level,
                    "task_create": task_create,
                })
            await self.send_frame(ProxyFrame(
                stream_id=stream_id, type=FrameType.http_request,
                payload=start_payload,
            ))
            async for chunk in request.stream():
                for offset in range(0, len(chunk), 16384):
                    if authorization_check is not None:
                        await authorization_check()
                    await self.send_frame(ProxyFrame(
                        stream_id=stream_id, type=FrameType.http_request,
                        payload={"phase": "body", "data": base64.b64encode(
                            chunk[offset:offset + 16384],
                        ).decode()},
                    ))
            await self.send_frame(ProxyFrame(
                stream_id=stream_id, type=FrameType.http_request, payload={"phase": "end"},
            ))

        upload_task = asyncio.create_task(upload())
        try:
            first = await checked_get(30)
            if isinstance(first, Exception):
                raise first
            if first.type != FrameType.http_response or first.payload.get("phase") != "start":
                raise ValueError("Invalid proxy response")
            status = first.payload.get("status")
            if type(status) is not int or status < 100 or status > 599:
                raise ValueError("Invalid proxy status")
            response_headers = first.payload.get("headers", [])
            if not isinstance(response_headers, list):
                raise ValueError("Invalid proxy headers")

            async def body():
                try:
                    while True:
                        frame = await checked_get(60)
                        if isinstance(frame, Exception):
                            raise frame
                        if frame.type != FrameType.http_response:
                            raise ValueError("Invalid proxy frame")
                        phase = frame.payload.get("phase")
                        if phase == "end":
                            break
                        if phase != "body":
                            raise ValueError("Invalid proxy body frame")
                        yield base64.b64decode(frame.payload["data"], validate=True)
                finally:
                    upload_task.cancel()
                    self._streams.pop(stream_id, None)
                    try:
                        await self.send_frame(ProxyFrame(
                            stream_id=stream_id, type=FrameType.cancel, payload={},
                        ))
                    except Exception:
                        pass

            response = StreamingResponse(body(), status_code=status)
            remote_host = request.headers.get("host", "")
            for pair in response_headers:
                if (isinstance(pair, list) and len(pair) == 2
                        and all(isinstance(item, str) for item in pair)
                        and pair[0].lower() not in ("connection", "transfer-encoding",
                                                    "content-length", "set-cookie",
                                                    "content-security-policy",
                                                    "access-control-allow-origin")):
                    value = pair[1]
                    if pair[0].lower() == "location":
                        parsed = urlsplit(value)
                        if parsed.hostname in ("127.0.0.1", "localhost"):
                            value = urlunsplit(("https", remote_host, parsed.path,
                                                parsed.query, parsed.fragment))
                    response.headers.append(pair[0], value)
            response.headers["Content-Security-Policy"] = "; ".join((
                "default-src 'self'", "script-src 'self' 'unsafe-inline'",
                "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https:",
                "font-src 'self' data:", f"connect-src 'self' wss://{remote_host}",
                "object-src 'none'", "base-uri 'self'", "form-action 'self'",
                "frame-ancestors 'none'",
            ))
            return response
        except Exception:
            upload_task.cancel()
            self._streams.pop(stream_id, None)
            raise

    async def proxy_websocket(self, browser: WebSocket, *, user_id: str,
                              username: str, display_name: str | None = None,
                              project_id: str | None = None,
                              access_level: str | None = None,
                              authorization_check=None) -> None:
        if (project_id is None) != (access_level is None) or (
                access_level is not None and access_level not in ("read", "edit")):
            raise ValueError("Invalid project proxy scope")
        if len(self._streams) >= 32:
            await browser.close(code=1013)
            return
        if authorization_check is not None:
            try:
                await authorization_check()
            except Exception:
                await browser.close(code=4403)
                return
        stream_id = uuid4().hex
        queue: asyncio.Queue = asyncio.Queue(maxsize=32)
        self._streams[stream_id] = queue
        tasks: list[asyncio.Task] = []
        headers = [[key.decode("latin1"), value.decode("latin1")]
                   for key, value in browser.scope["headers"]
                   if key.lower() not in (b"host", b"cookie", b"connection",
                                          b"sec-websocket-key", b"sec-websocket-version")
                   and not key.lower().startswith(b"x-workstep-")]
        try:
            await self.send_frame(ProxyFrame(
                stream_id=stream_id, type=FrameType.websocket_open,
                payload={"phase": "start", "path": browser.url.path,
                         "query": browser.url.query, "headers": headers,
                         "user_id": user_id, "username": username,
                         "display_name": display_name or username,
                         "project_id": project_id, "access_level": access_level},
            ))
            opened = await asyncio.wait_for(queue.get(), timeout=15)
            if (isinstance(opened, Exception) or opened.type != FrameType.websocket_open
                    or opened.payload.get("accepted") is not True):
                await browser.close(code=4403)
                return
            subprotocol = opened.payload.get("subprotocol")
            await browser.accept(subprotocol=subprotocol if isinstance(subprotocol, str) else None)

            async def browser_to_pc():
                while True:
                    message = await browser.receive()
                    if message["type"] == "websocket.disconnect":
                        await self.send_frame(ProxyFrame(
                            stream_id=stream_id, type=FrameType.websocket_close,
                            payload={"code": message.get("code", 1000)},
                        ))
                        return
                    if message["type"] != "websocket.receive":
                        continue
                    if message.get("text") is not None:
                        kind, data = "text", message["text"].encode("utf-8")
                    else:
                        kind, data = "bytes", message.get("bytes") or b""
                    for payload in websocket_payloads(kind, data):
                        await self.send_frame(ProxyFrame(
                            stream_id=stream_id, type=FrameType.websocket_data,
                            payload=payload,
                        ))

            async def pc_to_browser():
                assembler = WebSocketMessageAssembler()
                while True:
                    frame = await queue.get()
                    if isinstance(frame, Exception):
                        raise frame
                    if frame.type == FrameType.websocket_close:
                        await browser.close(code=frame.payload.get("code", 1000))
                        return
                    if frame.type != FrameType.websocket_data:
                        raise ValueError("Invalid managed WebSocket frame")
                    message = assembler.add(frame.payload)
                    if message is None:
                        continue
                    kind, data = message
                    if kind == "text":
                        await browser.send_text(data.decode("utf-8"))
                    else:
                        await browser.send_bytes(data)

            async def watch_authorization():
                while True:
                    await asyncio.sleep(1)
                    try:
                        await authorization_check()
                    except Exception:
                        await browser.close(code=4403)
                        return

            tasks = [asyncio.create_task(browser_to_pc()), asyncio.create_task(pc_to_browser())]
            if authorization_check is not None:
                tasks.append(asyncio.create_task(watch_authorization()))
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            for task in done:
                if task.exception():
                    raise task.exception()
        finally:
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            self._streams.pop(stream_id, None)
            try:
                await self.send_frame(ProxyFrame(
                    stream_id=stream_id, type=FrameType.cancel, payload={},
                ))
            except Exception:
                pass


@router.websocket("/api/data/ws")
async def data_socket(ws: WebSocket):
    await ws.accept()
    connection = None
    try:
        hello = await asyncio.wait_for(ws.receive_json(), timeout=5)
        if (not isinstance(hello, dict) or hello.get("kind") != "data_hello"
                or not isinstance(hello.get("token"), str)):
            await ws.close(code=4401)
            return
        connection = await ws.app.state.control_connections.attach_data(hello["token"], ws)
        if connection is None:
            await ws.close(code=4401)
            return
        await ws.send_json({"kind": "data_ready", "version": 1,
                            "device_id": connection.device_id})
        ws.app.state.control_connections.data_ready(connection)
        while True:
            message = await ws.receive_json()
            if isinstance(message, dict) and message.get("kind") == "heartbeat":
                await ws.send_json({"kind": "heartbeat_ack", "version": 1})
                continue
            try:
                frame = ProxyFrame.model_validate(message)
            except Exception:
                await ws.close(code=4400)
                return
            if frame.type not in (FrameType.http_response, FrameType.websocket_open,
                                  FrameType.websocket_data, FrameType.websocket_close):
                await ws.close(code=4400)
                return
            await connection.deliver(frame)
    except (asyncio.TimeoutError, WebSocketDisconnect):
        pass
    finally:
        if connection:
            await ws.app.state.control_connections.release_data(connection)


@router.websocket("/api/control/ws")
async def control_socket(ws: WebSocket):
    await ws.accept()
    device_id = None
    user_id = None
    connection_id = None
    config_public_key_pem = None
    usage_tasks: set[asyncio.Task] = set()
    audit_tasks: set[asyncio.Task] = set()
    send_lock = asyncio.Lock()

    async def send_json(value: dict) -> None:
        async with send_lock:
            await ws.send_json(value)

    async def apply_usage_batch(batch_id: str, events: list[dict]) -> None:
        try:
            async with ws.app.state.usage_ledger_lock:
                result = await asyncio.wait_for(
                    record_usage_batch(ws.app.state.database, device_id, batch_id, events),
                    timeout=ws.app.state.usage_batch_timeout_seconds,
                )
            await send_json({"kind": "usage_ack", "version": 1,
                             "device_id": device_id, **result})
        except ValueError:
            await send_json({"kind": "usage_ack", "version": 1,
                             "device_id": device_id, "batch_id": batch_id,
                             "accepted": [], "duplicates": [],
                             "rejected": [str(item.get("usage_event_id", ""))[:64]
                                          for item in events if isinstance(item, dict)]})
        except Exception:
            await send_json({"kind": "usage_retry", "version": 1,
                             "device_id": device_id, "batch_id": batch_id,
                             "retry_after": 5})
        finally:
            ws.app.state.usage_batch_slots.release()

    async def apply_audit_batch(batch_id: str, events: list[dict]) -> None:
        try:
            result = await record_audit_batch(
                ws.app.state.database, device_id, batch_id, events,
            )
            await send_json({"kind": "audit_ack", "version": 1,
                             "device_id": device_id, **result})
        except ValueError:
            await send_json({"kind": "audit_ack", "version": 1,
                             "device_id": device_id, "batch_id": batch_id,
                             "accepted": [], "duplicates": [],
                             "rejected": [str(item.get("audit_event_id", ""))[:64]
                                          for item in events if isinstance(item, dict)]})
        except Exception:
            await send_json({"kind": "audit_retry", "version": 1,
                             "device_id": device_id, "batch_id": batch_id,
                             "retry_after": 5})

    try:
        try:
            nonce = secrets.token_urlsafe(32)
            await send_json({"kind": "challenge", "version": 1, "nonce": nonce})
            hello = await asyncio.wait_for(ws.receive_json(), timeout=5)
            if not isinstance(hello, dict):
                raise ValueError("Invalid handshake")
            device_id, user_id, config_public_key_pem = await authenticate_device(ws, hello, nonce)
        except (ValueError, asyncio.TimeoutError):
            await ws.close(code=4401)
            return
        connection_id = uuid4().hex
        async with ws.app.state.database.session() as session:
            async with session.begin():
                session.add(DeviceConnection(id=connection_id, device_id=device_id))
        await ws.app.state.control_connections.claim(
            device_id, user_id, connection_id, ws, config_public_key_pem, send_json,
        )
        signer = ws.app.state.gateway_signer
        (policy_revision, task_create, project_publish,
         task_create_projects, task_create_denied_projects) = await compiled_device_policy(
            ws.app.state.database, device_id, user_id,
        )
        provider_ids, models = await compiled_provider_access(
            ws.app.state.database, device_id, user_id,
        )
        policy = signer.sign_policy_snapshot(
            gateway_id=ws.app.state.settings.gateway_id,
            device_id=device_id, user_id=user_id, revision=policy_revision,
            task_create=task_create,
            project_publish=project_publish,
            task_create_project_ids=task_create_projects,
            task_create_denied_project_ids=task_create_denied_projects,
            allowed_provider_ids=provider_ids, allowed_models=models,
        )
        provider_bundle = await compile_provider_bundle(
            ws.app.state.database, signer, ws.app.state.settings.gateway_id,
            device_id, user_id, config_public_key_pem,
        )
        skill_manifest = await compile_skill_manifest(
            ws.app.state.database, signer, ws.app.state.settings.gateway_id,
            device_id, user_id,
        )
        await send_json({"kind": "hello", "version": 1, "device_id": device_id,
                            "gateway_public_key_pem": signer.public_key_pem,
                            "policy_snapshot": policy,
                            "provider_bundle": provider_bundle,
                            "skill_manifest": skill_manifest,
                            "command": await _signed_command(ws, device_id)})
        while True:
            try:
                message = await asyncio.wait_for(ws.receive_json(), timeout=90)
            except asyncio.TimeoutError:
                await ws.close(code=4001, reason="Heartbeat timeout")
                return
            if not isinstance(message, dict):
                await ws.close(code=4400, reason="Invalid control message")
                return
            if message.get("kind") == "policy_applied":
                revision = message.get("revision")
                if type(revision) is not int or revision < 0 or revision > policy_revision:
                    await ws.close(code=4400, reason="Invalid policy revision")
                    return
                async with ws.app.state.database.session() as session:
                    connection = await session.get(DeviceConnection, connection_id)
                    if connection:
                        connection.applied_policy_revision = revision
                        await session.commit()
                await send_json({"kind": "policy_applied_ack", "version": 1,
                                    "device_id": device_id, "revision": revision})
                continue
            if message.get("kind") == "provider_applied":
                revision = message.get("revision")
                result = message.get("result")
                error = message.get("error")
                if (type(revision) is not int or revision < 0
                        or result not in ("success", "error")
                        or (error is not None and (not isinstance(error, str) or len(error) > 512))):
                    await ws.close(code=4400, reason="Invalid provider application")
                    return
                async with ws.app.state.database.session() as session:
                    async with session.begin():
                        device = await session.get(Device, device_id)
                        if not device or revision > device.provider_revision:
                            await ws.close(code=4400, reason="Invalid provider revision")
                            return
                        applied = await session.get(DeviceProviderApplication, device_id)
                        if applied is None:
                            applied = DeviceProviderApplication(device_id=device_id)
                            session.add(applied)
                        applied.desired_revision = device.provider_revision
                        if result == "success":
                            applied.applied_revision = revision
                            applied.last_error = None
                        else:
                            safe_errors = {"ValueError", "RuntimeError", "OSError",
                                           "PermissionError", "FileNotFoundError",
                                           "InvalidSignature", "InvalidTag", "TimeoutError"}
                            error_type = error.split(":", 1)[0] if error else ""
                            applied.last_error = (error_type if error_type in safe_errors
                                                  else "application_failed")
                await send_json({"kind": "provider_applied_ack", "version": 1,
                                    "device_id": device_id, "revision": revision})
                continue
            if message.get("kind") == "skill_applied":
                projects = message.get("projects")
                if (message.get("version") != 1 or not isinstance(projects, list)
                        or len(projects) > 1000 or any(
                            not isinstance(item, dict)
                            or not isinstance(item.get("project_id"), str)
                            or len(item["project_id"]) > 64
                            or type(item.get("revision")) is not int
                            or item["revision"] < 0
                            or item.get("status") not in ("applied", "failed", "deferred")
                            or item.get("error_code") not in (
                                None, "name_conflict", "project_missing", "apply_failed",
                                "busy")
                            for item in projects)
                        or len({item["project_id"] for item in projects}) != len(projects)):
                    await ws.close(code=4400, reason="Invalid Skill application")
                    return
                async with ws.app.state.database.session() as session:
                    async with session.begin():
                        rows = {row.id: row for row in (await session.scalars(
                            select(PlatformProject).where(
                                PlatformProject.id.in_([item["project_id"]
                                                        for item in projects]),
                            ),
                        )).all()}
                        if any(item["project_id"] not in rows
                               or rows[item["project_id"]].device_id != device_id
                               or item["revision"] > rows[item["project_id"]].skill_revision
                               for item in projects):
                            await ws.close(code=4400, reason="Invalid Skill project scope")
                            return
                        for item in projects:
                            project = rows[item["project_id"]]
                            state = await session.get(DeviceProjectSkillState,
                                                      (device_id, project.host_project_id))
                            if state is None:
                                state = DeviceProjectSkillState(
                                    device_id=device_id, host_project_id=project.host_project_id,
                                    platform_project_id=project.id,
                                    desired_revision=project.skill_revision,
                                    status="pending",
                                )
                                session.add(state)
                            state.desired_revision = project.skill_revision
                            state.status = ("pending" if item["status"] == "deferred"
                                            else item["status"])
                            state.last_error_code = item["error_code"]
                            state.acknowledged_at = datetime.now(timezone.utc)
                            if item["status"] == "applied":
                                state.applied_revision = item["revision"]
                await send_json({"kind": "skill_applied_ack", "version": 1,
                                 "device_id": device_id,
                                 "projects": [item["project_id"] for item in projects]})
                continue
            if message.get("kind") == "provider_test_result":
                request_id = message.get("request_id")
                status = message.get("status")
                duration_ms = message.get("duration_ms")
                error_code = message.get("error_code")
                if (set(message) != {"kind", "version", "device_id", "request_id",
                                     "status", "duration_ms", "error_code"}
                        or message.get("version") != 1 or message.get("device_id") != device_id
                        or not isinstance(request_id, str) or len(request_id) != 32
                        or any(char not in "0123456789abcdef" for char in request_id)
                        or status not in ("succeeded", "failed")
                        or type(duration_ms) is not int or not 0 <= duration_ms <= 120000
                        or (error_code is not None and error_code not in (
                            "connection_failed", "provider_unavailable"))
                        or (status == "succeeded" and error_code is not None)
                        or (status == "failed" and error_code is None)):
                    await ws.close(code=4400, reason="Invalid provider test result")
                    return
                await ws.app.state.control_connections.complete_provider_test(
                    device_id, request_id, {"status": status,
                                            "duration_ms": duration_ms,
                                            "error_code": error_code})
                continue
            if message.get("kind") == "project_catalog_response":
                request_id = message.get("request_id")
                projects = message.get("projects")
                if (message.get("version") != 1 or message.get("device_id") != device_id
                        or not isinstance(request_id, str) or len(request_id) != 32
                        or any(char not in "0123456789abcdef" for char in request_id)
                        or message.get("status") not in ("ok", "failed")
                        or not isinstance(projects, list) or len(projects) > 1000
                        or (message["status"] == "failed" and projects)
                        or any(not isinstance(item, dict) or set(item) != {"id", "name"}
                               or not isinstance(item["id"], str)
                               or not 1 <= len(item["id"]) <= 128
                               or any(char in item["id"] for char in ("/", "\\", " "))
                               or not isinstance(item["name"], str)
                               or not 1 <= len(item["name"]) <= 256
                               or item["name"] != item["name"].strip()
                               or any(char in item["name"] for char in ("/", "\\"))
                               for item in projects)
                        or len({item["id"] for item in projects}) != len(projects)):
                    await ws.close(code=4400, reason="Invalid project catalog")
                    return
                await ws.app.state.control_connections.complete_project_catalog(
                    device_id, request_id, projects if message["status"] == "ok" else None,
                )
                continue
            if message.get("kind") == "project_publish":
                if (message.get("version") != 1
                        or message.get("action") not in ("publish", "unpublish")
                        or not isinstance(message.get("host_project_id"), str)
                        or not isinstance(message.get("name"), str)):
                    await ws.close(code=4400, reason="Invalid project publication")
                    return
                _, _, may_publish, _, _ = await compiled_device_policy(
                    ws.app.state.database, device_id, user_id,
                )
                if not may_publish:
                    await send_json({"kind": "project_publish_ack", "version": 1,
                                     "device_id": device_id,
                                     "host_project_id": message["host_project_id"],
                                     "project_id": None, "status": "denied"})
                    continue
                try:
                    result = await record_project_publication(
                        ws.app.state.database, device_id=device_id, user_id=user_id,
                        host_project_id=message["host_project_id"],
                        name=message["name"], action=message["action"],
                    )
                except ValueError:
                    result = {"host_project_id": message["host_project_id"],
                              "project_id": None, "status": "failed"}
                await send_json({"kind": "project_publish_ack", "version": 1,
                                 "device_id": device_id, **result})
                continue
            if message.get("kind") == "command_status":
                command_id = message.get("command_id")
                status = message.get("status")
                error = message.get("error")
                if (not isinstance(command_id, str) or len(command_id) > 64
                        or status not in ("received", "running", "succeeded", "failed")
                        or (error is not None and (not isinstance(error, str) or len(error) > 512))):
                    await ws.close(code=4400, reason="Invalid command status")
                    return
                accepted = await record_command_result(
                    ws.app.state.database, command_id, device_id, status, error,
                )
                await send_json({"kind": "command_status_ack", "version": 1,
                                    "device_id": device_id, "command_id": command_id,
                                    "accepted": accepted})
                continue
            if message.get("kind") == "usage_batch":
                batch_id = message.get("batch_id")
                events = message.get("events")
                if (message.get("version") != 1 or not isinstance(batch_id, str)
                        or not 1 <= len(batch_id) <= 128
                        or not isinstance(events, list) or not 1 <= len(events) <= 100):
                    await ws.close(code=4400, reason="Invalid usage batch")
                    return
                if len(usage_tasks) >= 4:
                    await send_json({"kind": "usage_retry", "version": 1,
                                     "device_id": device_id, "batch_id": batch_id,
                                     "retry_after": 5})
                    continue
                if ws.app.state.usage_batch_slots.locked():
                    await send_json({"kind": "usage_retry", "version": 1,
                                     "device_id": device_id, "batch_id": batch_id,
                                     "retry_after": 5})
                    continue
                await ws.app.state.usage_batch_slots.acquire()
                task = asyncio.create_task(apply_usage_batch(batch_id, events))
                usage_tasks.add(task)
                task.add_done_callback(usage_tasks.discard)
                continue
            if message.get("kind") == "audit_batch":
                batch_id = message.get("batch_id")
                events = message.get("events")
                if (message.get("version") != 1 or not isinstance(batch_id, str)
                        or not 1 <= len(batch_id) <= 128
                        or not isinstance(events, list) or not 1 <= len(events) <= 100):
                    await ws.close(code=4400, reason="Invalid audit batch")
                    return
                if len(audit_tasks) >= 4:
                    await send_json({"kind": "audit_retry", "version": 1,
                                     "device_id": device_id, "batch_id": batch_id,
                                     "retry_after": 5})
                    continue
                task = asyncio.create_task(apply_audit_batch(batch_id, events))
                audit_tasks.add(task)
                task.add_done_callback(audit_tasks.discard)
                continue
            if message.get("kind") != "heartbeat":
                if message.get("kind") == "project_runtime":
                    projects = message.get("projects")
                    if (message.get("version") != 1 or message.get("device_id") != device_id
                            or not isinstance(projects, list) or len(projects) > 1000
                            or any(not isinstance(item, dict)
                                   or set(item) != {"id", "running_tasks"}
                                   or not isinstance(item["id"], str)
                                   or not 1 <= len(item["id"]) <= 128
                                   or any(char in item["id"] for char in ("/", "\\", " "))
                                   or type(item["running_tasks"]) is not int
                                   or not 0 <= item["running_tasks"] <= 1_000_000_000
                                   for item in projects)
                            or len({item["id"] for item in projects}) != len(projects)):
                        await ws.close(code=4400, reason="Invalid project runtime")
                        return
                    ws.app.state.control_connections.update_project_runtime(
                        device_id, connection_id, projects,
                    )
                    continue
                await ws.close(code=4400, reason="Invalid control message")
                return
            daemon_health = message.get("daemon_health")
            if daemon_health is not None and type(daemon_health) is not bool:
                await ws.close(code=4400, reason="Invalid daemon health")
                return
            ws.app.state.control_connections.update_daemon_health(device_id, daemon_health)
            if not await binding_active(ws, device_id, user_id):
                await ws.close(code=4003, reason="Device access revoked")
                return
            (policy_revision, task_create, project_publish,
             task_create_projects, task_create_denied_projects) = await compiled_device_policy(
                ws.app.state.database, device_id, user_id,
            )
            provider_ids, models = await compiled_provider_access(
                ws.app.state.database, device_id, user_id,
            )
            policy = signer.sign_policy_snapshot(
                gateway_id=ws.app.state.settings.gateway_id,
                device_id=device_id, user_id=user_id, revision=policy_revision,
                task_create=task_create,
                project_publish=project_publish,
                task_create_project_ids=task_create_projects,
                task_create_denied_project_ids=task_create_denied_projects,
                allowed_provider_ids=provider_ids, allowed_models=models,
            )
            provider_bundle = await compile_provider_bundle(
                ws.app.state.database, signer, ws.app.state.settings.gateway_id,
                device_id, user_id, config_public_key_pem,
            )
            skill_manifest = await compile_skill_manifest(
                ws.app.state.database, signer, ws.app.state.settings.gateway_id,
                device_id, user_id,
            )
            await send_json({"kind": "heartbeat_ack", "version": 1,
                                "device_id": device_id, "policy_snapshot": policy,
                                "provider_bundle": provider_bundle,
                                "skill_manifest": skill_manifest,
                                "command": await _signed_command(ws, device_id)})
    except WebSocketDisconnect:
        pass
    finally:
        for task in usage_tasks:
            task.cancel()
        if usage_tasks:
            await asyncio.gather(*usage_tasks, return_exceptions=True)
        for task in audit_tasks:
            task.cancel()
        if audit_tasks:
            await asyncio.gather(*audit_tasks, return_exceptions=True)
        if device_id and connection_id:
            with anyio.CancelScope(shield=True):
                async with ws.app.state.database.session() as session:
                    connection = await session.get(DeviceConnection, connection_id)
                    if connection:
                        connection.disconnected_at = datetime.now(timezone.utc)
                        connection.close_reason = "closed"
                        await session.commit()
                await ws.app.state.control_connections.release(device_id, connection_id)
