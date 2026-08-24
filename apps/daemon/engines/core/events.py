"""InternalEvent — unified event type across all engines.

事件词汇与 ACP session update 对齐：引擎内容事件直接采用 ACP 字段形状
（``agent_message_chunk`` / ``tool_call`` / ``usage_update`` …），编排类事件
（``status`` / ``session_started`` / ``live_message`` / ``engine_state`` /
``subagent`` / ``compacted`` / ``error`` 与新增 ``a2ui`` / ``acp_raw``）与非 ACP
词汇共存于 ``InternalEvent``。对外（WebSocket / 历史回放）统一由
``engines/core/agui.py`` 翻译为 AG-UI 标准事件。
"""

from dataclasses import dataclass, field
from typing import Any, Literal, Mapping
import time

# ACP session update 内容事件词汇（引擎适配器统一按此产出）。
ACP_CONTENT_EVENT_TYPES = frozenset({
    "agent_message_chunk",
    "agent_thought_chunk",
    "user_message_chunk",
    "tool_call",
    "tool_call_update",
    "plan",
    "plan_update",
    "plan_removed",
    "usage_update",
    "session_info_update",
    "available_commands_update",
    "config_option_update",
    "current_mode_update",
    "mcp_message",
    "elicitation_completed",
})

# 非 ACP 编排事件：与 ACP 词汇共存，不参与引擎内容映射。
ORCHESTRATION_EVENT_TYPES = frozenset({
    "status",
    "session_started",
    "live_message",
    "engine_state",
    "subagent",
    "compacted",
    "error",
    "interaction_request",
    "interaction_response",
    "a2ui",
    "acp_raw",
})

_ALL_EVENT_TYPES = tuple(
    sorted(ACP_CONTENT_EVENT_TYPES | ORCHESTRATION_EVENT_TYPES)
)


def normalize_cost(usage: Mapping[str, Any]) -> dict[str, Any] | None:
    """Extract a unified ``{amount, currency}`` cost record (订单金额) from provider usage.

    Mirrors ACP's ``cost`` field (amount + ISO 4217 currency) so every engine
    surfaces billing through the same ``usage`` event shape. Supported inputs:

    - ``{"cost": {"amount": 0.045, "currency": "USD"}}``  ACP style
    - ``{"cost": 0.045}``                                 bare number, assumed USD
    - ``{"cost_usd": 0.045}`` / ``{"total_cost": 0.045}`` OpenAI-style

    Returns None when no cost information is present.
    """

    raw = usage.get("cost")
    if isinstance(raw, Mapping):
        amount = raw.get("amount")
        if isinstance(amount, (int, float)) and not isinstance(amount, bool):
            currency = raw.get("currency") or raw.get("currency_code") or "USD"
            return {"amount": round(float(amount), 6), "currency": str(currency)}
    elif isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return {"amount": round(float(raw), 6), "currency": "USD"}

    for key in ("cost_usd", "total_cost", "total_cost_usd", "amount"):
        value = usage.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return {"amount": round(float(value), 6), "currency": "USD"}
    return None


def normalize_token_usage(usage: Mapping[str, Any]) -> dict[str, Any]:
    """Normalize provider-specific token fields to WorkStep's event schema.

    Token fields keep their normalized names; any cost/billing info present in
    the source dict is appended as a unified ``cost: {amount, currency}``.
    """

    def value(*keys: str) -> int:
        for key in keys:
            candidate = usage.get(key)
            if isinstance(candidate, (int, float)) and not isinstance(candidate, bool):
                return int(candidate)
        return 0

    input_tokens = value("input_tokens", "prompt_tokens")
    output_tokens = value("output_tokens", "completion_tokens")
    total_tokens = value("total_tokens", "tokens") or input_tokens + output_tokens
    result: dict[str, Any] = {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_creation_input_tokens": value(
            "cache_creation_input_tokens",
            "cache_write_tokens",
            "cached_write_tokens",
        ),
        "cache_read_input_tokens": value(
            "cache_read_input_tokens",
            "cache_read_tokens",
            "cached_read_tokens",
            "cached_tokens",
        ),
        "total_tokens": total_tokens,
    }
    cost = normalize_cost(usage)
    if cost is not None:
        result["cost"] = cost
    return result


