"""ACP stable execution-plan snapshots shared by engine adapters."""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from typing import Any

from engines.core.events import InternalEvent

_PRIORITIES = {"high", "medium", "low"}
_STATUSES = {
    "pending": "pending",
    "in_progress": "in_progress",
    "inprogress": "in_progress",
    "running": "in_progress",
    "paused": "in_progress",
    "blocked": "pending",
    "completed": "completed",
    "done": "completed",
    "cancelled": "completed",
    "canceled": "completed",
}


def normalize_plan_status(raw: Any) -> str:
    """Project a provider-specific plan status onto ACP stable values.

    ACP ``PlanEntry.status`` only has ``pending`` / ``in_progress`` /
    ``completed``; harness-style extras collapse safely: ``blocked`` reads as
    ``pending`` (it cannot start yet) and ``cancelled`` reads as ``completed``
    (terminal). Unknown values fall back to ``pending``.
    """
    return _STATUSES.get(str(raw or "pending").replace("-", "_").lower(), "pending")


def normalize_plan_entries(
    entries: Iterable[Mapping[str, Any]],
) -> list[dict[str, str]]:
    """Project provider-specific plan entries onto ACP v1 stable fields."""
    normalized: list[dict[str, str]] = []
    for entry in entries:
        content = str(
            entry.get("content")
            or entry.get("description")
            or entry.get("step")
            or entry.get("subject")
            or entry.get("prompt")
            or ""
        ).strip()
        if not content:
            continue
        raw_priority = str(entry.get("priority") or "medium").lower()
        normalized_entry = {
            "content": content,
            "priority": raw_priority if raw_priority in _PRIORITIES else "medium",
            "status": normalize_plan_status(entry.get("status")),
        }
        detail = str(entry.get("detail") or entry.get("details") or "").strip()
        subject = str(entry.get("subject") or "").strip()
        description = str(entry.get("description") or "").strip()
        if not detail and subject and description and description != content:
            detail = description
        if detail and detail != content:
            normalized_entry["detail"] = detail
        normalized.append(normalized_entry)
    return normalized


def plan_event(
    entries: Iterable[Mapping[str, Any]],
    *,
    explanation: str | None = None,
) -> InternalEvent:
    """Build an ``InternalEvent`` with ACP stable Plan snapshot semantics."""
    data: dict[str, Any] = {"entries": normalize_plan_entries(entries)}
    if explanation:
        data["explanation"] = str(explanation)
    return InternalEvent(type="plan", data=data)


