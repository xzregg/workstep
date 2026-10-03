"""Security boundary for the privileged loopback API used by Electron."""

from __future__ import annotations

import hmac
import os
import re
from contextlib import nullcontext

from fastapi import WebSocket
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from services.remote_access import ActorSnapshot, actor_context
from services.project_request_audit import record_remote_request_failure
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
    # 不做 Origin 同源校验：TLS 终结的逆向代理（nginx 等）把 wss 转发到本机
    # daemon 后，连接是 ws:// 而 Origin 仍是 https://，scheme 对不上会把所有
    # 合法的反代部署挡在门外。WS 访问控制由 desktop token + managed local
    # session 承担。
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
                request, actor.project_id, actor.project_access_level,
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
