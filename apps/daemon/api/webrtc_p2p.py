"""Host-scoped REST API for configuring WebRTC P2P remote access."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from api.workspace_access import require_workspace_access, require_same_origin

router = APIRouter(prefix="/api/webrtc-p2p", tags=["WebRTC P2P"])


class WebRtcSettingsInput(BaseModel):
    enabled: bool = False
    signal_url: str = Field(default="", max_length=2048)


async def _require_host_manager(request: Request, *, mutation: bool = False):
    await require_workspace_access(request, 'local_credentials', detail='WebRTC settings require direct host access')
    if mutation:
        require_same_origin(request, optional=True)

    service = getattr(request.app.state, "webrtc_client", None)
    if service is None:
        raise HTTPException(status_code=503, detail="WebRTC service unavailable")
    return service


@router.get("/settings")
async def get_webrtc_settings(request: Request):
    service = await _require_host_manager(request)
    return await service.get_settings()


@router.put("/settings")
async def update_webrtc_settings(request: Request, body: WebRtcSettingsInput):
    service = await _require_host_manager(request, mutation=True)
    try:
        return await service.update_settings(enabled=body.enabled, signal_url=body.signal_url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/rotate-key")
async def rotate_webrtc_pair_key(request: Request):
    service = await _require_host_manager(request, mutation=True)
    return await service.rotate_pair_key()


@router.post("/check")
async def check_webrtc_connectivity(request: Request):
    service = await _require_host_manager(request, mutation=True)
    return await service.check_connectivity()


@router.get("/status")
async def get_webrtc_status(request: Request):
    service = await _require_host_manager(request)
    return await service.get_status()
