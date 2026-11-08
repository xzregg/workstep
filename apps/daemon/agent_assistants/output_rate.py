"""Compact generation-rate sample, matching web/utils/outputRate.ts."""
from typing import Any


class OutputRateSampler:
    def __init__(self):
        self.started_at: int | None = None
        self.last_at: int | None = None
        self.units = 0
        self.last_sample: dict[str, int] | None = None

    def record(self, event: dict[str, Any], at: int | None) -> None:
        kind = event.get("type")
        if kind in {"tool_call", "tool_call_update", "interaction_request"}:
            self.started_at = None
            self.last_at = None
            self.units = 0
            return
        data = event.get("data") or {}
        if kind not in {"agent_message_chunk", "agent_thought_chunk"} or data.get("role") == "user":
            return
        text = (data.get("content") or {}).get("text", "")
        if not isinstance(text, str) or not text or at is None:
            return
        if self.last_at is not None and at < self.last_at:
            return
        self.last_at = at
        if self.started_at is None:
            self.started_at = at
            return
        units = sum(
            4 if (0x4e00 <= ord(ch) <= 0x9fff
                  or 0x3400 <= ord(ch) <= 0x4dbf
                  or 0x3040 <= ord(ch) <= 0x30ff
                  or 0xac00 <= ord(ch) <= 0xd7af
                  or 0xf900 <= ord(ch) <= 0xfaff) else 1
            for ch in text
        )
        self.units += units
        elapsed = at - self.started_at
        if elapsed > 0:
            self.last_sample = {
                "units": self.units,
                "elapsed_ms": elapsed,
            }
