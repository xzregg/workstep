"""Assistant session identity and accepted turn state."""

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any


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
