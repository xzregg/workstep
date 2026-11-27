"""Standalone zero-database WebRTC signaling + UDP STUN server."""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse

from workstep_webrtc_signal import SignalingHub, StunServer, create_webrtc_router


@dataclass
class SignalSettings:
    host: str = os.environ.get("WORKSTEP_SIGNAL_HOST", "0.0.0.0")
    port: int = int(os.environ.get("WORKSTEP_SIGNAL_PORT", "8780"))
    stun_host: str = os.environ.get("WORKSTEP_STUN_HOST", "0.0.0.0")
    stun_port: int = int(os.environ.get("WORKSTEP_STUN_PORT", "3478"))
    public_host: str = os.environ.get("WORKSTEP_PUBLIC_HOST", "").strip()
    web_dist: Path | None = (
        Path(os.environ["WORKSTEP_SIGNAL_WEB_DIST"])
        if os.environ.get("WORKSTEP_SIGNAL_WEB_DIST")
        else None
    )


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


def _stun_urls_for_request(request: Request, settings: SignalSettings, bound_port: int) -> list[str]:
    host = settings.public_host or (request.url.hostname or "127.0.0.1")
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return [f"stun:{host}:{bound_port}"]


def create_app(settings: SignalSettings | None = None) -> FastAPI:
    if settings is None:
        settings = SignalSettings()
        if settings.web_dist is None:
            candidate = Path(__file__).resolve().parents[1] / "web" / "dist"
            if candidate.is_dir():
                settings.web_dist = candidate

    hub = SignalingHub()
    stun = StunServer(host=settings.stun_host, port=settings.stun_port)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        bound_port = await stun.start()
        app.state.stun_port = bound_port
        try:
            yield
        finally:
            await stun.close()

    app = FastAPI(title="WorkStep WebRTC Signal", lifespan=lifespan)
    app.state.hub = hub
    app.state.stun = stun
    app.state.stun_port = settings.stun_port

    app.include_router(
        create_webrtc_router(
            hub,
            stun_urls_provider=lambda req: _stun_urls_for_request(req, settings, app.state.stun_port),
        )
    )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        return response

    @app.get("/api/health")
    async def health():
        return {
            "status": "ok",
            "stun_port": app.state.stun_port,
            "direct_only": True,
        }

    web_dist = settings.web_dist
    if web_dist is not None and web_dist.is_dir():
        index_file = web_dist / "index.html"

        async def _serve_file_or_index(rel: str) -> FileResponse:
            if rel:
                candidate = await asyncio.to_thread(_resolve_static, web_dist, rel)
                if candidate is not None:
                    headers = {"Cache-Control": "no-store"} if candidate.suffix == ".html" else None
                    return FileResponse(candidate, headers=headers)
                if rel == "assets" or rel.startswith("assets/"):
                    raise HTTPException(status_code=404)
            if not index_file.is_file():
                raise HTTPException(status_code=404)
            return FileResponse(index_file, headers={"Cache-Control": "no-store"})

        @app.get("/p2p/{device_id}", include_in_schema=False)
        async def p2p_root(device_id: str) -> FileResponse:
            return await _serve_file_or_index("")

        @app.get("/p2p/{device_id}/{fullpath:path}", include_in_schema=False)
        async def p2p_subpath(device_id: str, fullpath: str) -> FileResponse:
            return await _serve_file_or_index(fullpath)

        @app.get("/{fullpath:path}", include_in_schema=False)
        async def spa_fallback(fullpath: str) -> FileResponse:
            if fullpath == "api" or fullpath.startswith("api/"):
                raise HTTPException(status_code=404)
            return await _serve_file_or_index(fullpath)

    return app


app = create_app()
