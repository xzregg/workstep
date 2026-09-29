"""Search API - search tasks by various criteria."""

import asyncio

from fastapi import APIRouter, HTTPException, Query
from services.project import project_manager
from services.remote_access import get_current_actor
from services.task_read_model import project_relative_task_cwd

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
    from datetime import datetime, timezone
    from models import Task

    actor = get_current_actor()
    project_scoped = actor is not None and actor.project_id is not None
    if project_scoped and project_id != actor.project_id:
        raise HTTPException(status_code=403, detail="Project scope denied")

    projects = (
        [project_manager.get_project_by_id(project_id)]
        if project_id
        else list(project_manager.iter_projects())
    )
    if not projects or projects == [None]:
        return {"tasks": [], "limit": limit, "offset": offset, "total": 0}

    start_datetime = None
    end_datetime = None
    if start_date:
        try:
            start_datetime = datetime.fromisoformat(start_date.replace("Z", "+00:00"))
            if start_datetime.tzinfo is None:
                start_datetime = start_datetime.replace(tzinfo=timezone.utc)
            else:
                start_datetime = start_datetime.astimezone(timezone.utc)
        except ValueError:
            pass
    if end_date:
        try:
            end_datetime = datetime.fromisoformat(end_date.replace("Z", "+00:00"))
            if end_datetime.tzinfo is None:
                end_datetime = end_datetime.replace(tzinfo=timezone.utc)
            else:
                end_datetime = end_datetime.astimezone(timezone.utc)
        except ValueError:
            pass

    def load_project_tasks(project):
        conditions = []
        if query:
            conditions.append(
                (Task.title.contains(query)) | (Task.description.contains(query))
            )
        if status:
            conditions.append(Task.status == status)
        if engine:
            conditions.append(Task.engine == engine)
        if start_datetime is not None:
            conditions.append(Task.created_at >= start_datetime)
        if end_datetime is not None:
            conditions.append(Task.created_at <= end_datetime)

        task_query = Task.select()
        if conditions:
            task_query = task_query.where(*conditions)
        return [
            {
                "id": task.id,
                "title": task.title,
                "description": task.description,
                "cwd": (
                    project_relative_task_cwd(task.cwd, project.path)
                    if project_scoped else task.cwd
                ),
                "status": task.status,
                "engine": task.engine,
                "created_at": task.created_at,
                "updated_at": task.updated_at,
            }
            for task in task_query
        ]

    batches = await asyncio.gather(*(
        project_manager.run_db(
            project.id if hasattr(project, "id") else project["id"],
            lambda _project: load_project_tasks(_project),
        )
        for project in projects
    ))
    tasks = [item for batch in batches for item in batch]
    tasks.sort(key=lambda task: task["updated_at"], reverse=True)
    total = len(tasks)
    tasks = tasks[offset:offset + limit]

    return {
        "tasks": tasks,
        "limit": limit,
        "offset": offset,
        "total": total,
    }
