"""Task API routes — all endpoints require project_id."""

import asyncio
import json
import os
import uuid

from fastapi import APIRouter, Header, HTTPException, Query

from schemas.base import BaseSchema
from schemas.task import (
    CreateTaskRequest,
    CoordinatorChatRequest,
    CoordinatorConfigRequest,
    ReviewDecisionRequest,
    RunTaskRequest,
    ScheduledStartRequest,
    StageMessageRequest,
    StageResumeRequest,
    UpdateTaskRequest,
)
from services.config import DEFAULT_EXECUTION_ENGINE, config_store
from services.workflow_definition import WorkflowValidationError
from services.task_creation import create_project_task
from services.artifacts import list_task_artifacts

router = APIRouter(prefix="/api/task")


def _project(project_id: str):
    """Resolve project metadata without touching its SQLite connection."""
    from main import project_manager
    if not project_manager:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        project = project_manager.get_project_by_id(project_id)
        if project is None:
            raise ValueError(f"Project not found: {project_id}")
        return project
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


async def _run_db(project_id: str, operation):
    """Run task persistence on the selected project's DB executor."""
    from main import project_manager

    run_db = getattr(project_manager, "run_db", None)
    if run_db is not None:
        return await run_db(project_id, lambda _project: operation())
    def execute():
        with project_manager.activate_project_by_id(project_id):
            return operation()

    return await asyncio.to_thread(execute)


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
                or config_store.get_execution_default_engine()
                or DEFAULT_EXECUTION_ENGINE
            ),
            start_step_key=req.start_step_key,
            review_overrides=req.review_overrides,
            workflow_id=req.workflow_id,
            execution_mode=mode,
            scheduled_start_at=req.scheduled_start_at,
        )
        return result.task
    except WorkflowValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
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
    limit: int = Query(50, ge=1, le=200),
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
async def send_stage_message(
    task_id: str,
    step_key: str,
    req: StageMessageRequest,
    pid: str = Query(..., alias="project_id"),
):
    """Inject an ordinary user message into a running stage execution."""
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Workflow runtime not initialized")
    _project(pid)
    try:
        accepted = await workflow_runtime.send_stage_message(
            pid,
            task_id,
            step_key,
            req.content,
            as_guidance=req.as_guidance,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return accepted


@router.post("/{task_id}/step/{step_key}/cancel")
async def cancel_stage(
    task_id: str,
    step_key: str,
    pid: str = Query(..., alias="project_id"),
):
    """Stop a running stage engine."""
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
async def resume_stage(
    task_id: str,
    step_key: str,
    req: StageResumeRequest,
    pid: str = Query(..., alias="project_id"),
):
    """Persist a user message and re-run a manually stopped stage."""
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Service not initialized")
    _project(pid)
    try:
        accepted = await workflow_runtime.resume_stage_with_message(
            pid,
            task_id,
            step_key,
            req.content,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return accepted


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
        )
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
    """List files produced for a task, enriched by stage manifests."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    project = _project(pid)
    exists = await _run_db(pid, lambda: task_service.get_task(task_id))
    if not exists:
        raise HTTPException(status_code=404, detail="Task not found")
    artifacts = await _run_db(
        pid, lambda: list_task_artifacts(project, task_id)
    )
    return {"artifacts": artifacts}


@router.get("/{task_id}/reviews")
async def get_task_reviews(
    task_id: str,
    pid: str = Query(..., alias="project_id"),
):
    """Return persisted review history for a task."""
    from models import ReviewRun
    def load_reviews():
        rows = (
            ReviewRun.select()
            .where(ReviewRun.task == task_id)
            .order_by(ReviewRun.started_at.desc(), ReviewRun.id.desc())
        )
        return [{
            "id": row.id,
            "workflow_run_id": row.workflow_run_id,
            "step_run_id": row.step_run_id,
            "step_key": row.step_key,
            "mode": row.mode,
            "status": row.status,
            "engine": row.engine,
            "model": row.model,
            "report": json.loads(row.report_json) if row.report_json else None,
            "decision": row.decision,
            "decision_comment": row.decision_comment,
            "started_at": row.started_at,
            "ended_at": row.ended_at,
        } for row in rows]

    return {"reviews": await _run_db(pid, load_reviews)}


async def _decide_review(
    task_id: str,
    step_key: str,
    req: ReviewDecisionRequest,
    project_id: str,
    decision: str,
):
    from main import workflow_runtime
    if not workflow_runtime:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        handle = await workflow_runtime.decide_review(
            project_id, task_id, step_key, req.review_run_id, decision, req.comment
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {
        "decision": decision,
        "resumed": handle is not None,
        "run_id": handle.id if handle else None,
    }


@router.post("/{task_id}/steps/{step_key}/review/approve")
async def approve_review(
    task_id: str,
    step_key: str,
    req: ReviewDecisionRequest,
    pid: str = Query(..., alias="project_id"),
):
    return await _decide_review(task_id, step_key, req, pid, "approve")


@router.post("/{task_id}/steps/{step_key}/review/reject")
async def reject_review(
    task_id: str,
    step_key: str,
    req: ReviewDecisionRequest,
    pid: str = Query(..., alias="project_id"),
):
    return await _decide_review(task_id, step_key, req, pid, "reject")


@router.post("/{task_id}/steps/{step_key}/review/force-approve")
async def force_approve_review(
    task_id: str,
    step_key: str,
    req: ReviewDecisionRequest,
    pid: str = Query(..., alias="project_id"),
):
    return await _decide_review(task_id, step_key, req, pid, "force_approve")


@router.post("/run")
async def run_task(req: RunTaskRequest, pid: str = Query(..., alias="project_id")):
    """Run a task (fire-and-forget, events come via WebSocket)."""
    from main import workflow_runtime, task_service, event_bus
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
                "name": "workstep.scheduled_start",
                "value": {
                    "task_id": req.task_id,
                    "scheduled_start_at": None,
                    "scheduled_start_state": None,
                    "scheduled_start_error": None,
                },
                "task_id": req.task_id,
            })
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
        pid, lambda: task_service._pause_task_sync(req.task_id)
    )
    if not paused:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"paused": paused}


class DeleteTaskRequest(BaseSchema):
    task_id: str


@router.delete("/delete")
async def delete_task(req: DeleteTaskRequest, pid: str = Query(..., alias="project_id")):
    """Delete a task."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        deleted = await _run_db(
            pid,
            lambda: task_service.delete_task(req.task_id, pid),
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"deleted": deleted}


