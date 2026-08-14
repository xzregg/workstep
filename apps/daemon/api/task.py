"""Task API routes — all endpoints require project_id."""

import json

from fastapi import APIRouter, Header, HTTPException, Query

from schemas.base import BaseSchema
from schemas.task import (
    CreateTaskRequest,
    CoordinatorChatRequest,
    CoordinatorConfigRequest,
    ReviewDecisionRequest,
    RunTaskRequest,
    StageMessageRequest,
    StageResumeRequest,
    UpdateTaskRequest,
)
from services.config import DEFAULT_EXECUTION_ENGINE, config_store
from services.workflow_definition import WorkflowValidationError
from services.task_creation import create_project_task
from services.artifacts import list_task_artifacts

router = APIRouter(prefix="/api/task")


def _bind(project_id: str):
    """Bind db_proxy to the project identified by ID."""
    from main import project_manager
    if not project_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        return project_manager.bind_project_by_id(project_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/create")
async def create_task(req: CreateTaskRequest, pid: str = Query(..., alias="project_id")):
    """Create a new task."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        from main import project_manager, workflow_runtime
        mode = (
            "immediate" if req.auto_start is True
            else "manual" if req.auto_start is False
            else "workflow"
        )
        result = await create_project_task(
            project_manager=project_manager,
            task_service=task_service,
            workflow_runtime=workflow_runtime,
            project_id=pid,
            title=req.title,
            cwd=req.cwd,
            description=req.description,
            engine=(
                req.engine
                or config_store.get_execution_default_engine()
                or DEFAULT_EXECUTION_ENGINE
            ),
            start_step_key=req.start_step_key,
            review_overrides=req.review_overrides,
            workflow_id=req.workflow_id,
            execution_mode=mode,
        )
        return result.task
    except WorkflowValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/list")
async def list_tasks(
    pid: str = Query(..., alias="project_id"),
    wf: str | None = Query(None, alias="workflow_id"),
    archived: bool = Query(False, description="True lists only archived tasks; default hides them"),
):
    """List tasks for a project, optionally filtered by workflow/archive state."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    _bind(pid)
    return {"tasks": task_service.list_tasks(workflow_id=wf, archived=archived)}


@router.get("/{task_id}")
async def get_task(task_id: str, pid: str = Query(..., alias="project_id")):
    """Get a single task."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    _bind(pid)
    task = task_service.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.patch("/{task_id}")
async def update_task(
    task_id: str,
    req: UpdateTaskRequest,
    pid: str = Query(..., alias="project_id"),
):
    """Update editable task metadata while preserving its execution state."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    _bind(pid)
    task = task_service.update_task_description(task_id, req.description, req.review_overrides)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.get("/{task_id}/history")
async def get_task_history(
    task_id: str,
    pid: str = Query(..., alias="project_id"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """Get chat history (messages) for a task with pagination."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    _bind(pid)
    history = task_service.get_task_history(task_id, limit=limit, offset=offset)
    return {"messages": history, "limit": limit, "offset": offset}


@router.post("/{task_id}/chat")
async def chat_with_coordinator(
    task_id: str,
    req: CoordinatorChatRequest,
    pid: str = Query(..., alias="project_id"),
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
):
    """Queue one engine-backed coordinator turn without starting a workflow."""
    from main import coordinator_module
    if not coordinator_module:
        raise HTTPException(status_code=503, detail="Coordinator is not initialized")
    try:
        accepted = await coordinator_module.submit_message(
            pid,
            task_id,
            req.content,
            idempotency_key,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return accepted.to_dict()


@router.post("/{task_id}/coordinator/stop")
async def stop_coordinator(
    task_id: str,
    pid: str = Query(..., alias="project_id"),
):
    """Stop the currently running coordinator turn for a task."""
    from main import coordinator_module
    if not coordinator_module:
        raise HTTPException(status_code=503, detail="Coordinator is not initialized")
    try:
        stopped = await coordinator_module.stop_current(pid, task_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"stopped": stopped}


@router.get("/{task_id}/coordinator-config")
async def get_coordinator_config(
    task_id: str,
    pid: str = Query(..., alias="project_id"),
):
    from main import coordinator_module
    if not coordinator_module:
        raise HTTPException(status_code=503, detail="Coordinator is not initialized")
    try:
        return await coordinator_module.get_config(pid, task_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{task_id}/step/{step_key}/message")
async def send_stage_message(
    task_id: str,
    step_key: str,
    req: StageMessageRequest,
    pid: str = Query(..., alias="project_id"),
):
    """Inject an ordinary user message into a running stage execution."""
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Workflow runtime not initialized")
    _bind(pid)
    try:
        accepted = await workflow_runtime.send_stage_message(
            pid,
            task_id,
            step_key,
            req.content,
            as_guidance=req.as_guidance,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return accepted


@router.post("/{task_id}/step/{step_key}/cancel")
async def cancel_stage(
    task_id: str,
    step_key: str,
    pid: str = Query(..., alias="project_id"),
):
    """Stop a running stage engine."""
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Workflow runtime not initialized")
    _bind(pid)
    try:
        cancelled = await workflow_runtime.cancel_step(pid, task_id, step_key)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"cancelled": cancelled}


@router.post("/{task_id}/step/{step_key}/resume")
async def resume_stage(
    task_id: str,
    step_key: str,
    req: StageResumeRequest,
    pid: str = Query(..., alias="project_id"),
):
    """Persist a user message and re-run a manually stopped stage."""
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Service not initialized")
    _bind(pid)
    try:
        accepted = await workflow_runtime.resume_stage_with_message(
            pid,
            task_id,
            step_key,
            req.content,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return accepted


@router.patch("/{task_id}/coordinator-config")
async def update_coordinator_config(
    task_id: str,
    req: CoordinatorConfigRequest,
    pid: str = Query(..., alias="project_id"),
):
    from main import coordinator_module
    if not coordinator_module:
        raise HTTPException(status_code=503, detail="Coordinator is not initialized")
    try:
        return await coordinator_module.update_config(
            pid,
            task_id,
            req.engine,
            req.model,
            req.fast_model,
            req.vision_model,
            req.thinking_effort,
            req.provider_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{task_id}/actions/{proposal_id}/confirm")
async def confirm_coordinator_action(
    task_id: str,
    proposal_id: str,
    pid: str = Query(..., alias="project_id"),
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
):
    from main import coordinator_module
    if not coordinator_module:
        raise HTTPException(status_code=503, detail="Coordinator is not initialized")
    try:
        return await coordinator_module.confirm_action(
            pid,
            task_id,
            proposal_id,
            idempotency_key,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/{task_id}/actions/{proposal_id}/cancel")
async def cancel_coordinator_action(
    task_id: str,
    proposal_id: str,
    pid: str = Query(..., alias="project_id"),
):
    from main import coordinator_module
    if not coordinator_module:
        raise HTTPException(status_code=503, detail="Coordinator is not initialized")
    try:
        return await coordinator_module.cancel_action(pid, task_id, proposal_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/{task_id}/artifacts")
async def get_task_artifacts(
    task_id: str,
    pid: str = Query(..., alias="project_id"),
):
    """List files produced for a task, enriched by stage manifests."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    project = _bind(pid)
    if not task_service.get_task(task_id):
        raise HTTPException(status_code=404, detail="Task not found")
    return {"artifacts": list_task_artifacts(project, task_id)}


@router.get("/{task_id}/reviews")
async def get_task_reviews(
    task_id: str,
    pid: str = Query(..., alias="project_id"),
):
    """Return persisted review history for a task."""
    from models import ReviewRun
    _bind(pid)
    rows = (
        ReviewRun.select()
        .where(ReviewRun.task == task_id)
        .order_by(ReviewRun.started_at.desc(), ReviewRun.id.desc())
    )
    return {
        "reviews": [{
            "id": row.id,
            "workflow_run_id": row.workflow_run_id,
            "step_run_id": row.step_run_id,
            "step_key": row.step_key,
            "mode": row.mode,
            "status": row.status,
            "engine": row.engine,
            "model": row.model,
            "report": json.loads(row.report_json) if row.report_json else None,
            "decision": row.decision,
            "decision_comment": row.decision_comment,
            "started_at": row.started_at,
            "ended_at": row.ended_at,
        } for row in rows]
    }


async def _decide_review(
    task_id: str,
    step_key: str,
    req: ReviewDecisionRequest,
    project_id: str,
    decision: str,
):
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        handle = await workflow_runtime.decide_review(
            project_id, task_id, step_key, req.review_run_id, decision, req.comment
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {
        "decision": decision,
        "resumed": handle is not None,
        "run_id": handle.id if handle else None,
    }


@router.post("/{task_id}/steps/{step_key}/review/approve")
async def approve_review(
    task_id: str,
    step_key: str,
    req: ReviewDecisionRequest,
    pid: str = Query(..., alias="project_id"),
):
    return await _decide_review(task_id, step_key, req, pid, "approve")


@router.post("/{task_id}/steps/{step_key}/review/reject")
async def reject_review(
    task_id: str,
    step_key: str,
    req: ReviewDecisionRequest,
    pid: str = Query(..., alias="project_id"),
):
    return await _decide_review(task_id, step_key, req, pid, "reject")


@router.post("/{task_id}/steps/{step_key}/review/force-approve")
async def force_approve_review(
    task_id: str,
    step_key: str,
    req: ReviewDecisionRequest,
    pid: str = Query(..., alias="project_id"),
):
    return await _decide_review(task_id, step_key, req, pid, "force_approve")


@router.post("/run")
async def run_task(req: RunTaskRequest, pid: str = Query(..., alias="project_id")):
    """Run a task (fire-and-forget, events come via WebSocket)."""
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        handle = await workflow_runtime.start(pid, req.task_id, req.prompt)
    except WorkflowValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {
        "status": "started",
        "task_id": req.task_id,
        "run_id": handle.id,
    }


class CancelTaskRequest(BaseSchema):
    task_id: str


@router.post("/cancel")
async def cancel_task(req: CancelTaskRequest, pid: str | None = Query(None, alias="project_id")):
    """Cancel a running task."""
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Service not initialized")
    if pid:
        _bind(pid)
    cancelled = await workflow_runtime.cancel(req.task_id)
    return {"cancelled": cancelled}


class PauseTaskRequest(BaseSchema):
    task_id: str


@router.post("/pause")
async def pause_task(req: PauseTaskRequest, pid: str = Query(..., alias="project_id")):
    """Pause a running task."""
    from main import task_service, workflow_runtime
    if workflow_runtime and await workflow_runtime.cancel(req.task_id):
        return {"paused": True}
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    _bind(pid)
    paused = await task_service.pause_task(req.task_id)
    if not paused:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"paused": paused}


class DeleteTaskRequest(BaseSchema):
    task_id: str


@router.delete("/delete")
async def delete_task(req: DeleteTaskRequest, pid: str = Query(..., alias="project_id")):
    """Delete a task."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    _bind(pid)
    try:
        deleted = task_service.delete_task(req.task_id, pid)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"deleted": deleted}


class ArchiveTaskRequest(BaseSchema):
    task_id: str


@router.post("/archive")
async def archive_task(req: ArchiveTaskRequest, pid: str = Query(..., alias="project_id")):
    """Archive a task so it disappears from the active board."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    _bind(pid)
    try:
        archived = task_service.archive_task(req.task_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not archived:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"archived": archived}


@router.post("/unarchive")
async def unarchive_task(req: ArchiveTaskRequest, pid: str = Query(..., alias="project_id")):
    """Restore an archived task back to the active board."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    _bind(pid)
    try:
        unarchived = task_service.unarchive_task(req.task_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not unarchived:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"unarchived": unarchived}


class CopyTaskRequest(BaseSchema):
    task_id: str
    newTitle: str


@router.post("/copy")
async def copy_task(req: CopyTaskRequest, pid: str = Query(..., alias="project_id")):
    """Copy a task with a new title."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    _bind(pid)
    copied = task_service.copy_task(req.task_id, req.newTitle, pid)
    if not copied:
        raise HTTPException(status_code=404, detail="Task not found")
    return copied
