"""Remote-project transport, identity, and FastAPI dispatch seam.

The public interface is deliberately HTTP-shaped.  WebSocket connections only
carry ``RemoteHttpRequest`` / ``RemoteHttpResponse`` values; FastAPI remains the
single source of truth for route matching, validation, and error handling.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import inspect
import ipaddress
import json
import logging
import secrets
import socket
import time
import uuid
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Callable, Literal
from urllib.parse import urlparse, urlunparse

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.encoders import jsonable_encoder
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import compile_path

logger = logging.getLogger(__name__)

_LAN_IPV4_NETWORKS = tuple(
    ipaddress.ip_network(value)
    for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
)


@dataclass(frozen=True)
class ActorSnapshot:
    actor_id: str
    user_name: str
    device_id: str
    device_name: str
    source: Literal["local", "remote"]


@dataclass(frozen=True)
class RemotePrincipal:
    project_id: str
    actor: ActorSnapshot
    credential: str | None = None
    expires_at: int | None = None


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


_current_actor: ContextVar[ActorSnapshot | None] = ContextVar(
    "workstep_current_actor",
    default=None,
)


def get_current_actor() -> ActorSnapshot | None:
    return _current_actor.get()


def get_effective_actor() -> ActorSnapshot | None:
    """Return the remote caller, or this installation's configured user."""
    actor = get_current_actor()
    if actor is not None:
        return actor

    from services.config import config_store

    get_user_name = getattr(config_store, "get_user_name", None)
    get_device_identity = getattr(config_store, "get_device_identity", None)
    if get_user_name is None or get_device_identity is None:
        return None
    user_name = get_user_name()
    if not user_name:
        return None
    device = get_device_identity()
    return ActorSnapshot(
        actor_id=device["device_id"],
        user_name=user_name,
        device_id=device["device_id"],
        device_name=device["device_name"],
        source="local",
    )


def current_actor_event_fields() -> dict[str, Any]:
    actor = get_effective_actor()
    if actor is None:
        return {}
    return {
        "actor": {
            "id": actor.actor_id,
            "name": actor.user_name,
            "device_id": actor.device_id,
            "device_name": actor.device_name,
        }
    }


def _secret_hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _websocket_endpoint(base_url: str, *, external: bool) -> str:
    raw = base_url.strip().rstrip("/")
    parsed = urlparse(raw)
    allowed = {"https", "wss"} if external else {"http", "https", "ws", "wss"}
    if parsed.scheme not in allowed or not parsed.netloc:
        raise ValueError("Invalid remote access address")
    scheme = {"http": "ws", "https": "wss"}.get(parsed.scheme, parsed.scheme)
    path = parsed.path.rstrip("/") + "/ws/remote-project"
    return urlunparse((scheme, parsed.netloc, path, "", "", ""))


def _select_network_ipv4(candidates: list[str]) -> str:
    usable: list[ipaddress.IPv4Address] = []
    for candidate in candidates:
        try:
            address = ipaddress.ip_address(candidate)
        except ValueError:
            continue
        if (
            isinstance(address, ipaddress.IPv4Address)
            and not address.is_unspecified
            and not address.is_loopback
            and not address.is_link_local
        ):
            usable.append(address)
    if not usable:
        return "127.0.0.1"
    usable.sort(
        key=lambda address: (
            0 if any(address in network for network in _LAN_IPV4_NETWORKS)
            else 1 if address.is_private
            else 2
        )
    )
    return str(usable[0])


def _primary_network_ipv4() -> str:
    """Return the IPv4 address used by the primary network route."""
    candidates: list[str] = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.settimeout(0.1)
            probe.connect(("192.0.2.1", 9))
            candidates.append(str(probe.getsockname()[0]))
    except OSError:
        pass

    try:
        candidates.extend(
            str(item[4][0])
            for item in socket.getaddrinfo(
                socket.gethostname(),
                None,
                family=socket.AF_INET,
                type=socket.SOCK_STREAM,
            )
        )
    except OSError:
        pass
    return _select_network_ipv4(candidates)


