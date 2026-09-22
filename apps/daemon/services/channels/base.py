"""Framework-independent channel contract."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable


@dataclass(slots=True)
class LoginResult:
    status: str
    qr_code: str | None = None
    account_id: str | None = None
    error: str | None = None


@dataclass(slots=True)
class MessageContent:
    text: str


@dataclass(slots=True)
class IncomingMessage:
    chat_id: str
    sender_id: str
    text: str


MessageHandler = Callable[[IncomingMessage], Awaitable[None]]
StateHandler = Callable[[LoginResult], Awaitable[None]]


class ChannelBase(ABC):
    channel_type = ""
    display_name = ""
    icon = ""

    def __init__(self, project_id: str, session_dir: Path):
        self.project_id = project_id
        self.session_dir = session_dir
        self._message_handlers: list[MessageHandler] = []
        self._state_handlers: list[StateHandler] = []

    def on_message(self, handler: MessageHandler) -> None:
        self._message_handlers.append(handler)

    def on_login_state_change(self, handler: StateHandler) -> None:
        self._state_handlers.append(handler)

    async def emit_message(self, message: IncomingMessage) -> None:
        for handler in tuple(self._message_handlers):
            await handler(message)

    async def emit_login_state(self, result: LoginResult) -> None:
        for handler in tuple(self._state_handlers):
            await handler(result)

    @abstractmethod
    async def start(self) -> None: ...

    @abstractmethod
    async def stop(self) -> None: ...

    @abstractmethod
    async def login(self) -> LoginResult: ...

    @abstractmethod
    async def logout(self) -> None: ...

    @abstractmethod
    async def is_logged_in(self) -> bool: ...

    @abstractmethod
    async def send_text(self, chat_id: str, text: str) -> None: ...

    async def send_message(self, chat_id: str, content: MessageContent) -> None:
        await self.send_text(chat_id, content.text)
