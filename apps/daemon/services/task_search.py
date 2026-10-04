"""Task search and cross-project history query orchestration."""

import asyncio
from services.task_read_model import project_relative_task_cwd


async def search_tasks(project_manager, *, actor, project_id, query, status, engine, start_date, end_date, limit, offset):
    from datetime import datetime, timezone
    from models import Task

    project_scoped = actor is not None and actor.project_id is not None

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


async def list_sessions(project_manager, project_id, limit, offset):
    from models import Task

    def load_project_tasks(pid: str, *, bounded: bool) -> list[dict]:
        query = Task.select().order_by(Task.updated_at.desc())
        if bounded:
            query = query.limit(limit).offset(offset)
        return [
            {
                "id": task.id,
                "title": task.title,
                "description": task.description,
                "status": task.status,
                "engine": task.engine,
                "created_at": task.created_at,
                "updated_at": task.updated_at,
            }
            for task in query
        ]

    if project_id:
        # Get sessions for specific project
        proj = project_manager.get_project_by_id(project_id)
        if not proj:
            raise LookupError("Project not found")

        sessions = await project_manager.run_db(
            project_id,
            lambda _project: load_project_tasks(project_id, bounded=True),
        )
    else:
        # Cross-project session list. Each project owns a separate database, so
        # query under its context and merge before applying global pagination.
        projects = tuple(project_manager.iter_projects())
        batches = await asyncio.gather(*(
            project_manager.run_db(
                project.id,
                lambda _project, pid=project.id: load_project_tasks(
                    pid, bounded=False
                ),
            )
            for project in projects
        ))
        sessions = [item for batch in batches for item in batch]
        sessions.sort(key=lambda task: task["updated_at"], reverse=True)
        sessions = sessions[offset:offset + limit]

    return {"sessions": sessions, "limit": limit, "offset": offset}
