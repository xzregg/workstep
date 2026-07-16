"""Project API routes."""

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from schemas.project import InitRequest, RegisterRequest, RenameRequest, SaveStepsRequest
from services.project import project_manager

router = APIRouter(prefix="/api/project")

# Path to default steps template
DEFAULT_STEPS_PATH = Path(__file__).parent.parent / "data" / "steps.json"


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
        return {"path": str(proj.path), "name": proj.name, "steps": proj.steps}
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


@router.post("/save-steps")
async def save_steps(req: SaveStepsRequest, pid: str = Query(..., alias="project_id")):
    """Save workflow steps.json for a project."""
    proj = project_manager.get_project_by_id(pid)
    if not proj:
        raise HTTPException(status_code=404, detail="Project not found")

    steps_path = proj.workstep_dir / "steps.json"
    steps_path.write_text(json.dumps(req.steps, ensure_ascii=False, indent=2))

    # Update in-memory steps
    proj.steps = req.steps
    return {"path": str(steps_path), "saved": True}


@router.get("/default-steps")
async def get_default_steps():
    """Return the default steps.json template."""
    if not DEFAULT_STEPS_PATH.exists():
        raise HTTPException(status_code=404, detail="Default steps template not found")
    return json.loads(DEFAULT_STEPS_PATH.read_text())
