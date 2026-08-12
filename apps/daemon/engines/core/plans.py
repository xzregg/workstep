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
    "completed": "completed",
    "done": "completed",
}


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
        raw_status = str(entry.get("status") or "pending").replace("-", "_").lower()
        normalized.append({
            "content": content,
            "priority": raw_priority if raw_priority in _PRIORITIES else "medium",
            "status": _STATUSES.get(raw_status, "pending"),
        })
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
        self._create_names: dict[str, str] = {}
        self._subagent_calls: set[str] = set()
        self._list_calls: set[str] = set()

    def _snapshot(self) -> InternalEvent:
        return plan_event(self._tasks.values())

    def observe(self, event: InternalEvent) -> InternalEvent | None:
        if event.type == "tool_use":
            name = "".join(
                character
                for character in str(event.data.get("name") or "").lower()
                if character.isalnum()
            )
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
            raw_prompt = tool_input.get("prompt")
            prompt_text = str(raw_prompt or "").strip() if isinstance(raw_prompt, str) else ""
            looks_like_subagent = (
                "command" not in tool_input
                and bool(prompt_text)
            )
            if name in ("taskcreate", "task", "spawnagent") or looks_like_subagent:
                call_id = str(event.data.get("id") or "")
                key = f"pending:{call_id}"
                content = (
                    tool_input.get("subject")
                    or tool_input.get("description")
                    or (prompt_text[:157] + "…" if len(prompt_text) > 157 else prompt_text)
                    or "新任务"
                )
                self._tasks[key] = {
                    "content": content,
                    "priority": tool_input.get("priority") or "medium",
                    "status": "pending",
                }
                if call_id:
                    self._create_calls[call_id] = key
                    self._create_names[call_id] = name
                    if looks_like_subagent and name not in ("task", "spawnagent"):
                        self._subagent_calls.add(call_id)
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
                if tool_input.get("subject") or tool_input.get("description"):
                    current["content"] = (
                        tool_input.get("subject") or tool_input.get("description")
                    )
                if tool_input.get("priority"):
                    current["priority"] = tool_input["priority"]
                if tool_input.get("status"):
                    current["status"] = tool_input["status"]
                return self._snapshot()
            if name == "tasklist":
                call_id = str(event.data.get("id") or "")
                if call_id:
                    self._list_calls.add(call_id)
            return None

        if event.type == "tool_result":
            call_id = str(event.data.get("tool_use_id") or "")
            if call_id in self._list_calls:
                self._list_calls.discard(call_id)
                try:
                    listed = json.loads(str(event.data.get("content") or ""))
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
            provisional = self._create_calls.pop(call_id, None)
            if provisional is None:
                return None
            create_name = self._create_names.pop(call_id, "")
            is_subagent_call = call_id in self._subagent_calls
            self._subagent_calls.discard(call_id)
            current = self._tasks.pop(provisional, None) or {}
            try:
                parsed = json.loads(str(event.data.get("content") or ""))
            except (json.JSONDecodeError, TypeError):
                parsed = {}
            task = parsed.get("task") if isinstance(parsed, Mapping) else None
            if not isinstance(task, Mapping):
                task = {}
            task_id = str(task.get("id") or provisional)
            content = task.get("subject") or task.get("description")
            if content:
                current["content"] = content
            if task.get("status"):
                current["status"] = task["status"]
            elif create_name in ("task", "spawnagent") or is_subagent_call:
                # 子代理工具（Claude Task / Codex spawnAgent / ACP 委托工具）
                # 的 tool_result 即完成信号；TaskCreate 仅表示任务已建，保持 pending。
                current["status"] = "completed"
            existing = self._tasks.get(task_id)
            if existing is not None:
                # 子代理生命周期帧可能已把该任务写为终态，保留更完整的信息。
                merged = dict(existing)
                for key, value in current.items():
                    if value:
                        merged[key] = value
                self._tasks[task_id] = merged
            else:
                self._tasks[task_id] = current
            return self._snapshot()

        if event.type == "subagent":
            return self._observe_subagent(event)
        return None

    def _observe_subagent(self, event: InternalEvent) -> InternalEvent | None:
        """Fold subagent lifecycle frames into the plan snapshot state."""
        data = event.data if isinstance(event.data, Mapping) else {}
        task_id = str(data.get("task_id") or "").strip()
        tool_use_id = str(data.get("tool_use_id") or "").strip()
        if not task_id:
            return None
        if tool_use_id:
            # 同一 spawn 工具的占位条目由该任务 ID 接管，避免重复展示。
            self._tasks.pop(f"pending:{tool_use_id}", None)
        entry = self._tasks.get(task_id)
        if entry is None:
            entry = {"content": "", "priority": "medium", "status": "pending"}
        description = data.get("description") or data.get("subject")
        if description:
            entry["content"] = str(description)
        status = str(data.get("status") or "").lower()
        if status in ("running", "paused"):
            entry["status"] = "in_progress"
        elif status in _TERMINAL_SUBAGENT_STATUSES:
            entry["status"] = "completed"
        elif status == "pending":
            entry["status"] = "pending"
        self._tasks[task_id] = entry
        return self._snapshot()


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
