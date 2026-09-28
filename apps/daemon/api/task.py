"""Task API routes — all endpoints require project_id."""

import asyncio
from pathlib import Path

from fastapi import APIRouter, Body, Header, HTTPException, Query

from schemas.base import BaseSchema
from schemas.task import (
    CreateTaskRequest,
    CoordinatorChatRequest,
    CoordinatorConfigRequest,
    FailedStepCompletionRequest,
    RunTaskRequest,
    ScheduledStartRequest,
    StepMessageRequest,
    StepExecutionConfigRequest,
    StepResumeRequest,
    UpdateTaskRequest,
)
from services.config import DEFAULT_EXECUTION_ENGINE, config_store
from services.workflow_definition import WorkflowValidationError
from services.task_creation import create_project_task
from services.messages import current_actor_task_fields
from services.artifacts import (
    list_task_artifact_input_snapshots,
    list_task_artifacts,
)
from api.task_context import _project, _run_db

router = APIRouter(prefix="/api/task")


@router.post("/create")
async def create_task(req: CreateTaskRequest, pid: str = Query(..., alias="project_id")):
    """Create a new task."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        from main import project_manager, workflow_runtime
        mode = (
            "immediate" if req.auto_start is True
            else "manual" if req.auto_start is False
            else "workflow"
        )
        if req.scheduled_start_at is not None and req.auto_start is True:
            raise HTTPException(status_code=422, detail="scheduled_start_at conflicts with auto_start")
        if req.scheduled_start_at is not None:
            mode = "manual"
        title = (
            req.title
            if req.title.strip()
            else f"{(req.description or '').strip()[:10]}..."
        )
        default_engine = await asyncio.to_thread(
            config_store.get_execution_default_engine
        )
        creator_fields = current_actor_task_fields()
        result = await create_project_task(
            project_manager=project_manager,
            task_service=task_service,
            workflow_runtime=workflow_runtime,
            project_id=pid,
            title=title,
            cwd=req.cwd,
            description=req.description,
            engine=(
                req.engine
                or default_engine
                or DEFAULT_EXECUTION_ENGINE
            ),
            start_step_key=req.start_step_key,
            review_overrides=req.review_overrides,
            workflow_id=req.workflow_id,
            execution_mode=mode,
            scheduled_start_at=req.scheduled_start_at,
            creator_fields=creator_fields,
        )
        return result.task
    except WorkflowValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        status = 422 if "scheduled_start_at" in str(exc) else 404
        raise HTTPException(status_code=status, detail=str(exc)) from exc


@router.patch("/{task_id}/scheduled-start")
async def update_scheduled_start(
    task_id: str,
    req: ScheduledStartRequest,
    pid: str = Query(..., alias="project_id"),
):
    from main import task_service, event_bus
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        task = await _run_db(
            pid,
            lambda: task_service.update_scheduled_start(
                task_id,
                req.scheduled_start_at,
            ),
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    await event_bus.publish({
        "type": "CUSTOM",
        "project_id": pid,
        "name": "workstep.scheduled_start",
        "value": {
            "task_id": task_id,
            "scheduled_start_at": task["scheduled_start_at"].isoformat() if task["scheduled_start_at"] else None,
            "scheduled_start_state": task["scheduled_start_state"],
            "scheduled_start_error": task["scheduled_start_error"],
        },
        "task_id": task_id,
    })
    return task


@router.get("/list")
async def list_tasks(
    pid: str = Query(..., alias="project_id"),
    wf: str | None = Query(None, alias="workflow_id"),
    archived: bool = Query(False, description="True lists only archived tasks; default hides them"),
):
    """List tasks for a project, optionally filtered by workflow/archive state."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    tasks = await _run_db(
        pid,
        lambda: task_service.list_tasks(workflow_id=wf, archived=archived),
    )
    return {"tasks": tasks}


@router.get("/{task_id}")
async def get_task(task_id: str, pid: str = Query(..., alias="project_id")):
    """Get a single task."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    task = await _run_db(pid, lambda: task_service.get_task(task_id))
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.get("/{task_id}/execution-report")
async def get_task_execution_report(
    task_id: str,
    pid: str = Query(..., alias="project_id"),
):
    """Return one task's execution rounds, timeline, usage, and milestones."""
    from services.task_execution_report import build_task_execution_report

    project = _project(pid)
    pricing = await asyncio.to_thread(config_store.get_model_pricing)
    report = await _run_db(
        pid,
        lambda: build_task_execution_report(
            task_id,
            pricing=pricing,
            project=project,
        ),
    )
    if report is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return report


