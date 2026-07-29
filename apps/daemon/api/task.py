"""Task API routes — all endpoints require project_id."""

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from schemas.base import BaseSchema
from schemas.task import CreateTaskRequest, RunTaskRequest, UpdateTaskRequest
from services.workflow_definition import WorkflowValidationError

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
    try:
        return task_service.create_task(
            title=req.title,
            cwd=req.cwd,
            description=req.description,
            engine=req.engine,
            workflow=project.steps,
            start_step_key=req.start_step_key,
        )
    except WorkflowValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/list")
async def list_tasks(pid: str = Query(..., alias="project_id")):
    """List all tasks for a project."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    _bind(pid)
    return {"tasks": task_service.list_tasks()}


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
    task = task_service.update_task_description(task_id, req.description)
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
    for stage_dir in sorted(artifacts_root.iterdir()):
        task_dir = (stage_dir / task_id).resolve()
        try:
            task_dir.relative_to(artifacts_root)
        except ValueError:
            continue
        if not task_dir.is_dir():
            continue

        manifest_entries: dict[Path, dict] = {}
        manifest_path = task_dir / "manifest.json"
        if manifest_path.is_file():
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                for entry in manifest.get("artifacts", []):
                    artifact_path = (task_dir / str(entry.get("path", ""))).resolve()
                    try:
                        artifact_path.relative_to(task_dir)
                    except ValueError:
                        continue
                    manifest_entries[artifact_path] = entry
            except (OSError, ValueError, TypeError):
                pass

        for file_path in sorted(task_dir.rglob("*")):
            if not file_path.is_file() or file_path.name == "manifest.json":
                continue
            resolved = file_path.resolve()
            try:
                resolved.relative_to(task_dir)
            except ValueError:
                continue
            metadata = manifest_entries.get(resolved, {})
            artifacts.append({
                "step_key": stage_dir.name,
                "name": file_path.name,
                "logical_name": metadata.get("name"),
                "artifact_type": metadata.get("type"),
                "path": str(resolved),
                "relative_path": str(resolved.relative_to(task_dir)),
                "size": resolved.stat().st_size,
            })
    return {"artifacts": artifacts}


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
    deleted = task_service.delete_task(req.task_id, pid)
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