class ArchiveTaskRequest(BaseSchema):
    task_id: str


class ConfirmArchiveExperienceRequest(BaseSchema):
    experience: str


def _normalize_archive_experience(experience: str) -> tuple[str, bool]:
    normalized = experience.strip()
    compact = normalized.lstrip("-•* ").rstrip("。.!！ ")
    if compact in {
        "未发现值得记录的错误经验",
        "未发现值得提炼的错误经验",
        "未发现值得提炼的内容",
    }:
        return "", False
    return normalized, bool(normalized)


def _load_archive_experience_draft(task_id: str, workstep_dir=None):
    from models import Message

    message = (
        Message.select()
        .where(
            (Message.task == task_id)
            & (Message.channel == "archive_experience")
            & (Message.run_status == "succeeded")
        )
        .order_by(Message.sequence.desc(), Message.created_at.desc())
        .first()
    )
    if message is None:
        return None
    summary = json.loads(message.event_summary_json or "{}")
    events = []
    if workstep_dir is not None and message.event_log_path:
        from agent_assistants.event_journal import TurnEventJournal
        from services.history import translate_events

        journal = TurnEventJournal()
        ref = journal.reopen(workstep_dir, message.event_log_path)
        timeline = journal.timeline(ref, limit=200)
        events = translate_events(
            timeline["events"],
            task_id=task_id,
            step_key=message.step_key,
            message_id=message.id,
            channel=message.channel,
            engine=message.engine,
            model=message.model,
        )
    prompt = ""
    if message.prompt_json:
        prompt = str(json.loads(message.prompt_json).get("prompt") or "")
    return {
        "found": True,
        "message_id": message.id,
        "experience": message.content or "",
        "has_experience": bool(summary.get("has_experience", message.content.strip())),
        "events": events,
        "prompt": prompt,
    }


