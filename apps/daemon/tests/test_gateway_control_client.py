import asyncio
import json
import base64
import hashlib
import time

import pytest
import httpx
from fastapi import FastAPI
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from websockets.exceptions import ConnectionClosedError
from websockets.frames import Close

from api.managed import router as managed_router
from services.desktop_security import DesktopSecurityMiddleware
from services.gateway_client import GatewayClientService
from services.gateway_client.identity import ManagedActor
from services.gateway_client.policy import ManagedPolicyCache
from types import SimpleNamespace


def _control_keys():
    private_key = Ed25519PrivateKey.generate()
    return (
        private_key.private_bytes(serialization.Encoding.PEM,
                                  serialization.PrivateFormat.PKCS8,
                                  serialization.NoEncryption()).decode(),
        private_key.public_key().public_bytes(serialization.Encoding.PEM,
                                              serialization.PublicFormat.SubjectPublicKeyInfo).decode(),
    )


def _gateway_policy():
    key = Ed25519PrivateKey.generate()
    public = key.public_key()
    pem = public.public_bytes(serialization.Encoding.PEM,
                              serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    fingerprint = hashlib.sha256(public.public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
    )).hexdigest()
    now = int(time.time())
    claims = {"iss": "gateway-test", "kind": "policy.snapshot", "gateway_id": "gateway-test",
              "device_id": "device-1", "user_id": "user-1", "policy_revision": 0,
              "iat": now, "exp": now + 600, "allowed_provider_ids": [], "allowed_models": [],
              "allow_local_providers": False, "task_create": False,
              "project_publish": False, "task_share": False, "engine_install": False}
    header = base64.urlsafe_b64encode(b'{"alg":"EdDSA","typ":"JWT"}').rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    data = f"{header}.{payload}"
    signature = base64.urlsafe_b64encode(key.sign(data.encode())).rstrip(b"=").decode()
    return f"{data}.{signature}", pem, fingerprint

from services.gateway_client.control import GatewayControlClient, control_url, data_url


def test_control_url_is_fixed_to_managed_gateway():
    assert control_url("https://gateway.example") == "wss://gateway.example/api/control/ws"
    assert data_url("https://gateway.example") == "wss://gateway.example/api/data/ws"


