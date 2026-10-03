import base64
import asyncio
import hashlib
import json
import time

import pytest
import httpx
from fastapi import FastAPI
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from services.gateway_client.provider_config import verify_provider_bundle
from services.gateway_client.control import GatewayControlClient
from services.gateway_client.policy import ManagedPolicyCache
from services import config as config_module
from api.provider import router as provider_router
from engines.codex import CodexEngine
from engines.pydantic_ai import PydanticAIEngine
from engines.core.base import EngineTestResult
from types import SimpleNamespace


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _signed_bundle(gateway_key, recipient, *, revision=3, device_id="device-1",
                   default_provider_id=""):
    ephemeral = X25519PrivateKey.generate()
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
               info=b"workstep-provider-device-v1").derive(
                   ephemeral.exchange(recipient.public_key()),
               )
    nonce = b"123456789012"
    providers = [{"id": "provider-1", "name": "Managed API", "type": "custom",
                  "api_key": "secret-api-key", "protocols": ["openai_responses"],
                  "protocol_base_urls": {"openai_responses": "https://api.example.test"}}]
    ciphertext = AESGCM(key).encrypt(
        nonce, json.dumps({"providers": providers,
                           "default_provider_id": default_provider_id}).encode(),
        f"gateway-test:{device_id}:user-1:{revision}".encode(),
    )
    now = int(time.time())
    claims = {"iss": "gateway-test", "kind": "provider.bundle", "gateway_id": "gateway-test",
              "device_id": device_id, "user_id": "user-1", "revision": revision,
              "iat": now, "exp": now + 600,
              "ephemeral_public_key": _b64(ephemeral.public_key().public_bytes(
                  serialization.Encoding.Raw, serialization.PublicFormat.Raw,
              )), "nonce": _b64(nonce), "ciphertext": _b64(ciphertext)}
    header = _b64(b'{"alg":"EdDSA","typ":"JWT"}')
    payload = _b64(json.dumps(claims).encode())
    message = f"{header}.{payload}"
    return f"{message}.{_b64(gateway_key.sign(message.encode()))}"


def test_provider_bundle_verifies_pin_scope_revision_and_encryption():
    gateway_key = Ed25519PrivateKey.generate()
    public = gateway_key.public_key()
    pem = public.public_bytes(serialization.Encoding.PEM,
                              serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    fingerprint = hashlib.sha256(public.public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
    )).hexdigest()
    recipient = X25519PrivateKey.generate()
    token = _signed_bundle(gateway_key, recipient, default_provider_id="provider-1")
    bundle = verify_provider_bundle(token, pem, fingerprint, "gateway-test", "device-1",
                                    "user-1", recipient, current_revision=2)
    assert bundle.revision == 3
    assert bundle.providers[0]["api_key"] == "secret-api-key"
    assert bundle.default_provider_id == "provider-1"
    with pytest.raises(ValueError):
        verify_provider_bundle(_signed_bundle(gateway_key, recipient,
                               default_provider_id="unassigned"), pem, fingerprint,
                               "gateway-test", "device-1", "user-1", recipient,
                               current_revision=2)
    with pytest.raises(ValueError):
        verify_provider_bundle(token, pem, fingerprint, "gateway-test", "device-2",
                               "user-1", recipient, current_revision=2)
    with pytest.raises(ValueError):
        verify_provider_bundle(token, pem, fingerprint, "gateway-test", "device-1",
                               "user-1", X25519PrivateKey.generate(), current_revision=2)
    with pytest.raises(ValueError):
        verify_provider_bundle(token, pem, fingerprint, "gateway-test", "device-1",
                               "user-1", recipient, current_revision=4)
    with pytest.raises(ValueError):
        verify_provider_bundle(token + "x", pem, fingerprint, "gateway-test", "device-1",
                               "user-1", recipient, current_revision=2)


