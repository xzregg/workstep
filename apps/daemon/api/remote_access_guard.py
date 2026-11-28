"""Browser identity and remote access HTTP/WebSocket adapters."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from fastapi import WebSocket
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from services.remote_access import (
    RemoteAccessService, ACCESS_COOKIE_NAME, _current_actor, get_current_actor, authenticated_remote_dispatch,
    actor_from_browser_headers, _is_loopback, _client_host, _guard_exempt,
)
from api.desktop_security import (
    desktop_runtime_authenticated, LOCAL_SESSION_HEADER, webrtc_bridge_authenticated,
    local_gateway_fallback_allowed,
)
from services.gateway_client.browser_login import local_session_cookie_name


def gateway_browser_authenticated(request: Request | WebSocket) -> bool:
    """An existing host Gateway session is an alternative to the native key."""
    gateway = getattr(request.app.state, 'gateway_client', None)
    if gateway is None or getattr(gateway, 'managed_config', None) is None:
        return False
    actor = gateway.local_sessions.resolve(
        request.headers.get(LOCAL_SESSION_HEADER)
        or request.cookies.get(local_session_cookie_name(request.app)))
    return actor is not None and actor.project_id is None


def _gateway_bridge_authenticated(request: Request | WebSocket) -> bool:
    # Only the authenticated device bridge installs this ASGI scope identity.
    # Browser headers and cookies cannot manufacture it.
    if getattr(request, "scope", {}).get("gateway_remote_actor") is None:
        return False
    gateway_client = getattr(request.app.state, "gateway_client", None)
    return (gateway_client is not None
            and getattr(gateway_client, "managed_config", None) is not None)


class BrowserActorMiddleware(BaseHTTPMiddleware):
    """Attach the browser visitor identity for the lifetime of one request."""

    async def dispatch(self, request: Request, call_next):
        if get_current_actor() is not None:
            return await call_next(request)
        # A host that still uses Gateway must not silently create work under a
        # leftover browser profile while verified identity is being restored.
        gateway = getattr(request.app.state, 'gateway_client', None)
        from workstep_gateway_protocol.hooks import HOOK_PATH
        host_workspace = desktop_runtime_authenticated(request) or local_gateway_fallback_allowed(request)
        if (gateway is not None and host_workspace
                and request.url.path.startswith('/api/') and not HOOK_PATH.fullmatch(request.url.path)):
            from api.system_settings import _configured_gateway_mode
            enabled = bool(getattr(gateway, 'managed_config', None)) or await asyncio.to_thread(_configured_gateway_mode)
            if enabled:
                from services.remote_access import replayed_actor_context
                with replayed_actor_context(None):
                    return await call_next(request)
        from services.project_audit import _remote_browser_request
        # Container port forwarding changes the peer address of local Electron requests.
        remote = (not desktop_runtime_authenticated(request)
                  and not _is_loopback(_client_host(request.headers, request.client)))
        remote_token = _remote_browser_request.set(remote)
        actor = actor_from_browser_headers(request.headers)
        token = None
        if actor is not None:
            if remote:
                actor = replace(actor, access_source="remote_browser")
            token = _current_actor.set(actor)
        try:
            return await call_next(request)
        finally:
            if token is not None:
                _current_actor.reset(token)
            _remote_browser_request.reset(remote_token)


def remote_access_authorized(request: Request | WebSocket, access_service: RemoteAccessService) -> bool:
    """Shared HTTP/WebSocket/native unlock decision; run password I/O off-loop."""
    if (authenticated_remote_dispatch() is not None
            or _gateway_bridge_authenticated(request) or webrtc_bridge_authenticated(request)
            or desktop_runtime_authenticated(request)
            or gateway_browser_authenticated(request)):
        return True
    if _is_loopback(_client_host(request.headers, request.client)):
        return True
    if not access_service.access_password_required():
        return True
    token = request.cookies.get(ACCESS_COOKIE_NAME)
    if not token:
        header = request.headers.get("x-workstep-access")
        token = header.strip() if header else None
    if not token and isinstance(request, WebSocket):
        token = str(request.query_params.get('access') or '').strip() or None
    return access_service.verify_access_token(token)



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

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if _guard_exempt(path, request.method):
            return await call_next(request)
        if await asyncio.to_thread(remote_access_authorized, request, self._service):
            return await call_next(request)
        return JSONResponse(
            {"detail": "需要远程访问密钥", "code": "remote_access_locked"},
            status_code=401,
        )


def websocket_access_allowed(ws: WebSocket, access_service: RemoteAccessService) -> bool:
    return remote_access_authorized(ws, access_service)
