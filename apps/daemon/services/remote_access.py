"""Remote access identity, browser authorization, shares, and devices."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import secrets
import socket
import threading
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from functools import wraps
from typing import Any, Callable, Literal
from urllib.parse import unquote, urlparse, urlunparse



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
    source: Literal["local", "browser", "remote", "managed"]
    project_id: str | None = None
    access_level: str | None = None
    remote_task_create: bool = False
    username: str | None = None
    provider_ids: frozenset[str] | None = None
    provider_grant_expires_at: int | None = None


@dataclass(frozen=True)
class RemotePrincipal:
    project_id: str
    actor: ActorSnapshot
    credential: str | None = None
    expires_at: int | None = None


# Set only while the authenticated RPC dispatcher invokes its bound ASGI route.
_remote_dispatch_principal: ContextVar[RemotePrincipal | None] = ContextVar(
    "workstep_remote_dispatch_principal", default=None,
)


def authenticated_remote_dispatch() -> RemotePrincipal | None:
    return _remote_dispatch_principal.get()


_current_actor: ContextVar[ActorSnapshot | None] = ContextVar(
    "workstep_current_actor",
    default=None,
)
_suppress_default_actor: ContextVar[bool] = ContextVar(
    "workstep_suppress_default_actor", default=False,
)


def get_current_actor() -> ActorSnapshot | None:
    return _current_actor.get()


@contextmanager
def actor_context(actor: ActorSnapshot):
    token = _current_actor.set(actor)
    try:
        yield
    finally:
        _current_actor.reset(token)


@contextmanager
def replayed_actor_context(actor: ActorSnapshot | None):
    """Replay a saved actor, including an unknown legacy actor, without fallback."""
    actor_token = _current_actor.set(actor)
    fallback_token = _suppress_default_actor.set(True)
    try:
        yield
    finally:
        _suppress_default_actor.reset(fallback_token)
        _current_actor.reset(actor_token)


def get_effective_actor() -> ActorSnapshot | None:
    """Return the remote caller, or this installation's configured user."""
    actor = get_current_actor()
    if actor is not None:
        return actor
    if _suppress_default_actor.get():
        return None

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


class UserIdentityRequired(ValueError):
    """A user action needs a named local, browser, or managed actor."""


def require_user_actor() -> ActorSnapshot:
    actor = get_effective_actor()
    if actor is None or not actor.user_name.strip():
        raise UserIdentityRequired("请先设置本地用户名")
    return actor


