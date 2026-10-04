"""Shared project lookup and database execution for task API domains."""

import asyncio

from fastapi import HTTPException


def _require_project_scope(project_id: str | None) -> None:
    from services.remote_access import get_current_actor

    actor = get_current_actor()
    if actor is not None and actor.project_id is not None and actor.project_id != project_id:
        raise HTTPException(status_code=403, detail="Project scope denied")


def _project(project_id: str):
    """Resolve project metadata without touching its SQLite connection."""
    from main import project_manager

    _require_project_scope(project_id)
    if not project_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        project = project_manager.get_project_by_id(project_id)
        if project is None:
            raise ValueError(f"Project not found: {project_id}")
        return project
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


async def _run_db(project_id: str, operation):
    """Run task persistence on the selected project's DB executor."""
    from main import project_manager

    _require_project_scope(project_id)
    run_db = getattr(project_manager, "run_db", None)
    if run_db is not None:
        return await run_db(project_id, lambda _project: operation())

    def execute():
        with project_manager.activate_project_by_id(project_id):
            return operation()

    return await asyncio.to_thread(execute)


async def _require_scoped_task(project_id: str | None, task_id: str) -> None:
    """Verify a project-only actor owns a task before using global runtime state."""
    from services.remote_access import get_current_actor

    actor = get_current_actor()
    if actor is None or actor.project_id is None:
        return
    _require_project_scope(project_id)

    from models import Task

    exists = await _run_db(project_id, lambda: Task.select().where(
        Task.id == task_id,
    ).exists())
    if not exists:
        raise HTTPException(status_code=404, detail="Task not found")


async def _release_task_channel_bindings(project_id: str, task_id: str) -> None:
    """Release channel routing after a successful archive or deletion."""
    from main import channel_bot_manager

    if channel_bot_manager is not None:
        await channel_bot_manager.remove_task_bindings(project_id, task_id)
