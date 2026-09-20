"""Security boundary for the privileged loopback API used by Electron."""

from __future__ import annotations

import hmac
import os

from fastapi import WebSocket
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse


DESKTOP_TOKEN_HEADER = "x-workstep-desktop-token"
CONTENT_SECURITY_POLICY = "; ".join(
    (
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data:",
        "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
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

    return _valid_token(ws.headers.get(DESKTOP_TOKEN_HEADER))


class DesktopSecurityMiddleware(BaseHTTPMiddleware):
    """Authenticate privileged desktop APIs and attach browser hardening headers."""

    async def dispatch(self, request: Request, call_next):
        protected = request.url.path.startswith(("/api/", "/docs", "/redoc", "/openapi.json"))
        if protected and not _valid_token(request.headers.get(DESKTOP_TOKEN_HEADER)):
            response = JSONResponse(
                {"detail": "desktop authentication required"},
                status_code=401,
            )
        else:
            response = await call_next(request)

        response.headers.setdefault("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        )
        return response