@dataclass
class InternalEvent:
    """Unified event yielded by all engine implementations.

    内容事件采用 ACP session update 词汇与字段形状；编排事件保持原有形状。
    所有引擎 stdout 流都解析为该统一格式。
    """

    type: Literal[  # type: ignore[valid-type]
        "agent_message_chunk",       # assistant text increment (ACP)
        "agent_thought_chunk",       # thinking/reasoning increment (ACP)
        "user_message_chunk",        # user text chunk (ACP)
        "tool_call",                 # tool call start (ACP tool_call)
        "tool_call_update",          # tool progress/result (ACP tool_call_update)
        "plan",                      # ACP stable execution-plan snapshot
        "plan_update",               # ACP plan_update (items/markdown/file)
        "plan_removed",              # ACP plan_removed
        "usage_update",              # ACP usage_update (used/size/cost + tokens)
        "session_info_update",       # ACP session_info_update
        "available_commands_update", # ACP available_commands_update
        "config_option_update",      # ACP config_option_update
        "current_mode_update",       # ACP current_mode_update
        "mcp_message",               # ACP MessageMcpNotification
        "elicitation_completed",     # ACP CompleteElicitationNotification
        "status",                    # status change (initializing / running / done)
        "session_started",           # reusable engine session identity
        "live_message",              # queued live-stage message delivery state
        "engine_state",              # serializable in-process engine state snapshot
        "subagent",                  # subagent / background task lifecycle event
        "compacted",                 # engine auto-compacted its context window
        "error",                     # error
        "interaction_request",       # ACP permission / form elicitation request
        "interaction_response",      # user response to an interaction request
        "a2ui",                      # A2UI surface payload (createSurface/updateComponents)
        "acp_raw",                   # passthrough of an unmapped ACP session update
    ]
    data: dict = field(default_factory=dict)
    timestamp: int = field(default_factory=lambda: int(time.time() * 1000))

    def to_dict(self) -> dict:
        return {"type": self.type, "data": self.data, "timestamp": self.timestamp}


def compacted_event(summary: str | None = None) -> InternalEvent:
    """Build a ``compacted`` event (engine auto-compressed its context)."""
    data: dict[str, Any] = {}
    if summary:
        data["summary"] = str(summary)
    return InternalEvent(type="compacted", data=data)


# ── ACP 词汇构建辅助 ──────────────────────────────────────────────────────


def _content_block(text: str) -> dict[str, str]:
    return {"text": str(text)}


