"""Codex CLI JSONL event, tool, and permission mapping."""

import re
import uuid

from engines.codex_events import codex_cli_raw_event
from engines.codex_visualize import convert_visualize_markers
from engines.core.events import (
    InternalEvent,
    agent_message_chunk,
    extract_reasoning_text,
    normalize_cost,
    tool_call_event,
    tool_call_update_event,
    usage_update_event,
)
from engines.core.interactions import permission_request, permission_signature
from engines.core.plans import plan_event
from engines.core.tool_inputs import file_change_input


def _is_codex_terminal_event(event: InternalEvent) -> bool:
    if event.type in {"usage_update", "error"}:
        return True
    return (
        event.type == "status"
        and event.data.get("status") in {"done", "cancelled"}
    )


_CODEX_CLI_TOOL_ITEM_TYPES = frozenset({
    "file_change",
    "mcp_tool_call",
    "dynamic_tool_call",
    "web_search",
})


def _cli_tool_call_event(item: dict) -> InternalEvent:
    """Map a Codex CLI tool item (snake_case transport) to ACP tool_call."""
    item_type = str(item.get("type") or "")
    if item_type == "file_change":
        title = "EditFile"
        kind = "edit"
        raw_input = file_change_input(item.get("changes") or [])
    elif item_type == "mcp_tool_call":
        server = str(item.get("server") or "")
        tool = str(item.get("tool") or "")
        title = f"{server}/{tool}" if server else tool
        raw_input = item.get("arguments") or {}
    elif item_type == "dynamic_tool_call":
        title = str(item.get("tool") or "DynamicToolCall")
        raw_input = item.get("arguments") or {}
    elif item_type == "web_search":
        title = "WebSearch"
        raw_input = {"query": item.get("query") or ""}
    else:
        title = str(item.get("tool") or item_type or "tool")
        raw_input = item.get("arguments") or item
    if item_type != "file_change":
        kind = "other"
    return tool_call_event(
        tool_call_id=str(item.get("id") or ""),
        title=title,
        kind=kind,
        raw_input=raw_input,
    )


def _cli_tool_result_event(item: dict) -> InternalEvent:
    """Map a completed Codex CLI tool item to ACP tool_call_update."""
    item_type = str(item.get("type") or "")
    if item_type == "file_change":
        output = item.get("changes") or item.get("output") or ""
    elif item_type == "mcp_tool_call":
        output = item.get("result") or item.get("error") or item.get("output") or ""
    elif item_type == "dynamic_tool_call":
        output = item.get("content_items") or item.get("output") or ""
    elif item_type == "web_search":
        output = item.get("results") or item.get("query") or ""
    else:
        output = item.get("output") or item.get("result") or ""
    status = str(item.get("status") or "")
    exit_code = item.get("exit_code")
    failed = (
        status.lower() in {"failed", "error", "declined"}
        or bool(item.get("error"))
        or item.get("success") is False
        or (
            isinstance(exit_code, int)
            and exit_code != 0
        )
    )
    return tool_call_update_event(
        tool_call_id=str(item.get("id") or ""),
        status="failed" if failed else "completed",
        raw_output=output,
    )


# codex exec 模式没有执行中审批协议：沙箱/策略拒绝只表现为失败的
# command_execution 项。以下特征串用于识别「权限拒绝」而非普通命令失败。
_SANDBOX_DENIAL_PATTERN = re.compile(
    r"operation\s+not\s+permitted|permission\s+denied|read-only\s+file"
    r"\s+system|requires\s+approval|denied|not\s+permitted|被拒绝|未授权",
    re.IGNORECASE,
)