class RemoteAccessService:
    """Persist remote-access settings, invitations, and authorized devices."""

    def __init__(
        self,
        config_store,
        *,
        daemon_host: str | None = None,
        daemon_port: int | None = None,
        network_address_resolver: Callable[[], str] | None = None,
    ):
        if daemon_host is None or daemon_port is None:
            from settings import settings as daemon_settings

            daemon_host = daemon_settings.host if daemon_host is None else daemon_host
            daemon_port = daemon_settings.port if daemon_port is None else daemon_port
        self._config = config_store
        self._daemon_host = daemon_host
        self._daemon_port = daemon_port
        self._network_address_resolver = network_address_resolver or _primary_network_ipv4
        self._live_connections: dict[tuple[str, str], int] = {}
        self._live_sockets: dict[tuple[str, str], set[Any]] = {}

    def set_runtime_port(self, port: int) -> None:
        """Use the actual ASGI listener port when it differs from configuration."""
        if 1 <= int(port) <= 65535:
            self._daemon_port = int(port)

    def _default_internal_base_url(self) -> str:
        host = self._daemon_host.strip()
        if host in {"", "0.0.0.0", "::"}:
            host = self._network_address_resolver()
        elif host == "localhost":
            host = "127.0.0.1"
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        return f"http://{host}:{self._daemon_port}"

    def _load(self) -> dict[str, Any]:
        raw = self._config.get("remote_access", {})
        return dict(raw) if isinstance(raw, dict) else {}

    def _save(self, value: dict[str, Any]) -> None:
        self._config.set("remote_access", value)

    def settings(self) -> dict[str, Any]:
        raw = self._load()
        return {
            "enabled": bool(raw.get("enabled", False)),
            "internal_base_url": str(
                raw.get("internal_base_url") or self._default_internal_base_url()
            ),
            "external_base_url": str(raw.get("external_base_url") or ""),
            "host_id": str(raw.get("host_id") or ""),
        }

    def update_settings(
        self,
        *,
        enabled: bool,
        internal_base_url: str,
        external_base_url: str,
    ) -> dict[str, Any]:
        if internal_base_url.strip():
            _websocket_endpoint(internal_base_url, external=False)
        if external_base_url.strip():
            _websocket_endpoint(external_base_url, external=True)
        raw = self._load()
        normalized_internal = internal_base_url.strip().rstrip("/")
        if normalized_internal == self._default_internal_base_url():
            normalized_internal = ""
        raw.update(
            enabled=bool(enabled),
            internal_base_url=normalized_internal,
            external_base_url=external_base_url.strip().rstrip("/"),
            host_id=str(raw.get("host_id") or uuid.uuid4()),
        )
        self._save(raw)
        return self.settings()

    def create_share(
        self,
        *,
        project_id: str,
        project_name: str,
        access: Literal["internal", "external"],
        access_expires_at: int | None = None,
    ) -> dict[str, Any]:
        raw = self._load()
        if not raw.get("enabled"):
            raise ValueError("Remote project access is disabled")
        if access_expires_at is not None and int(access_expires_at) <= int(time.time()):
            raise ValueError("Device access expiry must be in the future")
        base_key = "external_base_url" if access == "external" else "internal_base_url"
        base_url = str(self.settings().get(base_key) or "")
        if not base_url:
            raise ValueError(f"{access} access address is not configured")
        endpoint = _websocket_endpoint(base_url, external=access == "external")
        invite_token = secrets.token_urlsafe(32)
        expires_at = int(time.time()) + 24 * 60 * 60
        now = int(time.time())
        invites = [
            item
            for item in list(raw.get("invites") or [])
            if not item.get("used") and int(item.get("expires_at") or 0) >= now
        ]
        invites.append(
            {
                "id": str(uuid.uuid4()),
                "project_id": project_id,
                "token_hash": _secret_hash(invite_token),
                "expires_at": expires_at,
                "access_expires_at": access_expires_at,
                "used": False,
            }
        )
        raw["invites"] = invites
        host_id = str(raw.get("host_id") or uuid.uuid4())
        raw["host_id"] = host_id
        self._save(raw)
        payload = {
            "version": 1,
            "endpoint": endpoint,
            "project_id": project_id,
            "project_name": project_name,
            "invite_token": invite_token,
            "fingerprint": host_id,
        }
        encoded = base64.urlsafe_b64encode(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        ).decode().rstrip("=")
        return {
            "share_string": f"workstep://remote-project/v1/{encoded}",
            "endpoint": endpoint,
            "expires_at": expires_at,
            "access_expires_at": access_expires_at,
        }

    @staticmethod
    def parse_share_string(value: str) -> dict[str, Any]:
        prefix = "workstep://remote-project/v1/"
        if not value.startswith(prefix):
            raise ValueError("Invalid WorkStep remote-project share string")
        encoded = value[len(prefix):]
        encoded += "=" * (-len(encoded) % 4)
        try:
            payload = json.loads(base64.urlsafe_b64decode(encoded).decode())
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Invalid WorkStep remote-project share string") from exc
        required = {"endpoint", "project_id", "project_name", "invite_token", "fingerprint"}
        if not isinstance(payload, dict) or not required.issubset(payload):
            raise ValueError("Invalid WorkStep remote-project share string")
        return payload

    def authenticate(
        self,
        *,
        project_id: str,
        actor: ActorSnapshot,
        invite_token: str | None,
        credential: str | None,
    ) -> RemotePrincipal:
        raw = self._load()
        if not raw.get("enabled"):
            raise PermissionError("Remote project access is disabled")
        devices = list(raw.get("devices") or [])
        if credential:
            credential_hash = _secret_hash(credential)
            matched = next(
                (
                    item
                    for item in devices
                    if item.get("project_id") == project_id
                    and item.get("device_id") == actor.device_id
                    and secrets.compare_digest(str(item.get("credential_hash") or ""), credential_hash)
                ),
                None,
            )
            if matched is None:
                raise PermissionError("Invalid remote-project credential")
            if matched.get("revoked", False):
                raise PermissionError("Remote device authorization was revoked")
            expires_at = matched.get("expires_at")
            if expires_at is not None and int(expires_at) <= int(time.time()):
                raise PermissionError("Remote device authorization expired")
            matched.update(
                user_name=actor.user_name,
                device_name=actor.device_name,
                last_seen_at=int(time.time()),
            )
            raw["devices"] = devices
            self._save(raw)
            return RemotePrincipal(
                project_id=project_id,
                actor=actor,
                credential=credential,
                expires_at=int(expires_at) if expires_at is not None else None,
            )

        if not invite_token:
            raise PermissionError("Missing remote-project credential")
        token_hash = _secret_hash(invite_token)
        invite = next(
            (
                item
                for item in list(raw.get("invites") or [])
                if item.get("project_id") == project_id
                and secrets.compare_digest(str(item.get("token_hash") or ""), token_hash)
            ),
            None,
        )
        if invite is None or invite.get("used") or int(invite.get("expires_at") or 0) < int(time.time()):
            raise PermissionError("Invalid or expired remote-project invitation")
        invite["used"] = True
        issued = secrets.token_urlsafe(48)
        devices = [
            item
            for item in devices
            if not (
                item.get("project_id") == project_id
                and item.get("device_id") == actor.device_id
            )
        ]
        devices.append(
            {
                "project_id": project_id,
                "device_id": actor.device_id,
                "user_name": actor.user_name,
                "device_name": actor.device_name,
                "credential_hash": _secret_hash(issued),
                "revoked": False,
                "authorized_at": int(time.time()),
                "expires_at": invite.get("access_expires_at"),
                "last_seen_at": int(time.time()),
            }
        )
        raw["devices"] = devices
        self._save(raw)
        access_expires_at = invite.get("access_expires_at")
        return RemotePrincipal(
            project_id=project_id,
            actor=actor,
            credential=issued,
            expires_at=(
                int(access_expires_at) if access_expires_at is not None else None
            ),
        )

    def list_devices(self, project_id: str | None = None) -> list[dict[str, Any]]:
        """Return non-secret device metadata for the owner-side status UI."""
        result = []
        now = int(time.time())
        for item in list(self._load().get("devices") or []):
            if project_id and item.get("project_id") != project_id:
                continue
            expires_at = item.get("expires_at")
            status = (
                "revoked"
                if item.get("revoked", False)
                else "expired"
                if expires_at is not None and int(expires_at) <= now
                else "active"
            )
            result.append(
                {
                    "project_id": str(item.get("project_id") or ""),
                    "device_id": str(item.get("device_id") or ""),
                    "user_name": str(item.get("user_name") or ""),
                    "device_name": str(item.get("device_name") or ""),
                    "revoked": bool(item.get("revoked", False)),
                    "status": status,
                    "connected": (
                        status == "active"
                        and self._live_connections.get(
                            (str(item.get("project_id") or ""), str(item.get("device_id") or "")),
                            0,
                        ) > 0
                    ),
                    "authorized_at": int(item.get("authorized_at") or 0),
                    "expires_at": int(expires_at) if expires_at is not None else None,
                    "last_seen_at": int(item.get("last_seen_at") or 0),
                }
            )
        return result

    def mark_connection(self, project_id: str, device_id: str, connected: bool) -> None:
        key = (project_id, device_id)
        count = self._live_connections.get(key, 0)
        if connected:
            self._live_connections[key] = count + 1
        elif count <= 1:
            self._live_connections.pop(key, None)
        else:
            self._live_connections[key] = count - 1

    def register_connection(self, project_id: str, device_id: str, socket: Any) -> None:
        key = (project_id, device_id)
        self._live_sockets.setdefault(key, set()).add(socket)
        self.mark_connection(project_id, device_id, True)

    def unregister_connection(self, project_id: str, device_id: str, socket: Any) -> None:
        key = (project_id, device_id)
        sockets = self._live_sockets.get(key)
        if sockets is None or socket not in sockets:
            return
        sockets.discard(socket)
        if not sockets:
            self._live_sockets.pop(key, None)
        self.mark_connection(project_id, device_id, False)

    async def disconnect_device(
        self,
        project_id: str,
        device_id: str,
        *,
        reason: Literal["revoked", "expired", "access_changed"],
    ) -> None:
        key = (project_id, device_id)
        sockets = list(self._live_sockets.pop(key, set()))
        self._live_connections.pop(key, None)
        for socket in sockets:
            try:
                await socket.send_json({"type": "access_ended", "reason": reason})
            except Exception:
                pass
            try:
                await socket.close(code=4403, reason=reason)
            except Exception:
                pass

    def revoke_device(self, project_id: str, device_id: str) -> bool:
        raw = self._load()
        devices = list(raw.get("devices") or [])
        changed = False
        for item in devices:
            if item.get("project_id") == project_id and item.get("device_id") == device_id:
                item["revoked"] = True
                changed = True
        if changed:
            raw["devices"] = devices
            self._save(raw)
        return changed

    def update_device_expiry(
        self,
        project_id: str,
        device_id: str,
        expires_at: int | None,
    ) -> dict[str, Any] | None:
        if expires_at is not None and int(expires_at) <= int(time.time()):
            raise ValueError("Device access expiry must be in the future")
        raw = self._load()
        devices = list(raw.get("devices") or [])
        changed = False
        for item in devices:
            if (
                item.get("project_id") == project_id
                and item.get("device_id") == device_id
                and not item.get("revoked", False)
            ):
                item["expires_at"] = int(expires_at) if expires_at is not None else None
                changed = True
        if not changed:
            return None
        raw["devices"] = devices
        self._save(raw)
        return next(
            item
            for item in self.list_devices(project_id)
            if item["device_id"] == device_id and item["status"] != "revoked"
        )

    def touch_device_activity(self, project_id: str, device_id: str) -> None:
        raw = self._load()
        devices = list(raw.get("devices") or [])
        changed = False
        for item in devices:
            if (
                item.get("project_id") == project_id
                and item.get("device_id") == device_id
                and not item.get("revoked", False)
            ):
                item["last_seen_at"] = int(time.time())
                changed = True
        if changed:
            raw["devices"] = devices
            self._save(raw)

    def is_principal_authorized(self, principal: RemotePrincipal) -> bool:
        if not self._load().get("enabled"):
            return False
        if not principal.credential:
            return False
        credential_hash = _secret_hash(principal.credential)
        now = int(time.time())
        return any(
            item.get("project_id") == principal.project_id
            and item.get("device_id") == principal.actor.device_id
            and not item.get("revoked", False)
            and (
                item.get("expires_at") is None
                or int(item["expires_at"]) > now
            )
            and secrets.compare_digest(
                str(item.get("credential_hash") or ""), credential_hash
            )
            for item in list(self._load().get("devices") or [])
        )


