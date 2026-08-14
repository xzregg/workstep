"""Global system settings stored in ~/.workstep/config.json."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services.config import config_store

router = APIRouter(prefix="/api/system-settings")


class SystemSettingsRequest(BaseModel):
    user_name: str = Field(max_length=80)


@router.get("")
async def get_system_settings():
    return {"user_name": config_store.get_user_name(), **config_store.get_device_identity()}


@router.put("")
async def set_system_settings(req: SystemSettingsRequest):
    user_name = req.user_name.strip()
    if not user_name:
        raise HTTPException(status_code=400, detail="使用者名称不能为空")
    config_store.set_user_name(user_name)
    return {"user_name": config_store.get_user_name(), **config_store.get_device_identity()}