class CodexCLIEventMapper:
    """Own Codex CLI event projection and denied command interactions."""

    def _map_event(self, obj: dict) -> InternalEvent | None:
        """Map Codex event to InternalEvent."""
        event_type = obj.get("type", "")

        # Codex CLI emits this when its automatic context compaction finishes.
        # Older/newer transports may wrap the message in ``event_msg``.
        compacted = obj
        if event_type == "event_msg" and isinstance(obj.get("msg"), dict):
            compacted = obj["msg"]
            event_type = compacted.get("type", "")
        if event_type in {"context_compacted", "thread/compacted", "compacted"}:
            summary = (
                compacted.get("summary")
                or compacted.get("compact_summary")
                or compacted.get("text")
            )
            return InternalEvent(
                type="compacted",
                data={"summary": str(summary)} if summary else {},
            )

        if event_type == "thread.started":
            return InternalEvent(type="status", data={"status": "initializing"})

        if event_type == "turn.started":
            return InternalEvent(type="status", data={"status": "running"})

        if event_type in {"turn.plan.updated", "turn/plan/updated"}:
            return plan_event(
                obj.get("plan") or [],
                explanation=obj.get("explanation"),
            )

        if event_type == "item.completed":
            item = obj.get("item", {})
            item_type = item.get("type", "")

            if item_type == "collab_agent_tool_call":
                agents_states = item.get("agents_states") or []
                content = "\n".join(
                    str(state.get("message") or state)
                    for state in agents_states
                    if isinstance(state, dict)
                )
                status = ""
                if agents_states and isinstance(agents_states[-1], dict):
                    status = str(agents_states[-1].get("status") or "")
                return tool_call_update_event(
                    tool_call_id=str(item.get("id") or ""),
                    status="failed" if status in {"failed", "error", "declined"} else "completed",
                    raw_output=content or "",
                )

            if item_type == "agent_message":
                text = item.get("text") or item.get("message") or ""
                if text:
                    return agent_message_chunk(
                        convert_visualize_markers(str(text)),
                        phase=item.get("phase"), source_item_id=item.get("id"),
                    )

            elif item_type == "plan":
                text = item.get("text") or item.get("content") or ""
                return InternalEvent(type="plan_update", data={
                    "id": str(item.get("id") or ""),
                    "type": "markdown",
                    "content": str(text),
                })

            elif item_type in {"reasoning", "analysis"}:
                thinking = extract_reasoning_text(
                    item.get("text") or item.get("summary") or item.get("content")
                )
                if thinking:
                    return InternalEvent(
                        type="agent_thought_chunk",
                        data={"content": {"text": thinking}},
                    )

            elif item_type == "command_execution":
                cmd = item.get("command", "")
                output = item.get("output", "")
                is_error = item.get("exit_code", 0) != 0
                if is_error and _SANDBOX_DENIAL_PATTERN.search(str(output or "")):
                    interaction_id = str(uuid.uuid4())
                    signature = permission_signature("Bash", {"command": cmd})
                    if signature:
                        self._permission_signatures[interaction_id] = signature
                    return permission_request(
                        interaction_id=interaction_id,
                        session_id=self._thread_id or "codex",
                        tool_call={
                            "tool_call_id": item.get("id", ""),
                            "title": f"执行命令: {str(cmd)[:120]}",
                            "name": "Bash",
                            "raw_input": {"command": cmd, "denial": output},
                        },
                        options=[
                            {"option_id": "allow_once", "name": "允许并提升沙箱", "kind": "allow_once"},
                            {"option_id": "reject_once", "name": "拒绝", "kind": "reject_once"},
                            {"option_id": "reject_for_session", "name": "拒绝本次运行", "kind": "reject_for_session"},
                        ],
                    )
                return tool_call_update_event(
                    tool_call_id=str(item.get("id") or ""),
                    status="failed" if is_error else "completed",
                    raw_output=output,
                )

            elif item_type in _CODEX_CLI_TOOL_ITEM_TYPES:
                return _cli_tool_result_event(item)

        if event_type == "item.started":
            item = obj.get("item", {})
            if item.get("type") == "collab_agent_tool_call":
                return tool_call_event(
                    tool_call_id=str(item.get("id") or ""),
                    title=item.get("tool") or "spawnAgent",
                    kind="other",
                    raw_input={
                        "prompt": item.get("prompt"),
                        "model": item.get("model"),
                        "receiver_thread_ids": item.get("receiver_thread_ids") or [],
                    },
                )
            if item.get("type") == "command_execution":
                return tool_call_event(
                    tool_call_id=str(item.get("id") or ""),
                    title="Bash",
                    kind="execute",
                    raw_input={"command": item.get("command", "")},
                )
            if item.get("type") in _CODEX_CLI_TOOL_ITEM_TYPES:
                return _cli_tool_call_event(item)

        if event_type == "turn.completed":
            usage = obj.get("usage", {})
            data = {
                "input_tokens": usage.get("input_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0),
                "cache_creation_input_tokens": usage.get(
                    "cache_creation_input_tokens",
                    usage.get("cache_write_input_tokens", 0),
                ),
                "cache_read_input_tokens": usage.get(
                    "cache_read_input_tokens",
                    usage.get("cached_input_tokens", 0),
                ),
            }
            thought_tokens = (
                usage.get("reasoning_output_tokens")
                or usage.get("reasoning_tokens")
                or 0
            )
            if thought_tokens:
                data["thought_tokens"] = thought_tokens
            cost = normalize_cost(usage)
            if cost is not None:
                data["cost"] = cost
            return usage_update_event(data)

        if event_type in ("error", "turn.failed"):
            return InternalEvent(type="error", data={
                "message": obj.get("message", obj.get("error", "Unknown error")),
            })

        # 未知 Codex CLI 事件统一归一为 acp_raw（不静默丢弃），由 AG-UI
        # 翻译层下发为 workstep.acp_raw，历史回放同样保真。
        return codex_cli_raw_event(obj)
