"""Versioned wire models shared by Gateway and managed PC clients."""

import base64
import binascii
from enum import StrEnum
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

PROTOCOL_VERSION = 1
WEBSOCKET_CHUNK_BYTES = 16384
MAX_WEBSOCKET_MESSAGE_BYTES = 16 * 1024 * 1024


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


def websocket_payloads(kind: Literal["text", "bytes"], data: bytes):
    if kind not in ("text", "bytes") or len(data) > MAX_WEBSOCKET_MESSAGE_BYTES:
        raise ValueError("Invalid WebSocket message")
    for offset in range(0, len(data), WEBSOCKET_CHUNK_BYTES):
        chunk = data[offset:offset + WEBSOCKET_CHUNK_BYTES]
        yield {"kind": kind, "data": base64.b64encode(chunk).decode(),
               "final": offset + len(chunk) >= len(data)}
    if not data:
        yield {"kind": kind, "data": "", "final": True}


class WebSocketMessageAssembler:
    def __init__(self):
        self.kind: str | None = None
        self.parts: list[bytes] = []
        self.size = 0

    def add(self, payload: dict[str, Any]) -> tuple[str, bytes] | None:
        kind = payload.get("kind")
        data = payload.get("data")
        final = payload.get("final")
        if (kind not in ("text", "bytes") or not isinstance(data, str)
                or len(data) > 30000 or type(final) is not bool
                or (self.kind is not None and kind != self.kind)):
            raise ValueError("Invalid WebSocket fragment")
        try:
            chunk = base64.b64decode(data, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("Invalid WebSocket fragment encoding") from exc
        self.size += len(chunk)
        if self.size > MAX_WEBSOCKET_MESSAGE_BYTES:
            raise ValueError("WebSocket message is too large")
        self.kind = kind
        self.parts.append(chunk)
        if not final:
            return None
        result = (kind, b"".join(self.parts))
        self.kind = None
        self.parts = []
        self.size = 0
        return result


class ManagedGatewayPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    gateway_id: str = Field(min_length=1)
    gateway_origin: str
    gateway_public_key_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    deployment_channel: str = Field(min_length=1)
    min_protocol_version: int = Field(ge=1)

    @field_validator("gateway_origin")
    @classmethod
    def secure_origin(cls, value: str) -> str:
        parsed = urlsplit(value)
        if (
            parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path or parsed.query or parsed.fragment or not value.isascii()
            or parsed.netloc != parsed.netloc.lower() or parsed.port == 443
        ):
            raise ValueError("gateway_origin must be an HTTPS origin")
        return value


class SignedManagedGatewayConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    payload: ManagedGatewayPayload
    signature: str = Field(min_length=1)


__all__ = [
    "PROTOCOL_VERSION", "UnsupportedProtocolVersion", "assert_protocol_version",
    "Capability", "ErrorCode", "FrameType", "Handshake", "ControlEnvelope", "ProxyFrame",
    "ManagedGatewayPayload", "SignedManagedGatewayConfig",
    "WEBSOCKET_CHUNK_BYTES", "MAX_WEBSOCKET_MESSAGE_BYTES",
    "websocket_payloads", "WebSocketMessageAssembler",
]
