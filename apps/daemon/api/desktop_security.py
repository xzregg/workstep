"""Security boundary for the privileged desktop API used by Electron."""

from __future__ import annotations

import asyncio
import hmac
import os
import re
from contextlib import nullcontext

from fastapi import WebSocket
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse
from services.gateway_client.browser_login import COOKIE as PLATFORM_COOKIE

from services.remote_access import ActorSnapshot, actor_context
from services.project_request_audit import record_remote_request_failure
from services.project_scope import project_http_allowed


DESKTOP_TOKEN_HEADER = "x-workstep-desktop-token"
LOCAL_SESSION_HEADER = "x-workstep-local-session"


def browser_origin_allowed(request: Request | WebSocket) -> bool:
    """Keep the Host boundary when a proxy terminates browser TLS.

    No forwarded header can supply a different authority. HTTPS may arrive
    over HTTP internally, but HTTP origins cannot downgrade an HTTPS request.
    """
    scheme = 'https' if request.url.scheme in ('https', 'wss') else 'http'
    authority = request.url.netloc
    origin = request.headers.get('origin')
    return (origin == f'{scheme}://{authority}'
            or (scheme == 'http' and origin == f'https://{authority}'))


async def _remote_task_share_management(request: Request) -> bool:
    """Only authenticated project-scoped management may pass to the LAN host."""
    if not re.fullmatch(r'/api/task-share/(?!public/)[^/]+(?:/create)?', request.url.path):
        return False
    project_id = request.query_params.get('project_id')
    if not project_id:
        return False
    from api.remote_project import remote_project_registry
    return await asyncio.to_thread(remote_project_registry.get, project_id) is not None


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
SHARE_ARTIFACT_CONTENT = re.compile(r"/api/platform-share/artifacts/[0-9a-f]{64}/(?:content|preview)\Z")
SHARE_UPLOAD_CONTENT = re.compile(r"/api/platform-share/uploads/t[0-9a-f]{24}-[0-9a-f]{32}\.[a-z0-9]{1,10}\Z")
SHARE_GIT_READ = re.compile(r"/api/platform-share/git/read/(?:repositories|history|changes|diff|blame|remotes|browse|preview|content)/[0-9a-f]{2,16384}\Z")
SHARE_GIT_STATUS = re.compile(r"/api/platform-share/git/worktrees/[0-9a-f]{24}/status\Z")
SHARE_GIT_BRANCHES = re.compile(r"/api/platform-share/git/worktrees/[0-9a-f]{24}/branches\Z")
SHARE_GIT_COMMIT = re.compile(r"/api/platform-share/git/worktrees/[0-9a-f]{24}/commit\Z")
SHARE_GIT_SYNC = re.compile(r"/api/platform-share/git/worktrees/[0-9a-f]{24}/(?:pull|push)\Z")
SHARE_GIT_BRANCH_WRITE = re.compile(r"/api/platform-share/git/worktrees/[0-9a-f]{24}/(?:switch|fetch|branches|branches/delete)\Z")
SHARE_HISTORY_PAGE = re.compile(r"/api/platform-share/history/(?:0|[1-9][0-9]{0,5})\Z")
SHARE_EVENTS_PAGE = re.compile(
    r"/api/platform-share/events/[A-Za-z0-9_-]{1,128}/(?:0|[1-9][0-9]{0,8})\Z"
)
SHARE_STEP_WRITE = re.compile(
    r"/api/platform-share/steps/[A-Za-z0-9_-]{1,128}/(?:message|resume|cancel)\Z"
)
SHARE_REVIEW_WRITE = re.compile(
    r"/api/platform-share/steps/[A-Za-z0-9_-]{1,128}/review/(?:approve|reject|force_approve|terminate|complete_task)\Z"
)
SHARE_INTERVENTION_WRITE = re.compile(
    r"/api/platform-share/interventions/[A-Za-z0-9_-]{1,128}/respond\Z"
)


def gateway_device_owner(request: Request) -> bool:
    actor = request.scope.get('gateway_remote_actor')
    return bool(actor is not None and actor.project_id is None
                and request.scope.get('gateway_device_owner') is True)


def _remote_filesystem_denied(request: Request) -> bool:
    path = request.url.path
    if path in ('/api/project/init', '/api/project/register', '/api/fs/browse', '/api/fs/search', '/api/fs/mkdir'):
        if gateway_device_owner(request): return False
        if path == '/api/fs/mkdir': return True
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


def desktop_request_authenticated(request: Request) -> bool:
    return _valid_token(request.headers.get(DESKTOP_TOKEN_HEADER))


def desktop_runtime_authenticated(request: Request | WebSocket) -> bool:
    """Verify the per-launch Electron credential, never a client-supplied flag."""
    return (_desktop_token() is not None
            and "gateway_remote_actor" not in request.scope
            and _valid_token(request.headers.get(DESKTOP_TOKEN_HEADER)))


def _remote_access_enabled(app) -> bool:
    service = getattr(app.state, "remote_access_service", None)
    return bool(service and service.settings().get("enabled"))