@router.patch("/{task_id}")
async def update_task(
    task_id: str,
    req: UpdateTaskRequest,
    pid: str = Query(..., alias="project_id"),
):
    """Update editable task metadata while preserving its execution state."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    task = await _run_db(
        pid,
        lambda: task_service.update_task_description(
            task_id,
            req.description,
            req.review_overrides,
        ),
    )
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.get("/{task_id}/history")
async def get_task_history(
    task_id: str,
    pid: str = Query(..., alias="project_id"),
    limit: int = Query(50, ge=1, le=300),
    offset: int = Query(0, ge=0),
):
    """Get chat history (messages) for a task with pagination."""
    from main import task_service
    from main import project_manager
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    project = project_manager.get_project_by_id(pid) if project_manager else None
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    history = await _run_db(
        pid,
        lambda: task_service.get_task_history(
            task_id,
            limit=limit,
            offset=offset,
            workstep_dir=str(project.workstep_dir),
        ),
    )
    return {"messages": history, "limit": limit, "offset": offset}


@router.post("/{task_id}/chat")
async def chat_with_coordinator(
    task_id: str,
    req: CoordinatorChatRequest,
    pid: str = Query(..., alias="project_id"),
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
):
    """Queue one engine-backed coordinator turn without starting a workflow."""
    from main import coordinator_module
    if not coordinator_module:
        raise HTTPException(status_code=503, detail="Coordinator is not initialized")
    try:
        accepted = await coordinator_module.submit_message(
            pid,
            task_id,
            req.content,
            idempotency_key,
            pending_insert_ids=req.pending_insert_ids,
            reset_session=req.reset_session,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return accepted.to_dict()


@router.post("/{task_id}/coordinator/stop")
async def stop_coordinator(
    task_id: str,
    pid: str = Query(..., alias="project_id"),
):
    """Stop the currently running coordinator turn for a task."""
    from main import coordinator_module
    if not coordinator_module:
        raise HTTPException(status_code=503, detail="Coordinator is not initialized")
    try:
        stopped = await coordinator_module.stop_current(pid, task_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"stopped": stopped}


@router.get("/{task_id}/coordinator-config")
async def get_coordinator_config(
    task_id: str,
    pid: str = Query(..., alias="project_id"),
):
    from main import coordinator_module
    if not coordinator_module:
        raise HTTPException(status_code=503, detail="Coordinator is not initialized")
    try:
        return await coordinator_module.get_config(pid, task_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{task_id}/step/{step_key}/message")
async def send_step_message(
    task_id: str,
    step_key: str,
    req: StepMessageRequest,
    pid: str = Query(..., alias="project_id"),
):
    """Inject a user message into a running step or automatic review."""
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Workflow runtime not initialized")
    _project(pid)
    try:
        accepted = await workflow_runtime.send_step_message(
            pid,
            task_id,
            step_key,
            req.content,
            as_guidance=req.as_guidance,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return accepted


@router.get("/{task_id}/step/{step_key}/config")
async def get_step_execution_config(
    task_id: str,
    step_key: str,
    pid: str = Query(..., alias="project_id"),
):
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Workflow runtime not initialized")
    try:
        return await workflow_runtime.get_step_execution_config(pid, task_id, step_key)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.patch("/{task_id}/step/{step_key}/config")
async def update_step_execution_config(
    task_id: str,
    step_key: str,
    req: StepExecutionConfigRequest,
    pid: str = Query(..., alias="project_id"),
):
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Workflow runtime not initialized")
    try:
        return await workflow_runtime.update_step_execution_config(
            pid, task_id, step_key,
            engine=req.engine,
            model=req.model,
            config=req.config,
            context_mode=req.context_mode,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.delete("/{task_id}/step/{step_key}/config")
async def reset_step_execution_config(
    task_id: str,
    step_key: str,
    pid: str = Query(..., alias="project_id"),
):
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Workflow runtime not initialized")
    try:
        return await workflow_runtime.reset_step_execution_config(pid, task_id, step_key)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{task_id}/step/{step_key}/cancel")
async def cancel_step(
    task_id: str,
    step_key: str,
    pid: str = Query(..., alias="project_id"),
):
    """Stop a running step engine."""
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Workflow runtime not initialized")
    _project(pid)
    try:
        cancelled = await workflow_runtime.cancel_step(pid, task_id, step_key)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"cancelled": cancelled}


@router.post("/{task_id}/step/{step_key}/resume")
async def resume_step(
    task_id: str,
    step_key: str,
    req: StepResumeRequest,
    pid: str = Query(..., alias="project_id"),
):
    """Persist a user message and re-run a stopped or completed step."""
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Service not initialized")
    _project(pid)
    try:
        accepted = await workflow_runtime.resume_step_with_message(
            pid,
            task_id,
            step_key,
            req.content,
            reset_session=req.reset_step,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return accepted


@router.post("/{task_id}/step/{step_key}/restart")
async def restart_step_with_fresh_session(
    task_id: str,
    step_key: str,
    pid: str = Query(..., alias="project_id"),
):
    """Rebuild a lost engine session and re-run the step from scratch."""
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Service not initialized")
    _project(pid)
    try:
        accepted = await workflow_runtime.restart_step_with_fresh_session(
            pid,
            task_id,
            step_key,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return accepted


@router.post("/{task_id}/messages/{message_id}/retry")
async def retry_failed_message(
    task_id: str,
    message_id: str,
    pid: str = Query(..., alias="project_id"),
):
    """Restart the failed execution represented by this message."""
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Service not initialized")
    _project(pid)
    try:
        return await workflow_runtime.retry_failed_message(pid, task_id, message_id)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/{task_id}/messages/{message_id}/set-complete")
async def set_failed_execution_complete(
    task_id: str,
    message_id: str,
    req: FailedStepCompletionRequest,
    pid: str = Query(..., alias="project_id"),
):
    """Accept an existing artifact after a failed step execution."""
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Service not initialized")
    _project(pid)
    try:
        handle = await workflow_runtime.complete_failed_step(
            pid, task_id, message_id, req.artifact_round,
            schedule_downstream=req.schedule_downstream,
        )
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {
        "completed": True,
        "resumed": handle is not None,
        "run_id": handle.id if handle else None,
    }


@router.patch("/{task_id}/coordinator-config")
async def update_coordinator_config(
    task_id: str,
    req: CoordinatorConfigRequest,
    pid: str = Query(..., alias="project_id"),
):
    from main import coordinator_module
    if not coordinator_module:
        raise HTTPException(status_code=503, detail="Coordinator is not initialized")
    try:
        return await coordinator_module.update_config(
            pid,
            task_id,
            req.engine,
            req.model,
            req.fast_model,
            req.vision_model,
            req.thinking_effort,
            req.provider_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/{task_id}/actions/{proposal_id}/confirm")
async def confirm_coordinator_action(
    task_id: str,
    proposal_id: str,
    pid: str = Query(..., alias="project_id"),
    idempotency_key: str = Header(..., alias="Idempotency-Key"),
    overwrite: bool = Body(False, embed=True),
):
    from main import coordinator_module
    if not coordinator_module:
        raise HTTPException(status_code=503, detail="Coordinator is not initialized")
    try:
        return await coordinator_module.confirm_action(
            pid,
            task_id,
            proposal_id,
            idempotency_key,
            overwrite=overwrite,
        )
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/{task_id}/actions/{proposal_id}/cancel")
async def cancel_coordinator_action(
    task_id: str,
    proposal_id: str,
    pid: str = Query(..., alias="project_id"),
):
    from main import coordinator_module
    if not coordinator_module:
        raise HTTPException(status_code=503, detail="Coordinator is not initialized")
    try:
        return await coordinator_module.cancel_action(pid, task_id, proposal_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/{task_id}/artifacts")
async def get_task_artifacts(
    task_id: str,
    pid: str = Query(..., alias="project_id"),
):
    """List files produced for a task, enriched by step manifests."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    project = _project(pid)
    exists = await _run_db(pid, lambda: task_service.get_task(task_id))
    if not exists:
        raise HTTPException(status_code=404, detail="Task not found")
    artifacts, input_snapshots = await _run_db(
        pid,
        lambda: (
            list_task_artifacts(project, task_id),
            list_task_artifact_input_snapshots(task_id),
        ),
    )
    artifact_directory = Path(project.workstep_dir) / "artifacts" / (exists["workflow_id"] or "default") / task_id
    return {
        "artifacts": artifacts,
        "input_snapshots": input_snapshots,
        "artifact_directory": str(artifact_directory),
    }


