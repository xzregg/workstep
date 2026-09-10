"""History replay — reconstruct past executions from stored events."""

import json
import logging
from pathlib import Path

from agent_assistants.event_journal import TurnEventJournal
from engines.core.agui import AGUIContext, to_agui_events
from engines.core.events import map_legacy_event
from models.message import Message
from models.task import Task

logger = logging.getLogger(__name__)
_event_journal = TurnEventJournal()


def event_detail(msg: Message) -> dict | None:
    if not msg.event_log_path:
        return None
    try:
        summary = json.loads(msg.event_summary_json or "{}")
    except json.JSONDecodeError:
        summary = {}
    return {
        "available": True,
        "loaded": False,
        "event_count": msg.event_count or 0,
        "last_event_seq": msg.last_event_seq or 0,
        **summary,
    }


def translate_events(
    events: list[dict],
    *,
    task_id: str | None = None,
    step_key: str | None = None,
    message_id: str | None = None,
    channel: str | None = None,
    engine: str | None = None,
    model: str | None = None,
) -> list[dict]:
    """历史回放统一读路径：旧词汇 → 新词汇 → AG-UI 翻译。

    与实时 WebSocket 推送共用 ``engines/core/agui.py`` 翻译层，保证前端
    store 只消费 AG-UI。
    """
    ctx = AGUIContext(
        task_id=task_id,
        step_key=step_key,
        message_id=message_id,
        channel=channel,
        engine=engine,
        model=model,
    )
    result: list[dict] = []
    for event in events:
        if not isinstance(event, dict):
            continue
        mapped = map_legacy_event(event)
        ctx.event_sequence = (
            event.get("event_sequence")
            if event.get("event_sequence") is not None
            else event.get("sequence", event.get("seq"))
        )
        ctx.timestamp = event.get("timestamp")
        ctx.created_at = event.get("created_at")
        result.extend(to_agui_events(mapped, ctx))
    return result


def restore_running_projection(
    entry: dict,
    msg: Message,
    workstep_dir: str | Path | None,
) -> None:
    if msg.run_status != "running" or not msg.event_log_path or workstep_dir is None:
        return
    try:
        ref = _event_journal.reopen(workstep_dir, msg.event_log_path)
        snapshot = _event_journal.snapshot(ref)
    except Exception:
        logger.exception("Failed to restore running task message %s", msg.id)
        return
    entry["content"] = snapshot["content"]
    entry["events"] = translate_events(
        snapshot["events"],
        task_id=str(msg.task_id),
        step_key=msg.step_key,
        message_id=msg.id,
        channel=msg.channel,
        engine=msg.engine,
        model=msg.model,
    )
    entry["event_detail"] = {
        "available": True,
        "loaded": False,
        **snapshot["summary"],
    }


def get_task_history(
    task_id: str,
    workstep_dir: str | Path | None = None,
) -> list[dict]:
    """Get all messages for a task with their events, ordered by position.

    Returns a list of message dicts with parsed events for replay.
    """
    messages = (
        Message.select()
        .where(Message.task == task_id)
        .order_by(Message.position)
    )

    result = []
    for msg in messages:
        entry = {
            "id": msg.id,
            "step_key": msg.step_key,
            "role": msg.role,
            "content": msg.content,
            "engine": msg.engine,
            "model": msg.model,
            "run_id": msg.run_id,
            "run_status": msg.run_status,
            "position": msg.position,
            "started_at": msg.started_at,
            "ended_at": msg.ended_at,
            "events": [],
            "prompt": None,
            "usage": None,
        }

        # Parse events_json → AG-UI（旧词汇经兼容映射）
        raw_events: list[dict] = []
        if msg.events_json:
            try:
                raw_events = json.loads(msg.events_json)
            except json.JSONDecodeError:
                logger.warning("Invalid events_json for message %s", msg.id)
        entry["events"] = translate_events(
            raw_events,
            task_id=task_id,
            step_key=msg.step_key,
            message_id=msg.id,
            channel=msg.channel,
            engine=msg.engine,
            model=msg.model,
        )
        detail = event_detail(msg)
        if detail is not None:
            entry["event_detail"] = detail
        restore_running_projection(entry, msg, workstep_dir)

        # Parse usage_json
        if msg.usage_json:
            try:
                entry["usage"] = json.loads(msg.usage_json)
            except json.JSONDecodeError:
                pass

        if msg.prompt_json:
            try:
                entry["prompt"] = json.loads(msg.prompt_json).get("prompt")
            except (json.JSONDecodeError, AttributeError):
                pass

        result.append(entry)

    return result


