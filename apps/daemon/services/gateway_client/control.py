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
from workstep_gateway_protocol import FrameType, ProxyFrame

from .policy import ManagedPolicyCache, verify_policy_snapshot
from .bridge import ManagedHttpBridge

logger = logging.getLogger(__name__)


def control_url(origin: str) -> str:
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or not parsed.netloc or parsed.path or parsed.query or parsed.fragment:
        raise ValueError("Invalid managed Gateway origin")
    return f"wss://{parsed.netloc}/api/control/ws"


def data_url(origin: str) -> str:
    return control_url(origin).removesuffix("/control/ws") + "/data/ws"


class GatewayControlClient:
    def __init__(self, origin: str, *, gateway_id: str, public_key_fingerprint: str,
                 user_id: str, policy_cache: ManagedPolicyCache,
                 connector=connect, heartbeat_seconds: float = 20, asgi_app=None):
        self.url = control_url(origin)
        self.origin = origin
        self.gateway_id = gateway_id
        self.public_key_fingerprint = public_key_fingerprint
        self.user_id = user_id
        self.policy_cache = policy_cache
        self.connector = connector
        self.heartbeat_seconds = heartbeat_seconds
        self.asgi_app = asgi_app
        self.online = False
        self.authorization_required = False
        self._task: asyncio.Task | None = None
        self._data_tasks: set[asyncio.Task] = set()
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
        for task in self._data_tasks:
            task.cancel()
        if self._data_tasks:
            await asyncio.gather(*self._data_tasks, return_exceptions=True)
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
            reader_task = None
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
                    messages = asyncio.Queue()
                    reader_task = asyncio.create_task(
                        self._read_control_messages(socket, device_id, messages),
                    )
                    hello = await self._receive_kind(messages, "hello")
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
                    await self._ack_policy(socket, messages, device_id)
                    self.online = True
                    delay = 1.0
                    while not self._stop.is_set():
                        await socket.send(json.dumps({"kind": "heartbeat"}))
                        ack = await self._receive_kind(messages, "heartbeat_ack")
                        if (not isinstance(ack, dict) or ack.get("kind") != "heartbeat_ack"
                                or ack.get("version") != 1 or ack.get("device_id") != device_id
                                or not isinstance(ack.get("policy_snapshot"), str)):
                            raise ValueError("Invalid Gateway heartbeat acknowledgment")
                        self.policy_cache.apply(verify_policy_snapshot(
                            ack["policy_snapshot"], gateway_key, self.public_key_fingerprint,
                            self.gateway_id, device_id, self.user_id,
                        ))
                        await self._ack_policy(socket, messages, device_id)
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
                if reader_task:
                    reader_task.cancel()
                    await asyncio.gather(reader_task, return_exceptions=True)
                for task in self._data_tasks:
                    task.cancel()
                if self._data_tasks:
                    await asyncio.gather(*self._data_tasks, return_exceptions=True)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                delay = min(delay * 2, 60)

    async def _ack_policy(self, socket, messages: asyncio.Queue, device_id: str) -> None:
        revision = self.policy_cache.current.revision
        await socket.send(json.dumps({"kind": "policy_applied", "revision": revision}))
        ack = await self._receive_kind(messages, "policy_applied_ack")
        if (not isinstance(ack, dict) or ack.get("kind") != "policy_applied_ack"
                or ack.get("version") != 1 or ack.get("device_id") != device_id
                or ack.get("revision") != revision):
            raise ValueError("Invalid policy application acknowledgment")

    async def _receive_kind(self, messages: asyncio.Queue, kind: str) -> dict:
        message = await asyncio.wait_for(messages.get(), timeout=10)
        if isinstance(message, Exception):
            raise message
        if not isinstance(message, dict) or message.get("kind") != kind:
            raise ValueError("Unexpected Gateway control message")
        return message

    async def _read_control_messages(self, socket, device_id: str,
                                     messages: asyncio.Queue) -> None:
        try:
            while not self._stop.is_set():
                message = json.loads(await socket.recv())
                if not isinstance(message, dict):
                    raise ValueError("Invalid Gateway control message")
                if message.get("kind") == "open_data":
                    token = message.get("token")
                    if (message.get("version") != 1 or message.get("device_id") != device_id
                            or not isinstance(token, str) or len(token) < 32 or len(token) > 256):
                        raise ValueError("Invalid data connection command")
                    task = asyncio.create_task(self._run_data(device_id, token))
                    self._data_tasks.add(task)
                    task.add_done_callback(self._data_tasks.discard)
                else:
                    messages.put_nowait(message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            messages.put_nowait(exc)

    async def _run_data(self, device_id: str, token: str) -> None:
        streams: dict[str, ManagedHttpBridge] = {}
        try:
            async with self.connector(data_url(self.origin), origin=self.origin,
                                      open_timeout=10, max_size=1024 * 1024) as socket:
                await socket.send(json.dumps({"kind": "data_hello", "token": token}))
                ready = json.loads(await asyncio.wait_for(socket.recv(), timeout=10))
                if ready != {"kind": "data_ready", "version": 1, "device_id": device_id}:
                    raise ValueError("Invalid Gateway data connection acknowledgment")
                send_lock = asyncio.Lock()
                async def send_frame(frame: ProxyFrame):
                    async with send_lock:
                        await socket.send(frame.model_dump_json())
                while not self._stop.is_set():
                    frame = ProxyFrame.model_validate_json(await socket.recv())
                    bridge = streams.get(frame.stream_id)
                    if frame.type == FrameType.http_request and frame.payload.get("phase") == "start":
                        if self.asgi_app is None or bridge is not None or len(streams) >= 32:
                            raise ValueError("Invalid managed data stream")
                        bridge = ManagedHttpBridge(self.asgi_app, frame.stream_id,
                                                   frame.payload, send_frame, device_id)
                        streams[frame.stream_id] = bridge
                        bridge.start_task()
                    elif frame.type == FrameType.cancel:
                        if bridge:
                            bridge.cancel()
                            streams.pop(frame.stream_id, None)
                    elif frame.type == FrameType.http_request and bridge:
                        await bridge.feed(frame)
                        if bridge.done:
                            streams.pop(frame.stream_id, None)
                    else:
                        raise ValueError("Invalid managed data frame")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Gateway data connection failed: %s", type(exc).__name__)
        finally:
            for bridge in streams.values():
                bridge.cancel()