@pytest.mark.asyncio
async def test_control_client_handshake_heartbeat_and_shutdown():
    sent = []
    heartbeat = asyncio.Event()
    policy, gateway_key, gateway_fingerprint = _gateway_policy()

    class Socket:
        def __init__(self):
            self.messages = asyncio.Queue()
            self.messages.put_nowait(json.dumps({"kind": "challenge", "version": 1,
                                                 "nonce": "fresh-nonce-0123456789ABCDEFGHIJKLMN"}))

        async def send(self, value):
            message = json.loads(value)
            sent.append(message)
            if message.get("authorization"):
                public_key = serialization.load_pem_public_key(message["control_public_key_pem"].encode())
                public_key.verify(base64.urlsafe_b64decode(message["control_challenge_proof"] + "=="),
                                  b"workstep-control-challenge-v1:fresh-nonce-0123456789ABCDEFGHIJKLMN:authorization")
                config_key = serialization.load_pem_public_key(message["config_public_key_pem"].encode())
                config_fingerprint = hashlib.sha256(config_key.public_bytes(
                    serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
                )).hexdigest()
                public_key.verify(base64.urlsafe_b64decode(message["config_key_proof"] + "=="),
                                  f"workstep-config-key-v1:fresh-nonce-0123456789ABCDEFGHIJKLMN:authorization:{config_fingerprint}".encode())
                self.messages.put_nowait(json.dumps({"kind": "hello", "version": 1,
                                                     "device_id": "device-1",
                                                     "gateway_public_key_pem": gateway_key,
                                                     "policy_snapshot": policy}))
            if message.get("kind") == "policy_applied":
                self.messages.put_nowait(json.dumps({"kind": "policy_applied_ack", "version": 1,
                                                     "device_id": "device-1",
                                                     "revision": message["revision"]}))
            if message.get("kind") == "heartbeat":
                heartbeat.set()
                self.messages.put_nowait(json.dumps({"kind": "heartbeat_ack", "version": 1,
                                                    "device_id": "device-1",
                                                    "policy_snapshot": policy}))

        async def recv(self):
            return await self.messages.get()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

    urls = []
    sockets = []

    def connect(url, **kwargs):
        urls.append((url, kwargs))
        socket = Socket()
        sockets.append(socket)
        return socket

    cache = ManagedPolicyCache()
    client = GatewayControlClient("https://gateway.example", gateway_id="gateway-test",
                                  public_key_fingerprint=gateway_fingerprint,
                                  user_id="user-1", policy_cache=cache, connector=connect,
                                  heartbeat_seconds=0.01)
    data_opened = asyncio.Event()
    async def observe_data(device_id, token):
        assert device_id == "device-1"
        assert token == "data-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        data_opened.set()
    client._run_data = observe_data
    private_pem, public_pem = _control_keys()
    client.start("authorization", "device-1", private_pem, public_pem, "delegation")
    await asyncio.wait_for(heartbeat.wait(), timeout=1)
    assert client.online is True
    assert cache.current and cache.current.device_id == "device-1"
    assert sent[0]["authorization"] == "authorization"
    assert sent[0]["control_delegation_signature"] == "delegation"
    assert urls[0][0] == "wss://gateway.example/api/control/ws"
    sockets[0].messages.put_nowait(json.dumps({
        "kind": "open_data", "version": 1, "device_id": "device-1",
        "token": "data-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    }))
    await asyncio.wait_for(data_opened.wait(), timeout=1)
    await client.stop()
    assert client.online is False


@pytest.mark.asyncio
async def test_control_heartbeat_probes_daemon_asgi_health():
    app = FastAPI()

    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    client = GatewayControlClient("https://gateway.example", gateway_id="gateway-test",
                                  public_key_fingerprint="0" * 64, user_id="user-1",
                                  policy_cache=ManagedPolicyCache(), asgi_app=app)
    assert await client._probe_daemon_health() is True
    app.routes.pop()
    assert await client._probe_daemon_health() is False


@pytest.mark.asyncio
async def test_slow_control_handshake_keeps_daemon_health_responsive(monkeypatch):
    monkeypatch.setenv("WORKSTEP_DESKTOP_RUNTIME", "1")
    monkeypatch.setenv("WORKSTEP_DESKTOP_TOKEN", "desktop-secret")
    started = asyncio.Event()
    release = asyncio.Event()

    class SlowConnection:
        async def __aenter__(self):
            started.set()
            await release.wait()
            raise ConnectionError("Gateway unavailable")

        async def __aexit__(self, *_):
            return None

    def factory(origin, **kwargs):
        return GatewayControlClient(origin, connector=lambda *_args, **_kwargs: SlowConnection(),
                                    **kwargs)

    service = GatewayClientService(control_client_factory=factory)
    service.managed_config = SimpleNamespace(gateway_origin="https://gateway.test",
                                             gateway_id="gateway-test",
                                             gateway_public_key_fingerprint="0" * 64)

    class Verifier:
        async def verify(self, *_):
            return ManagedActor("user-1", "alice", "device-1", "instance-1", 1)

    service.verifier = Verifier()
    app = FastAPI()
    app.add_middleware(DesktopSecurityMiddleware)
    app.include_router(managed_router)
    app.state.gateway_client = service

    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://127.0.0.1") as http:
            private_pem, public_pem = _control_keys()
            bootstrap = await http.post("/api/managed/bootstrap", json={
                "device_authorization": "signed", "device_proof": "proof",
                "control_private_key_pem": private_pem,
                "control_public_key_pem": public_pem,
                "control_delegation_signature": "delegation",
            }, headers={"X-WorkStep-Desktop-Token": "desktop-secret"})
            assert bootstrap.status_code == 200
            await asyncio.wait_for(started.wait(), timeout=1)
            assert (await asyncio.wait_for(http.get("/api/health", headers={
                "X-WorkStep-Desktop-Token": "desktop-secret",
            }), timeout=0.2)).status_code == 200
    finally:
        release.set()
        await service.close()


@pytest.mark.asyncio
async def test_control_revocation_discards_cached_policy():
    policy, gateway_key, fingerprint = _gateway_policy()
    cache = ManagedPolicyCache()

    class Socket:
        def __init__(self):
            self.stage = 0

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def send(self, _value):
            return None

        async def recv(self):
            self.stage += 1
            if self.stage == 1:
                return json.dumps({"kind": "challenge", "nonce": "nonce-0123456789ABCDEFGHIJKLMNOP"})
            if self.stage == 2:
                return json.dumps({"kind": "hello", "version": 1, "device_id": "device-1",
                                   "gateway_public_key_pem": gateway_key, "policy_snapshot": policy})
            if self.stage == 3:
                return json.dumps({"kind": "policy_applied_ack", "version": 1,
                                   "device_id": "device-1", "revision": 0})
            raise ConnectionClosedError(Close(4003, "revoked"), None)

    client = GatewayControlClient("https://gateway.example", gateway_id="gateway-test",
                                  public_key_fingerprint=fingerprint, user_id="user-1",
                                  policy_cache=cache, connector=lambda *_args, **_kwargs: Socket())
    private_pem, public_pem = _control_keys()
    client.start("authorization", "device-1", private_pem, public_pem, "delegation")
    await asyncio.wait_for(client._task, timeout=1)
    assert client.authorization_required is True
    assert cache.current is None
    await client.stop()
