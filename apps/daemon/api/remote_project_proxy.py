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
        if not request.url.path.startswith("/api/"):
            return await call_next(request)

        body = await request.body()
        project_id = request.query_params.get("project_id")
        if not project_id and request.url.path.startswith("/api/fs/project-raw/"):
            remainder = request.url.path.removeprefix("/api/fs/project-raw/")
            project_id = remainder.split("/", 1)[0] or None
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
        gateway_client = getattr(request.app.state, "gateway_client", None)
        if (gateway_client is not None
                and getattr(gateway_client, "managed_config", None) is not None):
            return JSONResponse(
                {"detail": "legacy remote projects are unavailable in managed mode"},
                status_code=403,
            )

        forwarded = RemoteHttpRequest(
            request_id=str(uuid.uuid4()),
            method=request.method,
            path=request.url.path,
            query={key: value for key, value in request.query_params.items()},
            headers={key: value for key, value in request.headers.items()},
            body=body,
        )
        try:
            response = await self._client_manager.request(project_id, forwarded)
        except Exception as exc:
            logger.warning("Remote project request unavailable: %s", exc)
            return JSONResponse(
                {"detail": f"远程项目连接不可用：{exc}"},
                status_code=502,
            )
        return Response(
            content=response.body,
            status_code=response.status,
            headers=response.headers,
        )
