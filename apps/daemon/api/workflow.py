"""Workflow CRUD API — multiple named workflows per project."""

import asyncio
import json
import logging

from fastapi import APIRouter, Body, HTTPException, Query

from schemas.project import CreateWorkflowRequest, UpdateWorkflowRequest
from engines.core.registry import list_all_engines
from services import config as config_service
from services.project import project_manager
from services.workflow_definition import WorkflowDefinition, WorkflowValidationError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/workflow", tags=["工作流管理"])


async def _run_db(project_id, operation):
    run_db = getattr(project_manager, "run_db", None)
    if run_db is not None:
        return await run_db(project_id, operation)
    def execute():
        with project_manager.activate_project_by_id(project_id) as project:
            return operation(project)

    return await asyncio.to_thread(execute)


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
    nodes = steps.get("nodes") or steps.get("steps") or []
    if not isinstance(nodes, list):
        return
    for node in nodes:
        if not isinstance(node, dict):
            continue
        _validate_stage_provider(
            str(node.get("engine") or ""),
            node.get("config"),
            "工作流阶段",
        )
        review = node.get("review")
        if isinstance(review, dict):
            _validate_stage_provider(
                str(review.get("engine") or node.get("engine") or ""),
                review.get("config"),
                "评审阶段",
            )


def _validate_stage_provider(
    engine_id: str,
    config: object,
    location: str,
) -> None:
    if not isinstance(config, dict):
        return
    provider_id = str(config.get("provider_id") or "").strip()
    if not provider_id:
        return
    provider = config_service.config_store.get_provider(provider_id)
    if provider is None:
        raise HTTPException(status_code=422, detail=f"{location}供应商不存在")
    if not provider.get("enabled", True):
        raise HTTPException(status_code=422, detail=f"{location}供应商已停用")
    engine_cls = list_all_engines().get(engine_id.replace("-", "_"))
    if engine_cls is None or not engine_cls.supports_provider(provider):
        raise HTTPException(
            status_code=422,
            detail=f"{location}供应商协议与引擎不兼容",
        )


@router.get("/list")
async def list_workflows(pid: str = Query(..., alias="project_id")):
    """List all workflows for a project."""
    def load(proj):
        return {
            "workflows": [
                {
                    "id": w["id"],
                    "name": w["name"],
                    "is_default": w["is_default"],
                    "deleted": w["deleted"],
                    "running": project_manager.workflow_has_running_tasks(w["id"]),
                    "failed": project_manager.workflow_has_failed_tasks(w["id"]),
                    "nodeCount": len(
                        w.get("steps", {}).get("nodes", [])
                        or w.get("steps", {}).get("steps", [])
                    ),
                }
                for w in proj.workflows
            ]
        }

    return await _run_db(pid, load)


@router.post("/reorder")
async def reorder_workflows(
    pid: str = Query(..., alias="project_id"),
    ordered_ids: list[str] = Body(..., embed=True),
):
    """Persist a new display order for the project's workflows."""
    def reorder(proj):
        project_manager.reorder_workflows(proj, ordered_ids)
        return {"ok": True}

    return await _run_db(pid, reorder)


@router.post("/create")
async def create_workflow(req: CreateWorkflowRequest, pid: str = Query(..., alias="project_id")):
    """Create a new workflow for a project."""
    steps = req.steps
    if steps is None and req.template_id:
        steps = await asyncio.to_thread(_resolve_template_steps, req.template_id)
        if steps is None:
            raise HTTPException(status_code=404, detail=f"Template not found: {req.template_id}")
    if steps is not None:
        await asyncio.to_thread(_validate_steps, steps)

    def create(proj):
        wf = project_manager.create_workflow(proj, name=req.name, steps=steps, is_default=req.is_default)
        return wf

    return await _run_db(pid, create)


@router.get("/{workflow_id}")
async def get_workflow(workflow_id: str, pid: str = Query(..., alias="project_id")):
    """Get a single workflow with full steps."""
    def load(proj):
        wf = next((w for w in proj.workflows if w["id"] == workflow_id), None)
        if wf is None:
            raise HTTPException(status_code=404, detail="Workflow not found")
        return wf

    return await _run_db(pid, load)


@router.put("/{workflow_id}")
async def update_workflow(workflow_id: str, req: UpdateWorkflowRequest, pid: str = Query(..., alias="project_id")):
    """Update workflow name and/or steps."""
    if req.steps is not None:
        await asyncio.to_thread(_validate_steps, req.steps)

    def update(proj):
        wf = project_manager.update_workflow(proj, workflow_id, name=req.name, steps=req.steps)
        if wf is None:
            raise HTTPException(status_code=404, detail="Workflow not found")
        return wf

    return await _run_db(pid, update)


@router.post("/{workflow_id}/restore")
async def restore_workflow(workflow_id: str, pid: str = Query(..., alias="project_id")):
    """Restore a soft-deleted workflow from the recycle bin."""
    def restore(proj):
        wf = project_manager.restore_workflow(proj, workflow_id)
        if wf is None:
            raise HTTPException(status_code=404, detail="Workflow not found or not deleted")
        return wf

    return await _run_db(pid, restore)


@router.delete("/{workflow_id}")
async def delete_workflow(workflow_id: str, pid: str = Query(..., alias="project_id")):
    """Delete a workflow — soft delete first, hard delete on the second call."""
    def delete(proj):
        result = project_manager.delete_workflow(proj, workflow_id)
        if result is None:
            raise HTTPException(status_code=404, detail="Workflow not found")
        if not result.get("deleted"):
            raise HTTPException(status_code=400, detail="默认流程或最后一个流程不能删除")
        return result

    return await _run_db(pid, delete)
