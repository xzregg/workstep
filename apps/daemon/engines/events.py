"""InternalEvent — unified event type across all engines."""

from dataclasses import dataclass, field
from typing import Literal
import time


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
        "error",            # error
    ]
    data: dict = field(default_factory=dict)
    timestamp: int = field(default_factory=lambda: int(time.time() * 1000))

    def to_dict(self) -> dict:
        return {"type": self.type, "data": self.data, "timestamp": self.timestamp}
