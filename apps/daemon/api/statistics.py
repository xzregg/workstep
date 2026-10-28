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
    """Host metrics are local-only and never collected on the request path."""
    from api.desktop_security import desktop_runtime_authenticated
    from services.remote_access import _client_host, _is_loopback, authenticated_remote_dispatch
    actor = get_current_actor()
    # Container port forwarding replaces Electron's loopback peer with a bridge
    # address. Its per-launch desktop credential still identifies local access.
    if ((not desktop_runtime_authenticated(request)
         and not _is_loopback(_client_host(request.headers, request.client)))
            or authenticated_remote_dispatch() is not None
            or request.scope.get('gateway_remote_actor') is not None
            or (actor is not None and (actor.project_id is not None
                                      or actor.source == 'remote'
                                      or actor.access_source == 'remote_browser'))):
        raise HTTPException(status_code=403, detail="System statistics are local only")
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
        return await asyncio.to_thread(
            StatisticsModule(project_manager).overview,
            StatisticsQuery(
                project_id=project_id,
                workflow_id=workflow_id,
                range_key=range_key,
                start=start,
                end=end,
                timezone=timezone,
            ),
        )
    except ValueError as exc:
        detail = str(exc)
        status_code = 404 if "not found" in detail.lower() else 422
        raise HTTPException(status_code=status_code, detail=detail) from exc
