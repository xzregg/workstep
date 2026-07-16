"""Task API routes — all endpoints require project_id."""

import asyncio

from fastapi import APIRouter, HTTPException, Query

from schemas.task import CreateTaskRequest, RunTaskRequest

router = APIRouter(prefix="/api/task")


def _bind(project_id: str):
    """Bind db_proxy to the project identified by ID."""
    from main import project_manager
    if not project_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        project_manager.bind_project_by_id(project_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/create")
async def create_task(req: CreateTaskRequest, pid: str = Query(..., alias="project_id")):
    """Create a new task."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    _bind(pid)
    return task_service.create_task(
        title=req.title,
        cwd=req.cwd,
        description=req.description,
        engine=req.engine,
    )


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


@router.post("/run")
async def run_task(req: RunTaskRequest, pid: str = Query(..., alias="project_id")):
    """Run a task (fire-and-forget, events come via WebSocket)."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    _bind(pid)
    task = task_service.get_task(req.task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    asyncio.create_task(task_service.run_task(req.task_id, req.prompt))
    return {"status": "started", "task_id": req.task_id}


@router.post("/cancel")
async def cancel_task(req: RunTaskRequest):
    """Cancel a running task."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    cancelled = await task_service.cancel_task(req.task_id)
    return {"cancelled": cancelled}