def actor_from_browser_headers(headers) -> ActorSnapshot | None:
    """Build a browser visitor identity from WorkStep request headers."""
    def decoded(name: str) -> str:
        return unquote(str(headers.get(name) or "")).strip()

    actor_id = decoded("x-workstep-actor-id")
    user_name = decoded("x-workstep-actor-name")
    device_id = decoded("x-workstep-actor-device-id") or actor_id
    device_name = decoded("x-workstep-actor-device-name")
    if not actor_id or not user_name or not device_id or not device_name:
        return None
    return ActorSnapshot(
        actor_id=actor_id,
        user_name=user_name,
        device_id=device_id,
        device_name=device_name,
        source="browser",
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


def _password_hash(value: str, salt: str) -> str:
    """Salted SHA-256 for the browser access password (never stored raw)."""
    return hashlib.sha256(f"{salt}:{value}".encode()).hexdigest()


ACCESS_COOKIE_NAME = "workstep_access"


def _client_host(headers, client) -> str:
    """Best-effort real client address behind a trusted local reverse proxy.

    ``X-Forwarded-For`` / ``X-Real-IP`` are only honoured when the direct peer
    is loopback (a local nginx/ingress). Otherwise a remote client could spoof
    ``127.0.0.1`` and skip the access-password guard.
    """
    peer = str(getattr(client, "host", "") or "").strip()
    if _is_loopback(peer):
        forwarded = str(headers.get("x-forwarded-for") or "").strip()
        if forwarded:
            return forwarded.split(",")[0].strip()
        real_ip = str(headers.get("x-real-ip") or "").strip()
        if real_ip:
            return real_ip
    return peer


def _is_loopback(host: str) -> bool:
    value = host.strip().strip("[]")
    if value.startswith("::ffff:"):
        value = value[len("::ffff:"):]
    if not value:
        return False
    if value in {"localhost", "127.0.0.1", "::1"}:
        return True
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


def _guard_exempt(path: str, method: str) -> bool:
    # Static assets and the SPA shell must load so the remote visitor can see
    # the unlock dialog; only the data/API surface is withheld.
    if not path.startswith("/api/"):
        return True
    if path == "/api/health":
        return True
    # OAuth-style Gateway callbacks are protected by one-time PKCE state and
    # must remain reachable from the external system browser.
    if path == "/api/gateway-platform/callback" and method.upper() == "GET":
        return True
    if path.startswith("/api/task-share/public/"):
        return True
    if path == "/api/remote-project/access/status":
        return True
    if path == "/api/remote-project/access/unlock" and method.upper() == "POST":
        return True
    return False




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
        self._state_lock = threading.RLock()
        self._daemon_host = daemon_host
        self._daemon_port = daemon_port
        self._desktop_runtime_address = False
        self._network_address_resolver = network_address_resolver or _primary_network_ipv4
        self._live_connections: dict[tuple[str, str], int] = {}
        self._live_sockets: dict[tuple[str, str], set[Any]] = {}

    def set_runtime_port(self, port: int) -> None:
        """Use the actual ASGI listener port when it differs from configuration."""
        if not self._desktop_runtime_address and 1 <= int(port) <= 65535:
            self._daemon_port = int(port)

    def set_runtime_address(self, host: str, port: int) -> None:
        """Advertise the desktop host address instead of a container address."""
        address = ipaddress.ip_address(host)
        if address.is_unspecified or address.is_loopback or address.is_link_local:
            raise ValueError("Invalid desktop runtime address")
        if not 1 <= int(port) <= 65535:
            raise ValueError("Invalid desktop runtime port")
        self._daemon_host = str(address)
        self._daemon_port = int(port)
        self._desktop_runtime_address = True

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
            "access_password_set": bool(raw.get("access_password_hash")),
        }

    def set_access_password(self, password: str) -> dict[str, Any]:
        """Set (or clear, with an empty string) the browser access password."""
        value = password.strip()
        raw = self._load()
        raw["host_id"] = str(raw.get("host_id") or uuid.uuid4())
        if value:
            salt = secrets.token_hex(16)
            raw["access_password_salt"] = salt
            raw["access_password_hash"] = _password_hash(value, salt)
            raw["access_password_set_at"] = int(time.time())
        else:
            raw.pop("access_password_salt", None)
            raw.pop("access_password_hash", None)
            raw.pop("access_password_set_at", None)
        self._save(raw)
        return self.settings()

    def access_password_required(self) -> bool:
        """A password gates non-local access only when one is configured."""
        return bool(self._load().get("access_password_hash"))

    def _access_secret(self, raw: dict[str, Any] | None = None) -> str:
        data = raw if raw is not None else self._load()
        return hashlib.sha256(
            f"{data.get('access_password_hash') or ''}:{data.get('host_id') or ''}".encode()
        ).hexdigest()

    def verify_access_password(self, password: str) -> bool:
        raw = self._load()
        stored = str(raw.get("access_password_hash") or "")
        salt = str(raw.get("access_password_salt") or "")
        if not stored or not salt:
            return False
        candidate = _password_hash(password, salt)
        return secrets.compare_digest(candidate, stored)

    def issue_access_token(self, *, ttl_seconds: int = 7 * 24 * 60 * 60) -> str:
        expires_at = int(time.time()) + int(ttl_seconds)
        payload = str(expires_at)
        signature = hmac.new(
            self._access_secret().encode(),
            payload.encode(),
            hashlib.sha256,
        ).hexdigest()
        return f"{payload}.{signature}"

    def verify_access_token(self, token: str | None) -> bool:
        if not token or "." not in token:
            return False
        payload, signature = token.split(".", 1)
        try:
            expires_at = int(payload)
        except ValueError:
            return False
        if expires_at < int(time.time()):
            return False
        expected = hmac.new(
            self._access_secret().encode(),
            payload.encode(),
            hashlib.sha256,
        ).hexdigest()
        return secrets.compare_digest(signature, expected)

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


def _serialize_remote_state(method):
    @wraps(method)
    def synchronized(self, *args, **kwargs):
        with self._state_lock:
            return method(self, *args, **kwargs)

    return synchronized


for _method_name in (
    "set_runtime_port", "settings", "update_settings", "create_share",
    "authenticate", "list_devices", "revoke_device", "update_device_expiry",
    "touch_device_activity", "is_principal_authorized",
):
    setattr(
        RemoteAccessService,
        _method_name,
        _serialize_remote_state(getattr(RemoteAccessService, _method_name)),
    )
