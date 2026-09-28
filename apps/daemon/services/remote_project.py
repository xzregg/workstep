"""Remote-project client connection and proxy seam.

The public interface is deliberately HTTP-shaped.  WebSocket connections only
carry ``RemoteHttpRequest`` / ``RemoteHttpResponse`` values. Host-side route
dispatch lives in ``remote_host`` and access control lives in ``remote_access``.
"""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
import logging
import time
import uuid
from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from services.remote_registry import RemoteProjectRegistry
from services.remote_protocol import (
    REMOTE_REQUEST_BODY_LIMIT,
    RemoteHttpRequest,
    RemoteHttpResponse,
)
from services.remote_host import (
    RemoteRouteDispatcher,
    _build_route_catalog,
    serve_remote_project_socket,
)
from services.remote_access import (
    ACCESS_COOKIE_NAME,
    ActorSnapshot,
    BrowserActorMiddleware,
    RemoteAccessGuardMiddleware,
    RemoteAccessService,
    RemotePrincipal,
    _client_host,
    _current_actor,
    _is_loopback,
    _select_network_ipv4,
    actor_from_browser_headers,
    current_actor_event_fields,
    get_current_actor,
    get_effective_actor,
    websocket_access_allowed,
)

logger = logging.getLogger(__name__)

REMOTE_REQUEST_CHUNK_BYTES = 3 * 1024 * 1024


async def _default_connect(endpoint: str, **kwargs):
    from websockets.asyncio.client import connect

    return await connect(endpoint, **kwargs)


