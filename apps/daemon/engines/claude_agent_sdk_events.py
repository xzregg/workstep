"""Claude Agent SDK message and result event translation."""

import re
from typing import Any, Mapping

from engines.core.claude_usage import claude_context_snapshot, normalize_claude_usage
from engines.core.events import (
    InternalEvent,
    compacted_event,
    tool_call_event,
    tool_call_update_event,
    usage_update_event,
)
from engines.core.plans import route_subagent_message, subagent_event_from_message


class ClaudeAgentSDKEventMapper:
    """Own SDK message decoding and internal event projection."""

    @staticmethod
    def _msg_type(msg: Any) -> str:
        """Normalize the SDK MessageType (str enum or plain str) to lowercase."""
        raw = getattr(msg, "type", "")
        value = getattr(raw, "value", None)
        if value is not None:
            return str(value).lower()
        if raw:
            return str(raw).lower()
        name = type(msg).__name__
        if name.endswith("Message"):
            name = name[: -len("Message")]
        return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()

    @staticmethod
    def _block_type(block: Any) -> str:
        """Normalize a content block type (``type`` attr or class name)."""
        raw = getattr(block, "type", "")
        value = getattr(raw, "value", None)
        if value is not None:
            return str(value).lower()
        if raw:
            return str(raw).lower()
        name = type(block).__name__
        if name.endswith("Block"):
            name = name[: -len("Block")]
        return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()

    @staticmethod
    def _content_blocks(msg: Any) -> list[Any]:
        """Content blocks from either the legacy ``message.content`` or top-level ``content``."""
        message = getattr(msg, "message", None)
        if message is not None:
            blocks = getattr(message, "content", None)
            if blocks:
                return blocks
        return getattr(msg, "content", None) or []

    @staticmethod
    def _result_output(result: Any) -> str:
        """Extract final text from a result payload (str, dict, or object)."""
        if isinstance(result, str):
            return result
        if isinstance(result, Mapping):
            for key in ("output", "result", "text"):
                value = result.get(key)
                if value:
                    return str(value)
            return ""
        return str(
            getattr(result, "output", "") or getattr(result, "text", "") or ""
        )

    @staticmethod
    def _as_dict(value: Any) -> dict[str, Any]:
        """Best-effort conversion of the SDK Usage object to a plain dict."""
        if isinstance(value, Mapping):
            return dict(value)
        if hasattr(value, "to_dict") and callable(value.to_dict):
            try:
                converted = value.to_dict()
                if isinstance(converted, Mapping):
                    return dict(converted)
            except Exception:
                pass
        result: dict[str, Any] = {}
        for key in (
            "input_tokens",
            "output_tokens",
            "total_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
        ):
            item = getattr(value, key, None)
            if item is not None:
                result[key] = item
        return result

    @staticmethod
    def _result_error_message(msg: Any, result: Any, state: dict[str, Any]) -> str:
        """Extract the most specific error description from a failed result.

        新版 SDK（≥0.2.130）的 ResultMessage 在失败时可能仍带
        ``subtype="success"``，真实原因散落在 ``errors`` / ``result`` 文本 /
        ``api_error_status`` / ``terminal_reason`` 等字段中（例如认证失败会
        回写 ``result="Not logged in · Please run /login"``）。按信息量从具体
        到笼统的顺序取值，避免 UI 只剩无提示的兜底文案。
        """
        sources = [msg] + ([result] if not isinstance(result, str) else [])
        errors = None
        for source in sources:
            candidate = getattr(source, "errors", None)
            if isinstance(candidate, (list, tuple)) and candidate:
                errors = candidate
                break
        if errors:
            first = str(errors[0] or "").strip()
            if first:
                return first
        for source in sources:
            legacy = getattr(source, "error", None)
            if legacy is not None and str(legacy).strip():
                return str(legacy).strip()
        if isinstance(result, str) and result.strip():
            # CLI 在错误 result 中回写的描述文本（如登录失效提示）。
            return result.strip()
        text = ClaudeAgentSDKEventMapper._result_output(result)
        if str(text).strip():
            return str(text).strip()
        assistant_error = (state or {}).get("assistant_error")
        if assistant_error:
            # 失败回合助手消息上的错误标记（如 authentication_failed）。
            return str(assistant_error)
        api_status = getattr(msg, "api_error_status", None)
        if api_status is not None and str(api_status).strip():
            return f"API 请求失败（HTTP {api_status}）"
        terminal = getattr(msg, "terminal_reason", None)
        if terminal and terminal != "success":
            return str(terminal)
        subtype = getattr(msg, "subtype", None) or getattr(result, "subtype", None)
        if subtype and subtype != "success":
            return str(subtype)
        return "Claude Agent SDK 执行失败"

    def _map_message(self, msg, state=None):
        state = state if state is not None else {}
        return route_subagent_message(msg, state, self._map_message_content)

    def _map_message_content(
        self,
        msg: Any,
        state: dict[str, Any] | None = None,
    ) -> list[InternalEvent]:
        """Map one SDK message to zero or more InternalEvents.

        ``state`` tracks whether text has been emitted for this query so the
        ``result`` message only falls back to ``result.output`` when the model
        streamed no text blocks.
        """
        state = state if state is not None else {}
        state.setdefault("emitted_text", False)
        state.setdefault("streamed_text", False)
        state.setdefault("streamed_thinking", False)
        state.setdefault("session_started", False)
        events: list[InternalEvent] = []
        mtype = self._msg_type(msg)
        subtype = getattr(msg, "subtype", "") or ""
        if subtype in (
            "task_started",
            "task_progress",
            "task_updated",
            "task_notification",
        ):
            subagent = subagent_event_from_message(msg)
            if subagent is not None:
                events.append(subagent)
            return events

        if mtype == "system":
            subtype = getattr(msg, "subtype", "") or ""
            if subtype == "init":
                events.append(
                    InternalEvent(type="status", data={"status": "initializing"})
                )
                data = getattr(msg, "data", None) or {}
                session_id = data.get("session_id") if isinstance(data, Mapping) else None
                if session_id and not state["session_started"]:
                    state["session_started"] = True
                    events.append(InternalEvent(
                        type="session_started",
                        data={"session_id": str(session_id)},
                    ))
            elif subtype == "error":
                error = getattr(msg, "message", None) or "Claude Agent SDK 启动失败"
                events.append(InternalEvent(type="error", data={"message": str(error)}))
            elif "compact" in subtype.lower():
                data = getattr(msg, "data", None) or {}
                if isinstance(data, Mapping):
                    summary = (
                        data.get("summary")
                        or data.get("compact_summary")
                        or data.get("message")
                    )
                    events.append(compacted_event(str(summary) if summary else None))
                else:
                    events.append(compacted_event())
            return events

        if mtype == "stream_event":
            session_id = getattr(msg, "session_id", None)
            if session_id and not state["session_started"]:
                state["session_started"] = True
                events.append(InternalEvent(
                    type="session_started", data={"session_id": str(session_id)}
                ))
            stream_event = getattr(msg, "event", None) or {}
            if stream_event.get("type") != "content_block_delta":
                return events
            delta = stream_event.get("delta") or {}
            delta_type = delta.get("type", "")
            if delta_type == "text_delta" and delta.get("text"):
                state["emitted_text"] = True
                state["streamed_text"] = True
                events.append(InternalEvent(
                    type="agent_message_chunk",
                    data={"content": {"text": str(delta["text"])}},
                ))
            elif delta_type == "thinking_delta":
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

        if mtype == "assistant":
            # 失败回合的助手消息带 error 标记（如 authentication_failed）；
            # 记录到 state，供 result 错误映射在缺少描述文本时兜底使用。
            assistant_error = getattr(msg, "error", None)
            if assistant_error and not state.get("assistant_error"):
                state["assistant_error"] = str(assistant_error)
            for block in self._content_blocks(msg):
                block_type = self._block_type(block)
                if block_type == "text" and not state["streamed_text"]:
                    delta = getattr(block, "text", "") or ""
                    if delta:
                        state["emitted_text"] = True
                        events.append(
                            InternalEvent(
                                type="agent_message_chunk",
                                data={"content": {"text": delta}},
                            )
                        )
                elif block_type == "thinking" and not state["streamed_thinking"]:
                    thinking = getattr(block, "thinking", "") or ""
                    if thinking:
                        events.append(
                            InternalEvent(
                                type="agent_thought_chunk",
                                data={"content": {"text": thinking}},
                            )
                        )
                elif block_type == "tool_use":
                    events.append(tool_call_event(
                        tool_call_id=str(getattr(block, "id", "") or ""),
                        title=str(getattr(block, "name", "") or "tool"),
                        raw_input=getattr(block, "input", {}) or {},
                    ))
            usage = getattr(msg, "usage", None)
            message = getattr(msg, "message", None)
            if usage is None and message is not None:
                usage = getattr(message, "usage", None)
            if usage is not None:
                raw_usage = self._as_dict(usage)
                context_used, context_size = claude_context_snapshot(raw_usage)
                events.append(usage_update_event(
                    normalize_claude_usage(raw_usage),
                    used=context_used,
                    size=context_size,
                ))
            return events

        if mtype == "user":
            for block in self._content_blocks(msg):
                if self._block_type(block) == "tool_result":
                    content = getattr(block, "content", "") or ""
                    if isinstance(content, list):
                        content = "\n".join(
                            str(part) for part in content if part
                        )
                    events.append(tool_call_update_event(
                        tool_call_id=str(getattr(block, "tool_use_id", "") or ""),
                        status="failed" if bool(getattr(block, "is_error", False)) else "completed",
                        raw_output=content,
                    ))
            return events

        if mtype == "result":
            result = getattr(msg, "result", msg)
            is_error = bool(getattr(msg, "is_error", getattr(result, "is_error", False)))
            if not state["emitted_text"]:
                output = self._result_output(result)
                if str(output).strip():
                    state["emitted_text"] = True
                    events.append(
                        InternalEvent(
                            type="agent_message_chunk",
                            data={"content": {"text": str(output)}},
                        )
                    )
            usage = getattr(msg, "usage", None)
            if usage is None and result is not msg:
                usage = getattr(result, "usage", None)
            if usage is not None:
                raw_usage = self._as_dict(usage)
                usage_data = normalize_claude_usage(raw_usage)
                cost_usd = getattr(msg, "total_cost_usd", None)
                if cost_usd is None and result is not msg:
                    cost_usd = getattr(result, "total_cost_usd", None)
                if (
                    cost_usd is not None
                    and isinstance(cost_usd, (int, float))
                    and not isinstance(cost_usd, bool)
                ):
                    usage_data["cost"] = {
                        "amount": round(float(cost_usd), 6),
                        "currency": "USD",
                    }
                session_id = getattr(msg, "session_id", None)
                if not session_id and result is not msg:
                    session_id = getattr(result, "session_id", None)
                usage_data["session_id"] = session_id or ""
                events.append(usage_update_event(usage_data))
            if is_error:
                message = ClaudeAgentSDKEventMapper._result_error_message(msg, result, state)
                events.append(
                    InternalEvent(type="error", data={"message": str(message)})
                )
            else:
                events.append(InternalEvent(type="status", data={"status": "done"}))
            return events

        return events
