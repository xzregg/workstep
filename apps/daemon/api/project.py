"""Project API routes."""

import asyncio

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from schemas.project import InitRequest, ReorderProjectsRequest, RegisterRequest, RenameRequest, SaveStepsRequest
from services.project import DEFAULT_STEPS, project_manager
from services.workflow_definition import (
    WorkflowDefinition,
    WorkflowValidationError,
)

router = APIRouter(prefix="/api/project")


class ProjectPublicationRequest(BaseModel):
    published: bool


async def _run_db(project_id, operation):
    run_db = getattr(project_manager, "run_db", None)
    if run_db is not None:
        return await run_db(project_id, operation)
    def execute():
        with project_manager.activate_project_by_id(project_id) as project:
            return operation(project)

    return await asyncio.to_thread(execute)

@router.post("/init")
async def init_project(req: InitRequest):
    """Initialize a new WorkStep project."""
    try:
        proj = await asyncio.to_thread(
            project_manager.init_project, req.path, name=req.name
        )
        return await _run_db(proj.id, project_manager.project_summary)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/register")
async def register_project(req: RegisterRequest):
    """Register an existing project path."""
    try:
        proj = await asyncio.to_thread(
            project_manager.register_and_save, req.path, name=req.name
        )
        return await _run_db(proj.id, project_manager.project_summary)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/rename")
async def rename_project(req: RenameRequest):
    """Rename a registered project."""
    proj = await asyncio.to_thread(project_manager.rename, req.path, req.name)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"path": str(proj.path), "name": proj.name}


@router.post("/reorder")
async def reorder_projects(req: ReorderProjectsRequest):
    """Reorder registered local projects by id."""
    await asyncio.to_thread(project_manager.reorder_projects, req.ordered_ids)
    return {"reordered": True}


@router.get("/list")
async def list_projects():
    """List all registered projects."""
    from api.remote_project import remote_project_registry
    from services.remote_access import get_current_actor

    actor = get_current_actor()
    if actor is not None and actor.project_id is not None:
        raise HTTPException(status_code=403, detail="Project scope denied")

    local_projects = await asyncio.to_thread(project_manager.list_projects)
    local = [
        {**project, "type": "local", "connection_status": "local"}
        for project in local_projects
    ]
    remote = await asyncio.to_thread(remote_project_registry.list_public)
    return {"projects": [*local, *remote]}


@router.get("/{project_id}/summary")
async def get_project_summary(project_id: str):
    """Expose one project's metadata without its host filesystem path."""
    from services.remote_access import get_current_actor

    actor = get_current_actor()
    if actor is not None and actor.project_id is not None and actor.project_id != project_id:
        raise HTTPException(status_code=403, detail="Project scope denied")

    def summarize(project):
        summary = project_manager.project_summary(project)
        summary.pop("path", None)
        return summary

    try:
        return await project_manager.run_db(project_id, summarize)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Project not found") from exc


@router.post("/{project_id}/publication")
async def set_project_publication(project_id: str, req: ProjectPublicationRequest):
    from main import gateway_client

    try:
        return await gateway_client.publish_project(project_id, published=req.published)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc).strip("'")) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ConnectionError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{project_id}/publication")
async def get_project_publication(project_id: str):
    from main import gateway_client

    try:
        return await gateway_client.project_publication_status(project_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc).strip("'")) from exc
    except ConnectionError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.delete("/{project_id}")
async def delete_project(project_id: str):
    """Unregister a project without deleting its files."""
    from api.remote_project import client_manager, remote_project_registry

    if await asyncio.to_thread(remote_project_registry.get, project_id) is not None:
        removed = (
            await client_manager.remove(project_id)
            if client_manager is not None
            else await asyncio.to_thread(remote_project_registry.remove, project_id)
        )
        return {"deleted": removed}
    if await asyncio.to_thread(project_manager.unregister, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"deleted": True}


@router.post("/save-steps")
async def save_steps(req: SaveStepsRequest, pid: str = Query(..., alias="project_id"),
                     workflow_id: str | None = Query(None)):
    """Save workflow steps for a project. Defaults to the default workflow."""
    try:
        WorkflowDefinition.load(req.steps).validate()
    except WorkflowValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    def save(proj):
        if workflow_id:
            wf = project_manager.update_workflow(proj, workflow_id, steps=req.steps)
            if wf is None:
                raise HTTPException(status_code=404, detail="Workflow not found")
        else:
            default = proj.default_workflow()
            if default is None:
                raise HTTPException(status_code=400, detail="No workflow exists")
            project_manager.update_workflow(proj, default["id"], steps=req.steps)

        return {"saved": True}

    return await _run_db(pid, save)


@router.get("/default-steps")
async def get_default_steps():
    """Return the built-in default workflow definition."""
    return DEFAULT_STEPS
