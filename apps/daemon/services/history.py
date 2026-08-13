"""History replay — reconstruct past executions from stored events."""

import json
import logging

from engines.core.agui import AGUIContext, to_agui_events
from engines.core.events import map_legacy_event
from models.message import Message
from models.task import Task

logger = logging.getLogger(__name__)


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
            else event.get("sequence")
        )
        ctx.timestamp = event.get("timestamp")
        ctx.created_at = event.get("created_at")
        result.extend(to_agui_events(mapped, ctx))
    return result


def get_task_history(task_id: str) -> list[dict]:
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


def get_step_history(task_id: str, step_key: str) -> list[dict]:
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


def replay_events(events: list[dict]):
    """Generator that yields events in order for frontend replay.

    Useful for SSE/WS streaming of historical events.
    """
    for event in events:
        yield event
