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

from .policy import ManagedPolicyCache, verify_policy_snapshot

logger = logging.getLogger(__name__)


def control_url(origin: str) -> str:
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or not parsed.netloc or parsed.path or parsed.query or parsed.fragment:
        raise ValueError("Invalid managed Gateway origin")
    return f"wss://{parsed.netloc}/api/control/ws"


class GatewayControlClient:
    def __init__(self, origin: str, *, gateway_id: str, public_key_fingerprint: str,
                 user_id: str, policy_cache: ManagedPolicyCache,
                 connector=connect, heartbeat_seconds: float = 20):
        self.url = control_url(origin)
        self.origin = origin
        self.gateway_id = gateway_id
        self.public_key_fingerprint = public_key_fingerprint
        self.user_id = user_id
        self.policy_cache = policy_cache
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
                    if (not isinstance(hello, dict) or hello.get("kind") != "hello"
                            or hello.get("version") != 1 or hello.get("device_id") != device_id):
                        raise ValueError("Invalid Gateway control handshake")
                    gateway_key = hello.get("gateway_public_key_pem")
                    if not isinstance(gateway_key, str) or not isinstance(hello.get("policy_snapshot"), str):
                        raise ValueError("Missing Gateway policy snapshot")
                    self.policy_cache.apply(verify_policy_snapshot(
                        hello["policy_snapshot"], gateway_key, self.public_key_fingerprint,
                        self.gateway_id, device_id, self.user_id,
                    ))
                    await self._ack_policy(socket, device_id)
                    self.online = True
                    delay = 1.0
                    while not self._stop.is_set():
                        await socket.send(json.dumps({"kind": "heartbeat"}))
                        raw = await asyncio.wait_for(socket.recv(), timeout=10)
                        ack = json.loads(raw)
                        if (not isinstance(ack, dict) or ack.get("kind") != "heartbeat_ack"
                                or ack.get("version") != 1 or ack.get("device_id") != device_id
                                or not isinstance(ack.get("policy_snapshot"), str)):
                            raise ValueError("Invalid Gateway heartbeat acknowledgment")
                        self.policy_cache.apply(verify_policy_snapshot(
                            ack["policy_snapshot"], gateway_key, self.public_key_fingerprint,
                            self.gateway_id, device_id, self.user_id,
                        ))
                        await self._ack_policy(socket, device_id)
                        try:
                            await asyncio.wait_for(self._stop.wait(), timeout=self.heartbeat_seconds)
                        except asyncio.TimeoutError:
                            pass
            except asyncio.CancelledError:
                raise
            except ConnectionClosed as exc:
                if exc.rcvd and exc.rcvd.code in (4003, 4401):
                    self.policy_cache.clear()
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

    async def _ack_policy(self, socket, device_id: str) -> None:
        revision = self.policy_cache.current.revision
        await socket.send(json.dumps({"kind": "policy_applied", "revision": revision}))
        raw = await asyncio.wait_for(socket.recv(), timeout=10)
        ack = json.loads(raw)
        if (not isinstance(ack, dict) or ack.get("kind") != "policy_applied_ack"
                or ack.get("version") != 1 or ack.get("device_id") != device_id
                or ack.get("revision") != revision):
            raise ValueError("Invalid policy application acknowledgment")