@router.post("/run")
async def run_task(req: RunTaskRequest, pid: str = Query(..., alias="project_id")):
    """Run a task (fire-and-forget, events come via WebSocket)."""
    from main import workflow_runtime, task_service, event_bus, project_manager
    from services.remote_access import UserIdentityRequired
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        handle = await workflow_runtime.start(pid, req.task_id, req.prompt)
        if task_service and hasattr(task_service, "clear_scheduled_start"):
            await _run_db(
                pid,
                lambda: task_service.clear_scheduled_start(req.task_id),
            )
            await event_bus.publish({
                "type": "CUSTOM",
                "project_id": pid,
                "name": "workstep.scheduled_start",
                "value": {
                    "task_id": req.task_id,
                    "scheduled_start_at": None,
                    "scheduled_start_state": None,
                    "scheduled_start_error": None,
                },
                "task_id": req.task_id,
            })
    except UserIdentityRequired as exc:
        if project_manager.get_project_by_id(pid) is not None:
            from services.project_audit import record_project_audit

            await project_manager.run_db(
                pid,
                lambda _project: record_project_audit(
                    project_id=pid, task_id=req.task_id,
                    action="task.start", result="denied",
                    actor_type="system", metadata={"reason_code": "identity_required"},
                ),
            )
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except WorkflowValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {
        "status": "started",
        "task_id": req.task_id,
        "run_id": handle.id,
    }