class _RemoteProjectConnection:
    def __init__(
        self,
        *,
        local_project_id: str,
        registry: RemoteProjectRegistry,
        actor_provider,
        event_sink,
        connect_factory,
    ):
        self.local_project_id = local_project_id
        self._registry = registry
        self._actor_provider = actor_provider
        self._event_sink = event_sink
        self._connect_factory = connect_factory
        self._socket = None
        self._connect_lock = asyncio.Lock()
        self._send_lock = asyncio.Lock()
        self._reader_task: asyncio.Task | None = None
        self._pending: dict[str, asyncio.Future] = {}

    async def _emit_status(self, status: str) -> None:
        try:
            result = self._event_sink(
                {
                    "type": "CUSTOM",
                    "name": "workstep.remote_project_status",
                    "project_id": self.local_project_id,
                    "value": {
                        "project_id": self.local_project_id,
                        "status": status,
                    },
                }
            )
            if inspect.isawaitable(result):
                await result
        except Exception:
            logger.debug("Failed to publish remote-project status", exc_info=True)

    async def connect(self) -> dict[str, Any]:
        async with self._connect_lock:
            if self._socket is not None and self._reader_task is not None:
                return RemoteProjectRegistry._public(
                    await asyncio.to_thread(
                        self._registry.get, self.local_project_id
                    ) or {}
                )
            descriptor = await asyncio.to_thread(
                self._registry.get, self.local_project_id
            )
            if descriptor is None:
                raise KeyError(self.local_project_id)
            await asyncio.to_thread(
                self._registry.set_status, self.local_project_id, "connecting"
            )
            socket = None
            try:
                socket = await self._connect_factory(
                    str(descriptor["endpoint"]),
                    open_timeout=10,
                    ping_interval=20,
                    ping_timeout=20,
                    max_size=16 * 1024 * 1024,
                )
                actor: ActorSnapshot = await asyncio.to_thread(self._actor_provider)
                auth = {
                    "type": "auth",
                    "project_id": descriptor["host_project_id"],
                    "invite_token": descriptor.get("invite_token"),
                    "credential": descriptor.get("credential"),
                    "actor": {
                        "actor_id": actor.actor_id,
                        "user_name": actor.user_name,
                        "device_id": actor.device_id,
                        "device_name": actor.device_name,
                    },
                }
                await socket.send(json.dumps(auth, ensure_ascii=False))
                raw = await asyncio.wait_for(socket.recv(), timeout=15)
                message = json.loads(raw)
                if message.get("type") != "auth_ok":
                    detail = str(message.get("detail") or "Remote authentication failed")
                    normalized_detail = detail.lower()
                    if "revoked" in normalized_detail:
                        await asyncio.to_thread(
                            self._registry.update,
                            self.local_project_id,
                            access_status="revoked",
                        )
                    elif "expired" in normalized_detail:
                        await asyncio.to_thread(
                            self._registry.update,
                            self.local_project_id,
                            access_status="expired",
                        )
                    raise PermissionError(detail)
                if message.get("host_id") != descriptor.get("fingerprint"):
                    raise PermissionError("Remote host fingerprint changed")
                credential = str(message.get("credential") or descriptor.get("credential") or "")
                if not credential:
                    raise PermissionError("Remote host did not issue a device credential")
                project = message.get("project")
                if not isinstance(project, dict):
                    raise ValueError("Remote host returned an invalid project summary")
                self._socket = socket
                public = await asyncio.to_thread(
                    self._registry.mark_authenticated,
                    self.local_project_id,
                    credential=credential,
                    project=project,
                    access_status=str(message.get("access_status") or "active"),
                    access_expires_at=(
                        int(message["access_expires_at"])
                        if message.get("access_expires_at") is not None
                        else None
                    ),
                )
                self._reader_task = asyncio.create_task(self._reader())
                await self._emit_status("connected")
                return public
            except Exception:
                if socket is not None and self._socket is None:
                    await socket.close()
                await asyncio.to_thread(
                    self._registry.set_status, self.local_project_id, "error"
                )
                await self._emit_status("error")
                raise

    async def _reader(self) -> None:
        try:
            while self._socket is not None:
                raw = await self._socket.recv()
                message = json.loads(raw)
                if message.get("type") == "http.response":
                    request_id = str(message.get("request_id") or "")
                    future = self._pending.pop(request_id, None)
                    if future is not None and not future.done():
                        future.set_result(
                            RemoteHttpResponse(
                                request_id=request_id,
                                status=int(message.get("status") or 500),
                                headers={
                                    str(k): str(v)
                                    for k, v in dict(message.get("headers") or {}).items()
                                },
                                body=await asyncio.to_thread(
                                    base64.b64decode,
                                    str(message.get("body_b64") or ""),
                                ),
                            )
                        )
                elif message.get("type") == "event" and isinstance(message.get("event"), dict):
                    event = {**message["event"], "project_id": self.local_project_id}
                    result = self._event_sink(event)
                    if inspect.isawaitable(result):
                        await result
                elif message.get("type") == "project.updated" and isinstance(
                    message.get("project"), dict
                ):
                    project = message["project"]
                    await asyncio.to_thread(
                        self._registry.update,
                        self.local_project_id,
                        name=str(project.get("name") or ""),
                        steps=project.get("steps") or {},
                        workflows=project.get("workflows") or [],
                    )
                elif message.get("type") == "access_ended":
                    reason = str(message.get("reason") or "")
                    if reason in {"expired", "revoked"}:
                        await asyncio.to_thread(
                            self._registry.update,
                            self.local_project_id,
                            access_status=reason,
                        )
                    return
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.info("Remote project socket closed: %s", exc)
        finally:
            self._socket = None
            await asyncio.to_thread(
                self._registry.set_status, self.local_project_id, "disconnected"
            )
            await self._emit_status("disconnected")
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(ConnectionError("Remote project disconnected"))
            self._pending.clear()

    async def request(self, request: RemoteHttpRequest) -> RemoteHttpResponse:
        if len(request.body) > REMOTE_REQUEST_BODY_LIMIT:
            raise ValueError("Remote request body exceeds the 64 MiB limit")
        await self.connect()
        if self._socket is None:
            raise ConnectionError("Remote project is not connected")
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._pending[request.request_id] = future
        envelope = {
            "request_id": request.request_id,
            "method": request.method,
            "path": request.path,
            "query": request.query,
            "headers": request.headers,
        }
        try:
            async with self._send_lock:
                if len(request.body) <= REMOTE_REQUEST_CHUNK_BYTES:
                    encoded_body = await asyncio.to_thread(
                        base64.b64encode, request.body
                    )
                    await self._socket.send(json.dumps({
                        **envelope,
                        "type": "http.request",
                        "body_b64": encoded_body.decode(),
                    }, ensure_ascii=False))
                else:
                    await self._socket.send(json.dumps({
                        **envelope,
                        "type": "http.request.start",
                        "body_size": len(request.body),
                    }, ensure_ascii=False))
                    for offset in range(0, len(request.body), REMOTE_REQUEST_CHUNK_BYTES):
                        encoded_chunk = await asyncio.to_thread(
                            base64.b64encode,
                            request.body[offset:offset + REMOTE_REQUEST_CHUNK_BYTES],
                        )
                        await self._socket.send(json.dumps({
                            "type": "http.request.chunk",
                            "request_id": request.request_id,
                            "body_b64": encoded_chunk.decode(),
                        }))
                    await self._socket.send(json.dumps({
                        "type": "http.request.end",
                        "request_id": request.request_id,
                    }))
            return await asyncio.wait_for(future, timeout=120)
        except BaseException:
            self._pending.pop(request.request_id, None)
            if self._socket is not None:
                try:
                    async with self._send_lock:
                        await self._socket.send(
                            json.dumps(
                                {"type": "http.cancel", "request_id": request.request_id}
                            )
                        )
                except Exception:
                    pass
            raise

    async def subscribe(self, subscription: dict[str, Any]) -> None:
        await self.connect()
        if self._socket is not None:
            async with self._send_lock:
                await self._socket.send(
                    json.dumps({"type": "subscribe", **subscription}, ensure_ascii=False)
                )

    async def close(self) -> None:
        reader, self._reader_task = self._reader_task, None
        socket, self._socket = self._socket, None
        if reader is not None:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
        if socket is not None:
            await socket.close()
        if reader is None:
            await asyncio.to_thread(
                self._registry.set_status, self.local_project_id, "disconnected"
            )
            await self._emit_status("disconnected")


