"""Project-scoped channel configuration API."""

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from services.channels.manager import (
    ChannelAlreadyLoggedInError,
    ChannelUnavailableError,
)


router = APIRouter(prefix="/api/channels", tags=["渠道"])


class ChannelConfigRequest(BaseModel):
    project_id: str = Field(min_length=1)
    enabled: bool = False
    assistant_id: str = "channel_chat"
    model: str = ""
    config: dict = Field(default_factory=dict)


def _manager():
    from main import channel_manager
    if channel_manager is None:
        raise HTTPException(status_code=503, detail="Channels are not initialized")
    return channel_manager


def _value_error_status(exc: ValueError) -> int:
    return 404 if "Project not found" in str(exc) else 400


@router.get("")
async def list_channels(project_id: str = Query(...)):
    try:
        return await _manager().list_channels(project_id)
    except ValueError as exc:
        raise HTTPException(status_code=_value_error_status(exc), detail=str(exc)) from exc
    except ChannelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.put("/{channel_id}/config")
async def update_channel(channel_id: str, request: ChannelConfigRequest):
    try:
        return await _manager().update_config(
            request.project_id, channel_id, request.model_dump(exclude={"project_id"})
        )
    except ValueError as exc:
        raise HTTPException(status_code=_value_error_status(exc), detail=str(exc)) from exc
    except ChannelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/wechat/login")
async def wechat_login(project_id: str = Query(...)):
    try:
        result = await _manager().login(project_id, "wechat")
    except ChannelAlreadyLoggedInError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ChannelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=_value_error_status(exc), detail=str(exc)) from exc
    return _manager()._login_dict(result)


@router.get("/wechat/login-status")
async def wechat_login_status(project_id: str = Query(...)):
    try:
        result = await _manager().login_status(project_id, "wechat")
    except ChannelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=_value_error_status(exc), detail=str(exc)) from exc
    return _manager()._login_dict(result)


@router.post("/wechat/logout")
async def wechat_logout(project_id: str = Query(...)):
    try:
        await _manager().logout(project_id, "wechat")
    except ChannelUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=_value_error_status(exc), detail=str(exc)) from exc
    return {"status": "success"}
