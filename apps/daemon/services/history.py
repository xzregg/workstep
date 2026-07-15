"""History replay — reconstruct past executions from stored events."""

import json
import logging

from models.message import Message
from models.task import Task

logger = logging.getLogger(__name__)


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
            "usage": None,
        }

        # Parse events_json
        if msg.events_json:
            try:
                entry["events"] = json.loads(msg.events_json)
            except json.JSONDecodeError:
                logger.warning("Invalid events_json for message %s", msg.id)

        # Parse usage_json
        if msg.usage_json:
            try:
                entry["usage"] = json.loads(msg.usage_json)
            except json.JSONDecodeError:
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
        }
        if msg.events_json:
            try:
                entry["events"] = json.loads(msg.events_json)
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
