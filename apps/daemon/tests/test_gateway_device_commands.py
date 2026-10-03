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
async def test_command_survives_control_waiter_cancellation_and_replays_after_reconnect(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(config_module, "CONFIG_FILE", tmp_path / "config.json")
    store = config_module.ConfigStore()
    key, pem, fingerprint, claims = _credential()
    command = verify_device_command(_sign(key, claims), pem, fingerprint,
                                    "gateway-test", "device-1")
    started = asyncio.Event()
    finish = asyncio.Event()
    calls = []

    async def action(_command):
        calls.append(_command.command_id)
        started.set()
        await finish.wait()
        return "succeeded", None

    executor = ManagedCommandExecutor(store, action)
    first_connection = asyncio.create_task(executor.execute(command))
    await asyncio.wait_for(started.wait(), timeout=1)
    first_connection.cancel()
    await asyncio.gather(first_connection, return_exceptions=True)
    assert store.get("managed_command_receipts", {})[command.command_id]["status"] == "running"
    second_connection = asyncio.create_task(executor.execute(command))
    finish.set()
    assert await asyncio.wait_for(second_connection, timeout=1) == ("succeeded", None)
    assert calls == [command.command_id]
    assert await ManagedCommandExecutor(config_module.ConfigStore(), action).execute(command) == (
        "succeeded", None)
    assert calls == [command.command_id]


@pytest.mark.asyncio
async def test_reconciliation_token_never_starts_an_expired_command_without_receipt(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(config_module, "CONFIG_FILE", tmp_path / "config.json")
    store = config_module.ConfigStore()
    key, pem, fingerprint, claims = _credential()
    token = _sign(key, {**claims, "kind": "device.command.reconcile"})
    command = verify_device_command(token, pem, fingerprint, "gateway-test", "device-1")
    calls = []

    async def action(_command):
        calls.append(_command.command_id)
        return "succeeded", None

    assert await ManagedCommandExecutor(store, action).execute(command) == (
        "failed", "Previous execution not found")
    assert calls == []
    assert store.get("managed_command_receipts", {}) == {}
    store.claim_managed_command(command.command_id, command.idempotency_key)
    store.finish_managed_command(command.command_id, command.idempotency_key,
                                 "succeeded", None)
    assert await ManagedCommandExecutor(config_module.ConfigStore(), action).execute(command) == (
        "succeeded", None)
    assert calls == []


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
    assert calls == [("codex", "1.2.3", {"rollback": False, "accept_terms": False,
        "managed_command": {"command_id": "command-1", "idempotency_key": "idempotency-1",
                            "device_id": "device-1", "action": "install", "version": "1.2.3",
                            "accept_third_party_terms": False}})]


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
async def test_control_reconnect_reports_one_continued_install(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(config_module, "CONFIG_FILE", tmp_path / "config.json")
    store = config_module.ConfigStore()
    key, pem, fingerprint, claims = _credential()
    envelope = {"command": {"kind": "device_command", "version": 1,
                            "device_id": "device-1", "token": _sign(key, claims)}}
    client = GatewayControlClient("https://gateway.test", gateway_id="gateway-test",
                                  public_key_fingerprint=fingerprint, user_id="user-1",
                                  policy_cache=ManagedPolicyCache(), provider_store=store)
    started, finish = asyncio.Event(), asyncio.Event()
    calls = []

    async def action(command):
        calls.append(command.command_id)
        started.set()
        await finish.wait()
        return "succeeded", None

    client.command_executor = ManagedCommandExecutor(store, action)
    first, second = [], []

    class Socket:
        def __init__(self, messages):
            self.messages = messages

        async def send(self, raw):
            self.messages.append(json.loads(raw))

    client._accept_command(Socket(first), envelope, pem, "device-1")
    await asyncio.wait_for(started.wait(), timeout=1)
    first_task = next(iter(client._command_tasks))
    first_task.cancel()
    await asyncio.gather(first_task, return_exceptions=True)
    assert store.get("managed_command_receipts", {})["command-1"]["status"] == "running"
    client._accept_command(Socket(second), envelope, pem, "device-1")
    finish.set()
    await asyncio.gather(*client._command_tasks)
    assert calls == ["command-1"]
    assert second[-1]["status"] == "succeeded"
    assert store.get("managed_command_receipts", {})["command-1"]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_control_reports_running_only_after_receipt_is_durable(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(config_module, "CONFIG_FILE", tmp_path / "config.json")
    store = config_module.ConfigStore()
    claim_started = asyncio.Event()
    release_claim = asyncio.Event()
    loop = asyncio.get_running_loop()
    original_claim = store.claim_managed_command

    def slow_claim(*args):
        loop.call_soon_threadsafe(claim_started.set)
        while not release_claim.is_set():
            time.sleep(0.005)
        return original_claim(*args)

    monkeypatch.setattr(store, "claim_managed_command", slow_claim)
    key, pem, fingerprint, claims = _credential()
    client = GatewayControlClient("https://gateway.test", gateway_id="gateway-test",
                                  public_key_fingerprint=fingerprint, user_id="user-1",
                                  policy_cache=ManagedPolicyCache(), provider_store=store)
    client.command_executor = ManagedCommandExecutor(store, lambda _command: asyncio.sleep(
        0, result=("succeeded", None)))
    sent = []

    class Socket:
        async def send(self, raw):
            sent.append(json.loads(raw))

    client._accept_command(Socket(), {"command": {"kind": "device_command", "version": 1,
        "device_id": "device-1", "token": _sign(key, claims)}}, pem, "device-1")
    try:
        await asyncio.wait_for(claim_started.wait(), timeout=1)
        assert [item["status"] for item in sent] == ["received"]
    finally:
        release_claim.set()
    await asyncio.gather(*client._command_tasks)
    assert [item["status"] for item in sent] == ["received", "running", "succeeded"]


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


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["queued", "running", "interrupted", "succeeded", "failed"])
async def test_restarted_command_reconciles_matching_runtime_journal(tmp_path, monkeypatch, status):
    from services import engine_runtime
    from services.gateway_client.engine_actions import recover_engine_command

    monkeypatch.setattr(config_module, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(config_module, "CONFIG_FILE", tmp_path / "config.json")
    store = config_module.ConfigStore()
    key, pem, fingerprint, claims = _credential()
    command = verify_device_command(_sign(key, {
        **claims, "engine_id": "codex_sdk", "action": "rollback", "kind": "device.command.reconcile",
    }), pem, fingerprint, "gateway-test", "device-1")
    store.claim_managed_command(command.command_id, command.idempotency_key)
    manager = engine_runtime.EngineRuntimeManager(tmp_path / "runtimes")
    scope = {"command_id": command.command_id, "idempotency_key": command.idempotency_key,
             "device_id": command.device_id, "action": command.action,
             "version": command.version, "accept_third_party_terms": False}
    operation = {"id": "original-operation", "engine_id": "codex_sdk", "action": "rollback",
                 "target_version": "1.2.3", "previous_version": "1.3.0",
                 "status": "running" if status == "interrupted" else status,
                 "stage": "installing", "managed_command": scope}
    await asyncio.to_thread(manager._save, "codex_sdk", {
        "operation": operation, "rollback_version": "1.2.3", "history": [],
    })
    calls = []

    async def install(engine_id, spec, state, record):
        calls.append((state["id"], state["target_version"], state["action"]))
        state.update(status="succeeded", stage="completed")
        record["operation"] = state
        await asyncio.to_thread(manager._save, engine_id, record)
        manager._busy = False

    monkeypatch.setattr(manager, "_run", install)
    monkeypatch.setattr(engine_runtime, "runtime_manager", manager)
    if status == "interrupted":
        assert (await manager.operation("codex_sdk"))["status"] == "failed"

    async def never_start(_command):
        pytest.fail("Recovery must not call the fresh-command action")

    executor = ManagedCommandExecutor(config_module.ConfigStore(), never_start,
                                      recover=recover_engine_command)
    try:
        result = await executor.execute(command)
        assert result == (("failed", "Engine operation failed") if status == "failed"
                          else ("succeeded", None))
        assert calls == ([] if status in ("succeeded", "failed") else
                         [("original-operation", "1.2.3", "rollback")])
        assert await executor.execute(command) == result
        assert config_module.ConfigStore().get("managed_command_receipts", {})[command.command_id]["status"] == result[0]
    finally:
        await manager.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize("changed", [None, {"command_id": "other"}, {"device_id": "other"},
                                     {"version": "9.9.9"}, {"accept_third_party_terms": True}])
async def test_recovery_rejects_missing_or_mismatched_journal(tmp_path, monkeypatch, changed):
    from services import engine_runtime
    from services.gateway_client.engine_actions import recover_engine_command

    key, pem, fingerprint, claims = _credential()
    command = verify_device_command(_sign(key, {**claims, "engine_id": "codex_sdk", "action": "install", "version": "1.2.3"}),
                                    pem, fingerprint, "gateway-test", "device-1")
    manager = engine_runtime.EngineRuntimeManager(tmp_path / "runtimes")
    if changed is not None:
        scope = {"command_id": command.command_id, "idempotency_key": command.idempotency_key,
                 "device_id": command.device_id, "action": command.action,
                 "version": command.version, "accept_third_party_terms": False, **changed}
        await asyncio.to_thread(manager._save, "codex_sdk", {"operation": {
            "id": "foreign-operation", "status": "running", "managed_command": scope,
            "target_version": "1.2.3", "action": "install",
        }})
    monkeypatch.setattr(engine_runtime, "runtime_manager", manager)
    assert await recover_engine_command(command) == ("failed", "Previous execution interrupted")
    assert manager._task is None


@pytest.mark.asyncio
async def test_slow_recovery_journal_keeps_health_responsive(tmp_path, monkeypatch):
    from services import engine_runtime
    from services.gateway_client.engine_actions import recover_engine_command

    manager = engine_runtime.EngineRuntimeManager(tmp_path / "runtimes")
    entered = asyncio.Event()
    loop = asyncio.get_running_loop()

    def slow_read(_engine_id):
        loop.call_soon_threadsafe(entered.set)
        time.sleep(0.2)
        return {}

    monkeypatch.setattr(manager, "_read", slow_read)
    monkeypatch.setattr(engine_runtime, "runtime_manager", manager)
    key, pem, fingerprint, claims = _credential()
    command = verify_device_command(_sign(key, {**claims, "engine_id": "codex_sdk", "action": "install", "version": "1.2.3"}),
                                    pem, fingerprint, "gateway-test", "device-1")
    recovery = asyncio.create_task(recover_engine_command(command))
    app = FastAPI()

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    await asyncio.wait_for(entered.wait(), 1)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        assert (await asyncio.wait_for(client.get("/health"), .1)).status_code == 200
    assert not recovery.done()
    assert await recovery == ("failed", "Previous execution interrupted")
