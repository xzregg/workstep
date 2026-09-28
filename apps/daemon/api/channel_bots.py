"""Enterprise chat bots and task discussion-group bindings."""

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field


router = APIRouter(prefix="/api/channel-bots", tags=["渠道机器人"])
task_group_router = APIRouter(prefix="/api/task", tags=["任务讨论群"])


class CreateBotRequest(BaseModel):
    platform: str
    name: str = Field(min_length=1)
    app_id: str = Field(min_length=1)
    secret: str = Field(min_length=1)
    enabled: bool = False
    default_target_type: str = ""
    default_project_id: str = ""
    default_task_id: str = ""


class UpdateBotRequest(BaseModel):
    name: str | None = None
    app_id: str | None = None
    secret: str | None = None
    enabled: bool | None = None
    default_target_type: str | None = None
    default_project_id: str | None = None
    default_task_id: str | None = None


class BindGroupRequest(BaseModel):
    project_id: str = Field(min_length=1)
    bot_id: str = Field(min_length=1)
    group_id: str = Field(min_length=1)


def _manager():
    from main import channel_bot_manager
    if channel_bot_manager is None:
        raise HTTPException(status_code=503, detail="渠道机器人尚未初始化")
    return channel_bot_manager


def _raise_error(exc: Exception):
    if isinstance(exc, LookupError):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    status = 409 if "已绑定" in str(exc) or "已经添加" in str(exc) else 400
    raise HTTPException(status_code=status, detail=str(exc)) from exc


@router.get("")
async def list_bots():
    return await _manager().list_bots()


@router.post("")
async def create_bot(request: CreateBotRequest):
    try:
        return await _manager().create_bot(request.model_dump())
    except (ValueError, LookupError) as exc:
        _raise_error(exc)


@router.patch("/{bot_id}")
async def update_bot(bot_id: str, request: UpdateBotRequest):
    try:
        return await _manager().update_bot(bot_id, request.model_dump(exclude_unset=True))
    except (ValueError, LookupError) as exc:
        _raise_error(exc)


@router.delete("/{bot_id}")
async def delete_bot(bot_id: str):
    try:
        await _manager().delete_bot(bot_id)
    except (ValueError, LookupError) as exc:
        _raise_error(exc)
    return {"deleted": True}


@router.get("/{bot_id}/recent-groups")
async def recent_groups(bot_id: str):
    return await _manager().recent_groups(bot_id)


@task_group_router.get("/{task_id}/discussion-groups")
async def list_task_groups(task_id: str, project_id: str = Query(...)):
    return await _manager().list_task_groups(project_id, task_id)


@task_group_router.post("/{task_id}/discussion-groups")
async def bind_task_group(task_id: str, request: BindGroupRequest):
    try:
        return await _manager().bind_group(
            request.project_id, task_id, request.bot_id, request.group_id,
        )
    except (ValueError, LookupError) as exc:
        _raise_error(exc)


@task_group_router.delete("/{task_id}/discussion-groups/{bot_id}/{group_id}")
async def unbind_task_group(task_id: str, bot_id: str, group_id: str, project_id: str = Query(...)):
    await _manager().unbind_group(project_id, task_id, bot_id, group_id)
    return {"deleted": True}