class NativePlanTracker:
    """Translate stateful provider task tools into ACP plan snapshots."""

    def __init__(self) -> None:
        self._tasks: dict[str, dict[str, Any]] = {}
        self._create_calls: dict[str, str] = {}
        self._list_calls: set[str] = set()

    def _snapshot(self) -> InternalEvent:
        return plan_event(self._tasks.values())

    def observe(self, event: InternalEvent) -> InternalEvent | None:
        if event.type == "tool_call":
            name = "".join(
                character
                for character in str(
                    event.data.get("title") or event.data.get("name") or ""
                ).lower()
                if character.isalnum()
            )
            tool_input = event.data.get("raw_input")
            if tool_input is None:
                tool_input = event.data.get("input")
            if not isinstance(tool_input, Mapping):
                return None
            if name == "todowrite":
                todos = tool_input.get("todos")
                if not isinstance(todos, list):
                    return None
                entries = [entry for entry in todos if isinstance(entry, Mapping)]
                self._tasks = {
                    f"todo-{index}": dict(entry)
                    for index, entry in enumerate(entries)
                }
                return self._snapshot()
            if name == "taskcreate":
                call_id = str(
                    event.data.get("tool_call_id")
                    or event.data.get("id")
                    or ""
                )
                key = f"pending:{call_id}"
                content = (
                    tool_input.get("subject")
                    or tool_input.get("description")
                    or "新任务"
                )
                self._tasks[key] = {
                    "content": content,
                    "priority": tool_input.get("priority") or "medium",
                    "status": "pending",
                }
                description = str(tool_input.get("description") or "").strip()
                if tool_input.get("subject") and description and description != str(content):
                    self._tasks[key]["detail"] = description
                if call_id:
                    self._create_calls[call_id] = key
                return self._snapshot()
            if name == "taskupdate":
                task_id = str(
                    tool_input.get("taskId") or tool_input.get("task_id") or ""
                )
                if not task_id:
                    return None
                if str(tool_input.get("status") or "") == "deleted":
                    self._tasks.pop(task_id, None)
                    return self._snapshot()
                current = self._tasks.setdefault(task_id, {
                    "content": (
                        tool_input.get("subject")
                        or tool_input.get("description")
                        or task_id
                    ),
                    "priority": "medium",
                    "status": "pending",
                })
                if tool_input.get("subject"):
                    current["content"] = tool_input["subject"]
                if tool_input.get("description"):
                    description = str(tool_input["description"]).strip()
                    if current.get("content") and current["content"] != task_id:
                        current["detail"] = description
                    else:
                        current["content"] = description
                if tool_input.get("priority"):
                    current["priority"] = tool_input["priority"]
                if tool_input.get("status"):
                    current["status"] = tool_input["status"]
                return self._snapshot()
            if name == "tasklist":
                call_id = str(
                    event.data.get("tool_call_id")
                    or event.data.get("id")
                    or ""
                )
                if call_id:
                    self._list_calls.add(call_id)
            return None

        if event.type == "tool_call_update":
            call_id = str(
                event.data.get("tool_call_id") or event.data.get("tool_use_id") or ""
            )
            raw_output = event.data.get("raw_output")
            if raw_output is None:
                raw_output = event.data.get("content")
            if call_id in self._list_calls:
                self._list_calls.discard(call_id)
                try:
                    listed = json.loads(str(raw_output or ""))
                except (json.JSONDecodeError, TypeError):
                    return None
                tasks = listed.get("tasks") if isinstance(listed, Mapping) else None
                if not isinstance(tasks, list):
                    return None
                self._tasks = {
                    str(task.get("id") or index): dict(task)
                    for index, task in enumerate(tasks)
                    if isinstance(task, Mapping)
                }
                return self._snapshot()
            if str(event.data.get("status") or "") != "completed":
                return None
            provisional = self._create_calls.pop(call_id, None)
            if provisional is None:
                return None
            current = self._tasks.pop(provisional, None) or {}
            metadata = event.data.get("_meta")
            provider_result = (
                metadata.get("provider_result")
                if isinstance(metadata, Mapping)
                else None
            )
            if isinstance(provider_result, Mapping):
                parsed = provider_result
            else:
                try:
                    parsed = json.loads(str(raw_output or ""))
                except (json.JSONDecodeError, TypeError):
                    parsed = {}
            task = parsed.get("task") if isinstance(parsed, Mapping) else None
            if not isinstance(task, Mapping):
                task = {}
            task_id = str(task.get("id") or provisional)
            if task.get("subject"):
                current["content"] = task["subject"]
            if task.get("description"):
                description = str(task["description"]).strip()
                if task.get("subject") or current.get("content") != description:
                    current["detail"] = description
                else:
                    current["content"] = description
            if task.get("status"):
                current["status"] = task["status"]
            existing = self._tasks.get(task_id)
            if existing is not None:
                merged = dict(existing)
                for key, value in current.items():
                    if value:
                        merged[key] = value
                self._tasks[task_id] = merged
            else:
                self._tasks[task_id] = current
            return self._snapshot()

        return None


# Subagent lifecycle stages surfaced by Claude/Qoder SDK ``system`` frames.
_SUBAGENT_SUBTYPES = frozenset({
    "task_started",
    "task_progress",
    "task_updated",
    "task_notification",
})
_SUBAGENT_STATUS_MAP = {
    "in_progress": "running",
    "inprogress": "running",
    "running": "running",
    "paused": "paused",
    "pending": "pending",
    "completed": "completed",
    "done": "completed",
    "failed": "failed",
    "killed": "killed",
    "stopped": "stopped",
}
# Terminal task statuses shared by both SDKs.
_TERMINAL_SUBAGENT_STATUSES = frozenset(
    {"completed", "failed", "killed", "stopped"}
)


def subagent_event(
    *,
    task_id: str,
    status: str,
    stage: str,
    description: str | None = None,
    tool_use_id: str | None = None,
    task_type: str | None = None,
    last_tool_name: str | None = None,
    summary: str | None = None,
    output_file: str | None = None,
    usage: Mapping[str, Any] | None = None,
) -> InternalEvent:
    """Build the unified ``subagent`` event for a lifecycle frame.

    ``stage`` preserves the provider frame (started/progress/updated/
    notification) while ``status`` carries the semantic lifecycle status
    (pending/running/paused/completed/failed/killed/stopped).
    """
    data: dict[str, Any] = {
        "task_id": str(task_id),
        "status": status,
        "stage": stage,
    }
    for key, value in (
        ("description", description),
        ("tool_use_id", tool_use_id),
        ("task_type", task_type),
        ("last_tool_name", last_tool_name),
        ("summary", summary),
        ("output_file", output_file),
    ):
        if value not in (None, ""):
            data[key] = str(value)
    if usage is not None:
        data["usage"] = (
            dict(usage) if isinstance(usage, Mapping) else {"raw": usage}
        )
    return InternalEvent(type="subagent", data=data)


