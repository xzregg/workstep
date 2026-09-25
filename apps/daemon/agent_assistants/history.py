"""Assistant event retention and history message normalization."""

import uuid
from datetime import datetime, timezone
from typing import Any

from engines.core.events import is_commentary


_PERSISTED_EVENT_TYPES = frozenset({
    "async_question",
    "status",
    "agent_thought_chunk",
    "tool_call",
    "tool_call_update",
    "interaction_request",
    "interaction_response",
    "plan",
    "plan_update",
    "plan_removed",
    "subagent",
    "compacted",
    "goal_update",
    "usage_update",
    "session_started",
    "error",
    "engine_state",
    "a2ui",
    "acp_raw",
    "elicitation_completed",
    "flow_proposals",
    "flow_proposals_rejected",
})


def _prune_events(events: list[dict]) -> list[dict]:
    """Keep replayable engine events; drop per-character text deltas."""
    return [
        event
        for event in events
        if isinstance(event, dict) and (
            event.get("type") in _PERSISTED_EVENT_TYPES or is_commentary(event)
        )
    ]


def default_history_message(item: dict) -> dict:
    """Normalize one stored message for the history API."""
    item = repair_message_times(item)
    events = []
    for event in item.get("events") or []:
        if not isinstance(event, dict):
            continue
        normalized = {
            "type": event.get("type"),
            "data": event.get("data") or {},
        }
        timestamp = event.get("timestamp") or event.get("created_at")
        if timestamp is not None:
            normalized["timestamp"] = timestamp
        events.append(normalized)
    return {
        "id": item.get("id") or str(uuid.uuid4()),
        "role": item.get("role", "assistant"),
        "content": item.get("content", ""),
        "status": (
            item.get("status")
            if item.get("status") in ("running", "error", "stopped")
            else "succeeded"
        ),
        "engine": item.get("engine"),
        "model": item.get("model"),
        "created_at": item.get("created_at"),
        "ended_at": item.get("ended_at"),
        "prompt": item.get("prompt"),
        "events": events,
        "author_id": item.get("author_id"),
        "author_name": item.get("author_name"),
        "author_device_id": item.get("author_device_id"),
        "author_device_name": item.get("author_device_name"),
        "event_summary": item.get("event_summary") or {},
        "event_detail": item.get("event_detail") or {"available": False},
        "event_log_path": item.get("event_log_path"),
    }


def _event_time_ms(value: Any) -> int | None:
    """Event/message timestamp → epoch milliseconds (int/float 秒或毫秒、ISO 字符串)."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return int(number) if number >= 1_000_000_000_000 else int(number * 1000)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            return None
        return int(parsed.timestamp() * 1000)
    return None


def _iso_from_ms(value: int) -> str:
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat()


def repair_message_times(item: dict) -> dict:
    """旧数据回补：早期成功回合只写了 ``created_at``（完成时刻）、没有 ``ended_at``。

    只有缺少 ``ended_at`` 且事件带时间戳时才修正：
    - 若 ``created_at`` 不早于最后一条事件（说明 created_at 记的是完成时刻），
      起点取最早事件时间、终点取原 ``created_at``；
    - 否则终点取最后一条事件时间。
    """
    created_at = item.get("created_at")
    if item.get("ended_at") or not created_at:
        return item
    event_times = []
    for event in item.get("events") or []:
        if not isinstance(event, dict):
            continue
        event_ms = _event_time_ms(
            event.get("timestamp") or event.get("created_at")
        )
        if event_ms is not None:
            event_times.append(event_ms)
    if not event_times:
        return item
    created_ms = _event_time_ms(created_at)
    if created_ms is None:
        return item
    if created_ms > min(event_times) and created_ms >= max(event_times):
        # 旧数据：created_at 是完成时刻 → 起点取最早事件，终点取原 created_at。
        return {
            **item,
            "created_at": _iso_from_ms(min(event_times)),
            "ended_at": created_at,
        }
    # 新数据只缺 ended_at：终点取最后事件时间。
    return {**item, "ended_at": _iso_from_ms(max(event_times))}
