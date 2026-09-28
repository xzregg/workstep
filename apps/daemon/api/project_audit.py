"""Read-only project operation audit API."""

from fastapi import APIRouter, HTTPException, Query, Request

from services.project_audit import list_project_audit
from services.remote_access import get_current_actor


router = APIRouter(prefix="/api/project-audit", tags=["操作审计"])


@router.get("")
async def get_project_audit(
    request: Request,
    project_id: str = Query(...),
    task_id: str | None = Query(None),
    limit: int = Query(100, ge=1, le=200),
    before: str | None = Query(None),
):
    from main import project_manager

    actor = get_current_actor()
    if request.scope.get("gateway_remote_actor") is not None or (
        actor is not None and actor.source == "remote"
    ):
        raise HTTPException(403, "远程项目审计查询尚未开放")
    if project_manager.get_project_by_id(project_id) is None:
        raise HTTPException(404, "项目不存在")
    try:
        return await project_manager.run_db(
            project_id,
            lambda _project: list_project_audit(
                project_id, task_id=task_id, limit=limit, before=before,
            ),
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
