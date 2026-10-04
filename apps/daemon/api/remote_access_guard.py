"""Browser identity and remote access HTTP/WebSocket adapters."""

from __future__ import annotations

import asyncio
from fastapi import WebSocket
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from services.remote_access import (
    RemoteAccessService, ACCESS_COOKIE_NAME, _current_actor, get_current_actor,
    actor_from_browser_headers, _is_loopback, _client_host, _guard_exempt,
)


class BrowserActorMiddleware(BaseHTTPMiddleware):
    """Attach the browser visitor identity for the lifetime of one request."""

    async def dispatch(self, request: Request, call_next):
        if get_current_actor() is not None:
            return await call_next(request)
        actor = actor_from_browser_headers(request.headers)
        if actor is None:
            return await call_next(request)
        token = _current_actor.set(actor)
        try:
            return await call_next(request)
        finally:
            _current_actor.reset(token)


class RemoteAccessGuardMiddleware(BaseHTTPMiddleware):
    """Require the access password for every non-local browser request.

    Only the ``/api`` surface is withheld, so the SPA shell can still load and
    render the unlock dialog. The main WebSocket feed applies the same check
    (see :func:`websocket_access_allowed`). Loopback callers, health checks
    and public share links stay reachable without the password.
    """

    def __init__(self, app, *, access_service: RemoteAccessService):
        super().__init__(app)
        self._service = access_service

    def _authorized(self, request: Request) -> bool:
        if _is_loopback(_client_host(request.headers, request.client)):
            return True
        if not self._service.access_password_required():
            return True
        token = request.cookies.get(ACCESS_COOKIE_NAME)
        if not token:
            header = request.headers.get("x-workstep-access")
            token = header.strip() if header else None
        return self._service.verify_access_token(token)

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if _guard_exempt(path, request.method):
            return await call_next(request)
        if await asyncio.to_thread(self._authorized, request):
            return await call_next(request)
        return JSONResponse(
            {"detail": "需要远程访问密钥", "code": "remote_access_locked"},
            status_code=401,
        )


def websocket_access_allowed(ws: WebSocket, access_service: "RemoteAccessService") -> bool:
    """Mirror ``RemoteAccessGuardMiddleware`` for the main WebSocket feed."""
    if _is_loopback(_client_host(ws.headers, ws.client)):
        return True
    if not access_service.access_password_required():
        return True
    token = ws.cookies.get(ACCESS_COOKIE_NAME)
    if not token:
        token = str(ws.query_params.get("access") or "").strip() or None
    return access_service.verify_access_token(token)
