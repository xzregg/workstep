"""Enterprise chat bots and task discussion-group bindings."""

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, model_validator
from typing import Literal
import logging

logger = logging.getLogger(__name__)


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
    card_template_id: str = Field(default="", max_length=200)


class UpdateBotRequest(BaseModel):
    name: str | None = None
    app_id: str | None = None
    secret: str | None = None
    enabled: bool | None = None
    default_target_type: str | None = None
    default_project_id: str | None = None
    default_task_id: str | None = None
    card_template_id: str | None = Field(default=None, max_length=200)


class BindGroupRequest(BaseModel):
    project_id: str = Field(min_length=1)
    bot_id: str = Field(min_length=1)
    group_id: str = Field(min_length=1)
    group_name: str | None = Field(default=None, max_length=200)


class BindCurrentGroupRequest(BaseModel):
    project_id: str = Field(min_length=1)
    task_id: str = Field(min_length=1)


class ChannelAttachmentRequest(BaseModel):
    kind: Literal['image', 'file']
    path: str = Field(min_length=1)


class SendChannelMessageRequest(BaseModel):
    project_id: str = Field(min_length=1)
    text: str = ""
    attachments: list[ChannelAttachmentRequest] = Field(default_factory=list, max_length=10)
    session_id: str | None = None
    bot_id: str | None = None
    user_id: str | None = None
    group_id: str | None = None

    @model_validator(mode="after")
    def validate_recipient(self):
        if (not self.text.strip() and not self.attachments) or not self.project_id.strip():
            raise ValueError("消息和项目不能为空")
        for value in (self.session_id, self.bot_id, self.user_id, self.group_id):
            if value is not None and not value.strip():
                raise ValueError("目标标识不能为空")
        if self.session_id:
            if any((self.bot_id, self.user_id, self.group_id)):
                raise ValueError("会话目标不能同时指定机器人或收件人")
        elif not self.bot_id or bool(self.user_id) == bool(self.group_id):
            raise ValueError("必须指定会话，或者机器人和唯一的用户/群")
        return self


def _enforce_project_scope(project_id):
    from services.remote_access import get_current_actor
    actor = get_current_actor()
    if actor is not None and actor.project_id is not None and actor.project_id != project_id:
        raise HTTPException(status_code=403, detail="Project scope denied")


@router.get("/sessions")
async def channel_sessions(project_id: str = Query(..., min_length=1)):
    _enforce_project_scope(project_id)
    try:
        return await _manager().list_channel_sessions(project_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/sessions/{session_id}/bind-task")
async def bind_current_group(session_id: str, request: BindCurrentGroupRequest):
    _enforce_project_scope(request.project_id)
    try:
        return await _manager().bind_session_group(session_id, request.project_id, request.task_id)
    except (ValueError, LookupError) as exc:
        _raise_error(exc)


@router.post("/send")
async def send_channel_message(request: SendChannelMessageRequest):
    _enforce_project_scope(request.project_id)
    try:
        return await _manager().send_message(**request.model_dump())
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        if str(exc) in {"渠道会话已归档", "机器人未启用或尚未连接"}:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        logger.exception("Channel notification delivery failed")
        raise HTTPException(status_code=502, detail="渠道消息发送失败，请检查机器人连接及发送权限") from exc
    except Exception as exc:
        logger.exception("Channel notification delivery failed")
        raise HTTPException(status_code=502, detail="渠道消息发送失败，请检查机器人连接及发送权限") from exc


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
            request.project_id, task_id, request.bot_id, request.group_id, request.group_name,
        )
    except (ValueError, LookupError) as exc:
        _raise_error(exc)


@task_group_router.delete("/{task_id}/discussion-groups/{bot_id}/{group_id}")
async def unbind_task_group(task_id: str, bot_id: str, group_id: str, project_id: str = Query(...)):
    await _manager().unbind_group(project_id, task_id, bot_id, group_id)
    return {"deleted": True}
