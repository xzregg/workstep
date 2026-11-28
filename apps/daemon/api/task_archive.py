"""Task archiving and archive experience API routes."""


from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import Field
from starlette.responses import JSONResponse

from api.task_context import _project, _require_scoped_task, _run_db, _release_task_channel_bindings
from schemas.base import BaseSchema
from services.business_ids import new_id
from services.coordinator_source import COORDINATOR_TURN_HEADER, coordinator_group_recipient
from services.task_archive import (
    load_archive_experience_draft, normalize_archive_experience,
    snapshot_archive_initiator, persist_archive_draft, persist_experience_and_archive,
)

router = APIRouter(prefix="/api/task")


class ArchiveTaskRequest(BaseSchema):
    task_id: str


class NotifyArchiveTaskRequest(ArchiveTaskRequest):
    notify: bool = False
    delete_workspace: bool = False


class ArchiveLanguageRequest(BaseSchema):
    locale: str = Field(default="zh-CN", max_length=64)


class ConfirmArchiveExperienceRequest(ArchiveLanguageRequest):
    experience: str
    notify: bool = False
    delete_workspace: bool = False


async def _clean_archive_workspace(pid, task_id):
    from api.task_workspace_cleanup import clean_task_workspaces
    from services.remote_access import get_current_actor

    actor = get_current_actor()
    if actor is not None and actor.project_id is not None:
        raise HTTPException(403, "Archive workspace cleanup is available on the host only")
    await clean_task_workspaces(pid, task_id, True, operation="archived")


async def _archive_notice_group(pid, task_id, notify, turn_id):
    if not notify:
        return None
    if not turn_id:
        raise HTTPException(status_code=422, detail="Archive notification requires a current group coordinator turn")
    try:
        return await _run_db(pid, lambda: coordinator_group_recipient(task_id, turn_id))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


async def _archive_result(pid, task_id, notify_group, **result):
    notification = await _release_task_channel_bindings(pid, task_id, notify_group=notify_group)
    if notify_group:
        result['notification'] = notification
    return result


@router.get("/{task_id}/archive-experience/draft")
async def get_archive_experience_draft(
    task_id: str,
    pid: str = Query(..., alias="project_id"),
):
    """Return the last generated draft so reopening does not call the LLM again."""
    from main import project_manager

    project = project_manager.get_project_by_id(pid)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    await _require_scoped_task(pid, task_id)

    try:
        draft = await _run_db(pid, lambda: load_archive_experience_draft(task_id, project.workstep_dir))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return draft or {
        "found": False,
        "message_id": None,
        "experience": "",
        "has_experience": False,
        "events": [],
        "prompt": "",
    }


