"""Remote-project registry, transport, and FastAPI dispatch seam.

The public interface is deliberately HTTP-shaped.  WebSocket connections only
carry ``RemoteHttpRequest`` / ``RemoteHttpResponse`` values; FastAPI remains the
single source of truth for route matching, validation, and error handling.
"""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.encoders import jsonable_encoder
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import compile_path

from services.remote_registry import RemoteProjectRegistry
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

REMOTE_REQUEST_BODY_LIMIT = 64 * 1024 * 1024
REMOTE_REQUEST_CHUNK_BYTES = 3 * 1024 * 1024


@dataclass(frozen=True)
class RemoteHttpRequest:
    request_id: str
    method: str
    path: str
    query: dict[str, str] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""


@dataclass(frozen=True)
class RemoteHttpResponse:
    request_id: str
    status: int
    headers: dict[str, str]
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body)


@dataclass(frozen=True)
class _RouteDescriptor:
    method: str
    path_template: str
    path_regex: Any
    project_binding: Literal["query", "json_body"]


def _schema_properties(schema: dict[str, Any], document: dict[str, Any]) -> dict[str, Any]:
    ref = schema.get("$ref")
    if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
        name = ref.rsplit("/", 1)[-1]
        resolved = document.get("components", {}).get("schemas", {}).get(name, {})
        return resolved.get("properties", {}) if isinstance(resolved, dict) else {}
    return schema.get("properties", {}) if isinstance(schema, dict) else {}


def _build_route_catalog(app: FastAPI) -> list[_RouteDescriptor]:
    document = app.openapi()
    catalog: list[_RouteDescriptor] = []
    for path_template, path_item in document.get("paths", {}).items():
        if path_template.startswith("/api/remote-project"):
            continue
        if not isinstance(path_item, dict):
            continue
        path_regex, _, _ = compile_path(path_template)
        for method, operation in path_item.items():
            if method.upper() not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
                continue
            if not isinstance(operation, dict):
                continue
            query_names = {
                item.get("name")
                for item in operation.get("parameters", [])
                if isinstance(item, dict) and item.get("in") == "query"
            }
            binding: Literal["query", "json_body"] | None = None
            if "project_id" in query_names:
                binding = "query"
            else:
                schema = (
                    operation.get("requestBody", {})
                    .get("content", {})
                    .get("application/json", {})
                    .get("schema", {})
                )
                if "project_id" in _schema_properties(schema, document):
                    binding = "json_body"
            if binding:
                catalog.append(
                    _RouteDescriptor(
                        method=method.upper(),
                        path_template=path_template,
                        path_regex=path_regex,
                        project_binding=binding,
                    )
                )
    return catalog


class RemoteRouteDispatcher:
    """Dispatch authenticated remote requests through the existing ASGI app."""

    def __init__(self, app: FastAPI):
        self._catalog = _build_route_catalog(app)
        self._client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://workstep.internal",
        )

    def _resolve(self, method: str, path: str) -> _RouteDescriptor:
        normalized_method = method.upper()
        for route in self._catalog:
            if route.method == normalized_method and route.path_regex.fullmatch(path):
                return route
        raise PermissionError(f"Route is not remotely accessible: {normalized_method} {path}")

    async def dispatch(
        self,
        request: RemoteHttpRequest,
        principal: RemotePrincipal,
    ) -> RemoteHttpResponse:
        route = self._resolve(request.method, request.path)
        query = dict(request.query)
        body = request.body
        if route.project_binding == "query":
            query["project_id"] = principal.project_id
        else:
            payload = json.loads(body or b"{}")
            if not isinstance(payload, dict):
                raise ValueError("Remote JSON request body must be an object")
            payload["project_id"] = principal.project_id
            body = json.dumps(payload, ensure_ascii=False).encode()

        actor_token = _current_actor.set(principal.actor)
        try:
            response = await self._client.request(
                request.method,
                request.path,
                params=query,
                content=body,
                headers={
                    key: value
                    for key, value in request.headers.items()
                    if key.lower() in {"accept", "content-type", "idempotency-key"}
                },
            )
        finally:
            _current_actor.reset(actor_token)

        return RemoteHttpResponse(
            request_id=request.request_id,
            status=response.status_code,
            headers={
                key: value
                for key, value in response.headers.items()
                if key.lower() in {"content-type", "content-disposition", "etag"}
            },
            body=response.content,
        )

    async def aclose(self) -> None:
        await self._client.aclose()


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


