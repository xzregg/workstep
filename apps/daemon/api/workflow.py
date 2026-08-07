"""Workflow CRUD API — multiple named workflows per project."""

import json
import logging

from fastapi import APIRouter, HTTPException, Query

from schemas.project import CreateWorkflowRequest, UpdateWorkflowRequest
from services.project import project_manager
from services.workflow_definition import WorkflowDefinition, WorkflowValidationError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/workflow", tags=["工作流管理"])


def _resolve_template_steps(template_id: str) -> dict | None:
    """Resolve template steps by ID from ~/.workstep/data/templates/."""
    from api.templates import GLOBAL_TEMPLATES_DIR
    template_path = GLOBAL_TEMPLATES_DIR / f"{template_id}.json"
    if template_path.exists():
        try:
            data = json.loads(template_path.read_text(encoding="utf-8"))
            # Templates may be raw canvas JSON or wrapped in {"steps": ...}
            if "steps" in data:
                return data["steps"]
            if "nodes" in data:
                return data
        except Exception:
            pass
    return None


def _validate_steps(steps: dict) -> None:
    """Raise HTTPException if steps are invalid."""
    try:
        WorkflowDefinition.load(steps).validate()
    except WorkflowValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/list")
async def list_workflows(pid: str = Query(..., alias="project_id")):
    """List all workflows for a project."""
    with project_manager.activate_project_by_id(pid) as proj:
        return {
            "workflows": [
                {
                    "id": w["id"],
                    "name": w["name"],
                    "is_default": w["is_default"],
                    "deleted": w["deleted"],
                    "running": project_manager.workflow_has_running_tasks(w["id"]),
                    "nodeCount": len(
                        w.get("steps", {}).get("nodes", [])
                        or w.get("steps", {}).get("steps", [])
                    ),
                }
                for w in proj.workflows
            ]
        }


@router.post("/create")
async def create_workflow(req: CreateWorkflowRequest, pid: str = Query(..., alias="project_id")):
    """Create a new workflow for a project."""
    with project_manager.activate_project_by_id(pid) as proj:
        steps = req.steps
        if steps is None and req.template_id:
            steps = _resolve_template_steps(req.template_id)
            if steps is None:
                raise HTTPException(status_code=404, detail=f"Template not found: {req.template_id}")
        if steps is not None:
            _validate_steps(steps)
        wf = project_manager.create_workflow(proj, name=req.name, steps=steps, is_default=req.is_default)
        return wf


@router.get("/{workflow_id}")
async def get_workflow(workflow_id: str, pid: str = Query(..., alias="project_id")):
    """Get a single workflow with full steps."""
    with project_manager.activate_project_by_id(pid) as proj:
        wf = next((w for w in proj.workflows if w["id"] == workflow_id), None)
        if wf is None:
            raise HTTPException(status_code=404, detail="Workflow not found")
        return wf


@router.put("/{workflow_id}")
async def update_workflow(workflow_id: str, req: UpdateWorkflowRequest, pid: str = Query(..., alias="project_id")):
    """Update workflow name and/or steps."""
    with project_manager.activate_project_by_id(pid) as proj:
        if req.steps is not None:
            _validate_steps(req.steps)
        wf = project_manager.update_workflow(proj, workflow_id, name=req.name, steps=req.steps)
        if wf is None:
            raise HTTPException(status_code=404, detail="Workflow not found")
        return wf


@router.post("/{workflow_id}/restore")
async def restore_workflow(workflow_id: str, pid: str = Query(..., alias="project_id")):
    """Restore a soft-deleted workflow from the recycle bin."""
    with project_manager.activate_project_by_id(pid) as proj:
        wf = project_manager.restore_workflow(proj, workflow_id)
        if wf is None:
            raise HTTPException(status_code=404, detail="Workflow not found or not deleted")
        return wf


@router.delete("/{workflow_id}")
async def delete_workflow(workflow_id: str, pid: str = Query(..., alias="project_id")):
    """Delete a workflow — soft delete first, hard delete on the second call."""
    with project_manager.activate_project_by_id(pid) as proj:
        result = project_manager.delete_workflow(proj, workflow_id)
        if result is None:
            raise HTTPException(status_code=404, detail="Workflow not found")
        if not result.get("deleted"):
            raise HTTPException(status_code=400, detail="默认流程或最后一个流程不能删除")
        return result
