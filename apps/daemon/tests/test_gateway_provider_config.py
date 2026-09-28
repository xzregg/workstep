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
from types import SimpleNamespace


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _signed_bundle(gateway_key, recipient, *, revision=3, device_id="device-1"):
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
        nonce, json.dumps({"providers": providers}).encode(),
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
    token = _signed_bundle(gateway_key, recipient)
    bundle = verify_provider_bundle(token, pem, fingerprint, "gateway-test", "device-1",
                                    "user-1", recipient, current_revision=2)
    assert bundle.revision == 3
    assert bundle.providers[0]["api_key"] == "secret-api-key"
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
    assert store.apply_managed_providers("gateway-test", 1, desired) is True
    assert [item["id"] for item in store.get_providers()] == ["managed-1"]
    assert store.get_provider("local-1") is None
    assert store.get_provider("managed-1")["managed_gateway_id"] == "gateway-test"
    assert store.apply_managed_providers("gateway-test", 1, desired) is False
    # A second signed-in user can have a different catalog at the same device revision.
    assert store.apply_managed_providers("gateway-test", 1, [], user_id="user-2") is True
    assert store.get_providers() == []
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
    }])
    monkeypatch.setattr(CodexEngine, "provider_config_store", classmethod(lambda cls: store))
    assert CodexEngine().resolve_provider_runtime(provider_id="managed-1",
                                                   model="model-a").provider_id == "managed-1"
    with pytest.raises(ValueError, match="模型"):
        CodexEngine().resolve_provider_runtime(provider_id="managed-1", model="model-b")
    with pytest.raises(ValueError, match="模型"):
        CodexEngine().resolve_provider_runtime(provider_id="managed-1", model=None)


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
    token = _signed_bundle(gateway_key, recipient)
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
    await client._apply_provider_bundle(Socket(), messages, {"provider_bundle": token + "x"},
                                        pem, "device-1")
    assert sent[1]["result"] == "error"
    assert store.get_provider("provider-1")["api_key"] == "secret-api-key"


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
