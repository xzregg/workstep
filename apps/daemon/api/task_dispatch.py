"""Daemon-to-daemon endpoint for remote workflow-step dispatch."""


from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from services.task_creation import create_project_task
from services.messages import current_actor_task_fields

router = APIRouter(prefix="/api/task-dispatch", tags=["流程步骤"])


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

    if task_service is None or workflow_runtime is None:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        from services.task_dispatch import prepare_received_dispatch

        prepared = await project_manager.run_db(project_id, lambda _project: prepare_received_dispatch(project_manager, task_service, project_id, req))
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
        if isinstance(exc, PermissionError):
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        raise HTTPException(status_code=422, detail=str(exc)) from exc
