"""Task archiving and archive experience API routes."""

import json
import os
import uuid

from fastapi import APIRouter, HTTPException, Query

from api.task_context import _project, _require_scoped_task, _run_db
from schemas.base import BaseSchema

router = APIRouter(prefix="/api/task")


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
        timeline = journal.timeline(ref, limit=30000)
        events = translate_events(
            timeline["events"],
            task_id=task_id,
            step_key=message.step_key,
            message_id=message.id,
            channel=message.channel,
            engine=message.engine,
            model=message.model,
        )
    from agent_assistants.prompt_input import get_prompt_view
    stored = json.loads(message.prompt_json or "{}")
    prompt = get_prompt_view(workstep_dir, message.id) or stored.get("prompt") or ""
    return {
        "found": True,
        "message_id": message.id,
        "experience": message.content or "",
        "has_experience": bool(summary.get("has_experience", message.content.strip())),
        "events": events,
        "prompt": prompt,
    }


def _archive_draft_message(task_id: str, message_id: str):
    """Validate a supplied draft ID inside the project's database executor."""
    from models import Message, Task

    if not Task.select().where(Task.id == task_id).exists():
        raise ValueError("Task not found")
    message = Message.get_or_none(Message.id == message_id)
    if message is not None and (
        message.task_id != task_id or message.channel != "archive_experience"
        or message.role != "assistant"
    ):
        raise ValueError("Archive draft not found")
    return message


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
    await _require_scoped_task(pid, task_id)

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
    await _require_scoped_task(pid, req.task_id)
    try:
        archived = await _run_db(
            pid,
            lambda: task_service.archive_task(req.task_id, pid),
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
    await _require_scoped_task(pid, task_id)
    try:
        progress_message_id = message_id or str(uuid.uuid4())

        def validate_and_snapshot():
            from services.messages import current_actor_message_fields

            _archive_draft_message(task_id, progress_message_id)
            actor = current_actor_message_fields()
            return {key: actor[key] for key in (
                "initiated_by_user_id", "initiated_by_username",
                "author_device_id", "author_device_name",
            ) if actor.get(key)}

        initiator_fields = await _run_db(pid, validate_and_snapshot)
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
        existing = _archive_draft_message(task_id, progress_message_id)
        if existing is not None:
            existing.content = experience
            existing.run_status = "succeeded"
            existing.event_summary_json = json.dumps(summary)
            if journal is not None:
                existing.engine = journal["engine"]
                existing.model = journal["model"]
                existing.prompt_json = json.dumps({"prompt": journal.get("prompt")}, ensure_ascii=False)
                existing.event_log_path = journal["event_log_path"]
                existing.events_json = json.dumps(journal_snapshot["events"], ensure_ascii=False)
                existing.event_count = journal_snapshot["summary"]["event_count"]
                existing.last_event_seq = journal_snapshot["summary"]["last_event_seq"]
            engine = existing.engine or "assistant"
            existing.author_id = engine
            existing.author_username = engine
            existing.author_name = engine
            existing.author_type = "assistant"
            for key, value in initiator_fields.items():
                setattr(existing, key, value)
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
            prompt_json=json.dumps({"prompt": journal.get("prompt")}, ensure_ascii=False) if journal else None,
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
            **initiator_fields,
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
    await _require_scoped_task(pid, task_id)
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
    await _require_scoped_task(pid, task_id)
    experience = req.experience.strip()
    if not experience:
        draft = await _run_db(pid, lambda: _load_archive_experience_draft(task_id))
        if draft is None or draft["has_experience"]:
            raise HTTPException(status_code=422, detail="Experience cannot be empty")
        try:
            archived = await _run_db(pid, lambda: task_service.archive_task(task_id, pid))
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
            archived = task_service.archive_task(task_id, pid)
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
    await _require_scoped_task(pid, req.task_id)
    try:
        unarchived = await _run_db(
            pid,
            lambda: task_service.unarchive_task(req.task_id, pid),
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not unarchived:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"unarchived": unarchived}