class RemoteProjectRegistry:
    """Persistent client-side catalog of remote projects.

    A remote project gets a local identifier.  That identifier is the only one
    exposed to the browser; the host project identifier is resolved at the
    transport boundary and cannot be forged by callers.
    """

    CONFIG_KEY = "remote_projects"

    def __init__(self, config_store):
        self._config = config_store

    def _load(self) -> list[dict[str, Any]]:
        raw = self._config.get(self.CONFIG_KEY, [])
        if not isinstance(raw, list):
            return []
        return [dict(item) for item in raw if isinstance(item, dict)]

    def _save(self, values: list[dict[str, Any]]) -> None:
        self._config.set(self.CONFIG_KEY, values)

    @staticmethod
    def _local_id(fingerprint: str, project_id: str) -> str:
        digest = hashlib.sha256(f"{fingerprint}:{project_id}".encode()).hexdigest()[:20]
        return f"remote:{digest}"

    def add_from_share(self, share_string: str) -> dict[str, Any]:
        payload = RemoteAccessService.parse_share_string(share_string.strip())
        endpoint = str(payload["endpoint"])
        parsed = urlparse(endpoint)
        if parsed.scheme not in {"ws", "wss"} or not parsed.netloc:
            raise ValueError("Invalid remote-project WebSocket endpoint")
        fingerprint = str(payload["fingerprint"])
        host_project_id = str(payload["project_id"])
        local_id = self._local_id(fingerprint, host_project_id)
        values = self._load()
        existing = next((entry for entry in values if entry.get("id") == local_id), None)
        item = {
            "id": local_id,
            "host_project_id": host_project_id,
            "name": str(payload["project_name"]),
            "endpoint": endpoint,
            "fingerprint": fingerprint,
            "invite_token": str(payload["invite_token"]),
            "connection_status": "disconnected",
            "access_status": "pending",
            "access_expires_at": None,
            "steps": {},
            "workflows": [],
        }
        same_consumed_invite = bool(
            existing
            and existing.get("credential")
            and existing.get("last_invite_hash")
            and secrets.compare_digest(
                str(existing["last_invite_hash"]),
                _secret_hash(str(payload["invite_token"])),
            )
        )
        if same_consumed_invite:
            item.update(
                credential=existing["credential"],
                steps=existing.get("steps") or {},
                workflows=existing.get("workflows") or [],
                last_invite_hash=existing["last_invite_hash"],
                access_status=existing.get("access_status") or "active",
                access_expires_at=existing.get("access_expires_at"),
            )
            item.pop("invite_token", None)
        values = [entry for entry in values if entry.get("id") != local_id]
        values.append(item)
        self._save(values)
        return self._public(item)

    def get(self, local_project_id: str) -> dict[str, Any] | None:
        return next(
            (item for item in self._load() if item.get("id") == local_project_id),
            None,
        )

    def update(self, local_project_id: str, **changes: Any) -> dict[str, Any]:
        values = self._load()
        item = next((entry for entry in values if entry.get("id") == local_project_id), None)
        if item is None:
            raise KeyError(local_project_id)
        item.update(changes)
        self._save(values)
        return item

    def mark_authenticated(
        self,
        local_project_id: str,
        *,
        credential: str,
        project: dict[str, Any],
        access_status: str = "active",
        access_expires_at: int | None = None,
    ) -> dict[str, Any]:
        item = self.get(local_project_id)
        if item is None:
            raise KeyError(local_project_id)
        changes = {
            "credential": credential,
            "connection_status": "connected",
            "name": str(project.get("name") or item.get("name") or ""),
            "steps": project.get("steps") or {},
            "workflows": project.get("workflows") or [],
            "access_status": access_status,
            "access_expires_at": access_expires_at,
        }
        values = self._load()
        stored = next(entry for entry in values if entry.get("id") == local_project_id)
        stored.update(changes)
        invite_token = stored.get("invite_token")
        if isinstance(invite_token, str) and invite_token:
            stored["last_invite_hash"] = _secret_hash(invite_token)
        stored.pop("invite_token", None)
        self._save(values)
        return self._public(stored)

    def set_status(self, local_project_id: str, status: str) -> None:
        try:
            self.update(local_project_id, connection_status=status)
        except KeyError:
            pass

    def remove(self, local_project_id: str) -> bool:
        values = self._load()
        remaining = [item for item in values if item.get("id") != local_project_id]
        if len(remaining) == len(values):
            return False
        self._save(remaining)
        return True

    @staticmethod
    def _public(item: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": str(item.get("id") or ""),
            "path": "",
            "name": str(item.get("name") or ""),
            "steps": item.get("steps") or {},
            "workflows": item.get("workflows") or [],
            "type": "remote",
            "connection_status": str(item.get("connection_status") or "disconnected"),
            "access_status": str(item.get("access_status") or "pending"),
            "access_expires_at": item.get("access_expires_at"),
            "endpoint": str(item.get("endpoint") or ""),
            "host_project_id": str(item.get("host_project_id") or ""),
        }

    def list_public(self) -> list[dict[str, Any]]:
        return [self._public(item) for item in self._load()]


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
                    self._registry.get(self.local_project_id) or {}
                )
            descriptor = self._registry.get(self.local_project_id)
            if descriptor is None:
                raise KeyError(self.local_project_id)
            self._registry.set_status(self.local_project_id, "connecting")
            socket = None
            try:
                socket = await self._connect_factory(
                    str(descriptor["endpoint"]),
                    open_timeout=10,
                    ping_interval=20,
                    ping_timeout=20,
                    max_size=16 * 1024 * 1024,
                )
                actor: ActorSnapshot = self._actor_provider()
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
                        self._registry.update(
                            self.local_project_id,
                            access_status="revoked",
                        )
                    elif "expired" in normalized_detail:
                        self._registry.update(
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
                public = self._registry.mark_authenticated(
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
                self._registry.set_status(self.local_project_id, "error")
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
                                body=base64.b64decode(str(message.get("body_b64") or "")),
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
                    self._registry.update(
                        self.local_project_id,
                        name=str(project.get("name") or ""),
                        steps=project.get("steps") or {},
                        workflows=project.get("workflows") or [],
                    )
                elif message.get("type") == "access_ended":
                    reason = str(message.get("reason") or "")
                    if reason in {"expired", "revoked"}:
                        self._registry.update(
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
            self._registry.set_status(self.local_project_id, "disconnected")
            await self._emit_status("disconnected")
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(ConnectionError("Remote project disconnected"))
            self._pending.clear()

    async def request(self, request: RemoteHttpRequest) -> RemoteHttpResponse:
        await self.connect()
        if self._socket is None:
            raise ConnectionError("Remote project is not connected")
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self._pending[request.request_id] = future
        envelope = {
            "type": "http.request",
            "request_id": request.request_id,
            "method": request.method,
            "path": request.path,
            "query": request.query,
            "headers": request.headers,
            "body_b64": base64.b64encode(request.body).decode(),
        }
        try:
            async with self._send_lock:
                await self._socket.send(json.dumps(envelope, ensure_ascii=False))
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
            self._registry.set_status(self.local_project_id, "disconnected")
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
        project = self._registry.add_from_share(share_string)
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
        if self._registry.get(local_project_id) is None:
            raise KeyError(local_project_id)
        return await self._connection(local_project_id).request(request)

    async def subscribe(self, local_project_id: str, subscription: dict[str, Any]) -> None:
        if self._registry.get(local_project_id) is not None:
            await self._connection(local_project_id).subscribe(subscription)

    async def remove(self, local_project_id: str) -> bool:
        connection = self._connections.pop(local_project_id, None)
        if connection is not None:
            await connection.close()
        return self._registry.remove(local_project_id)

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
        if not project_id and "application/json" in request.headers.get("content-type", ""):
            try:
                payload = json.loads(body or b"{}")
            except (UnicodeDecodeError, json.JSONDecodeError):
                payload = None
            if isinstance(payload, dict) and isinstance(payload.get("project_id"), str):
                project_id = payload["project_id"]
        if not project_id or self._registry.get(project_id) is None:
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
        principal = access_service.authenticate(
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
                    "host_id": access_service.settings()["host_id"],
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
            if not access_service.is_principal_authorized(principal):
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
                if not access_service.is_principal_authorized(principal):
                    raise PermissionError("Remote device authorization was revoked")
                access_service.touch_device_activity(
                    principal.project_id,
                    principal.actor.device_id,
                )
                encoded_body = str(message.get("body_b64") or "")
                request = RemoteHttpRequest(
                    request_id=request_id,
                    method=str(message.get("method") or "GET"),
                    path=str(message.get("path") or ""),
                    query={str(k): str(v) for k, v in dict(message.get("query") or {}).items()},
                    headers={str(k): str(v) for k, v in dict(message.get("headers") or {}).items()},
                    body=base64.b64decode(encoded_body, validate=True) if encoded_body else b"",
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
                request_id = str(message.get("request_id") or "")
                if not request_id or request_id in request_tasks:
                    await outgoing.put(
                        {"type": "protocol_error", "detail": "Invalid or duplicate request_id"}
                    )
                    continue
                task = asyncio.create_task(run_request(message))
                request_tasks[request_id] = task
                task.add_done_callback(
                    lambda _task, rid=request_id: request_tasks.pop(rid, None)
                )
            elif message_type == "http.cancel":
                task = request_tasks.get(str(message.get("request_id") or ""))
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
                access_service.touch_device_activity(
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
