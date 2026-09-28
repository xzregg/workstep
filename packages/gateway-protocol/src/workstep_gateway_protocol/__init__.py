"""Versioned wire models shared by Gateway and managed PC clients."""

from enum import StrEnum
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

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
]
