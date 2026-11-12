"""Host-scoped digital person configuration; no workspace/access selectors."""
import asyncio
from fastapi import APIRouter, Depends, HTTPException
from api.project_scope import require_catalog_project
from services import digital_person as service
from services.digital_person import DigitalPersonProfile


def authorize():
    require_catalog_project("")


router = APIRouter(prefix="/api/digital-person", dependencies=[Depends(authorize)])


@router.get("", response_model=DigitalPersonProfile)
async def get_profile():
    return await asyncio.to_thread(service.get_profile)


@router.put("", response_model=DigitalPersonProfile)
async def save_profile(profile: DigitalPersonProfile):
    try:
        return await asyncio.to_thread(service.save_profile, profile)
    except OSError as exc:
        raise HTTPException(503, "数字人配置保存失败，请重试") from exc


@router.get("/voice-wake")
async def get_voice_wake():
    return await asyncio.to_thread(service.get_voice_wake)


@router.put("/voice-wake")
async def save_voice_wake(draft: service.VoiceWakeDraft):
    try:
        return await asyncio.to_thread(service.save_voice_wake, draft)
    except OSError as exc:
        raise HTTPException(503, "语音唤醒配置保存失败，请重试") from exc