@router.get("/{task_id}/archive-experience/draft")
async def get_archive_experience_draft(
    task_id: str,
    pid: str = Query(..., alias="project_id"),
):
    """Return the last generated draft so reopening does not call the LLM again."""
    from main import project_manager
    from models import Task

    project = project_manager.get_project_by_id(pid)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    def load():
        if Task.get_or_none(Task.id == task_id) is None:
            raise ValueError("Task not found")
        return _load_archive_experience_draft(task_id, project.workstep_dir)

    try:
        draft = await _run_db(pid, load)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return draft or {
        "found": False,
        "message_id": None,
        "experience": "",
        "has_experience": False,
        "events": [],
        "prompt": "",
    }


@router.post("/archive")
async def archive_task(req: ArchiveTaskRequest, pid: str = Query(..., alias="project_id")):
    """Archive a task so it disappears from the active board."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        archived = await _run_db(
            pid,
            lambda: task_service.archive_task(req.task_id),
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not archived:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"archived": archived}


@router.post("/{task_id}/archive-experience/prepare")
async def prepare_archive_experience(
    task_id: str,
    pid: str = Query(..., alias="project_id"),
    message_id: str | None = Query(None),
):
    """Generate and cache an experience draft without writing project Memory."""
    from agent_assistants.coordinator import ArchiveExperienceStopped
    from main import coordinator_module

    if not coordinator_module:
        raise HTTPException(status_code=503, detail="Coordinator is not initialized")
    try:
        progress_message_id = message_id or str(uuid.uuid4())
        raw_experience = await coordinator_module.draft_archive_experience(
            pid,
            task_id,
            progress_message_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ArchiveExperienceStopped as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    experience, has_experience = _normalize_archive_experience(raw_experience)
    journal = coordinator_module.take_archive_experience_journal(
        pid,
        task_id,
        progress_message_id,
    )

    def persist_draft():
        from models import Message, Task
        from models.fields import utc_now
        from services.messages import create_task_message

        task = Task.get_or_none(Task.id == task_id)
        if task is None:
            raise ValueError("Task not found")
        journal_snapshot = journal["snapshot"] if journal is not None else None
        summary = {"has_experience": has_experience}
        if journal_snapshot is not None:
            summary.update(journal_snapshot["summary"])
        existing = Message.get_or_none(Message.id == progress_message_id)
        if existing is not None:
            existing.content = experience
            existing.run_status = "succeeded"
            existing.event_summary_json = json.dumps(summary)
            if journal is not None:
                existing.engine = journal["engine"]
                existing.model = journal["model"]
                existing.prompt_json = json.dumps({"prompt": journal["prompt"]}, ensure_ascii=False)
                existing.event_log_path = journal["event_log_path"]
                existing.events_json = json.dumps(journal_snapshot["events"], ensure_ascii=False)
                existing.event_count = journal_snapshot["summary"]["event_count"]
                existing.last_event_seq = journal_snapshot["summary"]["last_event_seq"]
            existing.save()
            return
        now = utc_now()
        create_task_message(
            id=progress_message_id,
            task=task,
            channel="archive_experience",
            step_key="archive",
            role="assistant",
            content=experience,
            run_id=progress_message_id,
            run_status="succeeded",
            engine=journal["engine"] if journal is not None else None,
            model=journal["model"] if journal is not None else None,
            prompt_json=(
                json.dumps({"prompt": journal["prompt"]}, ensure_ascii=False)
                if journal is not None else None
            ),
            event_log_path=journal["event_log_path"] if journal is not None else None,
            events_json=(
                json.dumps(journal_snapshot["events"], ensure_ascii=False)
                if journal_snapshot is not None else None
            ),
            event_summary_json=json.dumps(summary),
            event_count=(journal_snapshot["summary"]["event_count"] if journal_snapshot else 0),
            last_event_seq=(journal_snapshot["summary"]["last_event_seq"] if journal_snapshot else 0),
            position=1,
            started_at=now,
            ended_at=now,
            created_at=now,
        )

    try:
        await _run_db(pid, persist_draft)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {
        "message_id": progress_message_id,
        "experience": experience,
        "has_experience": has_experience,
        "cached": False,
    }


@router.post("/{task_id}/archive-experience/stop")
async def stop_archive_experience(
    task_id: str,
    pid: str = Query(..., alias="project_id"),
    message_id: str = Query(...),
):
    """Stop an in-flight archive experience draft."""
    from main import coordinator_module

    if not coordinator_module:
        raise HTTPException(status_code=503, detail="Coordinator is not initialized")
    stopped = await coordinator_module.stop_archive_experience(
        pid,
        task_id,
        message_id,
    )
    return {"stopped": stopped}


@router.post("/{task_id}/archive-experience/confirm")
async def confirm_archive_experience(
    task_id: str,
    req: ConfirmArchiveExperienceRequest,
    pid: str = Query(..., alias="project_id"),
):
    """Append the reviewed experience to project memory, then archive the task."""
    from main import project_manager, task_service
    from models import Task

    if not project_manager or not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    experience = req.experience.strip()
    if not experience:
        draft = await _run_db(pid, lambda: _load_archive_experience_draft(task_id))
        if draft is None or draft["has_experience"]:
            raise HTTPException(status_code=422, detail="Experience cannot be empty")
        try:
            archived = await _run_db(pid, lambda: task_service.archive_task(task_id))
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if not archived:
            raise HTTPException(status_code=404, detail="Task not found")
        return {"archived": True, "memory_saved": False}
    if len(experience) > 800:
        raise HTTPException(status_code=422, detail="Experience exceeds 800 characters")
    project = _project(pid)

    def persist_and_archive():
        task = Task.get_or_none(Task.id == task_id)
        if task is None:
            raise ValueError("Task not found")
        if task.archived:
            raise RuntimeError("Task is already archived")
        if task.status == "running":
            raise RuntimeError("Running tasks cannot be archived")

        memory_path = project.workstep_dir / "MEMORY.md"
        previous = memory_path.read_bytes() if memory_path.is_file() else None
        existing = previous.decode("utf-8") if previous is not None else ""
        separator = "\n\n" if existing.rstrip() else ""
        content = (
            f"{existing.rstrip()}{separator}"
            f"## 错误经验：{task.title}\n\n{experience}\n"
        )
        if len(content.encode("utf-8")) > 500_000:
            raise OverflowError("Memory content exceeds 500KB")

        memory_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = memory_path.with_name(
            f".{memory_path.name}.{uuid.uuid4().hex}.tmp"
        )
        try:
            temporary.write_text(content, encoding="utf-8")
            os.replace(temporary, memory_path)
            archived = task_service.archive_task(task_id)
            if not archived:
                raise ValueError("Task not found")
        except Exception:
            if temporary.exists():
                temporary.unlink()
            if previous is None:
                memory_path.unlink(missing_ok=True)
            else:
                memory_path.write_bytes(previous)
            raise
        return archived

    try:
        archived = await _run_db(pid, persist_and_archive)
    except OverflowError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"archived": archived, "memory_saved": True}


@router.post("/unarchive")
async def unarchive_task(req: ArchiveTaskRequest, pid: str = Query(..., alias="project_id")):
    """Restore an archived task back to the active board."""
    from main import task_service
    if not task_service:
        raise HTTPException(status_code=503, detail="Service not initialized")
    try:
        unarchived = await _run_db(
            pid,
            lambda: task_service.unarchive_task(req.task_id),
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not unarchived:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"unarchived": unarchived}


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
        lambda: task_service.copy_task(req.task_id, req.newTitle, pid),
    )
    if not copied:
        raise HTTPException(status_code=404, detail="Task not found")
    return copied
