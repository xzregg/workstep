"""Outbound managed device control connection with bounded reconnect."""

import asyncio
import base64
import json
import logging
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger(__name__)


def control_url(origin: str) -> str:
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or not parsed.netloc or parsed.path or parsed.query or parsed.fragment:
        raise ValueError("Invalid managed Gateway origin")
    return f"wss://{parsed.netloc}/api/control/ws"


class GatewayControlClient:
    def __init__(self, origin: str, *, connector=connect, heartbeat_seconds: float = 20):
        self.url = control_url(origin)
        self.origin = origin
        self.connector = connector
        self.heartbeat_seconds = heartbeat_seconds
        self.online = False
        self.authorization_required = False
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    def start(self, authorization: str, device_id: str,
              control_private_key_pem: str, control_public_key_pem: str,
              delegation_signature: str) -> None:
        if self._task and not self._task.done():
            raise RuntimeError("Control client already started")
        self._stop.clear()
        self.authorization_required = False
        private_key = serialization.load_pem_private_key(control_private_key_pem.encode(), password=None)
        if not isinstance(private_key, Ed25519PrivateKey):
            raise ValueError("Control key must be Ed25519")
        expected_public = private_key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode()
        if expected_public != control_public_key_pem:
            raise ValueError("Control key pair mismatch")
        self._task = asyncio.create_task(self._run(
            authorization, device_id, private_key, control_public_key_pem,
            delegation_signature,
        ))

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        self.online = False

    async def _run(self, authorization: str, device_id: str,
                   private_key: Ed25519PrivateKey, public_key_pem: str,
                   delegation_signature: str) -> None:
        delay = 1.0
        while not self._stop.is_set():
            try:
                async with self.connector(self.url, origin=self.origin, open_timeout=10,
                                          max_size=1024 * 1024) as socket:
                    raw = await asyncio.wait_for(socket.recv(), timeout=10)
                    challenge = json.loads(raw)
                    nonce = challenge.get("nonce") if isinstance(challenge, dict) else None
                    if (not isinstance(challenge, dict) or challenge.get("kind") != "challenge"
                            or not isinstance(nonce, str) or len(nonce) < 32):
                        raise ValueError("Invalid Gateway control challenge")
                    challenge_proof = base64.urlsafe_b64encode(private_key.sign(
                        f"workstep-control-challenge-v1:{nonce}:{authorization}".encode(),
                    )).rstrip(b"=").decode()
                    await socket.send(json.dumps({
                        "authorization": authorization,
                        "control_public_key_pem": public_key_pem,
                        "control_delegation_signature": delegation_signature,
                        "control_challenge_proof": challenge_proof,
                    }))
                    raw = await asyncio.wait_for(socket.recv(), timeout=10)
                    hello = json.loads(raw)
                    if hello != {"kind": "hello", "version": 1, "device_id": device_id}:
                        raise ValueError("Invalid Gateway control handshake")
                    self.online = True
                    delay = 1.0
                    while not self._stop.is_set():
                        await socket.send(json.dumps({"kind": "heartbeat"}))
                        raw = await asyncio.wait_for(socket.recv(), timeout=10)
                        ack = json.loads(raw)
                        if ack != {"kind": "heartbeat_ack", "version": 1,
                                   "device_id": device_id}:
                            raise ValueError("Invalid Gateway heartbeat acknowledgment")
                        try:
                            await asyncio.wait_for(self._stop.wait(), timeout=self.heartbeat_seconds)
                        except asyncio.TimeoutError:
                            pass
            except asyncio.CancelledError:
                raise
            except ConnectionClosed as exc:
                if exc.rcvd and exc.rcvd.code == 4401:
                    self.authorization_required = True
                    return
                logger.warning("Gateway control connection closed: %s", type(exc).__name__)
            except Exception as exc:
                logger.warning("Gateway control connection failed: %s", type(exc).__name__)
            finally:
                self.online = False
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                delay = min(delay * 2, 60)
