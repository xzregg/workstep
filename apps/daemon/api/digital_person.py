"""Host-scoped digital person configuration; no workspace/access selectors."""
import asyncio
from datetime import datetime
from typing import Annotated, Literal
from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response
from pydantic import ConfigDict, Field
from api.project_scope import require_catalog_project
from services import digital_person as service
from services.digital_person import DigitalPersonProfile
from services.wake_audio import wake_audio


def authorize():
    require_catalog_project("")


router = APIRouter(prefix="/api/digital-person", dependencies=[Depends(authorize)])
from api.face_recognition import router as face_router
router.include_router(face_router)


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
        raise HTTPException(503, "Failed to save digital human configuration. Please try again.") from exc


@router.post("/standing-memory")
async def remember(draft: service.StandingMemoryDraft):
    try:
        added = await asyncio.to_thread(service.append_standing_memory, draft)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(503, "Unable to save standing memory. Please retry.") from exc
    return {"saved": True, "added": added}


@router.get("/voice-wake")
async def get_voice_wake(response: Response):
    response.headers['Cache-Control'] = 'no-store'
    return await asyncio.to_thread(service.get_voice_wake)


@router.put("/voice-wake")
async def save_voice_wake(draft: service.VoiceWakeDraft):
    try:
        saved = await asyncio.to_thread(service.save_voice_wake, draft)
    except OSError as exc:
        raise HTTPException(503, "Voice wake-up configuration save failed, please retry") from exc
    try:
        await wake_audio.prepare(retry=True)
    except (OSError, ValueError):
        # The configuration is already saved. Audio can be requested again by a listener.
        pass
    return saved


@router.get("/voice-wake/audio")
async def get_wake_audio(response: Response):
    response.headers['Cache-Control'] = 'no-store'
    try:
        return await wake_audio.prepare()
    except (OSError, ValueError):
        raise HTTPException(503, "Unable to prepare wake greeting audio")


def runtime():
    import main
    if main.digital_person_runtime is None:
        raise HTTPException(503, "Digital human is initializing")
    return main.digital_person_runtime


@router.post("/main-session")
async def main_session():
    return await runtime().main_session()


@router.get("/activity")
async def activity():
    return await runtime().overview()


@router.get('/activity/records')
async def activity_records(run_offset: int = Query(default=0, ge=0),
                           delegation_offset: int = Query(default=0, ge=0),
                           limit: int = Query(default=5, ge=1, le=50)):
    return await runtime().activity_records(run_offset, delegation_offset, limit)


@router.get('/runs/{run_id}')
async def run_detail(run_id: str):
    try:
        return await runtime().run_detail(run_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get('/runs/{run_id}/knowledge')
async def run_knowledge(run_id: str, response: Response):
    try:
        result = await runtime().run_knowledge(run_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    response.headers['Cache-Control'] = 'no-store'
    return result


@router.get('/memory')
async def memory(session_id: str = '', query: str = Query(default='', max_length=1000),
                 since: datetime | None = None, before: datetime | None = None,
                 limit: int = Query(default=50, ge=1, le=100), project_id: str = ''):
    from services import digital_person_memory as memory_store
    current = runtime()
    scope = 'local' if query else None
    if session_id:
        from services.digital_person_sessions import memory_scope
        try:
            scope = await memory_scope(current, project_id, session_id)
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from exc
    return {'items': await memory_store.browse_projects(current.projects,scope=scope,query=query,since=since,before=before,limit=limit)}


AtlasKnowledgeId = Annotated[int, Field(gt=0, le=2**63 - 1)]


@router.get('/memory/atlas')
async def memory_atlas_page(cursor: int = Query(default=0, ge=0, le=2**63 - 1),
                            limit: int = Query(default=50, ge=1, le=500),
                            ids: list[AtlasKnowledgeId] = Query(default=[], max_length=50)):
    from services import memory_atlas
    return await memory_atlas.page(runtime().projects, cursor, limit, ids)


@router.get('/memory/atlas/{knowledge_id}')
async def memory_atlas_detail(knowledge_id: int = Path(gt=0, le=2**63 - 1)):
    from services import memory_atlas
    detail = await memory_atlas.detail(runtime().projects, knowledge_id)
    if detail is None:
        raise HTTPException(404, 'Knowledge does not exist or is inaccessible')
    return detail


@router.get('/memory/view')
async def memory_view(query: str = Query(default='', max_length=1000)):
    from services import memory_visualization
    return await memory_visualization.browse(runtime().projects, query)


@router.get('/memory/source/{source_id}')
async def memory_source(source_id: str, offset: int = Query(default=0, ge=0),
                        limit: int = Query(default=2400, ge=1, le=6000)):
    from services import memory_visualization
    try:
        return await memory_visualization.read(runtime().projects, source_id, offset=offset, limit=limit)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.delete('/memory/{memory_id}')
async def forget_memory(memory_id: str):
    from services.digital_person_memory import forget
    if not await asyncio.to_thread(forget, memory_id):
        raise HTTPException(404, 'Memory does not exist')
    return {'forgotten': True}


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
    model_config = ConfigDict(extra='forbid')

    project_id: str
    title: str | None = None
    instruction: str = service.Field(min_length=1, max_length=12000)
    origin_session_id: str = ""
    request_id: str = service.Field(min_length=1, max_length=200)
    continuation_of: str = service.Field(default='', max_length=200)


class ExistingDelegateRequest(DelegateRequest):
    target_session_id: str = service.Field(pattern=r'^[A-Za-z0-9_-]{1,128}$')


@router.get('/delegations')
async def list_delegations(origin_session_id: str | None = Query(default=None, min_length=1),
                           project_id: str | None = Query(default=None, min_length=1),
                           delegation_id: str | None = Query(default=None, min_length=1)):
    return await runtime().list_delegations(project_id, origin_session_id, delegation_id or '')


@router.post("/delegate")
async def delegate(request: DelegateRequest):
    try:
        return await runtime().delegate(**request.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/delegate/existing")
async def delegate_existing(request: ExistingDelegateRequest):
    return await delegate(request)


@router.post("/check")
async def check(background: bool = False):
    try:
        if background:
            return await runtime().trigger_check()
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
        raise HTTPException(404, "Channel not bound")
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


@router.get('/browser')
async def browser_status():
    from services import digital_person_browser
    return await asyncio.to_thread(digital_person_browser.scan)


@router.post('/browser/install')
async def browser_install():
    from services import digital_person_browser
    await digital_person_browser.start_install()
    return await asyncio.to_thread(digital_person_browser.scan)


class BrowserEnabledRequest(service.BaseModel):
    enabled: bool


@router.put('/browser')
async def browser_enabled(value: BrowserEnabledRequest):
    from services import digital_person_browser
    try:
        return await asyncio.to_thread(digital_person_browser.set_enabled, value.enabled)
    except (OSError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get('/affect/people')
async def affect_people():
    from services import digital_person_affect as affect
    return {'items': await asyncio.to_thread(affect.people)}


@router.get('/affect')
async def affect_state(project_id: str = '', session_id: str = '', person_id: str = Query(default='', max_length=600)):
    """Host-only, read-only projection. Actor identity always comes from stored attribution."""
    from services import digital_person_affect as affect
    if session_id:
        from services.digital_person_sessions import affect_person
        try:
            person_id = await affect_person(runtime(), project_id, session_id)
        except LookupError as exc:
            raise HTTPException(404, str(exc)) from exc
        if person_id is None:
            return {'state': None}
    return {'state': await asyncio.to_thread(affect.read, person_id or 'local:owner')}