@router.post("/archive")
async def archive_task(req: NotifyArchiveTaskRequest, pid: str = Query(..., alias="project_id"),
                       turn_id: str | None = Header(None, alias=COORDINATOR_TURN_HEADER)):
    """Archive a task so it disappears from the active board."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    await _require_scoped_task(pid, req.task_id)
    notify_group = await _archive_notice_group(pid, req.task_id, req.notify, turn_id)
    if req.delete_workspace:
        await _clean_archive_workspace(pid, req.task_id)
    try:
        archived = await _run_db(
            pid,
            lambda: task_service.archive_task(req.task_id, pid),
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not archived:
        raise HTTPException(status_code=404, detail="Task not found")
    return await _archive_result(pid, req.task_id, notify_group, archived=archived)


@router.post("/{task_id}/archive-experience/prepare")
async def prepare_archive_experience(
    task_id: str,
    body: ArchiveLanguageRequest | None = None,
    pid: str = Query(..., alias="project_id"),
    message_id: str | None = Query(None),
    background: bool = Query(False),
):
    """Generate and cache an experience draft without writing project Memory."""
    from agent_assistants.coordinator import ArchiveExperienceStopped
    from main import coordinator_module

    if not coordinator_module:
        raise HTTPException(status_code=503, detail="Coordinator is not initialized")
    await _require_scoped_task(pid, task_id)
    locale = body.locale if body else "zh-CN"
    progress_message_id = message_id or new_id(pid)
    if background:
        if not message_id:
            raise HTTPException(status_code=422, detail="Background preparation requires message_id")
        try:
            result = coordinator_module.poll_archive_preparation(
                pid, task_id, progress_message_id,
                lambda: _generate_archive_experience(pid, task_id, progress_message_id, locale),
            )
        except ArchiveExperienceStopped as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=429, detail=str(exc)) from exc
        return result if result is not None else JSONResponse(
            {"status": "running", "message_id": progress_message_id}, status_code=202,
        )
    return await _generate_archive_experience(pid, task_id, progress_message_id, locale)


async def _generate_archive_experience(pid: str, task_id: str, progress_message_id: str, locale: str = "zh-CN"):
    from agent_assistants.coordinator import ArchiveExperienceStopped
    from main import coordinator_module

    try:
        initiator_fields = await _run_db(pid, lambda: snapshot_archive_initiator(task_id, progress_message_id))
        raw_experience = await coordinator_module.draft_archive_experience(
            pid,
            task_id,
            progress_message_id,
            **({"locale": locale} if locale != "zh-CN" else {}),
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ArchiveExperienceStopped as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    experience, has_experience = normalize_archive_experience(raw_experience)
    journal = coordinator_module.take_archive_experience_journal(
        pid,
        task_id,
        progress_message_id,
    )

    try:
        await _run_db(pid, lambda: persist_archive_draft(
            task_id, progress_message_id, experience, has_experience, journal, initiator_fields,
        ))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {
        "message_id": progress_message_id,
        "experience": experience,
        "has_experience": has_experience,
        "cached": False,
    }


@router.post("/{task_id}/archive-experience/stop")
async def stop_archive_experience(
    task_id: str,
    pid: str = Query(..., alias="project_id"),
    message_id: str = Query(...),
):
    """Stop an in-flight archive experience draft."""
    from main import coordinator_module

    if not coordinator_module:
        raise HTTPException(status_code=503, detail="Coordinator is not initialized")
    await _require_scoped_task(pid, task_id)
    stopped = await coordinator_module.stop_archive_experience(
        pid,
        task_id,
        message_id,
    )
    return {"stopped": stopped}


@router.post("/{task_id}/archive-experience/confirm")
async def confirm_archive_experience(
    task_id: str,
    req: ConfirmArchiveExperienceRequest,
    pid: str = Query(..., alias="project_id"),
    turn_id: str | None = Header(None, alias=COORDINATOR_TURN_HEADER),
):
    """Append the reviewed experience to project memory, then archive the task."""
    from main import project_manager, task_service

    if not project_manager or not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    await _require_scoped_task(pid, task_id)
    notify_group = await _archive_notice_group(pid, task_id, req.notify, turn_id)
    experience = req.experience.strip()
    if len(experience) > 800:
        raise HTTPException(status_code=422, detail="Experience exceeds 800 characters")
    if not experience:
        draft = await _run_db(pid, lambda: load_archive_experience_draft(task_id))
        if draft is None or draft["has_experience"]:
            raise HTTPException(status_code=422, detail="Experience cannot be empty")
        if req.delete_workspace:
            await _clean_archive_workspace(pid, task_id)
        try:
            archived = await _run_db(pid, lambda: task_service.archive_task(task_id, pid))
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if not archived:
            raise HTTPException(status_code=404, detail="Task not found")
        return await _archive_result(pid, task_id, notify_group, archived=True, memory_saved=False)
    if req.delete_workspace:
        await _clean_archive_workspace(pid, task_id)
    project = _project(pid)

    try:
        archived, memory_saved = await _run_db(pid, lambda: persist_experience_and_archive(
            project, task_service, pid, task_id, experience, req.locale,
        ))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="Memory file access denied") from exc
    except OverflowError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return await _archive_result(pid, task_id, notify_group, archived=archived, memory_saved=memory_saved)


@router.post("/unarchive")
async def unarchive_task(req: ArchiveTaskRequest, pid: str = Query(..., alias="project_id")):
    """Restore an archived task back to the active board."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    await _require_scoped_task(pid, req.task_id)
    try:
        unarchived = await _run_db(
            pid,
            lambda: task_service.unarchive_task(req.task_id, pid),
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not unarchived:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"unarchived": unarchived}
