"""Outbound managed device control connection with bounded reconnect."""

import asyncio
import base64
import json
import logging
import hashlib
from urllib.parse import urlsplit

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed
from workstep_gateway_protocol import FrameType, ProxyFrame

from .policy import ManagedPolicyCache, verify_policy_snapshot
from .bridge import ManagedHttpBridge, ManagedWebSocketBridge
from .provider_config import verify_provider_bundle
from .commands import ManagedCommandExecutor, verify_device_command
from .engine_actions import execute_engine_command

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
                 connector=connect, heartbeat_seconds: float = 20, asgi_app=None,
                 provider_store=None, usage_outbox=None, audit_outbox=None,
                 skill_sync=None):
        self.url = control_url(origin)
        self.origin = origin
        self.gateway_id = gateway_id
        self.public_key_fingerprint = public_key_fingerprint
        self.user_id = user_id
        self.policy_cache = policy_cache
        self.connector = connector
        self.heartbeat_seconds = heartbeat_seconds
        self.asgi_app = asgi_app
        self.provider_store = provider_store
        self.usage_outbox = usage_outbox
        self.audit_outbox = audit_outbox
        self.skill_sync = skill_sync
        self.command_executor = (ManagedCommandExecutor(provider_store, execute_engine_command)
                                 if provider_store is not None else None)
        self.online = False
        self.authorization_required = False
        self._task: asyncio.Task | None = None
        self._data_tasks: set[asyncio.Task] = set()
        self._command_tasks: set[asyncio.Task] = set()
        self._catalog_tasks: set[asyncio.Task] = set()
        self._provider_test_tasks: set[asyncio.Task] = set()
        self._stop = asyncio.Event()
        self.config_private_key: X25519PrivateKey | None = None
        self._active_socket = None
        self._project_ack_messages: asyncio.Queue | None = None
        self._project_request_lock = asyncio.Lock()
        self._verified_gateway_key: str | None = None

    async def _probe_daemon_health(self) -> bool | None:
        if self.asgi_app is None:
            return None
        try:
            async def probe() -> bool:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.asgi_app),
                                             base_url="http://127.0.0.1") as client:
                    response = await client.get("/api/health")
                    return response.status_code == 200 and response.json().get("status") == "ok"
            return await asyncio.wait_for(probe(), timeout=2)
        except Exception:
            return False

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
        for task in self._catalog_tasks:
            task.cancel()
        if self._catalog_tasks:
            await asyncio.gather(*self._catalog_tasks, return_exceptions=True)
        for task in self._provider_test_tasks:
            task.cancel()
        if self._provider_test_tasks:
            await asyncio.gather(*self._provider_test_tasks, return_exceptions=True)
        for task in self._command_tasks:
            task.cancel()
        if self._command_tasks:
            await asyncio.gather(*self._command_tasks, return_exceptions=True)
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

    async def publish_project(self, device_id: str, host_project_id: str,
                              name: str, action: str) -> dict:
        async with self._project_request_lock:
            socket = self._active_socket
            messages = self._project_ack_messages
            if not self.online or socket is None or messages is None:
                raise ConnectionError("Gateway control connection is offline")
            await socket.send(json.dumps({
                "kind": "project_publish", "version": 1,
                "action": action, "host_project_id": host_project_id, "name": name,
            }))
            response = await asyncio.wait_for(messages.get(), timeout=15)
            if isinstance(response, Exception):
                raise response
            if (not isinstance(response, dict)
                    or response.get("kind") != "project_publish_ack"
                    or response.get("version") != 1
                    or response.get("device_id") != device_id
                    or response.get("host_project_id") != host_project_id
                    or response.get("status") not in (
                        "published", "unpublished", "denied", "failed")):
                raise ValueError("Invalid Gateway project publication acknowledgment")
            if response["status"] == "denied":
                raise PermissionError("Project publication denied by Gateway")
            if response["status"] == "failed":
                raise ValueError("Gateway project publication failed")
            return response

    async def _run(self, authorization: str, device_id: str,
                   private_key: Ed25519PrivateKey, public_key_pem: str,
                   delegation_signature: str) -> None:
        delay = 1.0
        while not self._stop.is_set():
            reader_task = None
            usage_task = None
            audit_task = None
            skill_task = None
            runtime_task = None
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
                    config_private_key = X25519PrivateKey.generate()
                    self.config_private_key = config_private_key
                    config_public_key = config_private_key.public_key()
                    config_public_key_pem = config_public_key.public_bytes(
                        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo,
                    ).decode()
                    config_fingerprint = hashlib.sha256(config_public_key.public_bytes(
                        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
                    )).hexdigest()
                    config_key_proof = base64.urlsafe_b64encode(private_key.sign(
                        f"workstep-config-key-v1:{nonce}:{authorization}:{config_fingerprint}".encode(),
                    )).rstrip(b"=").decode()
                    await socket.send(json.dumps({
                        "authorization": authorization,
                        "control_public_key_pem": public_key_pem,
                        "control_delegation_signature": delegation_signature,
                        "control_challenge_proof": challenge_proof,
                        "config_public_key_pem": config_public_key_pem,
                        "config_key_proof": config_key_proof,
                    }))
                    messages = asyncio.Queue()
                    usage_messages = asyncio.Queue()
                    audit_messages = asyncio.Queue()
                    skill_messages = asyncio.Queue()
                    project_messages = asyncio.Queue()
                    reader_task = asyncio.create_task(
                        self._read_control_messages(socket, device_id, messages,
                                                    usage_messages, skill_messages,
                                                    project_messages, audit_messages),
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
                    self._verified_gateway_key = gateway_key
                    await self._ack_policy(socket, messages, device_id)
                    await self._apply_provider_bundle(socket, messages, hello,
                                                      gateway_key, device_id)
                    self._accept_command(socket, hello, gateway_key, device_id)
                    if self.skill_sync is not None:
                        skill_task = asyncio.create_task(self._apply_skill_manifest(
                            socket, skill_messages, hello, gateway_key, device_id,
                        ))
                    if self.usage_outbox is not None:
                        usage_task = asyncio.create_task(
                            self._usage_loop(socket, device_id, usage_messages),
                        )
                    if self.audit_outbox is not None:
                        audit_task = asyncio.create_task(
                            self._audit_loop(socket, device_id, audit_messages),
                        )
                    self._active_socket = socket
                    self._project_ack_messages = project_messages
                    self.online = True
                    delay = 1.0
                    while not self._stop.is_set():
                        if runtime_task is None or runtime_task.done():
                            runtime_task = asyncio.create_task(
                                self._send_project_runtime(socket, device_id),
                            )
                        if skill_task is not None and skill_task.done():
                            await skill_task
                        if usage_task is not None and usage_task.done():
                            await usage_task
                        if audit_task is not None and audit_task.done():
                            await audit_task
                        await socket.send(json.dumps({"kind": "heartbeat",
                                                      "daemon_health": await self._probe_daemon_health()}))
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
                        await self._apply_provider_bundle(socket, messages, ack,
                                                          gateway_key, device_id)
                        self._accept_command(socket, ack, gateway_key, device_id)
                        if skill_task is not None and skill_task.done():
                            await skill_task
                        if self.skill_sync is not None and (
                                skill_task is None or skill_task.done()):
                            skill_task = asyncio.create_task(self._apply_skill_manifest(
                                socket, skill_messages, ack, gateway_key, device_id,
                            ))
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
                self._active_socket = None
                if self._project_ack_messages is not None:
                    self._project_ack_messages.put_nowait(
                        ConnectionError("Gateway control connection closed"),
                    )
                self._project_ack_messages = None
                self.config_private_key = None
                if runtime_task:
                    runtime_task.cancel()
                    await asyncio.gather(runtime_task, return_exceptions=True)
                if usage_task:
                    usage_task.cancel()
                    await asyncio.gather(usage_task, return_exceptions=True)
                if audit_task:
                    audit_task.cancel()
                    await asyncio.gather(audit_task, return_exceptions=True)
                if skill_task:
                    skill_task.cancel()
                    await asyncio.gather(skill_task, return_exceptions=True)
                for task in self._command_tasks:
                    task.cancel()
                if self._command_tasks:
                    await asyncio.gather(*self._command_tasks, return_exceptions=True)
                for task in self._catalog_tasks:
                    task.cancel()
                if self._catalog_tasks:
                    await asyncio.gather(*self._catalog_tasks, return_exceptions=True)
                for task in self._provider_test_tasks:
                    task.cancel()
                if self._provider_test_tasks:
                    await asyncio.gather(*self._provider_test_tasks, return_exceptions=True)
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
                                     messages: asyncio.Queue,
                                     usage_messages: asyncio.Queue,
                                     skill_messages: asyncio.Queue,
                                     project_messages: asyncio.Queue,
                                     audit_messages: asyncio.Queue) -> None:
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
                elif message.get("kind") == "project_catalog_request":
                    request_id = message.get("request_id")
                    if (message.get("version") != 1 or message.get("device_id") != device_id
                            or not isinstance(request_id, str) or len(request_id) != 32
                            or any(char not in "0123456789abcdef" for char in request_id)):
                        raise ValueError("Invalid project catalog request")
                    task = asyncio.create_task(self._send_project_catalog(socket, device_id, request_id))
                    self._catalog_tasks.add(task)
                    task.add_done_callback(self._catalog_tasks.discard)
                elif message.get("kind") == "provider_test_request":
                    request_id = message.get("request_id")
                    provider_id = message.get("provider_id")
                    if (set(message) != {"kind", "version", "device_id", "request_id", "provider_id"}
                            or message.get("version") != 1 or message.get("device_id") != device_id
                            or not isinstance(request_id, str) or len(request_id) != 32
                            or any(char not in "0123456789abcdef" for char in request_id)
                            or not isinstance(provider_id, str)
                            or not 1 <= len(provider_id) <= 64):
                        raise ValueError("Invalid provider test request")
                    task = asyncio.create_task(self._send_provider_test(
                        socket, device_id, request_id, provider_id))
                    self._provider_test_tasks.add(task)
                    task.add_done_callback(self._provider_test_tasks.discard)
                elif message.get("kind") == "command_status_ack":
                    if (message.get("version") != 1 or message.get("device_id") != device_id
                            or not isinstance(message.get("command_id"), str)
                            or type(message.get("accepted")) is not bool):
                        raise ValueError("Invalid command status acknowledgment")
                elif message.get("kind") in ("usage_ack", "usage_retry"):
                    usage_messages.put_nowait(message)
                elif message.get("kind") in ("audit_ack", "audit_retry"):
                    audit_messages.put_nowait(message)
                elif message.get("kind") == "skill_applied_ack":
                    skill_messages.put_nowait(message)
                elif message.get("kind") == "project_publish_ack":
                    project_messages.put_nowait(message)
                else:
                    messages.put_nowait(message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            messages.put_nowait(exc)

    async def _send_project_catalog(self, socket, device_id: str, request_id: str) -> None:
        from services.project import project_manager

        try:
            raw_projects = await asyncio.to_thread(project_manager.list_project_catalog)
            projects = [{"id": item["id"], "name": item["name"]}
                        for item in raw_projects]
            if (len(projects) > 1000 or any(
                    not isinstance(item.get("id"), str) or not 1 <= len(item["id"]) <= 128
                    or any(char in item["id"] for char in ("/", "\\", " "))
                    or not isinstance(item.get("name"), str) or not 1 <= len(item["name"]) <= 256
                    or item["name"] != item["name"].strip()
                    or any(char in item["name"] for char in ("/", "\\"))
                    for item in projects)):
                raise ValueError("Invalid local project catalog")
            status = "ok"
        except Exception:
            projects, status = [], "failed"
        await socket.send(json.dumps({"kind": "project_catalog_response", "version": 1,
                                      "device_id": device_id, "request_id": request_id,
                                      "status": status, "projects": projects}))

    async def _send_provider_test(self, socket, device_id: str, request_id: str,
                                  provider_id: str) -> None:
        from services import providers as provider_service

        duration_ms = 0
        error_code = "provider_unavailable"
        try:
            provider = (await asyncio.to_thread(self.provider_store.get_provider, provider_id)
                        if self.provider_store is not None else None)
            if (provider is not None and provider.get("managed_gateway_id") == self.gateway_id
                    and provider.get("enabled", True)):
                policy = self.policy_cache.current
                if (policy is not None and policy.valid
                        and policy.gateway_id == self.gateway_id
                        and policy.device_id == device_id
                        and policy.user_id == self.user_id
                        and provider_id in policy.allowed_provider_ids):
                    result = await provider_service.test_connection(provider, timeout_seconds=10)
                    duration_ms = max(0, min(int(result.duration_ms), 120000))
                    error_code = None if result.success else "connection_failed"
        except asyncio.CancelledError:
            raise
        except Exception:
            error_code = "connection_failed"
        await socket.send(json.dumps({"kind": "provider_test_result", "version": 1,
                                      "device_id": device_id, "request_id": request_id,
                                      "status": "succeeded" if error_code is None else "failed",
                                      "duration_ms": duration_ms, "error_code": error_code}))

    async def _send_project_runtime(self, socket, device_id: str) -> None:
        from services.project import project_manager

        try:
            projects = await project_manager.running_task_snapshot()
            if (len(projects) > 1000 or any(
                    not isinstance(item.get("id"), str) or not 1 <= len(item["id"]) <= 128
                    or any(char in item["id"] for char in ("/", "\\", " "))
                    or type(item.get("running_tasks")) is not int
                    or not 0 <= item["running_tasks"] <= 1_000_000_000
                    for item in projects)):
                raise ValueError("Invalid local project runtime")
            await socket.send(json.dumps({"kind": "project_runtime", "version": 1,
                                          "device_id": device_id, "projects": projects}))
        except Exception as exc:
            logger.warning("Project runtime snapshot unavailable: %s", type(exc).__name__)

    async def _run_data(self, device_id: str, token: str) -> None:
        streams: dict[str, ManagedHttpBridge | ManagedWebSocketBridge] = {}
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
                                                   frame.payload, send_frame, device_id,
                                                   gateway_key=self._verified_gateway_key,
                                                   gateway_fingerprint=self.public_key_fingerprint,
                                                   gateway_id=self.gateway_id)
                        streams[frame.stream_id] = bridge
                        bridge.start_task()
                    elif frame.type == FrameType.websocket_open and frame.payload.get("phase") == "start":
                        if self.asgi_app is None or bridge is not None or len(streams) >= 32:
                            raise ValueError("Invalid managed data stream")
                        bridge = ManagedWebSocketBridge(self.asgi_app, frame.stream_id,
                                                        frame.payload, send_frame, device_id)
                        streams[frame.stream_id] = bridge
                        bridge.start_task()
                    elif frame.type == FrameType.cancel:
                        if bridge:
                            bridge.cancel()
                            streams.pop(frame.stream_id, None)
                    elif frame.type in (FrameType.http_request, FrameType.websocket_data,
                                        FrameType.websocket_close) and bridge:
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

    async def _apply_provider_bundle(self, socket, messages: asyncio.Queue,
                                     envelope: dict, gateway_key: str,
                                     device_id: str) -> None:
        if self.provider_store is None:
            return
        token = envelope.get("provider_bundle")
        if not isinstance(token, str) or self.config_private_key is None:
            raise ValueError("Missing Gateway provider bundle")
        state = await asyncio.to_thread(self.provider_store.get, "managed_provider_state", {})
        current_revision = (state.get("revision", -1)
                            if isinstance(state, dict) and state.get("gateway_id") == self.gateway_id
                            else -1)
        revision = max(current_revision, 0)
        try:
            bundle = verify_provider_bundle(
                token, gateway_key, self.public_key_fingerprint,
                self.gateway_id, device_id, self.user_id, self.config_private_key,
                current_revision=current_revision,
            )
            revision = bundle.revision
            from engines.core.registry import refresh_registry
            await asyncio.to_thread(
                self.provider_store.apply_managed_providers,
                self.gateway_id, bundle.revision, bundle.providers, refresh_registry,
                user_id=self.user_id, default_provider_id=bundle.default_provider_id,
            )
            result, error = "success", None
        except Exception as exc:
            result, error = "error", f"{type(exc).__name__}: application failed"
            logger.warning("Gateway provider application failed: %s", type(exc).__name__)
        await socket.send(json.dumps({"kind": "provider_applied", "revision": revision,
                                      "result": result, "error": error}))
        ack = await self._receive_kind(messages, "provider_applied_ack")
        if (ack.get("version") != 1 or ack.get("device_id") != device_id
                or ack.get("revision") != revision):
            raise ValueError("Invalid provider application acknowledgment")

    def _accept_command(self, socket, envelope: dict, gateway_key: str,
                        device_id: str) -> None:
        raw = envelope.get("command")
        if raw is None or self.command_executor is None:
            return
        if (not isinstance(raw, dict) or raw.get("kind") != "device_command"
                or raw.get("version") != 1 or raw.get("device_id") != device_id
                or not isinstance(raw.get("token"), str)):
            raise ValueError("Invalid Gateway command envelope")
        command = verify_device_command(
            raw["token"], gateway_key, self.public_key_fingerprint,
            self.gateway_id, device_id,
        )
        task = asyncio.create_task(self._execute_command(socket, command))
        self._command_tasks.add(task)
        task.add_done_callback(self._command_tasks.discard)

    async def _execute_command(self, socket, command) -> None:
        async def report(status: str, error: str | None = None) -> None:
            await socket.send(json.dumps({
                "kind": "command_status", "command_id": command.command_id,
                "status": status, "error": error,
            }))

        try:
            await report("received")
            status, error = await self.command_executor.execute(
                command, on_started=lambda: report("running"))
            await report(status, error)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Gateway device command failed: %s", type(exc).__name__)

    async def _usage_loop(self, socket, device_id: str,
                          usage_messages: asyncio.Queue) -> None:
        while not self._stop.is_set():
            batch = await asyncio.to_thread(self.usage_outbox.pending,
                                            device_id=device_id)
            if batch is None:
                await asyncio.sleep(5)
                continue
            await socket.send(json.dumps({
                "kind": "usage_batch", "version": 1, **batch,
            }))
            try:
                response = await asyncio.wait_for(usage_messages.get(), timeout=30)
            except asyncio.TimeoutError:
                await asyncio.sleep(5)
                continue
            if (not isinstance(response, dict) or response.get("version") != 1
                    or response.get("device_id") != device_id
                    or response.get("batch_id") != batch["batch_id"]):
                raise ValueError("Invalid Gateway usage acknowledgment")
            if response.get("kind") == "usage_retry":
                retry_after = response.get("retry_after")
                if type(retry_after) is not int or not 1 <= retry_after <= 60:
                    raise ValueError("Invalid Gateway usage retry")
                await asyncio.sleep(retry_after)
                continue
            if response.get("kind") != "usage_ack":
                raise ValueError("Invalid Gateway usage response")
            for key in ("accepted", "duplicates", "rejected"):
                values = response.get(key)
                if (not isinstance(values, list) or len(values) > 100
                        or any(not isinstance(value, str) or len(value) > 64
                               for value in values)):
                    raise ValueError("Invalid Gateway usage acknowledgment IDs")
            await asyncio.to_thread(
                self.usage_outbox.ack, batch["batch_id"],
                accepted=response["accepted"], duplicates=response["duplicates"],
                rejected=response["rejected"],
            )
            if not (response["accepted"] or response["duplicates"] or response["rejected"]):
                await asyncio.sleep(5)

    async def _audit_loop(self, socket, device_id: str,
                          audit_messages: asyncio.Queue) -> None:
        while not self._stop.is_set():
            batch = await self.audit_outbox.pending(device_id=device_id)
            if batch is None:
                await asyncio.sleep(5)
                continue
            await socket.send(json.dumps({
                "kind": "audit_batch", "version": 1,
                "batch_id": batch["batch_id"], "events": batch["events"],
            }))
            try:
                response = await asyncio.wait_for(audit_messages.get(), timeout=30)
            except asyncio.TimeoutError:
                await asyncio.sleep(5)
                continue
            if (not isinstance(response, dict) or response.get("version") != 1
                    or response.get("device_id") != device_id
                    or response.get("batch_id") != batch["batch_id"]):
                raise ValueError("Invalid Gateway audit acknowledgment")
            if response.get("kind") == "audit_retry":
                retry_after = response.get("retry_after")
                if type(retry_after) is not int or not 1 <= retry_after <= 60:
                    raise ValueError("Invalid Gateway audit retry")
                await asyncio.sleep(retry_after)
                continue
            if response.get("kind") != "audit_ack":
                raise ValueError("Invalid Gateway audit response")
            for key in ("accepted", "duplicates", "rejected"):
                values = response.get(key)
                if (not isinstance(values, list) or len(values) > 100
                        or any(not isinstance(value, str) or len(value) > 64
                               for value in values)):
                    raise ValueError("Invalid Gateway audit acknowledgment IDs")
            await self.audit_outbox.ack(
                batch["project_id"], batch,
                accepted=response["accepted"], duplicates=response["duplicates"],
                rejected=response["rejected"],
            )
            if not (response["accepted"] or response["duplicates"] or response["rejected"]):
                await asyncio.sleep(5)

    async def _apply_skill_manifest(self, socket, messages: asyncio.Queue,
                                    envelope: dict, gateway_key: str,
                                    device_id: str) -> None:
        token = envelope.get("skill_manifest")
        if not isinstance(token, str):
            raise ValueError("Missing Gateway Skill manifest")
        results = await self.skill_sync.apply_manifest(
            token, gateway_key, self.public_key_fingerprint,
            self.gateway_id, device_id, self.user_id,
        )
        await socket.send(json.dumps({"kind": "skill_applied", "version": 1,
                                      "projects": results}))
        ack = await asyncio.wait_for(messages.get(), timeout=30)
        expected = [item["project_id"] for item in results]
        if (not isinstance(ack, dict) or ack.get("kind") != "skill_applied_ack"
                or ack.get("version") != 1 or ack.get("device_id") != device_id
                or ack.get("projects") != expected):
            raise ValueError("Invalid Skill application acknowledgment")
