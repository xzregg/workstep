"""Map task-share scope failures at the HTTP boundary."""

from fastapi import HTTPException

from services.shared_task_scope import SharedTaskScopeError


async def run_scope_db(project_id, operation):
    from main import project_manager

    try:
        return await project_manager.run_db(project_id, operation)
    except SharedTaskScopeError as exc:
        raise HTTPException(exc.status_code, exc.detail) from exc
