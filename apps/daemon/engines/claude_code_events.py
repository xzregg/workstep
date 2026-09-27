"""Claude CLI JSONL message, permission, and usage event mapping."""

import re
import uuid

from engines.core.claude_usage import claude_context_snapshot, normalize_claude_usage
from engines.core.events import (
    InternalEvent,
    normalize_cost,
    tool_call_event,
    tool_call_update_event,
    usage_update_event,
)
from engines.core.interactions import (
    interaction_from_tool_use,
    permission_request,
    permission_signature,
)
from engines.core.plans import route_subagent_message, subagent_event_from_message


def _claude_permission_rule(tool_name: str, tool_input: object) -> str:
    """Build the Claude Code permission rule string for an "always allow".

    规则格式与 Claude Code 原生 settings 一致（如 ``Bash(cat file.txt *)``、
    ``Read(/path/to/file:*)``）；无法可靠表达时返回空串，表示不写入设置。
    """
    if not isinstance(tool_input, dict):
        return ""
    command = tool_input.get("command")
    if isinstance(command, str) and command.strip():
        return f"Bash({command.strip()} *)"
    path = (
        tool_input.get("file_path")
        or tool_input.get("filePath")
        or tool_input.get("path")
    )
    if isinstance(path, str) and path.strip():
        return f"{tool_name}({path.strip()}:*)"
    return ""


# Claude CLI 在 -p 模式下没有执行中审批通道：被策略拒绝的命令以
# is_error tool_result 返回。这些特征串用于识别「权限拒绝」而非普通命令失败。
_APPROVAL_DENIAL_PATTERN = re.compile(
    r"requires?\s+approval|approval\s+is\s+required|permission.{0,24}"
    r"(denied|denial|required)|not\s+permitted|需要批准|未获批准|未授权",
    re.IGNORECASE,
)


