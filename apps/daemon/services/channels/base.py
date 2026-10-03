"""Platform-independent channel message protocol (version 1)."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Literal

CHANNEL_PROTOCOL_VERSION = 1
MediaKind = Literal['image', 'file']


@dataclass(frozen=True, slots=True)
class ChannelCapabilities:
    receive: frozenset[str] = frozenset({'text'})
    send: frozenset[str] = frozenset({'text'})
    waiting: bool = False
    streaming: bool = False
    file_extensions: frozenset[str] | None = None
    max_image_bytes: int = 2 * 1024 * 1024
    max_file_bytes: int = 20 * 1024 * 1024

    def limit(self, kind: str) -> int:
        return self.max_image_bytes if kind == 'image' else self.max_file_bytes


@dataclass(frozen=True, slots=True)
class ChannelAttachment:
    kind: MediaKind
    name: str = ''
    mime_type: str = 'application/octet-stream'
    path: str = ''
    data: bytes = field(default=b'', repr=False)
    reference: dict = field(default_factory=dict, repr=False, compare=False)


@dataclass(frozen=True, slots=True)
class IncomingMessage:
    bot_id: str
    message_id: str
    conversation_type: str
    conversation_id: str
    sender_id: str
    text: str
    sender_name: str = ''
    reply_context: object | None = field(default=None, repr=False)
    attachments: tuple[ChannelAttachment, ...] = ()


@dataclass(frozen=True, slots=True)
class OutgoingMessage:
    text: str = ''
    attachments: tuple[ChannelAttachment, ...] = ()


class ChannelAdapter(ABC):
    CHANNEL_ID: str = ''
    DISPLAY_NAME: str = ''
    CAPABILITIES = ChannelCapabilities()

    def __init__(self, bot: dict, on_message, on_state):
        self._bot = bot
        self._on_message = on_message
        self._on_state = on_state

    @abstractmethod
    async def start(self) -> None: ...

    @abstractmethod
    async def stop(self) -> None: ...

    @abstractmethod
    async def send(self, recipient: IncomingMessage, message: OutgoingMessage) -> None: ...

    async def send_text(self, recipient: IncomingMessage, text: str) -> None:
        await self.send(recipient, OutgoingMessage(text=text))

    async def start_reply(self, message: IncomingMessage) -> None:
        """Optional waiting indicator; callers inspect CAPABILITIES.waiting."""

    async def update_reply(self, message: IncomingMessage, text: str) -> None:
        """Replace an in-progress reply with cumulative text when streaming is supported."""
        raise ValueError(f'{self.DISPLAY_NAME}不支持流式回复')

    async def download(self, attachment: ChannelAttachment) -> tuple[bytes, str]:
        raise ValueError(f'{self.DISPLAY_NAME}不支持附件下载')

    def validate_outgoing(self, message: OutgoingMessage):
        if not message.text.strip() and not message.attachments:
            raise ValueError('渠道消息不能为空')
        if message.text and 'text' not in self.CAPABILITIES.send:
            raise ValueError(f'{self.DISPLAY_NAME}不支持文本发送')
        if len(message.attachments) > 10:
            raise ValueError('单次最多发送 10 个附件')
        for attachment in message.attachments:
            if attachment.kind not in self.CAPABILITIES.send:
                raise ValueError(f'{self.DISPLAY_NAME}不支持发送{attachment.kind}')
            if attachment.kind == 'file' and self.CAPABILITIES.file_extensions is not None:
                from pathlib import Path
                if Path(attachment.name).suffix.lower().lstrip('.') not in self.CAPABILITIES.file_extensions:
                    raise ValueError(f'{self.DISPLAY_NAME}不支持此文件格式')
            if not attachment.data or len(attachment.data) > self.CAPABILITIES.limit(attachment.kind):
                raise ValueError('附件为空或超过渠道大小限制')