async def desktop_websocket_allowed(ws: WebSocket) -> bool:
    """Require the Electron main-process header in packaged desktop mode."""

    gateway_client = getattr(ws.app.state, "gateway_client", None)
    if ws.url.path == "/ws/remote-project":
        # Native LAN connections authenticate their project invitation/device
        # credential in the remote host handler, independently of Gateway login.
        return ('gateway_remote_actor' not in ws.scope and (
            desktop_runtime_authenticated(ws)
            or await asyncio.to_thread(_remote_access_enabled, ws.app)))
    remote_actor = ws.scope.get("gateway_remote_actor")
    if (remote_actor is not None and gateway_client is not None
            and getattr(gateway_client, "managed_config", None) is not None):
        if remote_actor.project_id is not None and ws.url.path != "/ws":
            return False
        ws.scope["managed_actor"] = remote_actor
        return True

    # 显式 session header 兼容 TLS 终结反代；浏览器自动携带的 cookie
    # 必须另行校验 Origin，避免跨站 WebSocket 使用本机会话。
    if gateway_client is None or getattr(gateway_client, "managed_config", None) is None:
        return (_valid_token(ws.headers.get(DESKTOP_TOKEN_HEADER))
                or await asyncio.to_thread(_remote_access_enabled, ws.app))
    desktop_authenticated = desktop_runtime_authenticated(ws)
    if not desktop_authenticated and ws.cookies.get(PLATFORM_COOKIE) and not ws.headers.get(LOCAL_SESSION_HEADER):
        if not browser_origin_allowed(ws):
            return False
    browser_login = getattr(ws.app.state, 'gateway_browser_login', None)
    desktop_session = getattr(browser_login, 'desktop_local_session', None) if desktop_authenticated else None
    actor = gateway_client.local_sessions.resolve(ws.headers.get(LOCAL_SESSION_HEADER) or ws.cookies.get(PLATFORM_COOKIE) or desktop_session)
    if actor is None and desktop_authenticated:
        actor = getattr(gateway_client, 'current_actor', None)
    if actor is None:
        return desktop_authenticated or await asyncio.to_thread(_remote_access_enabled, ws.app)
    if actor.project_id is not None:
        return False
    ws.scope["managed_actor"] = actor
    return True


