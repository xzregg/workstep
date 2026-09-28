import asyncio
import hashlib
import json
import time

import pytest
import httpx
from fastapi import FastAPI
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from services.gateway_client.commands import verify_device_command, ManagedCommandExecutor
from services.gateway_client.engine_actions import execute_engine_command
from services.gateway_client.control import GatewayControlClient
from services.gateway_client.policy import ManagedPolicyCache
from services import config as config_module
from api import engine as engine_api


def _sign(key, claims):
    import base64
    enc = lambda value: base64.urlsafe_b64encode(value).rstrip(b"=").decode()
    head = enc(b'{"alg":"EdDSA","typ":"JWT"}')
    body = enc(json.dumps(claims).encode())
    return f"{head}.{body}.{enc(key.sign(f'{head}.{body}'.encode()))}"


def _credential():
    key = Ed25519PrivateKey.generate()
    public = key.public_key()
    pem = public.public_bytes(serialization.Encoding.PEM,
                              serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    fingerprint = hashlib.sha256(public.public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo,
    )).hexdigest()
    now = int(time.time())
    claims = {"iss": "gateway-test", "gateway_id": "gateway-test",
              "kind": "device.command", "device_id": "device-1",
              "command_id": "command-1", "batch_id": "batch-1",
              "idempotency_key": "idempotency-1", "action": "refresh",
              "engine_id": "codex", "version": None,
              "accept_third_party_terms": False, "iat": now, "exp": now + 600}
    return key, pem, fingerprint, claims


def test_device_command_verifies_signature_scope_and_catalog():
    key, pem, fingerprint, claims = _credential()
    token = _sign(key, claims)
    command = verify_device_command(token, pem, fingerprint,
                                    "gateway-test", "device-1")
    assert command.command_id == "command-1"
    assert command.action == "refresh"
    for changed in ({**claims, "device_id": "device-2"},
                    {**claims, "action": "shell"},
                    {**claims, "exp": int(time.time()) - 1}):
        with pytest.raises(ValueError):
            verify_device_command(_sign(key, changed), pem, fingerprint,
                                  "gateway-test", "device-1")
    with pytest.raises(ValueError):
        verify_device_command(token + "x", pem, fingerprint,
                              "gateway-test", "device-1")


@pytest.mark.asyncio
async def test_command_executor_persists_receipt_before_action_and_replays_result(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(config_module, "CONFIG_FILE", tmp_path / "config.json")
    store = config_module.ConfigStore()
    key, pem, fingerprint, claims = _credential()
    command = verify_device_command(_sign(key, claims), pem, fingerprint,
                                    "gateway-test", "device-1")
    calls = []

    async def action(_command):
        calls.append(_command.command_id)
        await asyncio.sleep(0.01)
        return "succeeded", None

    executor = ManagedCommandExecutor(store, action)
    assert await executor.execute(command) == ("succeeded", None)
    assert await executor.execute(command) == ("succeeded", None)
    assert calls == ["command-1"]
    assert await ManagedCommandExecutor(config_module.ConfigStore(), action).execute(command) == (
        "succeeded", None)
    assert calls == ["command-1"]


@pytest.mark.asyncio
async def test_versioned_engine_command_waits_for_existing_runtime_manager(monkeypatch):
    from services import engine_runtime
    key, pem, fingerprint, claims = _credential()
    command = verify_device_command(_sign(key, {
        **claims, "action": "install", "version": "1.2.3",
    }), pem, fingerprint, "gateway-test", "device-1")
    calls = []

    class Manager:
        async def start(self, engine_id, version, **kwargs):
            calls.append((engine_id, version, kwargs))
            return {"id": "operation-1", "status": "queued"}

        async def operation(self, engine_id):
            return {"id": "operation-1", "status": "succeeded"}

    monkeypatch.setattr(engine_runtime, "runtime_manager", Manager())
    assert await execute_engine_command(command) == ("succeeded", None)
    assert calls == [("codex", "1.2.3", {"rollback": False, "accept_terms": False})]


@pytest.mark.asyncio
async def test_control_reports_verified_command_result_without_blocking_heartbeat(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(config_module, "CONFIG_FILE", tmp_path / "config.json")
    store = config_module.ConfigStore()
    key, pem, fingerprint, claims = _credential()
    command = {"kind": "device_command", "version": 1, "device_id": "device-1",
               "token": _sign(key, claims)}
    client = GatewayControlClient("https://gateway.test", gateway_id="gateway-test",
                                  public_key_fingerprint=fingerprint, user_id="user-1",
                                  policy_cache=ManagedPolicyCache(), provider_store=store)

    async def action(_command):
        await asyncio.sleep(0.08)
        return "succeeded", None

    client.command_executor = ManagedCommandExecutor(store, action)
    sent = []

    class Socket:
        async def send(self, raw):
            sent.append(json.loads(raw))

    client._accept_command(Socket(), {"command": command}, pem, "device-1")
    await asyncio.sleep(0.02)
    assert [item["status"] for item in sent] == ["received", "running"]
    await asyncio.wait_for(asyncio.sleep(0.01), timeout=0.05)
    await asyncio.gather(*client._command_tasks)
    assert sent[-1]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_slow_command_receipt_disk_does_not_block_control_loop(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(config_module, "CONFIG_FILE", tmp_path / "config.json")
    store = config_module.ConfigStore()
    original = store.claim_managed_command

    def slow_claim(*args):
        time.sleep(0.15)
        return original(*args)

    monkeypatch.setattr(store, "claim_managed_command", slow_claim)
    key, pem, fingerprint, claims = _credential()
    command = verify_device_command(_sign(key, claims), pem, fingerprint,
                                    "gateway-test", "device-1")
    executor = ManagedCommandExecutor(store, lambda _command: asyncio.sleep(
        0, result=("succeeded", None),
    ))
    task = asyncio.create_task(executor.execute(command))
    await asyncio.sleep(0.02)
    assert not task.done()
    await asyncio.wait_for(asyncio.sleep(0.01), timeout=0.05)
    assert await task == ("succeeded", None)


@pytest.mark.asyncio
async def test_managed_local_engine_actions_require_policy(monkeypatch):
    def deny(_action):
        raise PermissionError("Managed capability denied")

    monkeypatch.setattr(engine_api, "require_managed_capability", deny)
    app = FastAPI()
    app.include_router(engine_api.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url="http://127.0.0.1") as client:
        assert (await client.post("/api/engine/refresh")).status_code == 403
        assert (await client.post("/api/engine/test", json={"engine_id": "codex"})).status_code == 403
        assert (await client.post("/api/engine/codex/runtime/operation", json={
            "version": "1.2.3",
        })).status_code == 403
        assert (await client.post("/api/engine/codex/install")).status_code == 403
        assert (await client.post("/api/engine/codex/update")).status_code == 403
