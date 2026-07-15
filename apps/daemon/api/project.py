"""Project API routes."""

from fastapi import APIRouter, HTTPException

from schemas.project import InitRequest, RegisterRequest, RenameRequest
from services.project import project_manager

router = APIRouter(prefix="/api/project")


@router.post("/init")
async def init_project(req: InitRequest):
    """Initialize a new WorkStep project."""
    try:
        proj = project_manager.init_project(req.path, name=req.name)
        return {"path": str(proj.path), "name": proj.name, "steps": proj.steps}
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
