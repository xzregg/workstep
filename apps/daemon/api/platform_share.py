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


@router.get("/history")
async def read_platform_share_history(request: Request):
    scope = request.scope.get("gateway_share_scope")
    if not isinstance(scope, dict):
        raise HTTPException(status_code=403, detail="Gateway share ticket required")
    from models import Message

    def load(_project):
        rows = list(Message.select(
            Message.id, Message.role, Message.content, Message.step_key,
            Message.run_status, Message.created_at,
        ).where(
            (Message.task == scope["task_id"])
            & (Message.channel == "execution")
        ).order_by(Message.sequence.desc(), Message.created_at.desc()).limit(100))
        return [{
            "id": message.id, "role": message.role,
            "content": (message.content or "")[:65536],
            "truncated": len(message.content or "") > 65536,
            "step_key": message.step_key, "run_status": message.run_status,
            "created_at": message.created_at,
        } for message in reversed(rows)]

    from main import project_manager
    if project_manager is None:
        raise HTTPException(status_code=503, detail="Service not initialized")
    messages = await project_manager.run_db(scope["host_project_id"], load)
    return {"messages": messages}
