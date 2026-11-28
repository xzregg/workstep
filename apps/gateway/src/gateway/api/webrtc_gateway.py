"""Mount WebRTC signaling router and /p2p/<device_id>/ workbench UI in Gateway."""

from __future__ import annotations

from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from workstep_webrtc_signal import SignalingHub, create_webrtc_router

from gateway.config import GatewaySettings

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


def install_webrtc_gateway(app: FastAPI, settings: GatewaySettings, hub: SignalingHub) -> None:
    """Register WebRTC signaling HTTP/WS endpoints and /p2p/<device_id>/ SPA routes."""

    app.include_router(
        create_webrtc_router(
            hub,
            stun_urls_provider=lambda req: stun_urls_for_gateway(
                req,
                settings,
                getattr(req.app.state, "stun_port", 0),
            ),
        )
    )

    from workstep_webrtc_signal.bootstrap import install_bootstrap_routes
    install_bootstrap_routes(app, settings.workspace_web_dist)
