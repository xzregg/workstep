"""Read and edit one task's workflow without changing the shared definition."""

import asyncio
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import Field

from api.task_context import _project, _require_scoped_task
from schemas.base import BaseSchema
from services.task_workflow import WorkflowConflict
from services.task_workflow_config import get_task_workflow, save_task_workflow

router = APIRouter(prefix="/api/task")


class TaskWorkflowSave(BaseSchema):
    workflow: dict
    revision: str = Field(min_length=1)
    context_mode: Literal["smart", "full", "none"] = "smart"


class TaskWorkflowSync(BaseSchema):
    revision: str = Field(min_length=1)


async def _configuration(pid: str, task_id: str, *, request=None, sync=False):
    from main import project_manager, workflow_runtime, event_bus

    _project(pid)
    await _require_scoped_task(pid, task_id)
    if workflow_runtime is None:
        raise HTTPException(503, "Service not initialized")
    lock = workflow_runtime._operation_locks.setdefault(task_id, asyncio.Lock())
    try:
        async with lock:
            active = task_id in workflow_runtime._runners
            if request is None:
                return await project_manager.run_db(pid, lambda project:
                    get_task_workflow(project, task_id, active_runner=active))
            result = await project_manager.run_db(pid, lambda project:
                save_task_workflow(project, task_id, None if sync else request.workflow,
                                   request.revision, active_runner=active,
                                   context_mode=getattr(request, "context_mode", "smart")))
        await event_bus.publish({"type": "CUSTOM", "name": "workstep.task_updated",
                                 "task_id": task_id, "project_id": pid, "value": {}})
        return result
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc
    except (WorkflowConflict, ValueError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/{task_id}/workflow")
async def read_workflow(task_id: str, pid: str = Query(..., alias="project_id")):
    return await _configuration(pid, task_id)


@router.put("/{task_id}/workflow")
async def edit_workflow(task_id: str, request: TaskWorkflowSave, pid: str = Query(..., alias="project_id")):
    return await _configuration(pid, task_id, request=request)


@router.post("/{task_id}/workflow/sync")
async def sync_workflow(task_id: str, request: TaskWorkflowSync, pid: str = Query(..., alias="project_id")):
    return await _configuration(pid, task_id, request=request, sync=True)