def subagent_event_from_message(msg: Any) -> InternalEvent | None:
    """Map a Claude/Qoder SDK ``system`` task_* message to a subagent event.

    Both SDKs expose typed dataclasses (``TaskStartedMessage`` etc.) and the
    raw ``SystemMessage`` fallback; fields are read from the typed attributes
    first and the raw ``data`` payload second.
    """
    base = msg if isinstance(msg, Mapping) else None
    if base is not None:
        subtype = str(base.get("subtype") or "").lower()
    else:
        subtype = str(getattr(msg, "subtype", "") or "").lower()
    if subtype not in _SUBAGENT_SUBTYPES:
        return None
    data = {} if base is not None else (getattr(msg, "data", {}) or {})
    if not isinstance(data, Mapping):
        data = {}

    def field(*names: str) -> Any:
        for name in names:
            if base is not None:
                value = base.get(name)
            else:
                value = getattr(msg, name, None)
            if value is None:
                value = data.get(name)
            if value not in (None, ""):
                return value
        return None

    task_id = str(field("task_id") or "")
    if not task_id:
        return None
    if subtype == "task_started":
        return subagent_event(
            task_id=task_id,
            status="running",
            stage="started",
            description=field("description"),
            tool_use_id=field("tool_use_id"),
            task_type=field("task_type"),
        )
    if subtype == "task_progress":
        return subagent_event(
            task_id=task_id,
            status="running",
            stage="progress",
            description=field("description"),
            tool_use_id=field("tool_use_id"),
            last_tool_name=field("last_tool_name"),
            usage=field("usage"),
        )
    if subtype == "task_updated":
        patch = field("patch") or {}
        if not isinstance(patch, Mapping):
            patch = {}
        raw_status = str(patch.get("status") or field("status") or "").lower()
        status = _SUBAGENT_STATUS_MAP.get(raw_status, raw_status or "updated")
        return subagent_event(
            task_id=task_id,
            status=status,
            stage="updated",
            description=field("description", "subject"),
            tool_use_id=field("tool_use_id"),
        )
    if subtype == "task_notification":
        raw_status = str(field("status") or "").lower()
        status = _SUBAGENT_STATUS_MAP.get(raw_status, raw_status or "completed")
        return subagent_event(
            task_id=task_id,
            status=status,
            stage="notification",
            description=field("description"),
            tool_use_id=field("tool_use_id"),
            summary=field("summary"),
            output_file=field("output_file"),
            usage=field("usage"),
        )
    return None


def route_subagent_message(msg, state, mapper):
    """Keep provider-tagged child messages and their dedupe state isolated."""
    parent_id = (msg.get("parent_tool_use_id") if isinstance(msg, Mapping)
                 else getattr(msg, "parent_tool_use_id", None))
    if not parent_id:
        return mapper(msg, state)
    child_state = state.setdefault("child_streams", {}).setdefault(str(parent_id), {})
    events = mapper(msg, child_state)
    result = []
    for event in events:
        if event.type in {"session_started", "status", "usage_update"}:
            continue
        frame = subagent_event(task_id=str(parent_id), tool_use_id=str(parent_id),
                               status="running", stage="progress")
        frame.data["event"] = event.to_dict()
        result.append(frame)
    return result


def codex_subagent_events(item):
    """Expose native collaboration snapshots without treating tool end as child end."""
    receivers = item.get("receiver_thread_ids") or item.get("receiverThreadIds") or []
    states = item.get("agents_states") or item.get("agentsStates") or {}
    if isinstance(states, list):
        states = {str(value.get("thread_id") or value.get("threadId") or receivers[index]): value
                  for index, value in enumerate(states)
                  if isinstance(value, Mapping) and (value.get("thread_id") or value.get("threadId") or index < len(receivers))}
    if not isinstance(states, Mapping):
        return []
    result = []
    for child_id, snapshot in states.items():
        if not isinstance(snapshot, Mapping):
            continue
        status = str(snapshot.get("status") or "running")
        status = {"errored": "failed", "shutdown": "stopped"}.get(status, status)
        result.append(subagent_event(task_id=str(child_id), status=status, stage="progress",
                                     summary=snapshot.get("message")))
    return result
