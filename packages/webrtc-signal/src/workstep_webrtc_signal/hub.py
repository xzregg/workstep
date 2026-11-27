"""In-memory Ed25519-verified device signaling hub for direct-only WebRTC."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import WebSocket

from workstep_gateway_protocol.webrtc import (
    WEBRTC_MAX_SIGNAL_BYTES,
    is_relay_candidate_line,
    sdp_contains_relay,
)

DEVICE_SIGNAL_PREFIX = "workstep-webrtc-device-v1"
GATEWAY_BIND_PREFIX = "workstep-webrtc-gateway-bind-v1"
ALLOWED_CLIENT_SIGNAL_TYPES = frozenset({"offer", "ice_candidate", "ice_restart", "bye", "ping"})
ALLOWED_DEVICE_SIGNAL_TYPES = frozenset({"answer", "ice_candidate", "ice_restart", "bye", "ping", "update_pair_key"})


class SignalingError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class PairRateLimitError(SignalingError):
    pass


def _decode_b64url(value: str) -> bytes:
    if not value or len(value) > 4096:
        raise ValueError("Invalid signature encoding")
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def hash_pair_key(pair_key: str, salt: str) -> str:
    return hashlib.sha256(f"{salt}:{pair_key}".encode("utf-8")).hexdigest()


def verify_ed25519_signature(public_key_pem: str, message: str, signature_b64: str) -> Ed25519PublicKey:
    key = serialization.load_pem_public_key(public_key_pem.encode("ascii"))
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError("Device public key must be Ed25519")
    key.verify(_decode_b64url(signature_b64), message.encode("utf-8"))
    return key


def ed25519_fingerprint(key: Ed25519PublicKey) -> str:
    der = key.public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return hashlib.sha256(der).hexdigest()


@dataclass
class DeviceConnection:
    device_id: str
    device_name: str
    public_key_pem: str
    pair_key_salt: str
    pair_key_verifier: str
    ws: WebSocket
    connection_ip: str | None = None
    gateway_key_fingerprint: str | None = None
    connected_at: float = field(default_factory=time.time)


@dataclass
class ClientSession:
    session_id: str
    device_id: str
    token_hash: str
    p2p_ticket: str
    expires_at: float
    stun_urls: list[str] = field(default_factory=list)
    ws: WebSocket | None = None
    ticket_delivered: bool = False


class SignalingHub:
    """Zero-database signaling state for device presence, pairing, and SDP/ICE relay."""

    def __init__(
        self,
        *,
        pair_max_failures: int = 10,
        pair_window_seconds: float = 60.0,
        session_ttl_seconds: int = 300,
    ) -> None:
        self.pair_max_failures = pair_max_failures
        self.pair_window_seconds = pair_window_seconds
        self.session_ttl_seconds = session_ttl_seconds
        self._devices: dict[str, DeviceConnection] = {}
        self._sessions: dict[str, ClientSession] = {}
        self._pair_failures: dict[tuple[str, str], deque[float]] = {}
        self.relayed_messages: int = 0

    def get_device(self, device_id: str) -> DeviceConnection | None:
        return self._devices.get(device_id)

    def list_devices(self) -> list[dict[str, Any]]:
        now = time.time()
        session_counts: dict[str, int] = {}
        for sess in self._sessions.values():
            if sess.expires_at > now and sess.ws is not None:
                session_counts[sess.device_id] = session_counts.get(sess.device_id, 0) + 1
        items = [
            {
                "device_id": device.device_id,
                "device_name": device.device_name,
                "online": True,
                "connection_ip": device.connection_ip,
                "connected_at": device.connected_at,
                "gateway_key_fingerprint": device.gateway_key_fingerprint,
                "active_sessions": session_counts.get(device.device_id, 0),
            }
            for device in self._devices.values()
        ]
        items.sort(key=lambda item: (-item["connected_at"], item["device_id"]))
        return items

    def device_summary(self, device_id: str) -> dict[str, Any]:
        device = self._devices.get(device_id)
        if device is None:
            return {"online": False, "device_id": device_id, "device_name": ""}
        return {
            "online": True,
            "device_id": device.device_id,
            "device_name": device.device_name,
        }

    async def register_device(
        self,
        *,
        nonce: str,
        payload: dict[str, Any],
        ws: WebSocket,
        client_ip: str | None = None,
    ) -> DeviceConnection:
        device_id = str(payload.get("device_id") or "").strip()
        device_name = str(payload.get("device_name") or "").strip()
        public_key_pem = str(payload.get("public_key_pem") or "")
        signature = str(payload.get("signature") or "")
        pair_salt = str(payload.get("pair_key_salt") or "").strip()
        pair_verifier = str(payload.get("pair_key_verifier") or "").strip()
        if (
            not device_id
            or len(device_id) > 128
            or not device_name
            or len(device_name) > 128
            or not pair_salt
            or len(pair_salt) > 128
            or len(pair_verifier) != 64
        ):
            raise SignalingError("invalid_registration", "Invalid device registration payload")

        signed_body = f"{DEVICE_SIGNAL_PREFIX}:{nonce}:{device_id}:{pair_verifier}"
        try:
            webrtc_key = verify_ed25519_signature(public_key_pem, signed_body, signature)
        except (ValueError, InvalidSignature, UnicodeDecodeError) as exc:
            raise SignalingError("invalid_signature", "Device signature verification failed") from exc

        gateway_fp: str | None = None
        gw_public_pem = str(payload.get("gateway_public_key_pem") or "")
        gw_signature = str(payload.get("gateway_binding_signature") or "")
        if gw_public_pem or gw_signature:
            if not gw_public_pem or not gw_signature:
                raise SignalingError("invalid_signature", "Incomplete gateway device binding")
            bind_body = f"{GATEWAY_BIND_PREFIX}:{nonce}:{device_id}:{ed25519_fingerprint(webrtc_key)}"
            try:
                gw_key = verify_ed25519_signature(gw_public_pem, bind_body, gw_signature)
            except (ValueError, InvalidSignature, UnicodeDecodeError) as exc:
                raise SignalingError("invalid_signature", "Gateway device binding verification failed") from exc
            gateway_fp = ed25519_fingerprint(gw_key)

        existing = self._devices.get(device_id)
        if existing is not None and existing.ws is not ws:
            if existing.public_key_pem != public_key_pem:
                raise SignalingError("device_conflict", "Device ID is already bound to another key")
            try:
                await existing.ws.close(code=4000, reason="replaced by new connection")
            except Exception:
                pass

        record = DeviceConnection(
            device_id=device_id,
            device_name=device_name,
            public_key_pem=public_key_pem,
            pair_key_salt=pair_salt,
            pair_key_verifier=pair_verifier,
            ws=ws,
            connection_ip=client_ip,
            gateway_key_fingerprint=gateway_fp,
        )
        self._devices[device_id] = record
        return record

    def unregister_device(self, device_id: str, ws: WebSocket) -> None:
        existing = self._devices.get(device_id)
        if existing is not None and existing.ws is ws:
            self._devices.pop(device_id, None)

    def update_device_pair_key(self, device_id: str, ws: WebSocket, payload: dict[str, Any]) -> None:
        record = self._devices.get(device_id)
        if record is None or record.ws is not ws:
            raise SignalingError("device_offline", "Device is not connected")
        pair_salt = str(payload.get("pair_key_salt") or "").strip()
        pair_verifier = str(payload.get("pair_key_verifier") or "").strip()
        if not pair_salt or len(pair_salt) > 128 or len(pair_verifier) != 64:
            raise SignalingError("invalid_pair_key", "Invalid pair key update")
        record.pair_key_salt = pair_salt
        record.pair_key_verifier = pair_verifier

    def _issue_client_session(
        self,
        device: DeviceConnection,
        *,
        stun_urls: list[str] | None = None,
    ) -> dict[str, Any]:
        self._prune_expired_sessions()
        session_id = secrets.token_hex(16)
        session_token = secrets.token_urlsafe(32)
        p2p_ticket = secrets.token_urlsafe(32)
        session = ClientSession(
            session_id=session_id,
            device_id=device.device_id,
            token_hash=hashlib.sha256(session_token.encode("utf-8")).hexdigest(),
            p2p_ticket=p2p_ticket,
            expires_at=time.time() + self.session_ttl_seconds,
            stun_urls=list(stun_urls or []),
        )
        self._sessions[session_id] = session
        return {
            "session_id": session_id,
            "session_token": session_token,
            "p2p_ticket": p2p_ticket,
            "device_id": device.device_id,
            "device_name": device.device_name,
            "direct_only": True,
        }

    def pair_authorized_client(
        self,
        *,
        device_id: str,
        stun_urls: list[str] | None = None,
    ) -> dict[str, Any]:
        device = self._devices.get(device_id)
        if device is None:
            raise SignalingError("device_offline", "Target device is offline")
        return self._issue_client_session(device, stun_urls=stun_urls)

    def pair_client(
        self,
        *,
        device_id: str,
        pair_key: str,
        client_ip: str = "",
        stun_urls: list[str] | None = None,
    ) -> dict[str, Any]:
        now = time.monotonic()
        bucket_key = (client_ip or "unknown", device_id)
        bucket = self._pair_failures.setdefault(bucket_key, deque())
        cutoff = now - self.pair_window_seconds
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if len(bucket) >= self.pair_max_failures:
            raise PairRateLimitError("rate_limited", "Too many failed pairing attempts")

        device = self._devices.get(device_id)
        if device is None:
            raise SignalingError("device_offline", "Target device is offline")

        candidate = hash_pair_key(pair_key, device.pair_key_salt)
        if not pair_key or not hmac.compare_digest(candidate, device.pair_key_verifier):
            bucket.append(now)
            raise SignalingError("invalid_pair_key", "Invalid pairing key")

        bucket.clear()
        return self._issue_client_session(device, stun_urls=stun_urls)

    def _prune_expired_sessions(self) -> None:
        now = time.time()
        expired = [sid for sid, sess in self._sessions.items() if sess.expires_at <= now and sess.ws is None]
        for sid in expired:
            self._sessions.pop(sid, None)

    def authenticate_client_ws(self, *, device_id: str, token: str, ws: WebSocket) -> ClientSession:
        if not token or not device_id:
            raise SignalingError("unauthorized", "Missing signaling token")
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        now = time.time()
        matched = next(
            (
                sess
                for sess in self._sessions.values()
                if sess.device_id == device_id
                and sess.expires_at > now
                and hmac.compare_digest(sess.token_hash, token_hash)
            ),
            None,
        )
        if matched is None:
            raise SignalingError("unauthorized", "Invalid or expired signaling session")
        if device_id not in self._devices:
            raise SignalingError("device_offline", "Target device is offline")
        matched.ws = ws
        return matched

    def detach_client_ws(self, session_id: str, ws: WebSocket) -> None:
        sess = self._sessions.get(session_id)
        if sess is not None and sess.ws is ws:
            sess.ws = None

    @staticmethod
    def _validate_signal_payload(msg: dict[str, Any]) -> None:
        msg_type = msg.get("type")
        if msg_type in {"offer", "answer"}:
            sdp = msg.get("sdp")
            if not isinstance(sdp, str) or not sdp.strip():
                raise SignalingError("invalid_sdp", "SDP payload is required")
            if sdp_contains_relay(sdp):
                raise SignalingError("relay_not_allowed", "TURN relay candidates are forbidden in direct-only mode")
        elif msg_type == "ice_candidate":
            candidate = msg.get("candidate")
            if candidate is not None:
                if not isinstance(candidate, str):
                    raise SignalingError("invalid_candidate", "ICE candidate must be a string")
                if is_relay_candidate_line(candidate):
                    raise SignalingError("relay_not_allowed", "TURN relay candidates are forbidden in direct-only mode")

    async def forward_from_client(self, session: ClientSession, raw_text: str, msg: dict[str, Any]) -> dict[str, Any] | None:
        if len(raw_text.encode("utf-8")) > WEBRTC_MAX_SIGNAL_BYTES:
            raise SignalingError("payload_too_large", "Signaling message exceeds size limit")
        msg_type = msg.get("type")
        if msg_type not in ALLOWED_CLIENT_SIGNAL_TYPES:
            raise SignalingError("unsupported_signal", f"Unsupported client signal type: {msg_type}")
        if msg_type == "ping":
            return {"type": "pong", "nonce": msg.get("nonce")}
        self._validate_signal_payload(msg)

        device = self._devices.get(session.device_id)
        if device is None:
            raise SignalingError("device_offline", "Target device is offline")

        forwarded = {k: v for k, v in msg.items() if k not in {"p2p_ticket", "session_id", "stun_urls"}}
        forwarded["session_id"] = session.session_id
        if msg_type in {"offer", "ice_restart"} or not session.ticket_delivered:
            forwarded["p2p_ticket"] = session.p2p_ticket
            session.ticket_delivered = True
        if msg_type in {"offer", "ice_restart"} and session.stun_urls:
            forwarded["stun_urls"] = list(session.stun_urls)
        self.relayed_messages += 1
        await device.ws.send_json(forwarded)
        return None

    async def forward_from_device(self, device: DeviceConnection, raw_text: str, msg: dict[str, Any]) -> dict[str, Any] | None:
        if len(raw_text.encode("utf-8")) > WEBRTC_MAX_SIGNAL_BYTES:
            raise SignalingError("payload_too_large", "Signaling message exceeds size limit")
        msg_type = msg.get("type")
        if msg_type not in ALLOWED_DEVICE_SIGNAL_TYPES:
            raise SignalingError("unsupported_signal", f"Unsupported device signal type: {msg_type}")
        if msg_type == "ping":
            return {"type": "pong", "nonce": msg.get("nonce")}
        if msg_type == "update_pair_key":
            self.update_device_pair_key(device.device_id, device.ws, msg)
            return {"type": "pair_key_updated"}
        self._validate_signal_payload(msg)

        session_id = str(msg.get("session_id") or "")
        session = self._sessions.get(session_id)
        if session is None or session.device_id != device.device_id or session.ws is None:
            return None
        forwarded = {k: v for k, v in msg.items() if k != "p2p_ticket"}
        self.relayed_messages += 1
        await session.ws.send_json(forwarded)
        return None
