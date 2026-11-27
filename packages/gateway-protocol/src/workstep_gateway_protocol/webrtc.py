"""Shared WebRTC P2P signaling, direct-only ICE validation, and DataChannel framing."""

from __future__ import annotations

import re
import struct
from enum import IntEnum
from ipaddress import ip_address
from urllib.parse import urlsplit

WEBRTC_PROTOCOL_VERSION = 1
WEBRTC_PROXY_CHANNEL_LABEL = "workstep-proxy-v1"
WEBRTC_MAX_SIGNAL_BYTES = 64 * 1024
WEBRTC_BINARY_MAGIC = 0x57  # 'W'
WEBRTC_BINARY_HEADER = struct.Struct("!BBBB")  # magic, version, kind, flags (followed by stream_id_len:1B)
WEBRTC_BINARY_PREFIX = struct.Struct("!BBBBB")  # magic, version, kind, flags, stream_id_len

DEFAULT_PUBLIC_STUN_URLS: tuple[str, ...] = (
    "stun:stun.miwifi.com:3478",
    "stun:stun.chat.bilibili.com:3478",
    "stun:stun.yy.com:3478",
    "stun:stun.cloudflare.com:3478",
    "stun:stun.l.google.com:19302",
)

_RELAY_CANDIDATE_RE = re.compile(r"(?:^|\s)typ\s+relay(?:\s|$)", re.IGNORECASE)
_HOST_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


def _is_valid_stun_host(host: str) -> bool:
    try:
        ip_address(host)
        return True
    except ValueError:
        pass
    if not host or len(host) > 253 or host.startswith(".") or host.endswith(".") or ".." in host:
        return False
    return all(bool(_HOST_LABEL_RE.fullmatch(label)) for label in host.split("."))


def normalize_stun_url(raw: str) -> str:
    """Validate and canonicalize one `stun:` URL or `host[:port]` entry."""
    if not isinstance(raw, str):
        raise ValueError("Invalid STUN server URL")
    cleaned = raw.strip()
    if (
        not cleaned
        or not cleaned.isascii()
        or any(ch.isspace() for ch in cleaned)
        or "\\" in cleaned
        or "://" in cleaned
    ):
        raise ValueError("Invalid STUN server URL")

    if cleaned.lower().startswith("stun:"):
        rest = cleaned[5:]
        if not rest or rest.startswith("//"):
            raise ValueError("Invalid STUN server URL")
    else:
        if not cleaned.startswith("["):
            head, sep, tail = cleaned.partition(":")
            if sep and head.isalpha() and not tail.isdigit():
                raise ValueError("Only stun: STUN server URLs are allowed")
        rest = cleaned

    if rest.endswith(":"):
        raise ValueError("Invalid STUN server port")

    parsed = urlsplit(f"stun://{rest}")
    host = (parsed.hostname or "").lower()
    if (
        not host
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
        or not _is_valid_stun_host(host)
    ):
        raise ValueError("Invalid STUN server host")

    port = 3478 if parsed.port is None else int(parsed.port)
    if port < 1 or port > 65535:
        raise ValueError("Invalid STUN server port")

    authority = f"[{host}]" if ":" in host else host
    return f"stun:{authority}:{port}"


def normalize_stun_urls(values: list[str], *, max_items: int = 16) -> list[str]:
    """Validate, canonicalize, deduplicate, and bound a list of STUN URLs."""
    result: list[str] = []
    for item in values:
        normalized = normalize_stun_url(item)
        if normalized not in result:
            result.append(normalized)
    if len(result) > max_items:
        raise ValueError(f"At most {max_items} STUN servers are allowed")
    return result


class DataChannelBinaryKind(IntEnum):
    """Compact binary DataChannel frame types to avoid base64 overhead."""

    http_request_body = 1
    http_response_body = 2
    websocket_data_bytes = 3
    websocket_data_text = 4


class DataChannelBinaryFlag(IntEnum):
    none = 0
    final = 1


def is_relay_candidate_line(candidate: str) -> bool:
    """Return True if an ICE candidate string advertises a TURN relay candidate."""
    if not isinstance(candidate, str):
        return False
    return bool(_RELAY_CANDIDATE_RE.search(candidate))


def sdp_contains_relay(sdp: str) -> bool:
    """Return True if any line in an SDP payload contains a TURN relay candidate."""
    if not isinstance(sdp, str):
        return False
    for line in sdp.splitlines():
        stripped = line.strip()
        if stripped.startswith(("a=candidate:", "candidate:")) and is_relay_candidate_line(stripped):
            return True
    return False


def is_direct_candidate_type(candidate_type: str | None) -> bool:
    """Only non-relay ICE candidates qualify as pure P2P direct paths."""
    return isinstance(candidate_type, str) and candidate_type.lower() in {"host", "srflx", "prflx"}


def encode_binary_frame(
    kind: DataChannelBinaryKind,
    stream_id: str,
    payload: bytes,
    *,
    final: bool = False,
) -> bytes:
    """Encode a binary DataChannel chunk with a compact 5-byte prefix + stream_id."""
    stream_bytes = stream_id.encode("utf-8")
    if not stream_bytes or len(stream_bytes) > 255:
        raise ValueError("Invalid DataChannel stream_id length")
    flags = int(DataChannelBinaryFlag.final if final else DataChannelBinaryFlag.none)
    header = WEBRTC_BINARY_PREFIX.pack(
        WEBRTC_BINARY_MAGIC,
        WEBRTC_PROTOCOL_VERSION,
        int(kind),
        flags,
        len(stream_bytes),
    )
    return header + stream_bytes + payload


def decode_binary_frame(raw: bytes) -> tuple[DataChannelBinaryKind, str, bool, bytes]:
    """Decode a compact binary DataChannel chunk into (kind, stream_id, final, payload)."""
    if len(raw) < WEBRTC_BINARY_PREFIX.size + 1:
        raise ValueError("Truncated WebRTC binary frame")
    magic, version, kind_val, flags, stream_len = WEBRTC_BINARY_PREFIX.unpack_from(raw, 0)
    if magic != WEBRTC_BINARY_MAGIC or version != WEBRTC_PROTOCOL_VERSION:
        raise ValueError("Unsupported WebRTC binary frame header")
    if stream_len == 0 or len(raw) < WEBRTC_BINARY_PREFIX.size + stream_len:
        raise ValueError("Invalid WebRTC binary stream_id")
    kind = DataChannelBinaryKind(kind_val)
    offset = WEBRTC_BINARY_PREFIX.size
    stream_id = raw[offset : offset + stream_len].decode("utf-8")
    payload = raw[offset + stream_len :]
    final = bool(flags & int(DataChannelBinaryFlag.final))
    return kind, stream_id, final, payload
