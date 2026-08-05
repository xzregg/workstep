"""Task API routes — all endpoints require project_id."""

import json
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException, Query

from schemas.base import BaseSchema
from schemas.task import (
    CreateTaskRequest,
    CoordinatorChatRequest,
    CoordinatorConfigRequest,
    ReviewDecisionRequest,
    RunTaskRequest,
    UpdateTaskRequest,
)
from services.config import config_store
from services.workflow_definition import WorkflowDefinition, WorkflowValidationError

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
    project = _bind(pid)
    if req.workflow_id:
        workflow = (
            project.workflow_by_id(req.workflow_id)
            if hasattr(project, "workflow_by_id")
            else next(
                (
                    item
                    for item in getattr(project, "workflows", [])
                    if item.get("id") == req.workflow_id
                    and not item.get("deleted")
                ),
                None,
            )
        )
    elif hasattr(project, "default_workflow"):
        workflow = project.default_workflow()
    else:
        workflow = {"id": None, "steps": project.steps}
    if workflow is None:
        if req.workflow_id:
            raise HTTPException(status_code=404, detail="Workflow not found")
        raise HTTPException(status_code=400, detail="No workflow exists")
    try:
        created = task_service.create_task(
            title=req.title,
            cwd=req.cwd,
            description=req.description,
            engine=(
                req.engine
                or config_store.get_execution_default_engine()
                or "claude"
            ),
            workflow=workflow["steps"],
            start_step_key=req.start_step_key,
            review_overrides=req.review_overrides,
            workflow_id=workflow["id"],
        )
        definition = WorkflowDefinition.load(workflow["steps"])
        should_auto_start = (
            req.auto_start
            if req.auto_start is not None
            else definition.auto_start_enabled(req.start_step_key)
        )
        if should_auto_start:
            from main import workflow_runtime
            if not workflow_runtime:
                raise HTTPException(status_code=503, detail="Workflow runtime not initialized")
            await workflow_runtime.start(pid, created["id"], "")
            return task_service.get_task(created["id"]) or created
        return created
    except WorkflowValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/list")
async def list_tasks(pid: str = Query(..., alias="project_id"), wf: str | None = Query(None, alias="workflow_id")):
    """List tasks for a project, optionally filtered by workflow."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    _bind(pid)
    return {"tasks": task_service.list_tasks(workflow_id=wf)}


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

    artifacts_root = (Path(project.workstep_dir) / "artifacts").resolve()
    if not artifacts_root.is_dir():
        return {"artifacts": []}

    artifacts = []
    for workflow_dir in sorted(artifacts_root.iterdir()):
        if not workflow_dir.is_dir():
            continue
        task_dir = (workflow_dir / task_id).resolve()
        try:
            task_dir.relative_to(artifacts_root)
        except ValueError:
            continue
        if not task_dir.is_dir():
            continue

        for step_dir in sorted(task_dir.iterdir()):
            if not step_dir.is_dir():
                continue

            manifest_entries: dict[Path, dict] = {}
            manifest_path = step_dir / "manifest.json"
            if manifest_path.is_file():
                try:
                    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                    for entry in manifest.get("artifacts", []):
                        artifact_path = (step_dir / str(entry.get("path", ""))).resolve()
                        try:
                            artifact_path.relative_to(step_dir)
                        except ValueError:
                            continue
                        manifest_entries[artifact_path] = entry
                except (OSError, ValueError, TypeError):
                    pass

            for file_path in sorted(step_dir.rglob("*")):
                if not file_path.is_file() or file_path.name == "manifest.json":
                    continue
                resolved = file_path.resolve()
                try:
                    resolved.relative_to(step_dir)
                except ValueError:
                    continue
                metadata = manifest_entries.get(resolved, {})
                artifacts.append({
                    "step_key": step_dir.name,
                    "name": file_path.name,
                    "logical_name": metadata.get("name"),
                    "artifact_type": metadata.get("type"),
                    "path": str(resolved),
                    "relative_path": str(resolved.relative_to(step_dir)),
                    "size": resolved.stat().st_size,
                })
    return {"artifacts": artifacts}


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
async def cancel_task(req: CancelTaskRequest):
    """Cancel a running task."""
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Service not initialized")
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
