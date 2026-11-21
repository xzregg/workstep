"""Assistant session identity and accepted turn state."""

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

PROVIDER_HANDOFF_REQUIRED = "供应商已变更。请确认智能交接后继续，或开启新会话。"


def provider_context_changed(previous: str | None, selected: str) -> bool:
    """Treat an unknown legacy binding as unverified on a WorkStep provider."""
    if previous is None:
        return bool(selected)
    return previous != selected


@dataclass
class AssistantSession:
    """One in-memory assistant conversation."""

    session_id: str
    project_id: str
    scope: str
    scope_key: str | None = None
    cwd: str = ""
    engine: str = ""
    model: str | None = None
    fast_model: str | None = None
    vision_model: str | None = None
    resolved_session_id: str | None = None
    messages: list[dict] = field(default_factory=list)
    steps: dict | None = None
    extra: dict = field(default_factory=dict)
    engine_state: Any = None
    session_provider: str | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_active: float = field(default_factory=time.monotonic)


@dataclass(frozen=True, slots=True)
class AcceptedTurn:
    session_id: str
    turn_id: str
    assistant_message_id: str
    status: str

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "turn_id": self.turn_id,
            "assistant_message_id": self.assistant_message_id,
            "status": self.status,
        }
