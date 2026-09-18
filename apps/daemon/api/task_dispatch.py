"""Daemon-to-daemon endpoint for remote workflow-stage dispatch."""

import base64
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from services.task_creation import create_project_task
from services.messages import current_actor_task_fields

router = APIRouter(prefix="/api/task-dispatch", tags=["流程阶段"])


class DispatchFile(BaseModel):
    source_step_key: str
    source_round: int
    name: str
    relative_path: str
    content_b64: str


class ReceiveDispatchRequest(BaseModel):
    dispatch_id: str
    title: str
    description: str | None = None
    workflow_id: str
    start_step_key: str
    auto_start: bool = False
    source_project_id: str
    source_task_id: str
    source_step_key: str
    dispatch_lineage: list[str] = []
    files: list[DispatchFile] = []


@router.post("/receive")
async def receive_dispatch(req: ReceiveDispatchRequest, project_id: str = Query(...)):
    from main import project_manager, task_service, workflow_runtime
    from models import Task

    if task_service is None or workflow_runtime is None:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        def prepare_dispatch():
            project = project_manager.get_project_by_id(project_id)
            if project is None:
                raise ValueError("Project not found")
            workflow = project.workflow_by_id(req.workflow_id)
            if workflow is None:
                raise ValueError("目标流程不存在")
            existing = Task.get_or_none(Task.source_dispatch_id == req.dispatch_id)
            if existing is not None:
                return {"existing": task_service.get_task(existing.id)}
            root = project.workstep_dir / "task-inputs" / req.dispatch_id
            manifest = []
            for item in req.files:
                relative = Path(item.relative_path)
                if relative.is_absolute() or ".." in relative.parts:
                    raise ValueError("输入产物路径非法")
                destination = (root / item.source_step_key / relative).resolve()
                destination.relative_to(root.resolve())
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(base64.b64decode(item.content_b64, validate=True))
                manifest.append({
                    "source_step_key": item.source_step_key,
                    "source_round": item.source_round,
                    "name": item.name,
                    "path": str(destination),
                })
            return {"cwd": str(project.path), "manifest": manifest}

        prepared = await project_manager.run_db(project_id, lambda _project: prepare_dispatch())
        if "existing" in prepared:
            return prepared["existing"]
        result = await create_project_task(
            project_manager=project_manager,
            task_service=task_service,
            workflow_runtime=workflow_runtime,
            project_id=project_id,
            title=req.title,
            cwd=prepared["cwd"],
            description=req.description,
            workflow_id=req.workflow_id,
            start_step_key=req.start_step_key,
            execution_mode="immediate" if req.auto_start else "manual",
            source_dispatch_id=req.dispatch_id,
            source_project_id=req.source_project_id,
            source_task_id=req.source_task_id,
            source_step_key=req.source_step_key,
            input_manifest=prepared["manifest"],
            dispatch_lineage=req.dispatch_lineage,
            creator_fields=current_actor_task_fields(),
        )
        return result.task
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
