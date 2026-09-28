"""Security boundary for the privileged loopback API used by Electron."""

from __future__ import annotations

import hmac
import os

from fastapi import WebSocket
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse


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


def desktop_websocket_allowed(ws: WebSocket) -> bool:
    """Require the Electron main-process header in packaged desktop mode."""

    if not _valid_token(ws.headers.get(DESKTOP_TOKEN_HEADER)):
        return False
    gateway_client = getattr(ws.app.state, "gateway_client", None)
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
        actor = None
        if managed and protected and request.url.path not in ("/api/managed/bootstrap", "/api/health"):
            actor = gateway_client.local_sessions.resolve(request.headers.get(LOCAL_SESSION_HEADER))
        denied = protected and (
            not _valid_token(request.headers.get(DESKTOP_TOKEN_HEADER))
            or (managed and request.url.path not in ("/api/managed/bootstrap", "/api/health") and actor is None)
        )
        if denied:
            response = JSONResponse(
                {"detail": "desktop authentication required"},
                status_code=401,
            )
        else:
            if actor is not None:
                request.state.managed_actor = actor
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
