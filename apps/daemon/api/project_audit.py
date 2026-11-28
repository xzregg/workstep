"""Read-only project operation audit API."""

from fastapi import APIRouter, HTTPException, Query, Request
from api.workspace_access import require_workspace_access

from services.project_audit import list_project_audit


router = APIRouter(prefix="/api/project-audit", tags=["操作审计"])


@router.get("")
async def get_project_audit(
    request: Request,
    project_id: str = Query(...),
    task_id: str | None = Query(None),
    limit: int = Query(100, ge=1, le=200),
    before: str | None = Query(None),
    remote_only: bool = Query(False),
    action: str | None = Query(None, max_length=128),
    result: str | None = Query(None, pattern="^(succeeded|denied|failed)$"),
):
    from main import project_manager

    await require_workspace_access(request, 'local', detail='Operation audit is only viewable on the device where the project resides')
    if project_manager.get_project_by_id(project_id) is None:
        raise HTTPException(404, "Project not found")
    try:
        return await project_manager.run_db(
            project_id,
            lambda _project: list_project_audit(
                project_id, task_id=task_id, limit=limit, before=before,
                remote_only=remote_only, action=action, result=result,
            ),
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
