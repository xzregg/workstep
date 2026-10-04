"""Search API - search tasks by various criteria."""


from fastapi import APIRouter, HTTPException, Query
from services.project import project_manager
from services.remote_access import get_current_actor

router = APIRouter(prefix="/api/search")


@router.get("/tasks")
async def search_tasks(
    project_id: str | None = Query(None, alias="projectId"),
    query: str | None = Query(None),
    status: str | None = Query(None),
    engine: str | None = Query(None),
    start_date: str | None = Query(None),
    end_date: str | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """Search tasks by various criteria.

    Parameters:
    - projectId: Filter by project ID
    - query: Search in title and description
    - status: Filter by task status (ready/running/paused/stopped)
    - engine: Filter by engine
    - startDate: Filter tasks created after this date (ISO format)
    - endDate: Filter tasks created before this date (ISO format)
    - limit: Max results
    - offset: Pagination offset
    """
    actor = get_current_actor()
    if actor is not None and actor.project_id is not None and project_id != actor.project_id:
        raise HTTPException(status_code=403, detail="Project scope denied")
    from services.task_search import search_tasks as search
    return await search(project_manager, actor=actor, project_id=project_id, query=query,
                        status=status, engine=engine, start_date=start_date, end_date=end_date,
                        limit=limit, offset=offset)