def test_managed_provider_apply_is_atomic_scoped_and_idempotent(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(config_module, "CONFIG_FILE", tmp_path / "config.json")
    store = config_module.ConfigStore()
    store.save_provider({"id": "local-1", "name": "Local", "type": "custom",
                         "protocols": ["openai"], "api_key": "local-secret"})
    store.set_managed_gateway_id("gateway-test", provider_guard=lambda provider_id: provider_id == "managed-1")
    desired = [{"id": "managed-1", "name": "Managed", "type": "custom",
                "protocols": ["openai_responses"], "protocol_base_urls": {
                    "openai_responses": "https://api.example.test",
                }, "api_key": "managed-secret", "models": ["model-a"]}]
    assert store.apply_managed_providers("gateway-test", 1, desired,
                                         default_provider_id="managed-1") is True
    assert store.get_managed_default_provider() == "managed-1"
    assert [item["id"] for item in store.get_providers()] == ["managed-1"]
    assert store.get_provider("local-1") is None
    assert store.get_provider("managed-1")["managed_gateway_id"] == "gateway-test"
    with pytest.raises(ValueError):
        store.apply_managed_providers("gateway-test", 2, desired,
                                      default_provider_id="unassigned")
    assert store.get_managed_default_provider() == "managed-1"
    assert store.apply_managed_providers("gateway-test", 1, desired,
                                         default_provider_id="managed-1") is False
    # A second signed-in user can have a different catalog at the same device revision.
    assert store.apply_managed_providers("gateway-test", 1, [], user_id="user-2") is True
    assert store.get_providers() == []
    assert store.get_managed_default_provider() == ""
    assert store.apply_managed_providers("gateway-test", 1, desired, user_id="user-1") is True
    with pytest.raises(PermissionError):
        store.save_provider({"id": "managed-1", "name": "Hijack", "type": "custom"})
    with pytest.raises(ValueError):
        store.apply_managed_providers("gateway-test", 0, [])
    with pytest.raises(ValueError):
        store.apply_managed_providers("gateway-test", 2, [
            {**desired[0], "id": "local-1"},
        ])
    assert store.get_provider("managed-1")["api_key"] == "managed-secret"
    with pytest.raises(RuntimeError):
        store.apply_managed_providers(
            "gateway-test", 2, [{**desired[0], "api_key": "changed"}],
            after_apply=lambda: (_ for _ in ()).throw(RuntimeError("reload failed")),
        )
    assert store.get_provider("managed-1")["api_key"] == "managed-secret"
    assert store.apply_managed_providers("gateway-test", 2, []) is True
    assert store.get_providers() == []
    store.set_managed_gateway_id(None)
    assert [item["id"] for item in store.get_providers()] == ["local-1"]


def test_managed_provider_runtime_requires_catalog_model(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(config_module, "CONFIG_FILE", tmp_path / "config.json")
    store = config_module.ConfigStore()
    store.set_managed_gateway_id("gateway-test", provider_guard=lambda _id: True)
    store.apply_managed_providers("gateway-test", 1, [{
        "id": "managed-1", "name": "Managed", "type": "custom",
        "protocols": ["openai_responses"],
        "protocol_base_urls": {"openai_responses": "https://api.example.test"},
        "api_key": "secret", "models": ["model-a"],
    }, {
        "id": "managed-2", "name": "Explicit", "type": "custom",
        "protocols": ["openai_responses"],
        "protocol_base_urls": {"openai_responses": "https://api.example.test"},
        "api_key": "secret", "models": ["model-a"],
    }], default_provider_id="managed-1")
    monkeypatch.setattr(CodexEngine, "provider_config_store", classmethod(lambda cls: store))
    store.set_engine_provider("codex", "local-1")
    assert CodexEngine().resolve_provider_id() == "managed-1"
    assert CodexEngine().resolve_provider_id("managed-2") == "managed-2"
    assert CodexEngine().get_full_config_values()["provider_id"] == "managed-1"
    assert store.get_assistant_defaults("task_coordinator")["provider_id"] == "managed-1"
    assert CodexEngine().resolve_provider_runtime(provider_id="managed-1",
                                                   model="model-a").provider_id == "managed-1"
    with pytest.raises(ValueError, match="模型"):
        CodexEngine().resolve_provider_runtime(provider_id="managed-1", model="model-b")
    with pytest.raises(ValueError, match="模型"):
        CodexEngine().resolve_provider_runtime(provider_id="managed-1", model=None)
    with pytest.raises(ValueError, match="模型未获平台供应商授权"):
        PydanticAIEngine.build_model(provider=store.get_provider("managed-1"),
                                     model_name="model-b")


@pytest.mark.asyncio
async def test_managed_provider_api_rejects_local_mutations_and_key_reveal():
    app = FastAPI()
    app.state.gateway_client = SimpleNamespace(managed_config=object())
    app.include_router(provider_router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://127.0.0.1") as client:
        assert (await client.post("/api/provider", json={})).status_code == 403
        assert (await client.post("/api/provider/import/cc-switch", json={})).status_code == 403
        assert (await client.delete("/api/provider/provider-1")).status_code == 403
        assert (await client.post("/api/provider/provider-1/reveal")).status_code == 403
        assert (await client.get("/api/provider/import/sources")).json() == {"sources": []}


@pytest.mark.asyncio
async def test_control_applies_signed_provider_bundle_and_acknowledges(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(config_module, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr("engines.core.registry.refresh_registry", lambda: None)
    store = config_module.ConfigStore()
    store.set_managed_gateway_id("gateway-test", provider_guard=lambda _id: True)
    gateway_key = Ed25519PrivateKey.generate()
    public = gateway_key.public_key()
    pem = public.public_bytes(serialization.Encoding.PEM,
                              serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    fingerprint = hashlib.sha256(public.public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
    )).hexdigest()
    recipient = X25519PrivateKey.generate()
    token = _signed_bundle(gateway_key, recipient, default_provider_id="provider-1")
    client = GatewayControlClient("https://gateway.test", gateway_id="gateway-test",
                                  public_key_fingerprint=fingerprint, user_id="user-1",
                                  policy_cache=ManagedPolicyCache(), provider_store=store)
    client.config_private_key = recipient
    messages = asyncio.Queue()
    sent = []
    class Socket:
        async def send(self, value):
            result = json.loads(value)
            sent.append(result)
            messages.put_nowait({"kind": "provider_applied_ack", "version": 1,
                                 "device_id": "device-1", "revision": result["revision"]})
    await client._apply_provider_bundle(Socket(), messages, {"provider_bundle": token},
                                        pem, "device-1")
    assert sent[0]["result"] == "success"
    assert store.get_provider("provider-1")["api_key"] == "secret-api-key"
    assert store.get_managed_default_provider() == "provider-1"
    await client._apply_provider_bundle(Socket(), messages, {"provider_bundle": token + "x"},
                                        pem, "device-1")
    assert sent[1]["result"] == "error"
    assert store.get_provider("provider-1")["api_key"] == "secret-api-key"


@pytest.mark.asyncio
async def test_provider_probe_uses_local_service_and_reports_only_bounded_status(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(config_module, "CONFIG_FILE", tmp_path / "config.json")
    store = config_module.ConfigStore()
    store.set_managed_gateway_id("gateway-test", provider_guard=lambda _id: True)
    store.apply_managed_providers("gateway-test", 1, [{
        "id": "provider-1", "name": "Managed API", "type": "custom",
        "api_key": "secret-api-key", "protocols": ["openai_responses"],
        "protocol_base_urls": {"openai_responses": "https://api.example.test"},
    }])
    calls = []
    async def fake_test(provider, *, timeout_seconds, protocol=None):
        calls.append((provider["id"], timeout_seconds))
        return EngineTestResult(success=False, message="secret-api-key", duration_ms=19)
    monkeypatch.setattr("services.providers.test_connection", fake_test)
    policy_cache = ManagedPolicyCache()
    client = GatewayControlClient("https://gateway.test", gateway_id="gateway-test",
                                  public_key_fingerprint="pin", user_id="user-1",
                                  policy_cache=policy_cache, provider_store=store)
    sent = []
    class Socket:
        async def send(self, value):
            sent.append(json.loads(value))
    await client._send_provider_test(Socket(), "device-1", "z" * 32, "provider-1")
    assert sent[-1]["error_code"] == "provider_unavailable"
    assert calls == []
    policy_cache.current = SimpleNamespace(valid=True, gateway_id="gateway-test",
                                           device_id="device-1", user_id="user-1",
                                           allowed_provider_ids=frozenset({"provider-1"}))
    await client._send_provider_test(Socket(), "device-1", "a" * 32, "provider-1")
    assert calls == [("provider-1", 10)]
    assert sent[-1] == {"kind": "provider_test_result", "version": 1,
                     "device_id": "device-1", "request_id": "a" * 32,
                     "status": "failed", "duration_ms": 19,
                     "error_code": "connection_failed"}
    await client._send_provider_test(Socket(), "device-1", "b" * 32, "missing")
    assert sent[-1]["error_code"] == "provider_unavailable"
    assert "secret-api-key" not in json.dumps(sent)
    original_get = store.get_provider
    def slow_get(provider_id):
        time.sleep(0.15)
        return original_get(provider_id)
    monkeypatch.setattr(store, "get_provider", slow_get)
    probe = asyncio.create_task(client._send_provider_test(
        Socket(), "device-1", "c" * 32, "provider-1"))
    await asyncio.wait_for(asyncio.sleep(0.01), timeout=0.05)
    await probe


@pytest.mark.asyncio
async def test_control_reader_dispatches_bounded_provider_probe_request(monkeypatch):
    client = GatewayControlClient("https://gateway.test", gateway_id="gateway-test",
                                  public_key_fingerprint="pin", user_id="user-1",
                                  policy_cache=ManagedPolicyCache())
    wire = asyncio.Queue()
    handled = asyncio.Event()
    calls = []
    async def probe(socket, device_id, request_id, provider_id):
        calls.append((device_id, request_id, provider_id))
        handled.set()
    monkeypatch.setattr(client, "_send_provider_test", probe)
    class Socket:
        async def recv(self):
            return await wire.get()
    queues = [asyncio.Queue() for _ in range(5)]
    reader = asyncio.create_task(client._read_control_messages(
        Socket(), "device-1", *queues))
    wire.put_nowait(json.dumps({"kind": "provider_test_request", "version": 1,
                                "device_id": "device-1", "request_id": "a" * 32,
                                "provider_id": "provider-1"}))
    await asyncio.wait_for(handled.wait(), timeout=1)
    assert calls == [("device-1", "a" * 32, "provider-1")]
    reader.cancel()
    await asyncio.gather(reader, return_exceptions=True)


@pytest.mark.asyncio
async def test_slow_provider_disk_apply_does_not_block_control_loop(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(config_module, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr("engines.core.registry.refresh_registry", lambda: None)
    store = config_module.ConfigStore()
    store.set_managed_gateway_id("gateway-test", provider_guard=lambda _id: True)
    original = store.apply_managed_providers

    def slow_apply(*args, **kwargs):
        time.sleep(0.15)
        return original(*args, **kwargs)

    monkeypatch.setattr(store, "apply_managed_providers", slow_apply)
    gateway_key = Ed25519PrivateKey.generate()
    public = gateway_key.public_key()
    pem = public.public_bytes(serialization.Encoding.PEM,
                              serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    fingerprint = hashlib.sha256(public.public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
    )).hexdigest()
    recipient = X25519PrivateKey.generate()
    client = GatewayControlClient("https://gateway.test", gateway_id="gateway-test",
                                  public_key_fingerprint=fingerprint, user_id="user-1",
                                  policy_cache=ManagedPolicyCache(), provider_store=store)
    client.config_private_key = recipient
    messages = asyncio.Queue()

    class Socket:
        async def send(self, value):
            messages.put_nowait({"kind": "provider_applied_ack", "version": 1,
                                 "device_id": "device-1", "revision": json.loads(value)["revision"]})

    task = asyncio.create_task(client._apply_provider_bundle(
        Socket(), messages, {"provider_bundle": _signed_bundle(gateway_key, recipient)},
        pem, "device-1",
    ))
    await asyncio.sleep(0.02)
    assert not task.done()
    await asyncio.wait_for(asyncio.sleep(0.01), timeout=0.05)
    await task


def test_remote_actor_cannot_use_another_users_installed_provider(tmp_path, monkeypatch):
    from services.remote_access import ActorSnapshot, actor_context
    monkeypatch.setattr(config_module, 'CONFIG_FILE', tmp_path / 'config.json')
    store = config_module.ConfigStore()
    store.set_managed_gateway_id('gateway', provider_guard=lambda _id: True)
    store.apply_managed_providers('gateway', 1, [{
        'id': 'owner-only', 'name': 'Owner API', 'type': 'custom', 'protocols': ['openai_responses'],
        'protocol_base_urls': {'openai_responses': 'https://api.example.test'},
        'api_key': 'owner-secret', 'models': ['model-a'],
    }], user_id='owner', default_provider_id='owner-only')
    monkeypatch.setattr(CodexEngine, 'provider_config_store', classmethod(lambda cls: store))
    actor = ActorSnapshot(actor_id='other', username='other', user_name='Other', device_id='pc',
                          device_name='PC', source='managed', project_id='project')
    with actor_context(actor):
        assert store.get_providers() == []

        with pytest.raises(ValueError):
            CodexEngine().resolve_provider_runtime(provider_id='owner-only', model='model-a')
        with pytest.raises(ValueError):
            CodexEngine().resolve_provider_runtime(model='model-a')

    from dataclasses import replace
    allowed = replace(actor, provider_ids=frozenset({'owner-only'}), provider_grant_expires_at=int(time.time()) + 60)
    with actor_context(allowed):
        assert store.get_provider('owner-only') is not None
        assert CodexEngine().resolve_provider_runtime(model='model-a').provider_id == 'owner-only'
    expired = replace(allowed, provider_grant_expires_at=int(time.time()) - 1)
    with actor_context(expired):
        assert store.get_providers() == []


@pytest.mark.asyncio
@pytest.mark.parametrize('engine_id', ['openclaw', 'qoder_sdk', 'cursor_sdk'])
async def test_native_credentials_engines_fail_closed_in_managed_mode(engine_id, tmp_path, monkeypatch):
    from engines.openclaw import OpenClawEngine
    from engines.qoder_sdk import QoderSDKEngine
    from engines.cursor_sdk import CursorSdkEngine
    store = config_module.ConfigStore()
    store.set_managed_gateway_id('gateway', provider_guard=lambda _id: True)
    engine_class = {'openclaw': OpenClawEngine, 'qoder_sdk': QoderSDKEngine,
                    'cursor_sdk': CursorSdkEngine}[engine_id]
    monkeypatch.setattr(engine_class, 'provider_config_store', classmethod(lambda cls: store))
    with pytest.raises(ValueError, match='受管模式'):
        async for _event in engine_class().spawn(prompt='Hello', cwd=str(tmp_path)):
            pass
