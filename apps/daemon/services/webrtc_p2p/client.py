"""Outbound WebRTC signaling client and persistent configuration service."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import secrets
import threading
import time
from ipaddress import ip_address
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed
from workstep_gateway_protocol.origin import is_private_gateway_hostname
from workstep_gateway_protocol.webrtc import valid_pair_key

from .peer import WebRtcPeerSession
from .connectivity import probe_stun

logger = logging.getLogger(__name__)

DEVICE_SIGNAL_PREFIX = "workstep-webrtc-device-v1"
GATEWAY_BIND_PREFIX = "workstep-webrtc-gateway-bind-v1"
MAX_CONCURRENT_P2P_SESSIONS = 8
SIGNAL_CHECK_TIMEOUT = 6.0


def normalize_signal_url(value: str) -> str:
    """Validate and canonicalize a WebRTC signaling server origin."""
    cleaned = value.strip().rstrip("/")
    if not cleaned:
        return ""
    parsed = urlsplit(cleaned)
    host = parsed.hostname
    if (
        not cleaned.isascii()
        or any(ch.isspace() for ch in cleaned)
        or "\\" in cleaned
        or not host
        or parsed.username
        or parsed.password
        or parsed.path
        or parsed.query
        or parsed.fragment
        or parsed.scheme not in {"https", "http", "wss", "ws"}
    ):
        raise ValueError("Invalid WebRTC signaling server URL")
    http_scheme = "https" if parsed.scheme in {"https", "wss"} else "http"
    if http_scheme == "http" and not is_private_gateway_hostname(host):
        try:
            is_priv = ip_address(host).is_private or ip_address(host).is_loopback
        except ValueError:
            is_priv = False
        if not is_priv:
            raise ValueError("Signaling URL requires HTTPS or a private/loopback network HTTP host")
    authority = f"[{host}]" if ":" in host else host
    if parsed.port is not None:
        if parsed.port == 0:
            raise ValueError("Invalid port")
        if parsed.port != (443 if http_scheme == "https" else 80):
            authority += f":{parsed.port}"
    return f"{http_scheme}://{authority}"


def device_ws_url(signal_url: str) -> str:
    parsed = urlsplit(signal_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return f"{scheme}://{parsed.netloc}/ws/webrtc/device"


def _hash_pair_key(pair_key: str, salt: str) -> str:
    return hashlib.sha256(f"{salt}:{pair_key}".encode("utf-8")).hexdigest()


def _load_or_create_identity(config_dir: Path) -> tuple[Ed25519PrivateKey, str]:
    config_dir.mkdir(parents=True, exist_ok=True)
    path = config_dir / "webrtc-identity.json"
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        private_key = serialization.load_pem_private_key(
            data["private_key"].encode("ascii"),
            password=None,
        )
        if not isinstance(private_key, Ed25519PrivateKey):
            raise ValueError("Invalid WebRTC device identity key")
    else:
        private_key = Ed25519PrivateKey.generate()
        pem = private_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode("ascii")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fp:
            json.dump({"private_key": pem}, fp)
    public_pem = private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")
    return private_key, public_pem


def _load_gateway_binding_key(config_dir: Path, store) -> Ed25519PrivateKey | None:
    """Return this installation's authorized Gateway device Ed25519 key if bound."""
    gateway = store.get("gateway_platform", {})
    if not isinstance(gateway, dict) or not gateway.get("authorized"):
        return None
    identities_dir = config_dir / "gateway-identities"
    candidates: list[Path] = []
    gateway_id = str(gateway.get("gateway_id") or "").strip()
    fingerprint = str(gateway.get("fingerprint") or "").strip()
    origin = str(gateway.get("url") or "").strip()
    if gateway_id and fingerprint:
        candidates.append(
            identities_dir / f"platform-{hashlib.sha256(f'{gateway_id}:{fingerprint}'.encode()).hexdigest()}.json"
        )
    if origin:
        candidates.append(
            identities_dir / f"{hashlib.sha256(origin.encode()).hexdigest()}.json"
        )
    for path in candidates:
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            key = serialization.load_pem_private_key(
                str(data["private_key"]).encode("ascii"),
                password=None,
            )
        except (OSError, ValueError, KeyError, TypeError, UnicodeEncodeError):
            continue
        if isinstance(key, Ed25519PrivateKey):
            return key
    return None


