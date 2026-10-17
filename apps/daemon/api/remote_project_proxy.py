"""Translate local HTTP calls to the remote project client service."""

import asyncio
import json
import logging
import uuid
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from services.remote_registry import RemoteProjectRegistry
from services.remote_protocol import RemoteHttpRequest
from services.remote_access import get_current_actor

logger = logging.getLogger(__name__)


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
        from workstep_gateway_protocol.hooks import HOOK_PATH
        if HOOK_PATH.fullmatch(request.url.path):
            # Hook ingress enforces a streaming body limit itself; never buffer
            # it here or infer a remote project from an untrusted payload.
            return await call_next(request)
        if not request.url.path.startswith("/api/"):
            return await call_next(request)

        body = await request.body()
        project_id = request.query_params.get("project_id")
        for prefix in ('/api/fs/project-raw/', '/api/fs/html-resource/'):
            if not project_id and request.url.path.startswith(prefix):
                project_id = request.url.path.removeprefix(prefix).split('/', 1)[0] or None
        if not project_id and "application/json" in request.headers.get("content-type", ""):
            try:
                payload = json.loads(body or b"{}")
            except (UnicodeDecodeError, json.JSONDecodeError):
                payload = None
            if isinstance(payload, dict) and isinstance(payload.get("project_id"), str):
                project_id = payload["project_id"]
        if not project_id or await asyncio.to_thread(
            self._registry.get, project_id
        ) is None:
            return await call_next(request)
        actor = get_current_actor()
        forwarded = RemoteHttpRequest(
            request_id=str(uuid.uuid4()),
            method=request.method,
            path=request.url.path,
            query={key: value for key, value in request.query_params.items()},
            # Local process/browser credentials belong only to this daemon;
            # the remote transport authenticates its own device/project.
            headers={key: value for key, value in request.headers.items()
                     if key.lower() in {'accept', 'content-type', 'idempotency-key'}},
            body=body,
            actor={
                'actor_id': actor.actor_id,
                'user_name': actor.user_name,
                'username': actor.username or '',
            } if actor is not None else None,
        )
        try:
            response = await self._client_manager.request(project_id, forwarded)
        except Exception as exc:
            logger.warning("Remote project request unavailable: %s", exc)
            return JSONResponse(
                {"detail": f"远程项目连接不可用：{exc}"},
                status_code=502,
            )
        headers = dict(response.headers)
        from workstep_gateway_protocol.html_preview import html_preview_policy, PREVIEW_RESOURCES_HEADER
        root = headers.get(PREVIEW_RESOURCES_HEADER.lower())
        if root is not None:
            headers['content-security-policy'] = html_preview_policy(
                f'{request.url.scheme}://{request.url.netloc}', root if root != 'none' else None)
        return Response(
            content=response.body,
            status_code=response.status,
            headers=headers,
        )
