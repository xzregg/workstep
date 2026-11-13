"""Host-scoped digital person configuration; no workspace/access selectors."""
import asyncio
from typing import Literal
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
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
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


def runtime():
    import main
    if main.digital_person_runtime is None:
        raise HTTPException(503, "数字人正在初始化")
    return main.digital_person_runtime


@router.post("/main-session")
async def main_session():
    return await runtime().main_session()


@router.get("/activity")
async def activity():
    return await runtime().overview()


class FeedbackRequest(service.BaseModel):
    message_id: str
    value: service.Literal[-1, 0, 1]


@router.put("/feedback")
async def feedback(request: FeedbackRequest):
    try:
        return await runtime().feedback(request.message_id, request.value)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


class DelegateRequest(service.BaseModel):
    project_id: str
    instruction: str = service.Field(min_length=1, max_length=12000)
    origin_session_id: str = ""
    request_id: str = service.Field(min_length=1, max_length=200)


@router.post("/delegate")
async def delegate(request: DelegateRequest):
    try:
        return await runtime().delegate(**request.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/check")
async def check():
    try:
        return await runtime().check()
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/check/stop")
async def stop_check():
    await runtime().stop_check()
    return {"stopped": True}


@router.get("/channels")
async def channels():
    from services.digital_person_channels import available, get_bindings
    current = runtime()
    return {"available": await available(current.bots, current.projects), "bindings": await asyncio.to_thread(get_bindings)}


class ChannelBindingRequest(service.BaseModel):
    bot_id: str
    conversation_type: Literal['single', 'group']
    conversation_id: str
    notify: bool = False


@router.put("/channels")
async def bind_channel(request: ChannelBindingRequest):
    from services.digital_person_channels import bind
    try:
        current = runtime()
        return await bind(current.bots, current.projects, **request.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/channels/{binding_id}")
async def unbind_channel(binding_id: str):
    from services.digital_person_channels import unbind
    await unbind(binding_id)
    return {"deleted": True}


@router.post("/channels/{binding_id}/test")
async def test_channel(binding_id: str):
    from services.digital_person_channels import get_bindings
    bindings = await asyncio.to_thread(get_bindings)
    binding = next((r for r in bindings if r['id']==binding_id), None)
    if not binding:
        raise HTTPException(404, "渠道未绑定")
    profile = await asyncio.to_thread(service.get_profile)
    try:
        from services.digital_person_channels import send_binding
        return await send_binding(runtime().bots, binding, f"你好，我是{profile.name}。这是一条数字人连接测试。")
    except Exception as exc:
        raise HTTPException(502, str(exc)) from exc


@router.post('/runs/{run_id}/retry')
async def retry_delivery(run_id: str):
    try:
        return await runtime().retry_delivery(run_id)
    except ValueError as exc:
        raise HTTPException(409,str(exc)) from exc


@router.post('/delegations/{delegation_id}/stop')
async def stop_delegation(delegation_id: str):
    try:
        return await runtime().stop_delegation(delegation_id)
    except ValueError as exc:
        raise HTTPException(400,str(exc)) from exc
