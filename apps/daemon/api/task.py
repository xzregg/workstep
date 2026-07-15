"""Task API routes."""

import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/task")


class CreateTaskRequest(BaseModel):
    title: str
    cwd: str
    description: str | None = None
    engine: str = "claude"


class RunTaskRequest(BaseModel):
    task_id: str
    prompt: str


@router.post("/create")
async def create_task(req: CreateTaskRequest):
    """Create a new task."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    return task_service.create_task(
        title=req.title,
        cwd=req.cwd,
        description=req.description,
        engine=req.engine,
    )


@router.get("/list")
async def list_tasks():
    """List all tasks."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    return {"tasks": task_service.list_tasks()}


@router.get("/{task_id}")
async def get_task(task_id: str):
    """Get a single task."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    task = task_service.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.post("/run")
async def run_task(req: RunTaskRequest):
    """Run a task (fire-and-forget, events come via WebSocket)."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")

    task = task_service.get_task(req.task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Fire and forget — events will stream via WebSocket
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
