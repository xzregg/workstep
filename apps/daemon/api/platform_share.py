"""Task-scoped read projection for Gateway public sharing."""

from fastapi import APIRouter, HTTPException, Request

from api.task_context import _run_db

router = APIRouter(prefix="/api/platform-share")


@router.get("/task")
async def read_platform_share_task(request: Request):
    scope = request.scope.get("gateway_share_scope")
    if not isinstance(scope, dict):
        raise HTTPException(status_code=403, detail="Gateway share ticket required")
    from main import task_service
    if task_service is None:
        raise HTTPException(status_code=503, detail="Service not initialized")
    task = await _run_db(
        scope["host_project_id"],
        lambda: task_service.get_task(scope["task_id"]),
    )
    if task is None or task.get("id") != scope["task_id"]:
        raise HTTPException(status_code=404, detail="Task unavailable")
    return {key: task.get(key) for key in (
        "id", "title", "description", "status", "created_at", "updated_at",
        "creator_name",
    )}
