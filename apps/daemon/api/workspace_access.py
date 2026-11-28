"""Shared workspace authorization; feature APIs declare policy, never transport.

Authentication stays in desktop_security/remote_access_guard. Project and record
permissions stay in project_scope and the domain services. Only this module
translates an authenticated transport into host/local/owner authority.
"""
from __future__ import annotations

import asyncio
import os
from typing import Literal

from fastapi import HTTPException, Request

from api.desktop_security import (
    browser_origin_allowed, desktop_runtime_authenticated, gateway_device_owner,
    local_gateway_fallback_allowed, webrtc_bridge_authenticated, webrtc_device_owner,
)
from services.gateway_client.browser_login import local_session_cookie_name
from services.remote_access import (
    ACCESS_COOKIE_NAME, _client_host, _is_loopback,
    get_current_actor,
)

WorkspacePolicy = Literal['host', 'local', 'local_credentials', 'scope', 'owner_session', 'gateway_configuration']


def local_client(request: Request) -> bool:
    """Verified native credential or actual loopback peer, never forwarded local IP."""
    return desktop_runtime_authenticated(request) or _is_loopback(_client_host(request.headers, request.client))


def remote_workspace_owner(request: Request) -> bool | None:
    """None means native transport; bool is the verified remote host grant."""
    if 'webrtc_remote_actor' in request.scope:
        return webrtc_device_owner(request)
    if 'gateway_remote_actor' in request.scope:
        return gateway_device_owner(request)
    return None


def host_identity_request(request: Request) -> bool:
    return (desktop_runtime_authenticated(request) or local_gateway_fallback_allowed(request)
            or remote_workspace_owner(request) is True)


def is_desktop_client(request: Request) -> bool:
    return desktop_runtime_authenticated(request)


def desktop_login_handoff(request: Request) -> bool:
    """UI handoff selection, not an authorization grant."""
    return desktop_runtime_authenticated(request) or bool(
        os.environ.get('WORKSTEP_DESKTOP_RUNTIME') == '1'
        and request.client and _is_loopback(request.client.host)
        and _is_loopback(request.url.hostname or ''))


def _scope_allowed(request: Request) -> bool:
    from services.remote_access import authenticated_remote_dispatch
    actor = get_current_actor()
    remote = request.scope.get('gateway_remote_actor')
    return not (
        authenticated_remote_dispatch() is not None
        or request.scope.get('gateway_share_scope') is not None
        or (actor is not None and actor.project_id is not None)
        or (remote is not None and getattr(remote, 'project_id', None) is not None)
        or ('webrtc_remote_actor' in request.scope and not webrtc_bridge_authenticated(request))
    )


def native_browser_access(request: Request) -> bool:
    """Synchronous password/config I/O; callers must use the I/O executor."""
    service = getattr(request.app.state, 'remote_access_service', None)
    if service is None or not service.settings().get('enabled'):
        return False
    return (not service.access_password_required()
            or service.verify_access_token(request.cookies.get(ACCESS_COOKIE_NAME)
                                           or request.headers.get('x-workstep-access')))


def _owner_session(request: Request) -> bool:
    if remote_workspace_owner(request) is not None:
        return False
    gateway = getattr(request.app.state, 'gateway_client', None)
    actor = getattr(request.state, 'managed_actor', None)
    return desktop_runtime_authenticated(request) or bool(
        gateway is not None and actor is not None and actor.project_id is None
        and actor.user_id == gateway.current_user_id)


async def workspace_access_allowed(request: Request, policy: WorkspacePolicy = 'host') -> bool:
    if not _scope_allowed(request):
        return False
    if policy == 'scope':
        return True
    actor = get_current_actor()
    remote_owner = remote_workspace_owner(request)
    if policy in ('local', 'local_credentials'):
        from services.project_audit import remote_audit_source
        return bool(remote_owner is None and not remote_audit_source()
                    and (actor is None or actor.source != 'remote')
                    and (desktop_runtime_authenticated(request)
                         or (local_client(request) and (policy == 'local' or _is_loopback(request.url.hostname or '')))))
    if policy == 'owner_session':
        return _owner_session(request)
    if policy == 'gateway_configuration':
        if remote_owner is not None:
            return remote_owner
        gateway = getattr(request.app.state, 'gateway_client', None)
        if gateway is None or gateway.managed_config is None or _owner_session(request):
            return True
        # A resolved local owner session may be available outside middleware
        # (login/callback routes); it remains bound to this device's owner.
        sessions = getattr(gateway, 'local_sessions', None)
        saved = sessions.resolve(request.headers.get('x-workstep-local-session')
                                 or request.cookies.get(local_session_cookie_name(request.app))) if sessions else None
        if saved is not None and saved.project_id is None and saved.user_id == gateway.current_user_id:
            return True
    elif policy != 'host':
        raise ValueError(f'Unknown workspace policy: {policy}')
    if remote_owner is not None:
        return remote_owner
    if actor is not None and actor.source == 'remote':
        return False
    if local_client(request):
        return actor is None or actor.access_source != 'remote_browser'
    return await asyncio.to_thread(native_browser_access, request)


def require_same_origin(request: Request, *, optional: bool = False, detail: str = 'Same-origin request required') -> None:
    # An authenticated bridge does not use browser ambient cookies. Local and
    # native browser requests retain their existing Origin protection.
    if not request.headers.get('origin') and remote_workspace_owner(request) is True:
        return
    if (not optional or request.headers.get('origin')) and not browser_origin_allowed(request):
        raise HTTPException(403, detail)


async def require_workspace_access(request: Request, policy: WorkspacePolicy = 'host', *,
                                   detail: str = 'Host workspace access required') -> None:
    if not await workspace_access_allowed(request, policy):
        raise HTTPException(403, detail)


async def require_host_workspace(request: Request) -> None:
    """FastAPI dependency for new host features, including verified direct access."""
    await require_workspace_access(request, 'host')


async def require_local_device(request: Request) -> None:
    """FastAPI dependency for operations that must stay on the physical host."""
    await require_workspace_access(request, 'local')
