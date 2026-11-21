"""Bounded audio requests reuse the authenticated HTTP / Gateway transport."""
import base64
import binascii

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, Field

from api.project_scope import require_catalog_project
from api.speech_credentials import SpeechCredentialRequest
from services.remote_access import get_current_actor
from services.speech import service

router = APIRouter(prefix='/api/speech', tags=['speech'])


def authorize(project_id: str, manage=False):
    require_catalog_project('' if manage else project_id)
    actor = get_current_actor()
    if actor and actor.project_id is not None and actor.access_level != 'edit':
        raise HTTPException(403, 'Voice input requires edit permissions')
    # Speech resources follow the same host scope as engine/appearance assets.
    # The retired engine.install capability must not gate speech settings.


def owner():
    actor = get_current_actor()
    return f'{actor.source}:{actor.actor_id}:{actor.device_id}' if actor else 'local'


def translate(exc):
    return HTTPException(404 if isinstance(exc, LookupError) else 409, str(exc))


class Settings(BaseModel):
    enabled: bool
    language: str = Field(default='auto', max_length=8)
    model_id: str | None = Field(default=None, max_length=80)
    connection: dict | None = None


class Audio(BaseModel):
    sequence: int = Field(ge=0, le=240)
    audio: str = Field(default='', max_length=342000)
    final: bool = False
    preview: bool = True


@router.get('')
async def status(project_id: str = ''):
    authorize(project_id)
    result = await service.snapshot()
    if project_id:
        result.pop('connections', None)
    return result


@router.post('/settings/secret')
async def connection_secret(body: SpeechCredentialRequest, response: Response):
    authorize('', manage=True)
    response.headers['Cache-Control'] = 'no-store'
    target = body.model_dump(exclude={'field'}, exclude_none=True)
    return {'value': await service.connection_secret(target, body.field)}


@router.put('/settings')
async def settings(body: Settings):
    authorize('', manage=True)
    try:
        args = (body.enabled, body.language, body.model_id)
        await service.configure(*args, *([body.connection] if body.connection is not None else []))
        return await service.snapshot()
    except ValueError as exc:
        raise translate(exc) from exc


@router.post('/models/download')
async def download(model_id: str | None = None, mirror: str | None = Query(default=None, max_length=2000)):
    authorize('', manage=True)
    try:
        await service.download(model_id, *([mirror] if mirror is not None else []))
    except ValueError as exc:
        raise translate(exc) from exc
    return await service.snapshot()


@router.post('/models/cancel')
async def cancel_download():
    authorize('', manage=True)
    await service.cancel_download()
    return await service.snapshot()


@router.delete('/models/current')
async def delete(model_id: str | None = None, partial_only: bool = False):
    authorize('', manage=True)
    try:
        if partial_only:
            await service.delete(model_id, partial_only=True)
        else:
            await service.delete(model_id)
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
        raise HTTPException(422, 'Invalid audio encoding') from exc
    try:
        return await service.audio(sid, project_id, owner(), body.sequence, pcm, body.final, body.preview)
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
