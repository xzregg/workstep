"""Local workflow debug catalog. Runs use the public workflow runtime methods."""

import asyncio
import time

from weakref import WeakValueDictionary

from fastapi import APIRouter, HTTPException, Query
from pydantic import Field

from api.task import DeleteTaskRequest, delete_task
from api.task_context import _project, _run_db
from api.workflow import _validate_steps
from schemas.base import BaseSchema
from services.config import DEFAULT_EXECUTION_ENGINE, config_store
from services.messages import current_actor_task_fields
from services.remote_access import get_current_actor
from services.workflow_debug import (
    compile_debug, create_debug_task, debug_records, debug_task_active, debug_task_ids,
    prepare_debug_restart, save_debug_workflow,
)

router = APIRouter(prefix="/api/workflow-debug", tags=["流程调试"])

_operations = WeakValueDictionary()


def operation_lock(pid, source_id):
    return _operations.setdefault((pid, source_id), asyncio.Lock())


class Sample(BaseSchema):
    step_key: str = Field(min_length=1, max_length=100)
    port: int = Field(ge=0)
    content: str = Field(max_length=256_000)


class DebugConfiguration(BaseSchema):
    workflow: dict


class DebugRestart(BaseSchema):
    step_key: str = Field(min_length=1, max_length=100)
    samples: list[Sample] = Field(default_factory=list, max_length=32)
    instruction: str = Field(default="", max_length=100_000)


class DebugStart(DebugConfiguration):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=100_000)
    step_key: str = Field(min_length=1, max_length=100)
    samples: list[Sample] = Field(default_factory=list, max_length=32)


def local_only(pid):
    actor = get_current_actor()
    if actor and actor.project_id is not None:
        raise HTTPException(403, "Workflow debugging is available on the host only")
    return _project(pid)


async def validate_workflow(workflow):
    try:
        await asyncio.to_thread(_validate_steps, workflow)
    except (ValueError, TypeError, KeyError) as exc:
        raise HTTPException(422, str(exc)) from exc


async def operate(pid, action):
    try:
        return await _run_db(pid, action)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except (ValueError, TypeError, KeyError) as exc:
        raise HTTPException(422, str(exc)) from exc
    except (RuntimeError, OSError) as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/{source_id}")
async def history(source_id: str, pid: str = Query(..., alias="project_id")):
    local_only(pid)
    return await operate(pid, lambda: debug_records(source_id))


@router.post("/{source_id}/start")
async def start(source_id: str, body: DebugStart, pid: str = Query(..., alias="project_id")):
    from main import task_service, workflow_runtime

    project = local_only(pid)
    if not body.title.strip():
        raise HTTPException(422, "Task title is required")
    await validate_workflow(body.workflow)
    creator = current_actor_task_fields()
    engine = await asyncio.to_thread(config_store.get_execution_default_engine) or DEFAULT_EXECUTION_ENGINE
    async with operation_lock(pid, source_id):
        result, rounds = await operate(pid, lambda: create_debug_task(
            project, source_id, body, task_service, engine, creator,
        ))
        try:
            await workflow_runtime.restart_from_step(pid, result["id"], body.step_key, input_rounds=rounds)
        except (ValueError, RuntimeError) as exc:
            # The record is reachable via history, even when the runtime rejects the start.
            return {**result, "start_error": str(exc)}
        return result


@router.put("/{source_id}/configuration")
async def configuration(source_id: str, body: DebugConfiguration, pid: str = Query(..., alias="project_id")):
    project = local_only(pid)
    await validate_workflow(body.workflow)
    try:
        await asyncio.to_thread(compile_debug, body.workflow)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    async with operation_lock(pid, source_id):
        return {"workflow_id": await operate(pid, lambda: save_debug_workflow(project, source_id, body.workflow))}


@router.post("/{source_id}/tasks/{task_id}/restart")
async def restart(source_id: str, task_id: str, body: DebugRestart, pid: str = Query(..., alias="project_id")):
    from main import workflow_runtime

    project = local_only(pid)
    async with operation_lock(pid, source_id):
        rounds = await operate(pid, lambda: prepare_debug_restart(project, source_id, task_id, body.step_key, body.samples))
        try:
            await workflow_runtime.restart_from_step(
                pid, task_id, body.step_key, input_rounds=rounds, step_followup=body.instruction or None,
            )
        except (ValueError, RuntimeError) as exc:
            raise HTTPException(409, str(exc)) from exc
    return {"started": True}


async def stop_task(pid, task_id):
    from main import workflow_runtime

    await workflow_runtime.cancel(task_id, action="task.pause")
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if task_id not in workflow_runtime._runners and not await _run_db(pid, lambda: debug_task_active(task_id)):
            return
        await asyncio.sleep(.05)
    raise HTTPException(409, "Debug task did not stop in time")


@router.post("/{source_id}/tasks/{task_id}/stop")
async def stop(source_id: str, task_id: str, pid: str = Query(..., alias="project_id")):
    local_only(pid)
    if not await operate(pid, lambda: debug_task_ids(source_id, task_id)):
        raise HTTPException(404, "Debug task not found")
    await stop_task(pid, task_id)
    return {"stopped": True}


@router.delete("/{source_id}")
@router.delete("/{source_id}/tasks/{task_id}")
async def clear(source_id: str, pid: str = Query(..., alias="project_id"), task_id: str | None = None):
    local_only(pid)
    async with operation_lock(pid, source_id):
        ids = await operate(pid, lambda: debug_task_ids(source_id, task_id))
        if task_id and not ids:
            raise HTTPException(404, "Debug task not found")
        for selected in ids:
            await stop_task(pid, selected)
            await delete_task(DeleteTaskRequest(task_id=selected, delete_workspace=True), pid)
        return {"deleted": len(ids)}
