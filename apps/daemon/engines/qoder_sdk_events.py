"""Qoder SDK message, tool, and usage event translation."""

import re
from typing import Any, Mapping

from engines.core.events import (
    InternalEvent,
    compacted_event,
    tool_call_event,
    tool_call_update_event,
    usage_update_event,
)
from engines.core.plans import route_subagent_message, subagent_event_from_message


class QoderSDKEventMapper:
    """Own SDK message decoding and internal event projection."""

    @staticmethod
    def _normalize_qoder_usage(raw: Mapping[str, Any]) -> dict[str, Any]:
        """Normalize the SDK's camelCase ModelUsage to WorkStep's event schema."""

        def num(*keys: str) -> int:
            for key in keys:
                value = raw.get(key)
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    return int(value)
            return 0

        input_tokens = num("inputTokens", "input_tokens")
        output_tokens = num("outputTokens", "output_tokens")
        usage_data: dict[str, Any] = {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cache_creation_input_tokens": num(
                "cacheCreationInputTokens", "cache_creation_input_tokens"
            ),
            "cache_read_input_tokens": num(
                "cacheReadInputTokens", "cache_read_input_tokens"
            ),
            "total_tokens": num("totalTokens", "total_tokens")
            or input_tokens + output_tokens,
        }
        cost = raw.get("costUSD")
        if isinstance(cost, (int, float)) and not isinstance(cost, bool):
            usage_data["cost"] = {
                "amount": round(float(cost), 6),
                "currency": "USD",
            }
        credits = raw.get("credits")
        if isinstance(credits, (int, float)) and not isinstance(credits, bool):
            usage_data["credits"] = float(credits)
        return usage_data

    @staticmethod
    def _msg_type(msg: Any) -> str:
        """Normalize a SDK message to ``system`` / ``stream`` / ``assistant`` /
        ``user`` / ``result``.

        Prefers an explicit ``type`` attribute (``str`` or ``StrEnum``), then
        falls back to the class name — works with real dataclasses and
        lightweight fakes."""
        raw = getattr(msg, "type", "")
        value = getattr(raw, "value", None)
        if value is not None:
            return str(value).lower()
        if raw:
            return str(raw).lower()
        name = type(msg).__name__
        for suffix in ("Message", "Event"):
            if name.endswith(suffix):
                name = name[: -len(suffix)]
                break
        parts = [part for part in re.split(r"(?<!^)(?=[A-Z])", name) if part]
        return parts[-1].lower() if parts else name.lower()

    @staticmethod
    def _block_type(block: Any) -> str:
        raw = getattr(block, "type", "")
        value = getattr(raw, "value", None)
        if value is not None:
            return str(value).lower()
        if raw:
            return str(raw).lower()
        name = type(block).__name__.replace("Block", "")
        parts = [part for part in re.split(r"(?<!^)(?=[A-Z])", name) if part]
        return "_".join(part.lower() for part in parts) if parts else name.lower()

    def _map_message(self, msg, state=None):
        state = state if state is not None else {}
        return route_subagent_message(msg, state, self._map_message_content)

    def _map_message_content(
        self,
        msg: Any,
        state: dict[str, Any] | None = None,
    ) -> list[InternalEvent]:
        """Map one SDK message to zero or more InternalEvents.

        ``state`` tracks whether text/thinking has already been streamed via
        ``StreamEvent`` so the final ``AssistantMessage`` does not duplicate it.
        """
        state = state if state is not None else {}
        state.setdefault("emitted_text", False)
        state.setdefault("emitted_thinking", False)
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
                data = getattr(msg, "data", {}) or {}
                session_id = data.get("session_id") if isinstance(data, Mapping) else None
                if session_id and not state["session_started"]:
                    state["session_started"] = True
                    events.append(InternalEvent(
                        type="session_started",
                        data={"session_id": str(session_id)},
                    ))
            elif subtype == "error":
                data = getattr(msg, "data", {}) or {}
                message = (
                    data.get("error")
                    or data.get("message")
                    or "Qoder 启动失败"
                )
                events.append(
                    InternalEvent(type="error", data={"message": str(message)})
                )
            elif "compact" in subtype.lower():
                data = getattr(msg, "data", {}) or {}
                if isinstance(data, Mapping):
                    summary = (
                        data.get("compact_summary")
                        or data.get("summary")
                    )
                    events.append(compacted_event(str(summary) if summary else None))
                else:
                    events.append(compacted_event())
            return events

        if mtype == "stream":
            session_id = getattr(msg, "session_id", None)
            if session_id and not state["session_started"]:
                state["session_started"] = True
                events.append(InternalEvent(
                    type="session_started", data={"session_id": str(session_id)}
                ))
            event = getattr(msg, "event", {}) or {}
            if event.get("type") != "content_block_delta":
                return events
            delta = event.get("delta") or {}
            delta_type = delta.get("type", "")
            if delta_type == "text_delta":
                text = delta.get("text", "")
                if text:
                    state["emitted_text"] = True
                    state["streamed_text"] = True
                    events.append(
                        InternalEvent(
                            type="agent_message_chunk",
                            data={"content": {"text": text}},
                        )
                    )
            elif delta_type == "thinking_delta":
                thinking = delta.get("thinking", "")
                if thinking:
                    state["emitted_thinking"] = True
                    state["streamed_thinking"] = True
                    events.append(
                        InternalEvent(
                            type="agent_thought_chunk",
                            data={"content": {"text": thinking}},
                        )
                    )
            return events

        if mtype == "assistant":
            for block in getattr(msg, "content", []) or []:
                block_type = self._block_type(block)
                if block_type == "text":
                    text = getattr(block, "text", "") or ""
                    if text and not state["streamed_text"]:
                        state["emitted_text"] = True
                        events.append(
                            InternalEvent(
                                type="agent_message_chunk",
                                data={"content": {"text": text}},
                            )
                        )
                elif block_type == "thinking":
                    thinking = getattr(block, "thinking", "") or ""
                    if thinking and not state["streamed_thinking"]:
                        state["emitted_thinking"] = True
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
            return events

        if mtype == "user":
            for block in getattr(msg, "content", []) or []:
                if self._block_type(block) == "tool_result":
                    content = getattr(block, "content", "") or ""
                    if isinstance(content, list):
                        content = "\n".join(str(part) for part in content if part)
                    events.append(tool_call_update_event(
                        tool_call_id=str(getattr(block, "tool_use_id", "") or ""),
                        status="failed" if bool(getattr(block, "is_error", False)) else "completed",
                        raw_output=content,
                    ))
            return events

        if mtype == "result":
            if not state["emitted_text"]:
                result_text = getattr(msg, "result", None) or ""
                if str(result_text).strip():
                    state["emitted_text"] = True
                    events.append(
                        InternalEvent(
                            type="agent_message_chunk",
                            data={"content": {"text": str(result_text)}},
                        )
                    )
            usage = getattr(msg, "usage", None)
            if usage is not None:
                raw = usage if isinstance(usage, Mapping) else {}
                usage_data = self._normalize_qoder_usage(raw)
                cost_usd = getattr(msg, "total_cost_usd", None)
                if cost_usd is None:
                    cost_usd = raw.get("costUSD")
                if (
                    cost_usd is not None
                    and isinstance(cost_usd, (int, float))
                    and not isinstance(cost_usd, bool)
                ):
                    usage_data["cost"] = {
                        "amount": round(float(cost_usd), 6),
                        "currency": "USD",
                    }
                credits = getattr(msg, "total_credits", None)
                if (
                    credits is not None
                    and isinstance(credits, (int, float))
                    and not isinstance(credits, bool)
                ):
                    usage_data["credits"] = float(credits)
                session_id = getattr(msg, "session_id", None)
                if session_id:
                    usage_data["session_id"] = str(session_id)
                events.append(usage_update_event(usage_data))
            is_error = bool(getattr(msg, "is_error", False))
            subtype = getattr(msg, "subtype", "") or ""
            if is_error or (subtype and subtype != "success"):
                errors = getattr(msg, "errors", None) or []
                message = str(errors[0]) if errors else (subtype or "Qoder 执行失败")
                events.append(
                    InternalEvent(type="error", data={"message": message})
                )
            else:
                events.append(InternalEvent(type="status", data={"status": "done"}))
            return events

        return events
