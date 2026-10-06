"""Shared subagent contract; provider adapters supply only native evidence."""

import json

from engines.core.events import InternalEvent

TERMINAL = {"completed", "failed", "stopped", "killed"}
STATUSES = TERMINAL | {"pending", "running", "paused"}
STATUS_ALIASES = {"inprogress": "running", "in_progress": "running", "done": "completed",
                  "errored": "failed", "error": "failed", "shutdown": "stopped",
                  "cancelled": "stopped", "canceled": "stopped"}


def delegation_prompt(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return None
    if isinstance(value, dict):
        for key in ("prompt", "message"):
            if isinstance(value.get(key), str) and value[key]:
                return value[key]
    return None


class SubagentTracker:
    """Preserve lifecycle metadata across progress and delayed result frames."""

    def __init__(self):
        self.activities = {}
        self.tool_prompts = {}

    def observe(self, event: InternalEvent) -> InternalEvent:
        data = event.data
        if event.type in {"tool_call", "tool_use"}:
            prompt = delegation_prompt(data.get("raw_input", data.get("input")))
            if prompt:
                self.tool_prompts[str(data.get("tool_call_id") or data.get("id") or "")] = prompt
            return event
        if event.type != "subagent":
            return event
        child = str(data.get("task_id") or data.get("id") or "")
        if not child:
            return event
        state = self.activities.setdefault(child, {})
        status = str(data.get("status") or state.get("status") or "pending").lower()
        status = STATUS_ALIASES.get(status, status)
        if status not in STATUSES:
            data["native_status"] = status
            status = state.get("status", "pending")
        if state.get("status") in TERMINAL and data.get("stage") != "started" and status == "running":
            status = state["status"]
        data["status"] = status
        if data.get("stage") == "started" and state.get("status") in TERMINAL:
            for key in ("started_at", "ended_at", "result"):
                state.pop(key, None)
        tool_id = str(data.get("tool_use_id") or child)
        nested = data.get("event") or {}
        nested_data = nested.get("data", {}) if isinstance(nested, dict) else {}
        prompt = data.get("prompt") or self.tool_prompts.get(tool_id) or delegation_prompt(nested_data.get("raw_input"))
        if prompt:
            data["prompt"] = prompt
        if data.get("summary") and status in TERMINAL:
            data.setdefault("result", data["summary"])
        for key in ("agent_name", "agent_path", "description", "prompt", "result", "tool_use_id"):
            if data.get(key) not in (None, ""):
                state[key] = data[key]
        for key in ("started_at", "ended_at"):
            if data.get(key) is not None:
                state.setdefault(key, data[key])
        if data.get("stage") == "started":
            state.setdefault("started_at", event.timestamp)
        elif status in TERMINAL:
            state.setdefault("ended_at", event.timestamp)
        state["status"] = status
        for key, value in state.items():
            data.setdefault(key, value)
        return event