class DesktopSecurityMiddleware(BaseHTTPMiddleware):
    """Authenticate privileged desktop APIs and attach browser hardening headers."""

    async def dispatch(self, request: Request, call_next):
        from workstep_gateway_protocol.hooks import HOOK_PATH
        if HOOK_PATH.fullmatch(request.url.path):
            # Only this narrow ingress authenticates with its own hook token.
            # It never inherits a browser/Gateway user identity.
            with actor_context(None):
                response = await call_next(request)
            response.headers['Cache-Control'] = 'no-store'
            response.headers['Referrer-Policy'] = 'no-referrer'
            return response
        desktop_authenticated = desktop_runtime_authenticated(request)
        # The login page and Electron both return with this marker. Complete
        # the local fallback before the managed-mode redirect/API boundary.
        loopback = ("127.0.0.1", "::1", "localhost")
        local_return = (desktop_authenticated or (
            _desktop_token() is None and request.client is not None
            and request.client.host in loopback and request.url.hostname in loopback))
        if (request.method == "GET" and request.url.path == "/"
                and request.query_params.get("gateway_auth") == "cancelled"
                and "gateway_remote_actor" not in request.scope and local_return
                and not os.environ.get("WORKSTEP_MANAGED_BUNDLE_DIR")):
            browser_login = getattr(request.app.state, "gateway_browser_login", None)
            if browser_login is not None:
                configured = await browser_login.settings()
                await browser_login.save_settings(configured["url"], False)
                response = RedirectResponse("/", status_code=303)
                response.delete_cookie(PLATFORM_COOKIE, path="/")
                response.headers["Cache-Control"] = "no-store"
                return response
        protected = request.url.path.startswith(("/api/", "/docs", "/redoc", "/openapi.json"))
        gateway_client = getattr(request.app.state, "gateway_client", None)
        managed = gateway_client is not None and getattr(gateway_client, "managed_config", None) is not None
        actor = request.scope.get("gateway_remote_actor")
        remote_bridge = actor is not None and managed
        remote_access = (
            (protected or request.url.path == "/") and not remote_bridge
            and not _valid_token(request.headers.get(DESKTOP_TOKEN_HEADER))
            and await asyncio.to_thread(_remote_access_enabled, request.app)
        )
        share_scope = request.scope.get("gateway_share_scope")
        if managed and (share_scope is not None or request.url.path.startswith("/api/platform-share/")):
            if (not remote_bridge or not isinstance(share_scope, dict)
                    or (request.method == "GET" and request.url.path not in (
                        "/api/platform-share/task", "/api/platform-share/history",
                        "/api/platform-share/artifacts", "/api/platform-share/reviews",
                        "/api/platform-share/interventions",
                        "/api/platform-share/git/workspace",
                        "/api/platform-share/execution-report")
                        and not SHARE_ARTIFACT_CONTENT.fullmatch(request.url.path)
                        and not SHARE_UPLOAD_CONTENT.fullmatch(request.url.path)
                        and not SHARE_GIT_READ.fullmatch(request.url.path)
                        and not SHARE_GIT_STATUS.fullmatch(request.url.path)
                        and not SHARE_GIT_BRANCHES.fullmatch(request.url.path)
                        and not SHARE_HISTORY_PAGE.fullmatch(request.url.path)
                        and not SHARE_EVENTS_PAGE.fullmatch(request.url.path))
                    or (request.method == "POST" and (
                        share_scope.get("mode") != "interactive"
                        or (not SHARE_STEP_WRITE.fullmatch(request.url.path)
                            and not SHARE_REVIEW_WRITE.fullmatch(request.url.path)
                            and not SHARE_INTERVENTION_WRITE.fullmatch(request.url.path)
                            and not SHARE_GIT_COMMIT.fullmatch(request.url.path)
                            and not SHARE_GIT_SYNC.fullmatch(request.url.path)
                            and not SHARE_GIT_BRANCH_WRITE.fullmatch(request.url.path)
                            and request.url.path != "/api/platform-share/uploads")))
                    or request.method not in ("GET", "POST")
                    or request.url.query):
                response = JSONResponse({"detail": "share scope denied"}, status_code=403)
                response.headers.setdefault("Content-Security-Policy", CONTENT_SECURITY_POLICY)
                return response
            request.state.gateway_share_scope = share_scope
        if remote_bridge and actor.project_id is not None and not project_http_allowed(
                request.method, request.url.path, list(request.query_params.multi_items()),
                actor.project_id, actor.project_access_level,
                actor.remote_task_create):
            await record_remote_request_failure(actor, 403, "project_scope")
            response = JSONResponse({"detail": "project scope denied"}, status_code=403)
            response.headers.setdefault("Content-Security-Policy", CONTENT_SECURITY_POLICY)
            return response
        if remote_bridge and _remote_filesystem_denied(request):
            await record_remote_request_failure(actor, 403, "host_filesystem_scope")
            response = JSONResponse({"detail": "remote host filesystem access unavailable"}, status_code=403)
            response.headers.setdefault("Content-Security-Policy", CONTENT_SECURITY_POLICY)
            return response
        if managed and protected and not remote_bridge:
            browser_login = getattr(request.app.state, 'gateway_browser_login', None)
            desktop_session = getattr(browser_login, 'desktop_local_session', None) if desktop_authenticated else None
            actor = gateway_client.local_sessions.resolve(request.headers.get(LOCAL_SESSION_HEADER) or request.cookies.get(PLATFORM_COOKIE) or desktop_session)
            if actor is None and desktop_authenticated:
                actor = getattr(gateway_client, 'current_actor', None)
        if (managed and not desktop_authenticated and actor is not None and request.cookies.get(PLATFORM_COOKIE)
                and not request.headers.get(LOCAL_SESSION_HEADER) and request.method not in ("GET", "HEAD", "OPTIONS")
                and not browser_origin_allowed(request)):
            return JSONResponse({"detail": "same-origin request required"}, status_code=403)
        if (managed and not remote_bridge and not desktop_authenticated and not remote_access and request.url.path == "/"
                and request.query_params.get("gateway_auth") != "cancelled"
                and getattr(request.app.state, "gateway_browser_login", None) is not None
                and gateway_client.local_sessions.resolve(request.headers.get(LOCAL_SESSION_HEADER) or request.cookies.get(PLATFORM_COOKIE)) is None):
            return RedirectResponse("/gateway/login", status_code=303)
        browser_session = managed and actor is not None and actor.project_id is None
        denied = protected and (
            (not remote_bridge and not remote_access and not browser_session
             and request.url.path != "/api/gateway-platform/callback"
             and not _valid_token(request.headers.get(DESKTOP_TOKEN_HEADER)))
            or (managed and not remote_bridge and not desktop_authenticated and not remote_access and request.url.path not in ("/api/managed/bootstrap", "/api/health", "/api/gateway-platform/settings", "/api/gateway-platform/login", "/api/gateway-platform/callback") and actor is None)
        )
        if denied:
            response = JSONResponse(
                {"detail": "desktop authentication required"}, status_code=401,
            )
            if managed and not desktop_authenticated and not remote_bridge and getattr(request.app.state, 'gateway_browser_login', None) is not None:
                response.headers["X-WorkStep-Gateway-Login"] = "/gateway/login"
            if managed and protected and _valid_token(request.headers.get(DESKTOP_TOKEN_HEADER)):
                response.headers["X-WorkStep-Managed-Session-Expired"] = "1"
        elif (managed and request.url.path.startswith('/api/task-share/')
              and not await _remote_task_share_management(request)):
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
                provider_ids=actor.provider_ids,
                provider_grant_expires_at=actor.provider_grant_expires_at,
            )) if actor is not None else nullcontext()
            with context:
                try:
                    response = await call_next(request)
                except Exception:
                    if remote_bridge:
                        await record_remote_request_failure(actor, 500, "handler_failure")
                    raise
                if remote_bridge and response.status_code >= 400:
                    await record_remote_request_failure(actor, response.status_code, "handler_rejected")

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
