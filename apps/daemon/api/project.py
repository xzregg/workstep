"""Project API routes."""

from fastapi import APIRouter, HTTPException, Query

from schemas.project import InitRequest, RegisterRequest, RenameRequest, SaveStepsRequest
from services.project import DEFAULT_STEPS, project_manager
from services.workflow_definition import (
    WorkflowDefinition,
    WorkflowValidationError,
)

router = APIRouter(prefix="/api/project")

@router.post("/init")
async def init_project(req: InitRequest):
    """Initialize a new WorkStep project."""
    try:
        proj = project_manager.init_project(req.path, name=req.name)
        return {"id": proj.id, "path": str(proj.path), "name": proj.name, "steps": proj.steps}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/register")
async def register_project(req: RegisterRequest):
    """Register an existing project path."""
    try:
        proj = project_manager.register_and_save(req.path, name=req.name)
        return {
            "id": proj.id,
            "path": str(proj.path),
            "name": proj.name,
            "steps": proj.steps,
        }
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/rename")
async def rename_project(req: RenameRequest):
    """Rename a registered project."""
    proj = project_manager.rename(req.path, req.name)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"path": str(proj.path), "name": proj.name}


@router.get("/list")
async def list_projects():
    """List all registered projects."""
    return {"projects": project_manager.list_projects()}


@router.delete("/{project_id}")
async def delete_project(project_id: str):
    """Unregister a project without deleting its files."""
    if project_manager.unregister(project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return {"deleted": True}


@router.post("/save-steps")
async def save_steps(req: SaveStepsRequest, pid: str = Query(..., alias="project_id"),
                     workflow_id: str | None = Query(None)):
    """Save workflow steps for a project. Defaults to the default workflow."""
    with project_manager.activate_project_by_id(pid) as proj:
        try:
            WorkflowDefinition.load(req.steps).validate()
        except WorkflowValidationError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

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


@router.get("/default-steps")
async def get_default_steps():
    """Return the default steps.json template."""
    return DEFAULT_STEPS