def extract_reasoning_text(value: Any) -> str:
    """Extract displayable text from Codex reasoning content/summary blocks."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, Mapping):
        for key in ("text", "summary", "content"):
            text = extract_reasoning_text(value.get(key))
            if text:
                return text
        return ""
    if isinstance(value, (list, tuple)):
        return "\n".join(
            text for item in value if (text := extract_reasoning_text(item))
        )
    for attr in ("text", "summary", "content"):
        text = extract_reasoning_text(getattr(value, attr, None))
        if text:
            return text
    return ""


def agent_message_chunk(text: str) -> InternalEvent:
    """ACP ``agent_message_chunk`` — assistant text increment."""
    return InternalEvent(type="agent_message_chunk", data={"content": _content_block(text)})


def agent_thought_chunk(text: str) -> InternalEvent:
    """ACP ``agent_thought_chunk`` — thinking/reasoning increment."""
    return InternalEvent(type="agent_thought_chunk", data={"content": _content_block(text)})


def user_message_chunk(text: str) -> InternalEvent:
    """ACP ``user_message_chunk`` — user text chunk."""
    return InternalEvent(type="user_message_chunk", data={"content": _content_block(text)})


def tool_call_event(
    tool_call_id: str,
    title: str,
    kind: str | None = None,
    raw_input: Any = None,
    needs_approval: bool = False,
) -> InternalEvent:
    """ACP ``tool_call`` — tool call started (complete snapshot)."""
    data: dict[str, Any] = {
        "tool_call_id": str(tool_call_id),
        "title": str(title or "tool"),
    }
    if kind:
        data["kind"] = str(kind)
    if raw_input is not None:
        data["raw_input"] = raw_input
    if needs_approval:
        data["needs_approval"] = True
    return InternalEvent(type="tool_call", data=data)


def tool_call_update_event(
    tool_call_id: str,
    status: str,
    raw_input: Any = None,
    raw_output: Any = None,
    title: str | None = None,
    kind: str | None = None,
) -> InternalEvent:
    """ACP ``tool_call_update`` — progress / result of a tool call.

    ``status`` ∈ pending | in_progress | completed | failed；``raw_input`` 为增量
    （实时专用，不持久化），``raw_output`` 为结果。
    """
    data: dict[str, Any] = {"tool_call_id": str(tool_call_id), "status": str(status)}
    if title:
        data["title"] = str(title)
    if kind:
        data["kind"] = str(kind)
    if raw_input is not None:
        data["raw_input"] = raw_input
    if raw_output is not None:
        data["raw_output"] = raw_output
    return InternalEvent(type="tool_call_update", data=data)


def usage_update_event(
    usage: Mapping[str, Any],
    *,
    used: int | None = None,
    size: int | None = None,
) -> InternalEvent:
    """ACP ``usage_update`` — context-window usage + token breakdown + cost.

    ``used`` 统一表示最近一次 usage 的总 token；``size`` 仅在引擎原生提供
    上下文窗口时写入，不合成窗口默认值。token 字段由
    ``normalize_token_usage`` 归一化。
    """
    data: dict[str, Any] = normalize_token_usage(usage)

    def number(*keys: str) -> int | None:
        for key in keys:
            value = usage.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return int(value)
        return None

    resolved_used = used if used is not None else number("used", "total_tokens", "tokens")
    if resolved_used is None:
        resolved_used = data["total_tokens"]
    resolved_size = size if size is not None else number(
        "size",
        "context_window",
        "model_context_window",
        "contextWindow",
        "modelContextWindow",
    )
    data["used"] = int(resolved_used)
    if data["total_tokens"] == 0 and resolved_used > 0:
        data["total_tokens"] = int(resolved_used)
    if resolved_size is not None and resolved_size > 0:
        data["size"] = int(resolved_size)
    for key in (
        "session_id",
        "provider_id",
        "requests",
        "credits",
        "thought_tokens",
        "reasoning_output_tokens",
    ):
        if key in usage:
            data[key] = usage[key]
    return InternalEvent(type="usage_update", data=data)


def a2ui_event(payload: Mapping[str, Any]) -> InternalEvent:
    """``a2ui`` — A2UI surface payload (createSurface / updateComponents / …)."""
    return InternalEvent(type="a2ui", data=dict(payload))


def acp_raw_event(update: Any) -> InternalEvent:
    """``acp_raw`` — passthrough of an unknown ACP session update (no silent drop)."""
    dump = getattr(update, "model_dump", None)
    if callable(dump):
        payload = dump(by_alias=False, exclude_none=True)
    elif isinstance(update, Mapping):
        payload = dict(update)
    else:
        payload = {"update": str(update)}
    return InternalEvent(type="acp_raw", data=payload)


# ── 旧词汇兼容映射（历史回放专用） ─────────────────────────────────────────

_LEGACY_TO_ACP: dict[str, str] = {
    "text_delta": "agent_message_chunk",
    "thinking_delta": "agent_thought_chunk",
    "tool_use": "tool_call",
    "tool_input_delta": "tool_call_update",
    "tool_result": "tool_call_update",
    "usage": "usage_update",
    "action_proposal": "action_proposal",
}


def map_legacy_event(event: Mapping[str, Any]) -> dict[str, Any]:
    """Map an old-vocabulary persisted event onto the ACP vocabulary.

    历史回放路径使用：老 ``events_json`` 数据先经此映射，再送 AG-UI 翻译层，
    保证旧消息 replay 不破。已是新词汇的事件原样返回。
    """
    event_type = str(event.get("type") or "")
    data = event.get("data")
    if not isinstance(data, dict):
        data = {}
    mapped_type = _LEGACY_TO_ACP.get(event_type, event_type)
    if mapped_type == event_type:
        return dict(event)
    if mapped_type == "agent_message_chunk":
        return {
            **event,
            "type": mapped_type,
            "data": {"content": {"text": str(data.get("delta") or data.get("text") or "")}},
        }
    if mapped_type == "agent_thought_chunk":
        return {
            **event,
            "type": mapped_type,
            "data": {"content": {"text": str(data.get("delta") or data.get("text") or "")}},
        }
    if mapped_type == "tool_call":
        return {
            **event,
            "type": mapped_type,
            "data": {
                "tool_call_id": str(data.get("id") or data.get("tool_use_id") or ""),
                "title": str(data.get("name") or data.get("title") or "tool"),
                **({"kind": data["kind"]} if data.get("kind") else {}),
                **({"raw_input": data["input"]} if data.get("input") is not None else {}),
            },
        }
    if mapped_type == "tool_call_update":
        if event_type == "tool_input_delta":
            return {
                **event,
                "type": mapped_type,
                "data": {
                    "tool_call_id": str(
                        data.get("tool_use_id") or data.get("id") or ""
                    ),
                    "status": "in_progress",
                    **({"raw_input": data["delta"]} if data.get("delta") is not None else {}),
                },
            }
        # tool_result
        return {
            **event,
            "type": mapped_type,
            "data": {
                "tool_call_id": str(
                    data.get("tool_use_id") or data.get("id") or ""
                ),
                "status": "failed" if data.get("is_error") else "completed",
                **({"raw_output": data["content"]} if data.get("content") is not None else {}),
            },
        }
    if mapped_type == "usage_update":
        used = data.get("used")
        size = data.get("size")
        return {
            **event,
            "type": mapped_type,
            "data": {
                key: value
                for key, value in data.items()
                if key not in {"usage_kind", "context_window"}
            }
            | ({"used": int(used)} if isinstance(used, (int, float)) else {})
            | ({"size": int(size)} if isinstance(size, (int, float)) else {}),
        }
    return {**event, "type": mapped_type}
