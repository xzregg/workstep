"""Project API routes."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services.project import project_manager

router = APIRouter(prefix="/api/project")


class InitRequest(BaseModel):
    path: str


class RegisterRequest(BaseModel):
    path: str


@router.post("/init")
async def init_project(req: InitRequest):
    """Initialize a new WorkStep project."""
    try:
        proj = project_manager.init_project(req.path)
        return {"path": str(proj.path), "name": proj.path.name, "steps": proj.steps}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/register")
async def register_project(req: RegisterRequest):
    """Register an existing project path."""
    try:
        proj = project_manager.register(req.path)
        return {"path": str(proj.path), "name": proj.path.name, "steps": proj.steps}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/list")
async def list_projects():
    """List all registered projects."""
    return {"projects": project_manager.list_projects()}
