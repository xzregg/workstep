"""Shared project lookup and database execution for task API domains."""

import asyncio

from fastapi import HTTPException


def _project(project_id: str):
    """Resolve project metadata without touching its SQLite connection."""
    from main import project_manager

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

    run_db = getattr(project_manager, "run_db", None)
    if run_db is not None:
        return await run_db(project_id, lambda _project: operation())

    def execute():
        with project_manager.activate_project_by_id(project_id):
            return operation()

    return await asyncio.to_thread(execute)
