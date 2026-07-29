"""Search API - search tasks by various criteria."""

from fastapi import APIRouter, Query
from services.project import project_manager

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
    from datetime import datetime
    from models import Task

    projects = (
        [project_manager.get_project_by_id(project_id)]
        if project_id
        else project_manager.list_projects()
    )
    if not projects or projects == [None]:
        return {"tasks": [], "limit": limit, "offset": offset, "total": 0}

    start_timestamp = None
    end_timestamp = None
    if start_date:
        try:
            start_timestamp = int(
                datetime.fromisoformat(start_date.replace("Z", "+00:00")).timestamp()
            )
        except ValueError:
            pass
    if end_date:
        try:
            end_timestamp = int(
                datetime.fromisoformat(end_date.replace("Z", "+00:00")).timestamp()
            )
        except ValueError:
            pass

    tasks = []
    for project in projects:
        project_id_for_context = (
            project.id if hasattr(project, "id") else project["id"]
        )
        with project_manager.activate_project_by_id(project_id_for_context):
            conditions = []
            if query:
                conditions.append(
                    (Task.title.contains(query)) | (Task.description.contains(query))
                )
            if status:
                conditions.append(Task.status == status)
            if engine:
                conditions.append(Task.engine == engine)
            if start_timestamp is not None:
                conditions.append(Task.created_at >= start_timestamp)
            if end_timestamp is not None:
                conditions.append(Task.created_at <= end_timestamp)

            task_query = Task.select()
            if conditions:
                task_query = task_query.where(*conditions)
            tasks.extend(list(task_query))

    tasks.sort(key=lambda task: task.updated_at, reverse=True)
    total = len(tasks)
    tasks = tasks[offset:offset + limit]

    return {
        "tasks": [
            {
                "id": t.id,
                "title": t.title,
                "description": t.description,
                "cwd": t.cwd,
                "status": t.status,
                "engine": t.engine,
                "created_at": t.created_at,
                "updated_at": t.updated_at,
            }
            for t in tasks
        ],
        "limit": limit,
        "offset": offset,
        "total": total,
    }
