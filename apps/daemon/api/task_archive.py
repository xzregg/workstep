"""Task archiving and archive experience API routes."""

import uuid

from fastapi import APIRouter, HTTPException, Query

from api.task_context import _project, _require_scoped_task, _run_db, _release_task_channel_bindings
from schemas.base import BaseSchema
from services.task_archive import (
    load_archive_experience_draft, normalize_archive_experience,
    snapshot_archive_initiator, persist_archive_draft, persist_experience_and_archive,
)

router = APIRouter(prefix="/api/task")


class ArchiveTaskRequest(BaseSchema):
    task_id: str


class ConfirmArchiveExperienceRequest(BaseSchema):
    experience: str


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
async def archive_task(req: ArchiveTaskRequest, pid: str = Query(..., alias="project_id")):
    """Archive a task so it disappears from the active board."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    await _require_scoped_task(pid, req.task_id)
    try:
        archived = await _run_db(
            pid,
            lambda: task_service.archive_task(req.task_id, pid),
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not archived:
        raise HTTPException(status_code=404, detail="Task not found")
    await _release_task_channel_bindings(pid, req.task_id)
    return {"archived": archived}


@router.post("/{task_id}/archive-experience/prepare")
async def prepare_archive_experience(
    task_id: str,
    pid: str = Query(..., alias="project_id"),
    message_id: str | None = Query(None),
):
    """Generate and cache an experience draft without writing project Memory."""
    from agent_assistants.coordinator import ArchiveExperienceStopped
    from main import coordinator_module

    if not coordinator_module:
        raise HTTPException(status_code=503, detail="Coordinator is not initialized")
    await _require_scoped_task(pid, task_id)
    try:
        progress_message_id = message_id or str(uuid.uuid4())

        initiator_fields = await _run_db(pid, lambda: snapshot_archive_initiator(task_id, progress_message_id))
        raw_experience = await coordinator_module.draft_archive_experience(
            pid,
            task_id,
            progress_message_id,
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
):
    """Append the reviewed experience to project memory, then archive the task."""
    from main import project_manager, task_service

    if not project_manager or not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    await _require_scoped_task(pid, task_id)
    experience = req.experience.strip()
    if not experience:
        draft = await _run_db(pid, lambda: load_archive_experience_draft(task_id))
        if draft is None or draft["has_experience"]:
            raise HTTPException(status_code=422, detail="Experience cannot be empty")
        try:
            archived = await _run_db(pid, lambda: task_service.archive_task(task_id, pid))
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if not archived:
            raise HTTPException(status_code=404, detail="Task not found")
        await _release_task_channel_bindings(pid, task_id)
        return {"archived": True, "memory_saved": False}
    if len(experience) > 800:
        raise HTTPException(status_code=422, detail="Experience exceeds 800 characters")
    project = _project(pid)

    try:
        archived = await _run_db(pid, lambda: persist_experience_and_archive(
            project, task_service, pid, task_id, experience,
        ))
    except OverflowError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    await _release_task_channel_bindings(pid, task_id)
    return {"archived": archived, "memory_saved": True}


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