class ClaudeCodeEventMapper:
    """Own CLI event projection and denied tool interaction detection."""

    def _map_event(self, obj: dict) -> InternalEvent | None:
        """Compatibility helper returning the first mapped event."""
        events = self._map_events(obj)
        return events[0] if events else None

    def _map_events(self, obj, state=None):
        state = state if state is not None else {}
        return route_subagent_message(obj, state, self._map_events_content)

    def _map_events_content(
        self,
        obj: dict,
        state: dict | None = None,
    ) -> list[InternalEvent]:
        """Map one Claude JSONL message without dropping content blocks."""
        state = state if state is not None else {
            "streamed_text": False,
            "streamed_thinking": False,
        }
        state.setdefault("streamed_text", False)
        state.setdefault("streamed_thinking", False)
        state.setdefault("session_started", False)
        events: list[InternalEvent] = []
        event_type = obj.get("type", "")

        if event_type == "system":
            subtype = obj.get("subtype", "")
            if subtype in {"compact_boundary", "compacted", "context_compaction"}:
                metadata = obj.get("compact_metadata")
                data: dict = {}
                summary = obj.get("summary") or obj.get("compact_summary")
                if summary:
                    data["summary"] = str(summary)
                if isinstance(metadata, dict):
                    data["metadata"] = metadata
                events.append(InternalEvent(type="compacted", data=data))
                return events
            if subtype == "init":
                events.append(
                    InternalEvent(type="status", data={"status": "initializing"})
                )
                session_id = obj.get("session_id")
                if session_id:
                    state.setdefault("session_id", "")
                    state["session_id"] = str(session_id)
                    state["session_started"] = True
                    events.append(InternalEvent(
                        type="session_started", data={"session_id": str(session_id)}
                    ))
                return events
            if subtype in (
                "task_started",
                "task_progress",
                "task_updated",
                "task_notification",
            ):
                subagent = subagent_event_from_message(obj)
                if subagent is not None:
                    events.append(subagent)
                return events

        if event_type == "stream_event":
            stream_event = obj.get("event") or {}
            if stream_event.get("type") != "content_block_delta":
                return events
            delta = stream_event.get("delta") or {}
            delta_type = delta.get("type", "")
            if delta_type == "text_delta" and delta.get("text"):
                state["streamed_text"] = True
                events.append(InternalEvent(
                    type="agent_message_chunk",
                    data={"content": {"text": str(delta["text"])}},
                ))
            elif delta_type in {"thinking_delta", "signature_delta"}:
                thinking = delta.get("thinking") or delta.get("text")
                if thinking:
                    state["streamed_thinking"] = True
                    events.append(InternalEvent(
                        type="agent_thought_chunk",
                        data={"content": {"text": str(thinking)}},
                    ))
            elif delta_type == "input_json_delta" and delta.get("partial_json"):
                events.append(tool_call_update_event(
                    tool_call_id=str(stream_event.get("index") or ""),
                    status="in_progress",
                    raw_input=str(delta["partial_json"]),
                ))
            return events

        if event_type == "assistant":
            message = obj.get("message", {})
            for block in message.get("content", []):
                block_type = block.get("type", "")
                if block_type == "text" and not state["streamed_text"]:
                    text = block.get("text", "")
                    if text:
                        events.append(InternalEvent(
                            type="agent_message_chunk",
                            data={"content": {"text": text}},
                        ))
                elif block_type == "thinking" and not state["streamed_thinking"]:
                    thinking = block.get("thinking", "")
                    if thinking:
                        events.append(InternalEvent(
                            type="agent_thought_chunk",
                            data={"content": {"text": thinking}},
                        ))
                elif block_type == "tool_use":
                    tool_use_id = str(block.get("id", ""))
                    tool_name = str(block.get("name", ""))
                    state.setdefault("tool_names", {})
                    state.setdefault("tool_inputs", {})
                    if tool_use_id:
                        state["tool_names"][tool_use_id] = tool_name
                        state["tool_inputs"][tool_use_id] = block.get("input", {})
                    interaction = interaction_from_tool_use(
                        tool_use_id,
                        tool_name,
                        block.get("input", {}),
                    )
                    if interaction is not None:
                        events.append(interaction)
                    else:
                        events.append(tool_call_event(
                            tool_call_id=tool_use_id,
                            title=tool_name,
                            raw_input=block.get("input", {}),
                        ))
            usage = message.get("usage")
            if isinstance(usage, dict):
                context_used, context_size = claude_context_snapshot(usage)
                events.append(usage_update_event(
                    normalize_claude_usage(usage),
                    used=context_used,
                    size=context_size,
                ))
            return events

        if event_type == "result":
            if obj.get("is_error") or str(obj.get("subtype") or "").startswith("error"):
                _subtype = obj.get("subtype")
                message = (
                    obj.get("result")
                    or obj.get("error")
                    or (_subtype if _subtype != "success" else None)
                )
                events.append(InternalEvent(
                    type="error",
                    data={"message": str(message or "Claude Code 执行失败")},
                ))
            usage = obj.get("usage") or obj
            data = normalize_claude_usage(usage)
            data["session_id"] = obj.get("session_id")
            cost = normalize_cost(usage)
            if cost is None:
                # claude CLI 把 total_cost_usd / cost_usd 放在 result 顶层
                cost = normalize_cost(obj)
            if cost is not None:
                data["cost"] = cost
            events.append(usage_update_event(data))
            session_id = obj.get("session_id")
            if session_id and not state["session_started"]:
                state["session_started"] = True
                events.append(InternalEvent(
                    type="session_started", data={"session_id": str(session_id)}
                ))
            return events

        if event_type == "user":
            # Tool results from Claude
            for block in obj.get("message", {}).get("content", []):
                if block.get("type") != "tool_result":
                    continue
                tool_use_id = str(block.get("tool_use_id", ""))
                content = str(block.get("content", "") or "")
                is_error = bool(block.get("is_error"))
                if (
                    is_error
                    and self._live_mode
                    and _APPROVAL_DENIAL_PATTERN.search(content)
                ):
                    tool_names = state.get("tool_names") or {}
                    tool_inputs = state.get("tool_inputs") or {}
                    tool_name = tool_names.get(tool_use_id) or "Bash"
                    tool_input = tool_inputs.get(tool_use_id)
                    interaction_id = str(uuid.uuid4())
                    signature = permission_signature(tool_name, tool_input)
                    rule = _claude_permission_rule(tool_name, tool_input)
                    self._permission_details[interaction_id] = (signature, rule)
                    events.append(permission_request(
                        interaction_id=interaction_id,
                        session_id=state.get("session_id") or "claude-code",
                        tool_call={
                            "tool_call_id": tool_use_id,
                            "title": content[:120],
                            "name": tool_name,
                            "raw_input": {"denial": content},
                        },
                        options=[
                            {"option_id": "allow_once", "name": "允许一次", "kind": "allow_once"},
                            {"option_id": "allow_always", "name": "允许所有", "kind": "allow_always"},
                            {"option_id": "allow_for_session", "name": "允许本次会话", "kind": "allow_for_session"},
                            {"option_id": "reject_once", "name": "拒绝", "kind": "reject_once"},
                            {"option_id": "reject_for_session", "name": "拒绝本次会话", "kind": "reject_for_session"},
                        ],
                    ))
                else:
                    result_event = tool_call_update_event(
                        tool_call_id=tool_use_id,
                        status="failed" if is_error else "completed",
                        raw_output=content,
                    )
                    structured_result = obj.get("toolUseResult")
                    if (
                        isinstance(structured_result, dict)
                        and isinstance(structured_result.get("task"), dict)
                    ):
                        result_event.data["_meta"] = {
                            "provider_result": structured_result,
                        }
                    events.append(result_event)
            return events

        return events
