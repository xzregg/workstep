"""Host-managed TTS, with project-scoped and actor-owned audio sessions."""
from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from api.project_scope import require_catalog_project
from api.speech_credentials import SpeechCredentialRequest
from services.remote_access import get_current_actor
from services.speech_output import MAX_REFERENCE_BYTES, service
from services.tts_catalog import DEFAULT_LOCAL_MODEL

router = APIRouter(prefix='/api/speech-output', tags=['speech-output'])


class Settings(BaseModel):
    model_config = ConfigDict(extra='forbid')
    mode: str = 'system'
    provider: str = 'qwen'
    model_id: str = DEFAULT_LOCAL_MODEL
    model: str = 'qwen3-tts-flash-realtime'
    base_url: str = Field(default='', max_length=2000)
    voice: str = Field(default='Cherry', max_length=200)
    region: str = Field(default='beijing', max_length=100)
    resource_id: str = Field(default='seed-tts-2.0', max_length=200)
    app_id: str = Field(default='', max_length=200)
    engine: str = Field(default='qwen', pattern='^(qwen|qwen_custom_voice|kokoro)$')
    instructions: str = Field(default='', max_length=500)
    reference_id: str = Field(default='', max_length=64)
    reference_text: str = Field(default='', max_length=500)
    rate: float = Field(default=1, ge=.5, le=2)
    volume: float = Field(default=1, ge=0, le=1)
    api_key: str | None = Field(default=None, max_length=4096)
    secret_id: str | None = Field(default=None, max_length=4096)
    secret_key: str | None = Field(default=None, max_length=4096)


class Synthesis(BaseModel):
    text: str = Field(min_length=1, max_length=1200)
    settings: Settings | None = None
    preview_prompt: str = Field(default='', max_length=6500)
    digital_session_id: str = Field(default='', max_length=128)


def authorize(project='', manage=False):
    require_catalog_project('' if manage else project)
    actor = get_current_actor()
    if actor and actor.project_id is not None and actor.access_level != 'edit':
        raise HTTPException(403, 'Voice output requires edit permissions')


def owner():
    actor = get_current_actor()
    return f'{actor.source}:{actor.actor_id}:{actor.device_id}' if actor else 'local'


def translated(exc):
    return HTTPException(404 if isinstance(exc, LookupError) else 409, str(exc))


@router.get('')
async def status(project_id: str = ''):
    authorize(project_id)
    result = await (service.snapshot(include_references=False) if project_id else service.snapshot())
    if project_id:
        result.pop('connections', None)
        result['settings'].pop('reference_id', None)
        result['settings'].pop('reference_text', None)
    return result


@router.post('/settings/secret')
async def connection_secret(body: SpeechCredentialRequest, response: Response):
    authorize(manage=True)
    response.headers['Cache-Control'] = 'no-store'
    target = body.model_dump(exclude={'field'}, exclude_none=True)
    return {'value': await service.connection_secret(target, body.field)}


@router.put('/settings')
async def configure(body: Settings):
    authorize(manage=True)
    try:
        return await service.configure(body.model_dump(), preview_owner=owner())
    except ValueError as exc:
        raise translated(exc) from exc


@router.post('/models/{action}')
async def model_action(action: str, model_id: str | None = None,
                       mirror: str | None = Query(default=None, max_length=2000)):
    authorize(manage=True)
    if action not in ('download', 'cancel', 'delete', 'discard', 'unload'):
        raise HTTPException(404, 'Unsupported model operation')
    try:
        await service.model_action(action, model_id, *([mirror] if mirror is not None else []))
        return await service.snapshot()
    except ValueError as exc:
        raise translated(exc) from exc


@router.post('/reference')
async def upload_reference(request: Request):
    authorize(manage=True)
    content = bytearray()
    async for block in request.stream():
        if len(content) + len(block) > MAX_REFERENCE_BYTES:
            raise HTTPException(413, 'Reference audio exceeds 12 MiB')
        content.extend(block)
    try:
        identifier = await service.upload_reference(content)
        return {'id': identifier, 'reference': await service.reference_info(identifier)}
    except ValueError as exc:
        raise translated(exc) from exc


@router.delete('/reference/{identifier}')
async def delete_reference(identifier: str):
    authorize(manage=True)
    try:
        return {'settings': await service.delete_reference(identifier)}
    except ValueError as exc:
        raise translated(exc) from exc
    except OSError as exc:
        raise HTTPException(409, 'Unable to delete the reference audio file') from exc


@router.post('/sessions')
async def start(body: Synthesis, project_id: str = ''):
    preview_prompt = body.preview_prompt.strip()
    authorize(project_id, manage=body.settings is not None or bool(preview_prompt))
    try:
        person_id = None
        if body.digital_session_id:
            authorize(manage=True)
            if body.settings is not None:
                raise ValueError('Use saved settings for digital person playback')
            from api.digital_person import runtime
            from services.digital_person_sessions import affect_person
            try:
                person_id = await affect_person(runtime(), project_id, body.digital_session_id) or ''
            except LookupError as exc:
                raise translated(exc) from exc
        return await service.start(project_id, owner(), body.text,
                                   body.settings.model_dump() if body.settings else None,
                                   preview_prompt=preview_prompt, digital_person_id=person_id)
    except ValueError as exc:
        raise translated(exc) from exc


@router.post('/voices')
async def voices(body: Settings):
    authorize(manage=True)
    try:
        return await service.remote_voices(body.model_dump())
    except ValueError as exc:
        raise translated(exc) from exc


@router.post('/sessions/{sid}/next')
async def next_audio(sid: str, project_id: str = ''):
    authorize(project_id)
    try:
        return await service.next(sid, project_id, owner())
    except (ValueError, LookupError) as exc:
        raise translated(exc) from exc


@router.delete('/sessions/{sid}')
async def cancel(sid: str, project_id: str = ''):
    authorize(project_id)
    try:
        await service.cancel(sid, project_id, owner())
    except LookupError as exc:
        raise translated(exc) from exc
    return {'cancelled': True}
