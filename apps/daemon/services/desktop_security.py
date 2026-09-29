"""Security boundary for the privileged loopback API used by Electron."""

from __future__ import annotations

import hmac
import os
import re
from contextlib import nullcontext
from urllib.parse import urlsplit

from fastapi import WebSocket
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from services.remote_access import ActorSnapshot, actor_context
from services.project_scope import project_http_allowed


DESKTOP_TOKEN_HEADER = "x-workstep-desktop-token"
LOCAL_SESSION_HEADER = "x-workstep-local-session"
CONTENT_SECURITY_POLICY = "; ".join(
    (
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data:",
        "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors *",
        "form-action 'self'",
    )
)

REMOTE_NATIVE_PATHS = frozenset({
    "/api/fs/open-directory", "/api/fs/open-session-journal", "/api/fs/directory-openers",
    "/api/project/init", "/api/project/register",
})
REMOTE_PROJECT_SCOPED_FS = frozenset({
    "/api/fs/browse", "/api/fs/search", "/api/fs/file", "/api/fs/preview",
    "/api/fs/serve", "/api/fs/upload/file", "/api/fs/upload/image",
})
SHARE_ARTIFACT_CONTENT = re.compile(r"/api/platform-share/artifacts/[0-9a-f]{64}/content\Z")
SHARE_HISTORY_PAGE = re.compile(r"/api/platform-share/history/(?:0|[1-9][0-9]{0,5})\Z")
SHARE_EVENTS_PAGE = re.compile(
    r"/api/platform-share/events/[A-Za-z0-9_-]{1,128}/(?:0|[1-9][0-9]{0,8})\Z"
)


def _remote_filesystem_denied(request: Request) -> bool:
    path = request.url.path
    if path in REMOTE_NATIVE_PATHS:
        return True
    if path in REMOTE_PROJECT_SCOPED_FS or path.startswith("/api/fs/raw/") or path.startswith("/api/fs/serve/"):
        return not bool(request.query_params.get("project_id"))
    return False


def _desktop_token() -> str | None:
    if os.environ.get("WORKSTEP_DESKTOP_RUNTIME") != "1":
        return None
    return os.environ.get("WORKSTEP_DESKTOP_TOKEN", "")


def _valid_token(value: str | None) -> bool:
    expected = _desktop_token()
    if expected is None:
        return True
    if not expected or not value:
        return False
    return hmac.compare_digest(value, expected)


def _same_origin(origin: str | None, scheme: str, host: str) -> bool:
    if origin is None:
        return True
    try:
        parsed = urlsplit(origin)
        return (parsed.scheme in ("http", "https") and parsed.netloc == host
                and parsed.scheme == scheme and not parsed.path and not parsed.query
                and not parsed.fragment)
    except ValueError:
        return False


def desktop_websocket_allowed(ws: WebSocket) -> bool:
    """Require the Electron main-process header in packaged desktop mode."""

    gateway_client = getattr(ws.app.state, "gateway_client", None)
    if (gateway_client is not None
            and getattr(gateway_client, "managed_config", None) is not None
            and ws.url.path == "/ws/remote-project"):
        return False
    remote_actor = ws.scope.get("gateway_remote_actor")
    if (remote_actor is not None and gateway_client is not None
            and getattr(gateway_client, "managed_config", None) is not None):
        if remote_actor.project_id is not None and ws.url.path != "/ws":
            return False
        ws.scope["managed_actor"] = remote_actor
        return True

    if not _valid_token(ws.headers.get(DESKTOP_TOKEN_HEADER)):
        return False
    if not _same_origin(ws.headers.get("origin"),
                        "https" if ws.url.scheme == "wss" else "http", ws.headers.get("host", "")):
        return False
    if gateway_client is None or getattr(gateway_client, "managed_config", None) is None:
        return True
    actor = gateway_client.local_sessions.resolve(ws.headers.get(LOCAL_SESSION_HEADER))
    if actor is None:
        return False
    ws.scope["managed_actor"] = actor
    return True