def get_step_history(
    task_id: str,
    step_key: str,
    workstep_dir: str | Path | None = None,
) -> list[dict]:
    """Get messages for a specific step within a task."""
    messages = (
        Message.select()
        .where(
            (Message.task == task_id) &
            (Message.step_key == step_key)
        )
        .order_by(Message.position)
    )

    result = []
    for msg in messages:
        entry = {
            "id": msg.id,
            "role": msg.role,
            "content": msg.content,
            "run_status": msg.run_status,
            "events": [],
            "prompt": None,
            "usage": None,
        }
        if msg.events_json:
            try:
                raw_events = json.loads(msg.events_json)
            except json.JSONDecodeError:
                raw_events = []
            entry["events"] = translate_events(
                raw_events,
                task_id=task_id,
                step_key=step_key,
                message_id=msg.id,
                channel=msg.channel,
                engine=msg.engine,
                model=msg.model,
            )
        detail = event_detail(msg)
        if detail is not None:
            entry["event_detail"] = detail
        restore_running_projection(entry, msg, workstep_dir)
        if msg.prompt_json:
            try:
                entry["prompt"] = json.loads(msg.prompt_json).get("prompt")
            except (json.JSONDecodeError, AttributeError):
                pass
        if msg.usage_json:
            try:
                entry["usage"] = json.loads(msg.usage_json)
            except json.JSONDecodeError:
                pass
        result.append(entry)

    return result


def get_message_events(
    task_id: str,
    message_id: str,
    workstep_dir: str | Path,
    *,
    cursor: int = 0,
    limit: int = 30000,
) -> dict:
    """Read one task message's detailed timeline without loading it in history."""
    msg = Message.get_or_none(
        (Message.id == message_id) & (Message.task == task_id)
    )
    if msg is None:
        raise ValueError("Task message not found")
    if msg.event_log_path:
        ref = _event_journal.reopen(workstep_dir, msg.event_log_path)
        page = _event_journal.timeline(ref, cursor=cursor, limit=limit)
        page["events"] = translate_events(
            page["events"],
            task_id=task_id,
            step_key=msg.step_key,
            message_id=msg.id,
            channel=msg.channel,
            engine=msg.engine,
            model=msg.model,
        )
        return {"message_id": message_id, **page}

    try:
        legacy = json.loads(msg.events_json or "[]")
    except json.JSONDecodeError:
        legacy = []
    start = max(0, cursor)
    bounded = min(max(1, limit), 30000)
    raw_events = legacy[start:start + bounded]
    next_cursor = start + len(raw_events)
    return {
        "message_id": message_id,
        "events": translate_events(
            raw_events,
            task_id=task_id,
            step_key=msg.step_key,
            message_id=msg.id,
            channel=msg.channel,
            engine=msg.engine,
            model=msg.model,
        ),
        "event_count": len(legacy),
        "last_event_seq": next_cursor,
        "next_cursor": next_cursor if next_cursor < len(legacy) else None,
        "complete": next_cursor >= len(legacy),
    }


def replay_events(events: list[dict]):
    """Generator that yields events in order for frontend replay.

    Useful for SSE/WS streaming of historical events.
    """
    for event in events:
        yield event
