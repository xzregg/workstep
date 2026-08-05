"""InternalEvent — unified event type across all engines."""

from dataclasses import dataclass, field
from typing import Any, Literal, Mapping
import time


def normalize_token_usage(usage: Mapping[str, Any]) -> dict[str, int]:
    """Normalize provider-specific token fields to WorkStep's event schema."""

    def value(*keys: str) -> int:
        for key in keys:
            candidate = usage.get(key)
            if isinstance(candidate, (int, float)) and not isinstance(candidate, bool):
                return int(candidate)
        return 0

    input_tokens = value("input_tokens", "prompt_tokens")
    output_tokens = value("output_tokens", "completion_tokens")
    total_tokens = value("total_tokens", "tokens") or input_tokens + output_tokens
    return {
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
        "usage",            # token usage summary
        "session_started",  # reusable engine session identity
        "error",            # error
    ]
    data: dict = field(default_factory=dict)
    timestamp: int = field(default_factory=lambda: int(time.time() * 1000))

    def to_dict(self) -> dict:
        return {"type": self.type, "data": self.data, "timestamp": self.timestamp}