def _subscription_matches(event: dict[str, Any], subscription: dict[str, set[str]]) -> bool:
    task_id = str(event.get("task_id") or "")
    session_id = str(event.get("session_id") or "")
    channel = str(event.get("channel") or "")
    if task_id and task_id in subscription["task_ids"]:
        return True
    if task_id and task_id in subscription["status_only_task_ids"]:
        from engines.core.agui import is_status_event

        return is_status_event(event)
    return bool(
        (session_id and session_id in subscription["session_ids"])
        or (channel and channel in subscription["channels"])
    )


async def serve_remote_project_socket(
    ws: WebSocket,
    *,
    dispatcher: RemoteRouteDispatcher,
    access_service: RemoteAccessService,
    event_bus,
    project_summary,
    max_concurrent_requests: int = 32,
) -> None:
    """Serve one authenticated, fully asynchronous daemon-to-daemon socket."""
    await ws.accept()
    try:
        auth = await asyncio.wait_for(ws.receive_json(), timeout=15)
        if not isinstance(auth, dict) or auth.get("type") != "auth":
            raise PermissionError("Authentication must be the first message")
        raw_actor = auth.get("actor")
        if not isinstance(raw_actor, dict):
            raise PermissionError("Missing remote actor identity")
        actor = ActorSnapshot(
            actor_id=str(raw_actor.get("actor_id") or raw_actor.get("device_id") or ""),
            user_name=str(raw_actor.get("user_name") or "").strip(),
            device_id=str(raw_actor.get("device_id") or "").strip(),
            device_name=str(raw_actor.get("device_name") or "").strip(),
            source="remote",
        )
        if not actor.user_name or not actor.device_id or not actor.device_name:
            raise PermissionError("Incomplete remote actor identity")
        principal = await asyncio.to_thread(
            access_service.authenticate,
            project_id=str(auth.get("project_id") or ""),
            actor=actor,
            invite_token=str(auth.get("invite_token") or "") or None,
            credential=str(auth.get("credential") or "") or None,
        )
        summary = project_summary(principal.project_id)
        if inspect.isawaitable(summary):
            summary = await summary
        if not isinstance(summary, dict):
            raise PermissionError("Remote project does not exist")
        await ws.send_json(
            jsonable_encoder(
                {
                    "type": "auth_ok",
                    "project_id": principal.project_id,
                    "credential": principal.credential,
                    "access_expires_at": principal.expires_at,
                    "access_status": "active",
                    "host_id": (
                        await asyncio.to_thread(access_service.settings)
                    )["host_id"],
                    "project": summary,
                }
            )
        )
        access_service.register_connection(
            principal.project_id,
            principal.actor.device_id,
            ws,
        )
    except (PermissionError, ValueError, asyncio.TimeoutError) as exc:
        try:
            await ws.send_json({"type": "auth_error", "detail": str(exc)})
        finally:
            await ws.close(code=4401, reason="unauthorized")
        return

    outgoing: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=1000)
    bus_queue = event_bus.subscribe()
    semaphore = asyncio.Semaphore(max_concurrent_requests)
    request_tasks: dict[str, asyncio.Task] = {}
    request_uploads: dict[str, dict[str, Any]] = {}
    subscription: dict[str, set[str]] = {
        "task_ids": set(),
        "status_only_task_ids": set(),
        "session_ids": set(),
        "channels": set(),
    }
    authorized_task_ids: set[str] = set()

    def discover_authorized_ids(path: str, response: RemoteHttpResponse) -> None:
        if not 200 <= response.status < 300:
            return
        try:
            payload = response.json()
        except (UnicodeDecodeError, json.JSONDecodeError):
            return
        if isinstance(payload, dict):
            task_id = payload.get("task_id")
            if isinstance(task_id, str):
                authorized_task_ids.add(task_id)
            tasks = payload.get("tasks")
            if isinstance(tasks, list):
                authorized_task_ids.update(
                    str(item["id"])
                    for item in tasks
                    if isinstance(item, dict) and item.get("id")
                )
            if path.startswith("/api/task/") and isinstance(payload.get("id"), str):
                authorized_task_ids.add(payload["id"])

    async def writer() -> None:
        while True:
            message = await outgoing.get()
            if message is None:
                return
            await ws.send_json(jsonable_encoder(message))

    async def forward_events() -> None:
        while True:
            event = await bus_queue.get()
            if event is None:
                return
            if not await asyncio.to_thread(
                access_service.is_principal_authorized, principal
            ):
                continue
            event_project_id = str(event.get("project_id") or "")
            task_id = str(event.get("task_id") or "")
            belongs_to_project = (
                event_project_id == principal.project_id
                if event_project_id
                else bool(task_id and task_id in authorized_task_ids)
            )
            if (
                belongs_to_project
                and any(subscription.values())
                and _subscription_matches(event, subscription)
            ):
                from engines.core.agui import is_status_event

                if is_status_event(event):
                    summary = project_summary(principal.project_id)
                    if inspect.isawaitable(summary):
                        summary = await summary
                    if isinstance(summary, dict):
                        await outgoing.put(
                            {"type": "project.updated", "project": summary}
                        )
                await outgoing.put({"type": "event", "event": event})

    async def run_request(message: dict[str, Any]) -> None:
        request_id = str(message.get("request_id") or "")
        try:
            async with semaphore:
                if not await asyncio.to_thread(
                    access_service.is_principal_authorized, principal
                ):
                    raise PermissionError("Remote device authorization was revoked")
                await asyncio.to_thread(
                    access_service.touch_device_activity,
                    principal.project_id,
                    principal.actor.device_id,
                )
                encoded_body = str(message.get("body_b64") or "")
                assembled_body = message.get("_assembled_body")
                body = (
                    bytes(assembled_body)
                    if isinstance(assembled_body, (bytes, bytearray))
                    else (
                        await asyncio.to_thread(
                            base64.b64decode, encoded_body, validate=True
                        )
                        if encoded_body
                        else b""
                    )
                )
                if len(body) > REMOTE_REQUEST_BODY_LIMIT:
                    raise ValueError("Remote request body exceeds the 64 MiB limit")
                request = RemoteHttpRequest(
                    request_id=request_id,
                    method=str(message.get("method") or "GET"),
                    path=str(message.get("path") or ""),
                    query={str(k): str(v) for k, v in dict(message.get("query") or {}).items()},
                    headers={str(k): str(v) for k, v in dict(message.get("headers") or {}).items()},
                    body=body,
                )
                response = await dispatcher.dispatch(request, principal)
                discover_authorized_ids(request.path, response)
                envelope = {
                    "type": "http.response",
                    "request_id": response.request_id,
                    "status": response.status,
                    "headers": response.headers,
                    "body_b64": base64.b64encode(response.body).decode(),
                }
        except asyncio.CancelledError:
            return
        except PermissionError as exc:
            body = json.dumps({"detail": str(exc)}, ensure_ascii=False).encode()
            envelope = {
                "type": "http.response",
                "request_id": request_id,
                "status": 403,
                "headers": {"content-type": "application/json"},
                "body_b64": base64.b64encode(body).decode(),
            }
        except Exception as exc:
            logger.exception("Remote project request failed: %s", request_id)
            body = json.dumps({"detail": str(exc)}, ensure_ascii=False).encode()
            envelope = {
                "type": "http.response",
                "request_id": request_id,
                "status": 500,
                "headers": {"content-type": "application/json"},
                "body_b64": base64.b64encode(body).decode(),
            }
        await outgoing.put(envelope)

    async def schedule_request(message: dict[str, Any]) -> None:
        request_id = str(message.get("request_id") or "")
        if not request_id or request_id in request_tasks:
            await outgoing.put(
                {"type": "protocol_error", "detail": "Invalid or duplicate request_id"}
            )
            return
        task = asyncio.create_task(run_request(message))
        request_tasks[request_id] = task
        task.add_done_callback(
            lambda _task, rid=request_id: request_tasks.pop(rid, None)
        )

    async def reject_upload(request_id: str, status: int, detail: str) -> None:
        body = json.dumps({"detail": detail}, ensure_ascii=False).encode()
        await outgoing.put({
            "type": "http.response",
            "request_id": request_id,
            "status": status,
            "headers": {"content-type": "application/json"},
            "body_b64": base64.b64encode(body).decode(),
        })

    writer_task = asyncio.create_task(writer())
    event_task = asyncio.create_task(forward_events())

    async def expire_access() -> None:
        if principal.expires_at is None:
            return
        await asyncio.sleep(max(0, principal.expires_at - time.time()))
        await access_service.disconnect_device(
            principal.project_id,
            principal.actor.device_id,
            reason="expired",
        )

    expiry_task = asyncio.create_task(expire_access())
    try:
        while True:
            message = await ws.receive_json()
            if not isinstance(message, dict):
                continue
            message_type = message.get("type")
            if message_type == "http.request":
                await schedule_request(message)
            elif message_type == "http.request.start":
                request_id = str(message.get("request_id") or "")
                try:
                    body_size = int(message.get("body_size") or 0)
                except (TypeError, ValueError):
                    await reject_upload(request_id, 400, "Invalid request body size")
                    continue
                if (
                    not request_id
                    or request_id in request_tasks
                    or request_id in request_uploads
                ):
                    await reject_upload(request_id, 400, "Invalid or duplicate request_id")
                elif len(request_uploads) >= max_concurrent_requests:
                    await reject_upload(request_id, 429, "Too many concurrent uploads")
                elif body_size < 0 or body_size > REMOTE_REQUEST_BODY_LIMIT:
                    await reject_upload(
                        request_id,
                        413,
                        "Remote request body exceeds the 64 MiB limit",
                    )
                else:
                    request_uploads[request_id] = {
                        "message": message,
                        "body": bytearray(),
                        "body_size": body_size,
                    }
            elif message_type == "http.request.chunk":
                request_id = str(message.get("request_id") or "")
                upload = request_uploads.get(request_id)
                if upload is None:
                    await reject_upload(request_id, 400, "Chunked request was not started")
                    continue
                try:
                    chunk = await asyncio.to_thread(
                        base64.b64decode,
                        str(message.get("body_b64") or ""),
                        validate=True,
                    )
                except (ValueError, TypeError):
                    request_uploads.pop(request_id, None)
                    await reject_upload(request_id, 400, "Invalid request chunk")
                    continue
                if len(upload["body"]) + len(chunk) > upload["body_size"]:
                    request_uploads.pop(request_id, None)
                    await reject_upload(request_id, 400, "Request body exceeds declared size")
                    continue
                upload["body"].extend(chunk)
            elif message_type == "http.request.end":
                request_id = str(message.get("request_id") or "")
                upload = request_uploads.pop(request_id, None)
                if upload is None:
                    await reject_upload(request_id, 400, "Chunked request was not started")
                elif len(upload["body"]) != upload["body_size"]:
                    await reject_upload(request_id, 400, "Request body size does not match")
                else:
                    await schedule_request({
                        **upload["message"],
                        "_assembled_body": upload["body"],
                    })
            elif message_type == "http.cancel":
                request_id = str(message.get("request_id") or "")
                request_uploads.pop(request_id, None)
                task = request_tasks.get(request_id)
                if task is not None:
                    task.cancel()
            elif message_type == "subscribe":
                for key in subscription:
                    values = message.get(key)
                    subscription[key] = (
                        {str(value) for value in values if value}
                        if isinstance(values, (list, tuple, set))
                        else set()
                    )
            elif message_type == "ping":
                await asyncio.to_thread(
                    access_service.touch_device_activity,
                    principal.project_id,
                    principal.actor.device_id,
                )
                await outgoing.put({"type": "pong", "timestamp": message.get("timestamp")})
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        access_service.unregister_connection(
            principal.project_id,
            principal.actor.device_id,
            ws,
        )
        event_bus.unsubscribe(bus_queue)
        tasks = list(request_tasks.values())
        for task in tasks:
            task.cancel()
        event_task.cancel()
        writer_task.cancel()
        expiry_task.cancel()
        await asyncio.gather(
            *tasks,
            event_task,
            writer_task,
            expiry_task,
            return_exceptions=True,
        )
