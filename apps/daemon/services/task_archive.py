"""Archive experience database work units; callers must use the project executor."""

import json
import os
import uuid


def normalize_archive_experience(experience: str) -> tuple[str, bool]:
    normalized = experience.strip()
    compact = normalized.lstrip("-•* ").rstrip("。.!！ ")
    if compact in {
        "未发现值得记录的错误经验",
        "未发现值得提炼的错误经验",
        "未发现值得提炼的内容",
    }:
        return "", False
    return normalized, bool(normalized)


def load_archive_experience_draft(task_id: str, workstep_dir=None):
    from models import Message, Task

    if not Task.select().where(Task.id == task_id).exists():
        raise ValueError("Task not found")
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


def snapshot_archive_initiator(task_id: str, progress_message_id: str):
    from services.messages import current_actor_message_fields

    _archive_draft_message(task_id, progress_message_id)
    actor = current_actor_message_fields()
    return {key: actor[key] for key in (
        "initiated_by_user_id", "initiated_by_username",
        "author_device_id", "author_device_name",
    ) if actor.get(key)}


def persist_archive_draft(
    task_id, progress_message_id, experience, has_experience, journal, initiator_fields,
):
    from models import Task
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


def persist_experience_and_archive(project, task_service, pid, task_id, experience):
    from models import Task

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
