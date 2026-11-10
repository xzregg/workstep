"""Bounded audio requests reuse the authenticated HTTP / Gateway transport."""
import base64
import binascii

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from api.project_scope import require_catalog_project
from services.remote_access import get_current_actor
from services.speech import service

router = APIRouter(prefix='/api/speech', tags=['speech'])


def authorize(project_id: str, manage=False):
    require_catalog_project('' if manage else project_id)
    actor = get_current_actor()
    if actor and actor.project_id is not None and actor.access_level != 'edit':
        raise HTTPException(403, '语音输入需要编辑权限')
    if manage:
        from services.gateway_client.policy import require_managed_capability
        try:
            require_managed_capability("engine.install")
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc


def owner():
    actor = get_current_actor()
    return f'{actor.source}:{actor.actor_id}:{actor.device_id}' if actor else 'local'


def translate(exc):
    return HTTPException(404 if isinstance(exc, LookupError) else 409, str(exc))


class Settings(BaseModel):
    enabled: bool
    language: str = Field(default='auto', max_length=8)


class Audio(BaseModel):
    sequence: int = Field(ge=0, le=240)
    audio: str = Field(default='', max_length=342000)
    final: bool = False


@router.get('')
async def status(project_id: str = ''):
    authorize(project_id)
    return await service.snapshot()


@router.put('/settings')
async def settings(body: Settings):
    authorize('', manage=True)
    try:
        return await service.configure(body.enabled, body.language)
    except ValueError as exc:
        raise translate(exc) from exc


@router.post('/models/download')
async def download():
    authorize('', manage=True)
    try:
        await service.download()
    except ValueError as exc:
        raise translate(exc) from exc
    return await service.snapshot()


@router.post('/models/cancel')
async def cancel_download():
    authorize('', manage=True)
    await service.cancel_download()
    return await service.snapshot()


@router.delete('/models/current')
async def delete():
    authorize('', manage=True)
    try:
        await service.delete()
    except ValueError as exc:
        raise translate(exc) from exc
    return await service.snapshot()


@router.post('/sessions')
async def start(project_id: str = ''):
    authorize(project_id)
    try:
        return await service.start(project_id, owner())
    except ValueError as exc:
        raise translate(exc) from exc


@router.post('/sessions/{sid}/audio')
async def audio(sid: str, body: Audio, project_id: str = ''):
    authorize(project_id)
    try:
        pcm = base64.b64decode(body.audio, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(422, '无效音频编码') from exc
    try:
        return await service.audio(sid, project_id, owner(), body.sequence, pcm, body.final)
    except (ValueError, LookupError) as exc:
        raise translate(exc) from exc


@router.delete('/sessions/{sid}')
async def cancel(sid: str, project_id: str = ''):
    authorize(project_id)
    try:
        await service.cancel(sid, project_id, owner())
    except (ValueError, LookupError) as exc:
        raise translate(exc) from exc
    return {'cancelled': True}