class RemoteProjectClientManager:
    """Own persistent outgoing sockets and multiplex RPC by local project ID."""

    def __init__(
        self,
        *,
        registry: RemoteProjectRegistry,
        actor_provider,
        event_sink,
        connect_factory=_default_connect,
    ):
        self._registry = registry
        self._actor_provider = actor_provider
        self._event_sink = event_sink
        self._connect_factory = connect_factory
        self._connections: dict[str, _RemoteProjectConnection] = {}
        for project in registry.list_public():
            registry.set_status(project["id"], "disconnected")

    def _connection(self, local_project_id: str) -> _RemoteProjectConnection:
        connection = self._connections.get(local_project_id)
        if connection is None:
            connection = _RemoteProjectConnection(
                local_project_id=local_project_id,
                registry=self._registry,
                actor_provider=self._actor_provider,
                event_sink=self._event_sink,
                connect_factory=self._connect_factory,
            )
            self._connections[local_project_id] = connection
        return connection

    async def add_share(self, share_string: str) -> dict[str, Any]:
        project = await asyncio.to_thread(self._registry.add_from_share, share_string)
        existing = self._connections.pop(project["id"], None)
        if existing is not None:
            await existing.close()
        try:
            return await self._connection(project["id"]).connect()
        except Exception:
            # Keep the descriptor so the user can retry after fixing network
            # access; the one-time invitation remains until auth succeeds.
            raise

    async def request(
        self, local_project_id: str, request: RemoteHttpRequest
    ) -> RemoteHttpResponse:
        if await asyncio.to_thread(self._registry.get, local_project_id) is None:
            raise KeyError(local_project_id)
        return await self._connection(local_project_id).request(request)

    async def subscribe(self, local_project_id: str, subscription: dict[str, Any]) -> None:
        if await asyncio.to_thread(self._registry.get, local_project_id) is not None:
            await self._connection(local_project_id).subscribe(subscription)

    async def remove(self, local_project_id: str) -> bool:
        connection = self._connections.pop(local_project_id, None)
        if connection is not None:
            await connection.close()
        return await asyncio.to_thread(self._registry.remove, local_project_id)

    async def close(self) -> None:
        connections = list(self._connections.values())
        self._connections.clear()
        await asyncio.gather(*(item.close() for item in connections), return_exceptions=True)


class RemoteProjectProxyMiddleware(BaseHTTPMiddleware):
    """Route project-scoped browser HTTP calls through a remote connection.

    Existing FastAPI endpoints remain unchanged.  The middleware only claims a
    request when its ``project_id`` maps to the remote-project registry; local
    identifiers continue through the normal ASGI stack.
    """

    def __init__(self, app, *, registry: RemoteProjectRegistry, client_manager):
        super().__init__(app)
        self._registry = registry
        self._client_manager = client_manager

    async def dispatch(self, request: Request, call_next):
        if not request.url.path.startswith("/api/"):
            return await call_next(request)

        body = await request.body()
        project_id = request.query_params.get("project_id")
        if not project_id and request.url.path.startswith("/api/fs/project-raw/"):
            remainder = request.url.path.removeprefix("/api/fs/project-raw/")
            project_id = remainder.split("/", 1)[0] or None
        if not project_id and "application/json" in request.headers.get("content-type", ""):
            try:
                payload = json.loads(body or b"{}")
            except (UnicodeDecodeError, json.JSONDecodeError):
                payload = None
            if isinstance(payload, dict) and isinstance(payload.get("project_id"), str):
                project_id = payload["project_id"]
        if not project_id or await asyncio.to_thread(
            self._registry.get, project_id
        ) is None:
            return await call_next(request)
        gateway_client = getattr(request.app.state, "gateway_client", None)
        if (gateway_client is not None
                and getattr(gateway_client, "managed_config", None) is not None):
            return JSONResponse(
                {"detail": "legacy remote projects are unavailable in managed mode"},
                status_code=403,
            )

        forwarded = RemoteHttpRequest(
            request_id=str(uuid.uuid4()),
            method=request.method,
            path=request.url.path,
            query={key: value for key, value in request.query_params.items()},
            headers={key: value for key, value in request.headers.items()},
            body=body,
        )
        try:
            response = await self._client_manager.request(project_id, forwarded)
        except Exception as exc:
            logger.warning("Remote project request unavailable: %s", exc)
            return JSONResponse(
                {"detail": f"远程项目连接不可用：{exc}"},
                status_code=502,
            )
        return Response(
            content=response.body,
            status_code=response.status,
            headers=response.headers,
        )