class DesktopSecurityMiddleware(BaseHTTPMiddleware):
    """Authenticate privileged desktop APIs and attach browser hardening headers."""

    async def dispatch(self, request: Request, call_next):
        protected = request.url.path.startswith(("/api/", "/docs", "/redoc", "/openapi.json"))
        gateway_client = getattr(request.app.state, "gateway_client", None)
        managed = gateway_client is not None and getattr(gateway_client, "managed_config", None) is not None
        actor = request.scope.get("gateway_remote_actor")
        remote_bridge = actor is not None and managed
        share_scope = request.scope.get("gateway_share_scope")
        if managed and (share_scope is not None or request.url.path.startswith("/api/platform-share/")):
            if (not remote_bridge or not isinstance(share_scope, dict)
                    or request.method != "GET"
                    or (request.url.path not in (
                        "/api/platform-share/task", "/api/platform-share/history",
                        "/api/platform-share/artifacts")
                        and not SHARE_ARTIFACT_CONTENT.fullmatch(request.url.path)
                        and not SHARE_HISTORY_PAGE.fullmatch(request.url.path)
                        and not SHARE_EVENTS_PAGE.fullmatch(request.url.path))
                    or request.url.query):
                response = JSONResponse({"detail": "share scope denied"}, status_code=403)
                response.headers.setdefault("Content-Security-Policy", CONTENT_SECURITY_POLICY)
                return response
            request.state.gateway_share_scope = share_scope
        if remote_bridge and actor.project_id is not None and not project_http_allowed(
                request, actor.project_id, actor.project_access_level,
                actor.remote_task_create):
            response = JSONResponse({"detail": "project scope denied"}, status_code=403)
            response.headers.setdefault("Content-Security-Policy", CONTENT_SECURITY_POLICY)
            return response
        if remote_bridge and _remote_filesystem_denied(request):
            response = JSONResponse({"detail": "remote host filesystem access unavailable"}, status_code=403)
            response.headers.setdefault("Content-Security-Policy", CONTENT_SECURITY_POLICY)
            return response
        invalid_origin = managed and protected and not _same_origin(
            request.headers.get("origin"), request.url.scheme, request.headers.get("host", ""),
        ) and not remote_bridge
        if invalid_origin:
            response = JSONResponse({"detail": "invalid desktop origin"}, status_code=403)
        else:
            if managed and protected and not remote_bridge and request.url.path not in ("/api/managed/bootstrap", "/api/health"):
                actor = gateway_client.local_sessions.resolve(request.headers.get(LOCAL_SESSION_HEADER))
            denied = protected and (
                (not remote_bridge and not _valid_token(request.headers.get(DESKTOP_TOKEN_HEADER)))
                or (managed and not remote_bridge and request.url.path not in ("/api/managed/bootstrap", "/api/health") and actor is None)
            )
            if denied:
                response = JSONResponse(
                    {"detail": "desktop authentication required"}, status_code=401,
                )
                if managed and protected and _valid_token(request.headers.get(DESKTOP_TOKEN_HEADER)):
                    response.headers["X-WorkStep-Managed-Session-Expired"] = "1"
            elif managed and request.url.path.startswith((
                    "/api/remote-project/", "/api/task-share/")):
                response = JSONResponse(
                    {"detail": "legacy sharing is unavailable in managed mode"}, status_code=403,
                )
            else:
                if actor is not None:
                    request.state.managed_actor = actor
                context = actor_context(ActorSnapshot(
                    actor_id=actor.user_id,
                    user_name=actor.display_name or actor.username,
                    device_id=actor.device_id, device_name=actor.device_id,
                    source="managed",
                    project_id=actor.project_id,
                    access_level=actor.project_access_level,
                    remote_task_create=actor.remote_task_create,
                    username=actor.username,
                )) if actor is not None else nullcontext()
                with context:
                    response = await call_next(request)

        response.headers.setdefault("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        )

        # 取消 iframe 嵌入限制：任何响应都不带 X-Frame-Options，CSP 允许任意祖先 frame。
        del response.headers["X-Frame-Options"]

        return response