class WebRtcClientService:
    """Manages host WebRTC P2P configuration, signaling connection, and peer sessions."""

    def __init__(
        self,
        *,
        config_store=None,
        config_dir_provider=None,
        connector=connect,
    ) -> None:
        self._config_store = config_store
        self._config_dir_provider = config_dir_provider
        self.connector = connector
        self.asgi_app = None
        self.event_sink = None
        self.scope_token = object()
        self._state_lock = threading.RLock()
        self._stop = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._active_ws = None
        self._sessions: dict[str, WebRtcPeerSession] = {}
        self.online = False
        self.last_error = ""
        self._stun_urls: list[str] = []
        self._signal_checked = asyncio.Event()
        self.heartbeat_interval: float = 20.0
        self.heartbeat_timeout: float = 45.0
        self._last_rx_monotonic: float = 0.0

    def _store(self):
        if self._config_store is None:
            from services.config import config_store
            return config_store
        return self._config_store

    def _config_dir(self) -> Path:
        if self._config_dir_provider is not None:
            return Path(self._config_dir_provider())
        from services import config as config_module
        return Path(config_module.CONFIG_DIR)

    def _ensure_section_sync(self) -> dict[str, Any]:
        store = self._store()
        with self._state_lock:
            raw = store.get("webrtc_p2p", {})
            section = dict(raw) if isinstance(raw, dict) else {}
            changed = False
            if not valid_pair_key(section.get("pair_key")) or not section.get("pair_key_salt") or not section.get("pair_key_verifier"):
                pair_key = secrets.token_urlsafe(24)
                salt = secrets.token_hex(16)
                section["pair_key"] = pair_key
                section["pair_key_salt"] = salt
                section["pair_key_verifier"] = _hash_pair_key(pair_key, salt)
                changed = True
            if "enabled" not in section:
                section["enabled"] = False
                changed = True
            if "signal_url" not in section:
                section["signal_url"] = ""
                changed = True
            if changed:
                store.set("webrtc_p2p", section)
            return section

    def _settings_sync(self) -> dict[str, Any]:
        store = self._store()
        section = self._ensure_section_sync()
        device = store.get_device_identity()
        signal_url = str(section.get("signal_url") or "")
        device_id = device["device_id"]
        return {
            "enabled": bool(section.get("enabled", False)),
            "signal_url": signal_url,
            "device_id": device_id,
            "device_name": device["device_name"],
            "pair_key": str(section.get("pair_key") or ""),
            "p2p_url": f"{signal_url}/p2p/{device_id}/" if signal_url else "",
            "online": self.online,
            "active_peers": len(self._sessions),
            "direct_only": True,
            "last_error": self.last_error,
        }

    def verify_pair_key(self, candidate: str) -> bool:
        section = self._ensure_section_sync()
        salt = str(section.get("pair_key_salt") or "")
        verifier = str(section.get("pair_key_verifier") or "")
        if not valid_pair_key(candidate) or not salt or not verifier:
            return False
        import hmac
        return hmac.compare_digest(_hash_pair_key(candidate, salt), verifier)

    async def get_settings(self) -> dict[str, Any]:
        return await asyncio.to_thread(self._settings_sync)

    async def verify_remote_pair_key(self, candidate: str) -> bool:
        return await asyncio.to_thread(self.verify_pair_key, candidate)

    async def get_status(self) -> dict[str, Any]:
        settings = await self.get_settings()
        return {
            "enabled": settings["enabled"],
            "online": self.online,
            "device_id": settings["device_id"],
            "device_name": settings["device_name"],
            "active_peers": len(self._sessions),
            "peers": [
                {
                    "session_id": sid,
                    "candidate_info": sess.candidate_info,
                }
                for sid, sess in self._sessions.items()
            ],
            "direct_only": True,
            "last_error": self.last_error,
        }

    async def check_connectivity(self) -> dict[str, Any]:
        settings = await self.get_settings()
        if not settings["enabled"]:
            return {"signaling": False, "stun": None}
        generation = self._task
        try:
            await asyncio.wait_for(self._signal_checked.wait(), timeout=SIGNAL_CHECK_TIMEOUT)
        except asyncio.TimeoutError:
            return {"signaling": False, "stun": None}
        if not self.online or generation is not self._task:
            return {"signaling": False, "stun": None}
        reachable = await probe_stun(self._stun_urls)
        if not self.online or generation is not self._task:
            return {"signaling": False, "stun": None}
        return {"signaling": True, "stun": reachable}

    async def update_settings(self, *, enabled: bool, signal_url: str) -> dict[str, Any]:
        normalized = normalize_signal_url(signal_url) if signal_url.strip() else ""
        if enabled and not normalized:
            raise ValueError("Signaling server URL is required when WebRTC P2P is enabled")

        def _save():
            with self._state_lock:
                section = self._ensure_section_sync()
                section["enabled"] = bool(enabled)
                section["signal_url"] = normalized
                self._store().set("webrtc_p2p", section)
                return self._settings_sync()

        result = await asyncio.to_thread(_save)
        await self.restart()
        return result

    async def rotate_pair_key(self) -> dict[str, Any]:
        def _rotate():
            with self._state_lock:
                section = self._ensure_section_sync()
                pair_key = secrets.token_urlsafe(24)
                salt = secrets.token_hex(16)
                section["pair_key"] = pair_key
                section["pair_key_salt"] = salt
                section["pair_key_verifier"] = _hash_pair_key(pair_key, salt)
                self._store().set("webrtc_p2p", section)
                return section, self._settings_sync()

        section, result = await asyncio.to_thread(_rotate)
        sessions = list(self._sessions.values())
        self._sessions.clear()
        if sessions:
            await asyncio.gather(*(session.close() for session in sessions), return_exceptions=True)
        ws = self._active_ws
        if ws is not None and self.online:
            try:
                await ws.send(json.dumps({
                    "type": "update_pair_key",
                    "pair_key_salt": section["pair_key_salt"],
                    "pair_key_verifier": section["pair_key_verifier"],
                }))
            except Exception:
                pass
        return result

    async def start(self) -> None:
        settings = await self.get_settings()
        if not settings["enabled"] or not settings["signal_url"]:
            return
        if self._task is not None and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run_loop(settings["signal_url"]))

    async def restart(self) -> None:
        await self.close()
        await self.start()

    async def close(self) -> None:
        self._stop.set()
        self._signal_checked.clear()
        self._stun_urls = []
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        self._active_ws = None
        self.online = False
        sessions = list(self._sessions.values())
        self._sessions.clear()
        if sessions:
            await asyncio.gather(*(s.close() for s in sessions), return_exceptions=True)

    async def _run_loop(self, signal_url: str) -> None:
        ws_endpoint = device_ws_url(signal_url)
        delay = 1.0
        while not self._stop.is_set():
            self._signal_checked.clear()
            try:
                async with self.connector(ws_endpoint, open_timeout=10, max_size=256 * 1024) as ws:
                    challenge = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
                    nonce = challenge.get("nonce")
                    if challenge.get("type") != "challenge" or not isinstance(nonce, str):
                        raise ValueError("Invalid signaling challenge")

                    settings = await self.get_settings()
                    section = await asyncio.to_thread(self._ensure_section_sync)
                    private_key, public_pem = await asyncio.to_thread(
                        _load_or_create_identity,
                        self._config_dir(),
                    )
                    gateway_key = await asyncio.to_thread(
                        _load_gateway_binding_key,
                        self._config_dir(),
                        self._store(),
                    )
                    device_id = settings["device_id"]
                    device_name = settings["device_name"]
                    verifier = section["pair_key_verifier"]
                    signed_body = f"{DEVICE_SIGNAL_PREFIX}:{nonce}:{device_id}:{verifier}".encode("utf-8")
                    signature = base64.urlsafe_b64encode(private_key.sign(signed_body)).rstrip(b"=").decode("ascii")

                    register_payload: dict[str, Any] = {
                        "type": "register",
                        "device_id": device_id,
                        "device_name": device_name,
                        "public_key_pem": public_pem,
                        "signature": signature,
                        "pair_key_salt": section["pair_key_salt"],
                        "pair_key_verifier": verifier,
                    }
                    if gateway_key is not None:
                        webrtc_fp = hashlib.sha256(
                            private_key.public_key().public_bytes(
                                serialization.Encoding.DER,
                                serialization.PublicFormat.SubjectPublicKeyInfo,
                            )
                        ).hexdigest()
                        gw_pub_pem = gateway_key.public_key().public_bytes(
                            serialization.Encoding.PEM,
                            serialization.PublicFormat.SubjectPublicKeyInfo,
                        ).decode("ascii")
                        bind_body = f"{GATEWAY_BIND_PREFIX}:{nonce}:{device_id}:{webrtc_fp}".encode("utf-8")
                        gw_sig = base64.urlsafe_b64encode(gateway_key.sign(bind_body)).rstrip(b"=").decode("ascii")
                        register_payload["gateway_public_key_pem"] = gw_pub_pem
                        register_payload["gateway_binding_signature"] = gw_sig

                    await ws.send(json.dumps(register_payload))
                    reg_ack = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
                    if reg_ack.get("type") != "registered":
                        raise ValueError(reg_ack.get("message") or "Signaling registration rejected")

                    self._active_ws = ws
                    self.online = True
                    self.last_error = ""
                    delay = 1.0
                    self._last_rx_monotonic = time.monotonic()

                    # Fetch STUN URLs once via HTTP or infer from signaling host
                    stun_urls = await self._fetch_stun_urls(signal_url, device_id)
                    self._stun_urls = stun_urls
                    self._signal_checked.set()

                    heartbeat = asyncio.create_task(self._heartbeat(ws))
                    try:
                        while not self._stop.is_set():
                            raw = await ws.recv()
                            self._last_rx_monotonic = time.monotonic()
                            msg = json.loads(raw)
                            await self._handle_signal_message(ws, msg, device_id, stun_urls)
                    finally:
                        heartbeat.cancel()
                        await asyncio.gather(heartbeat, return_exceptions=True)
            except asyncio.CancelledError:
                raise
            except (ConnectionClosed, OSError, asyncio.TimeoutError, ValueError) as exc:
                self.online = False
                self._active_ws = None
                self.last_error = str(exc) or type(exc).__name__
                self._signal_checked.set()
                logger.debug("WebRTC signaling reconnect in %.1fs (%s)", delay, self.last_error)
            finally:
                self.online = False
                self._active_ws = None

            try:
                await asyncio.wait_for(self._stop.wait(), timeout=delay)
                break
            except asyncio.TimeoutError:
                delay = min(30.0, delay * 2)

    async def _fetch_stun_urls(self, signal_url: str, device_id: str) -> list[str]:
        import httpx
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{signal_url}/api/webrtc/config", params={"device_id": device_id})
                if resp.status_code == 200:
                    urls = resp.json().get("stun_urls")
                    if isinstance(urls, list) and urls:
                        return [str(u) for u in urls]
        except Exception:
            pass
        parsed = urlsplit(signal_url)
        host = parsed.hostname or "127.0.0.1"
        return [f"stun:{host}:3478"]

    async def _heartbeat(self, ws) -> None:
        while not self._stop.is_set():
            await asyncio.sleep(self.heartbeat_interval)
            if time.monotonic() - self._last_rx_monotonic > self.heartbeat_timeout:
                logger.info("WebRTC signaling heartbeat timed out; reconnecting")
                try:
                    await asyncio.wait_for(ws.close(), timeout=1.0)
                except Exception:
                    transport = getattr(ws, "transport", None)
                    if transport is not None:
                        transport.abort()
                return
            await ws.send(json.dumps({"type": "ping", "nonce": secrets.token_hex(4)}))

    async def _handle_signal_message(self, ws, msg: dict[str, Any], device_id: str, stun_urls: list[str]) -> None:
        mtype = msg.get("type")
        if mtype in {"pong", "pair_key_updated"}:
            return
        session_id = str(msg.get("session_id") or "")
        if not session_id:
            return

        if mtype in {"offer", "ice_restart"}:
            sdp = str(msg.get("sdp") or "")
            ticket = str(msg.get("p2p_ticket") or "")
            if not sdp or not ticket:
                return
            raw_live_stun = msg.get("stun_urls")
            effective_stun = (
                [str(u) for u in raw_live_stun if isinstance(u, str) and u.strip()]
                if isinstance(raw_live_stun, list) and raw_live_stun
                else stun_urls
            )
            if effective_stun:
                self._stun_urls = effective_stun
            old = self._sessions.pop(session_id, None)
            if old is not None:
                await old.close()
            if len(self._sessions) >= MAX_CONCURRENT_P2P_SESSIONS:
                await ws.send(json.dumps({
                    "type": "error",
                    "session_id": session_id,
                    "code": "capacity_exceeded",
                    "message": "Maximum concurrent P2P sessions reached",
                }))
                return
            peer = WebRtcPeerSession(
                session_id=session_id,
                device_id=device_id,
                expected_ticket=ticket,
                verify_pair_key=self.verify_remote_pair_key,
                stun_urls=effective_stun,
                asgi_app=self.asgi_app,
                send_signal=lambda payload: ws.send(json.dumps(payload)),
                on_closed=lambda sid: self._sessions.pop(sid, None),
            )
            self._sessions[session_id] = peer
            try:
                answer_sdp = await peer.accept_offer(sdp)
                await ws.send(json.dumps({
                    "type": "answer",
                    "session_id": session_id,
                    "sdp": answer_sdp,
                }))
            except Exception as exc:
                self._sessions.pop(session_id, None)
                await peer.close()
                await ws.send(json.dumps({
                    "type": "error",
                    "session_id": session_id,
                    "code": "offer_rejected",
                    "message": str(exc),
                }))
        elif mtype == "ice_candidate":
            peer = self._sessions.get(session_id)
            if peer is not None:
                try:
                    await peer.add_remote_candidate(msg.get("candidate"))
                except Exception as exc:
                    await ws.send(json.dumps({
                        "type": "error",
                        "session_id": session_id,
                        "code": "relay_not_allowed",
                        "message": str(exc),
                    }))
        elif mtype == "bye":
            peer = self._sessions.pop(session_id, None)
            if peer is not None:
                await peer.close()
