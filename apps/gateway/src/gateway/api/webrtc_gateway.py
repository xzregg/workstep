"""Mount WebRTC signaling router and /p2p/<device_id>/ workbench UI in Gateway."""

from __future__ import annotations

import asyncio
import re
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from workstep_webrtc_signal import SignalingHub, create_webrtc_router

from gateway.config import GatewaySettings
from gateway.services.identity import COOKIE_NAME
from gateway.services.webrtc_auth import is_gateway_device_session_authorized

_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "testclient"}


def stun_urls_for_gateway(request: Request, settings: GatewaySettings, bound_port: int) -> list[str]:
    """Return configured public STUN URLs plus Gateway's built-in STUN when bound."""
    urls = list(settings.stun_urls)
    if bound_port <= 0:
        return urls
    req_host = (request.url.hostname or "").strip()
    origin_host = (
        (urlsplit(settings.public_origin).hostname or "").strip()
        if settings.public_origin
        else ""
    )
    if req_host and req_host not in _LOOPBACK_HOSTS:
        host = req_host
    elif origin_host:
        host = origin_host
    else:
        host = req_host or "127.0.0.1"
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    builtin = f"stun:{host}:{bound_port}"
    if builtin not in urls:
        urls.append(builtin)
    return urls


def _resolve_static(root: Path, rel: str) -> Path | None:
    if not rel or rel.startswith(("/", "\\", "..")):
        return None
    base = root.resolve()
    candidate = (root / rel).resolve()
    try:
        candidate.relative_to(base)
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


def install_webrtc_gateway(app: FastAPI, settings: GatewaySettings, hub: SignalingHub) -> None:
    """Register WebRTC signaling HTTP/WS endpoints and /p2p/<device_id>/ SPA routes."""

    async def _session_authorizer(request: Request, device_id: str) -> bool:
        if request.method != "GET":
            origin = request.headers.get("origin")
            if origin is not None:
                cleaned = origin.strip().rstrip("/")
                request_origin = f"{request.url.scheme}://{request.url.netloc}"
                if cleaned != request_origin and cleaned not in settings.platform_origins:
                    return False
        database = getattr(request.app.state, "database", None)
        return await is_gateway_device_session_authorized(
            database,
            hub,
            device_id=device_id,
            session_cookie=request.cookies.get(COOKIE_NAME),
        )

    app.include_router(
        create_webrtc_router(
            hub,
            stun_urls_provider=lambda req: stun_urls_for_gateway(
                req,
                settings,
                getattr(req.app.state, "stun_port", 0),
            ),
            session_authorizer=_session_authorizer,
        )
    )

    root = settings.workspace_web_dist

    async def _serve_p2p(device_id: str, fullpath: str = ""):
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", device_id):
            raise HTTPException(status_code=404)
        if root is None:
            raise HTTPException(status_code=503, detail="WorkStep WebRTC workspace build is unavailable")
        if fullpath:
            candidate = await asyncio.to_thread(_resolve_static, root, fullpath)
            if candidate is not None:
                headers = {"Cache-Control": "no-store"} if candidate.suffix == ".html" else None
                return FileResponse(candidate, headers=headers)
            if fullpath == "api" or fullpath.startswith(("api/", "assets/", "workspace-assets/")):
                raise HTTPException(status_code=404)
        try:
            html = await asyncio.to_thread((root / "index.html").read_text, encoding="utf-8")
        except OSError as exc:
            raise HTTPException(
                status_code=503,
                detail="WorkStep WebRTC workspace build is unavailable",
            ) from exc
        return HTMLResponse(html, headers={"Cache-Control": "no-store"})

    @app.get("/p2p/{device_id}", include_in_schema=False)
    async def p2p_root(device_id: str):
        return await _serve_p2p(device_id)

    @app.get("/p2p/{device_id}/{fullpath:path}", include_in_schema=False)
    async def p2p_subpath(device_id: str, fullpath: str):
        return await _serve_p2p(device_id, fullpath)