class CancelTaskRequest(BaseSchema):
    task_id: str


@router.post("/cancel")
async def cancel_task(req: CancelTaskRequest, pid: str | None = Query(None, alias="project_id")):
    """Cancel a running task."""
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Service not initialized")
    if pid:
        _project(pid)
    cancelled = await workflow_runtime.cancel(req.task_id)
    return {"cancelled": cancelled}


class PauseTaskRequest(BaseSchema):
    task_id: str


@router.post("/pause")
async def pause_task(req: PauseTaskRequest, pid: str = Query(..., alias="project_id")):
    """Pause a running task."""
    from main import task_service, workflow_runtime
    if workflow_runtime and await workflow_runtime.cancel(req.task_id):
        return {"paused": True}
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    paused = await _run_db(
        pid, lambda: task_service._pause_task_sync(req.task_id, pid)
    )
    if not paused:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"paused": paused}


class DeleteTaskRequest(BaseSchema):
    task_id: str
    delete_workspace: bool | None = None


@router.delete("/delete")
async def delete_task(req: DeleteTaskRequest, pid: str = Query(..., alias="project_id")):
    """Delete a task."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    project = _project(pid)
    from models import Task
    task = await _run_db(pid, lambda: (
        {"workflow_id": found.workflow_id, "status": found.status}
        if (found := Task.get_or_none(Task.id == req.task_id)) else None
    ))
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if task["status"] == "running":
        raise HTTPException(status_code=409, detail="Running tasks cannot be deleted")
    workflow_id = task["workflow_id"]
    workspace_roots = [project.workstep_dir / "worktrees" / req.task_id]
    if workflow_id:
        workspace_roots.append(project.workstep_dir / "artifacts" / workflow_id / req.task_id / ".worktrees")
    has_workspace = await asyncio.to_thread(lambda: any(root.is_dir() and any(root.iterdir()) for root in workspace_roots))
    if has_workspace and req.delete_workspace is None:
        raise HTTPException(status_code=409, detail="请先在任务 Git 标签中移除 Worktree，再删除任务。")
    if has_workspace and req.delete_workspace:
        from api.git import git_service
        from services.git.command import GitError
        from services.git.task_workspace import TaskGitWorkspace

        workspace = TaskGitWorkspace(git_service, workflow_id)
        try:
            for _ in workspace_roots:
                if await asyncio.to_thread(lambda: any(root.is_dir() and any(root.iterdir()) for root in workspace_roots)):
                    result = await workspace.delete(project.path, req.task_id, force=True)
                    if result["outcome"] == "partial":
                        raise GitError("Git 工作区仅部分删除：" + result["failure"], 409)
        except GitError as exc:
            raise HTTPException(status_code=exc.status, detail=str(exc)) from exc
    try:
        deleted = await _run_db(
            pid,
            lambda: task_service.delete_task(req.task_id, pid),
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail="Task not found")
    from main import channel_bot_manager
    if channel_bot_manager is not None:
        await channel_bot_manager.remove_task_bindings(pid, req.task_id)
    if req.delete_workspace is not False:
        for workspace_root in workspace_roots:
            if await asyncio.to_thread(workspace_root.is_dir):
                try:
                    await asyncio.to_thread(workspace_root.rmdir)
                except OSError:
                    pass
    return {"deleted": deleted}


class CopyTaskRequest(BaseSchema):
    task_id: str
    newTitle: str


@router.post("/copy")
async def copy_task(req: CopyTaskRequest, pid: str = Query(..., alias="project_id")):
    """Copy a task with a new title."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    copied = await _run_db(
        pid,
        lambda: task_service.copy_task(
            req.task_id,
            req.newTitle,
            pid,
            creator_fields=current_actor_task_fields(),
        ),
    )
    if not copied:
        raise HTTPException(status_code=404, detail="Task not found")
    return copied
