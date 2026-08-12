"""InternalEvent — unified event type across all engines."""

from dataclasses import dataclass, field
from typing import Any, Literal, Mapping
import time


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

    All engine stdout streams are parsed into this common format.
    """

    type: Literal[
        "status",           # status change (initializing / running / done)
        "text_delta",       # assistant text increment
        "thinking_delta",   # thinking/reasoning increment
        "tool_use",         # tool call (complete)
        "tool_input_delta", # tool input increment (real-time only, not persisted)
        "tool_result",      # tool execution result
        "interaction_request",  # ACP permission / form elicitation request
        "interaction_response", # user response to an interaction request
        "plan",              # ACP stable execution-plan snapshot
        "subagent",          # subagent / background task lifecycle event
        "compacted",        # engine auto-compacted its context window
        "usage",            # token usage summary
        "session_started",  # reusable engine session identity
        "live_message",     # queued live-stage message delivery state
        "engine_state",     # serializable in-process engine state snapshot
        "error",            # error
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
