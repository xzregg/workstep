"""Statistics dashboard API."""

import asyncio
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, Request

from services.project import project_manager
from services.remote_access import get_current_actor
from services.statistics import StatisticsModule, StatisticsQuery
from services.system_statistics import system_statistics


router = APIRouter(prefix="/api/statistics")


@router.get("/system")
async def system_report(request: Request):
    """Host metrics for local and authorized owner workspaces, read from cache."""
    from api.workspace_access import require_workspace_access
    await require_workspace_access(request, 'host', detail='System statistics require host workspace access')
    return system_statistics.snapshot()


@router.get("/overview")
async def overview(
    project_id: str | None = Query(None),
    workflow_id: str | None = Query(None),
    range_key: str = Query("30d", alias="range"),
    start: datetime | None = Query(None),
    end: datetime | None = Query(None),
    timezone: str = Query("UTC"),
):
    """Return one global, project, or workflow statistics report."""
    actor = get_current_actor()
    if actor is not None and actor.project_id is not None and project_id != actor.project_id:
        raise HTTPException(status_code=403, detail="Project scope denied")
    try:
        query = StatisticsQuery(
            project_id=project_id,
            workflow_id=workflow_id,
            range_key=range_key,
            start=start,
            end=end,
            timezone=timezone,
            actor_id=(actor.actor_id if actor is not None
                      and actor.source == "managed" and actor.project_id is not None else None),
        )
        module = StatisticsModule(project_manager)
        if project_id:
            return await project_manager.run_db(project_id, lambda _: module.overview(query))
        return await asyncio.to_thread(module.overview, query)
    except ValueError as exc:
        detail = str(exc)
        status_code = 404 if "not found" in detail.lower() else 422
        raise HTTPException(status_code=status_code, detail=detail) from exc
