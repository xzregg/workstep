"""Versioned wire models shared by Gateway and managed PC clients."""

from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field

PROTOCOL_VERSION = 1


class UnsupportedProtocolVersion(ValueError):
    pass


def assert_protocol_version(version: int) -> None:
    if version != PROTOCOL_VERSION:
        raise UnsupportedProtocolVersion(f"Unsupported gateway protocol version: {version}")


class Capability(StrEnum):
    control = "control"
    proxy_http = "proxy.http"
    proxy_websocket = "proxy.websocket"


class ErrorCode(StrEnum):
    unsupported_version = "unsupported_version"
    invalid_message = "invalid_message"
    unauthorized = "unauthorized"
    device_offline = "device_offline"
    stream_closed = "stream_closed"


class FrameType(StrEnum):
    http_request = "http.request"
    http_response = "http.response"
    websocket_open = "websocket.open"
    websocket_data = "websocket.data"
    websocket_close = "websocket.close"
    cancel = "cancel"
    window_update = "window.update"


class Handshake(BaseModel):
    version: Literal[1]
    capabilities: set[Capability]


class ControlEnvelope(BaseModel):
    version: Literal[1]
    message_id: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    device_id: str = Field(min_length=1)
    sent_at: str
    payload: dict[str, Any]


class ProxyFrame(BaseModel):
    stream_id: str = Field(min_length=1)
    type: FrameType
    payload: dict[str, Any]


__all__ = [
    "PROTOCOL_VERSION", "UnsupportedProtocolVersion", "assert_protocol_version",
    "Capability", "ErrorCode", "FrameType", "Handshake", "ControlEnvelope", "ProxyFrame",
]
