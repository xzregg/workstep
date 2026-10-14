"""Provider execution and catalogs belong to the project-hosting device."""

import asyncio
import time
from dataclasses import replace

import pytest

from engines.codex_sdk import CodexSDKEngine
from services import config as config_module
from services.channels.base import IncomingMessage
from services.gateway_client.policy import ManagedPolicyCache, verify_policy_snapshot
from services.gateway_client.service import GatewayClientService
from services.remote_access import ActorSnapshot, actor_context, get_current_actor
from tests.test_channel_bots import bots  # shared project databases and platform adapters
from tests.test_gateway_policy import _signed_policy


@pytest.fixture
def local_provider(tmp_path, monkeypatch):
    monkeypatch.setattr(config_module, "CONFIG_FILE", tmp_path / "providers.json")
    store = config_module.ConfigStore()
    store.save_provider({
        "id": "local", "name": "Local", "type": "custom",
        "protocols": ["openai_responses"], "api_key": "test-secret",
        "base_url": "https://api.example.test/v1",
    })
    store.set_engine_provider("codex_sdk", "local")
    service = object.__new__(GatewayClientService)
    service.policy_cache = ManagedPolicyCache()
    token, pem, fingerprint = _signed_policy(allow_local_providers=True)
    service.policy_cache.apply(verify_policy_snapshot(
        token, pem, fingerprint, "gateway-test", "device-1", "user-1",
    ))
    store.set_managed_gateway_id("gateway-test")
    monkeypatch.setattr(CodexSDKEngine, "provider_config_store", classmethod(lambda cls: store))
    return service, store


@pytest.mark.parametrize("policy_state", ["allowed", "denied", "expired", "missing"])
@pytest.mark.parametrize("source,user_id,project_id", [
    ("channel", "channel:wecom:sender", None),
    ("managed", "user-1", None),
    ("managed", "other-user", None),
    ("managed", "user-1", "remote-project"),
    ("remote", "user-1", None),
    ("browser", "browser-user", None),
])
def test_local_provider_is_available_independently_of_gateway_and_execution_source(
    local_provider, policy_state, source, user_id, project_id,
):
    service, store = local_provider
    policy = service.policy_cache.current
    if policy_state == "denied":
        service.policy_cache.current = replace(policy, allow_local_providers=False)
    elif policy_state == "expired":
        service.policy_cache.current = replace(policy, expires_at=int(time.time()) - 1)
    elif policy_state == "missing":
        service.policy_cache.clear()
    actor = ActorSnapshot(user_id, "Sender", "device-1", "PC", source, project_id=project_id)
    with actor_context(actor):
        assert store.get_provider("local") is not None
        assert CodexSDKEngine().resolve_provider_runtime(model="gpt-5.5").provider_id == "local"


@pytest.mark.parametrize("target", ["project", "task"])
@pytest.mark.parametrize("platform", ["wecom", "dingtalk"])
async def test_bot_inbound_resolves_default_local_provider(bots, local_provider, target, platform):
    manager, project, _, _, _, adapters = bots
    service, _ = local_provider
    resolved = []

    async def check_provider():
        actor = get_current_actor()
        assert actor.source == "channel"
        assert actor.actor_id == f"channel:{platform}:sender"
        runtime = await asyncio.to_thread(CodexSDKEngine().resolve_provider_runtime, model="gpt-5.5")
        resolved.append(runtime.provider_id)

    if target == "project":
        original = manager._responder

        async def respond(*args, **kwargs):
            await check_provider()
            return await original(*args, **kwargs)

        manager._responder = respond
    else:
        original = manager._coordinator.submit_message

        async def submit(*args, **kwargs):
            await check_provider()
            return await original(*args, **kwargs)

        manager._coordinator.submit_message = submit

    bot = await manager.create_bot({
        "platform": platform, "name": "机器人", "app_id": "bot", "secret": "secret",
        "enabled": True, "default_target_type": "project", "default_project_id": project.id,
    })
    if target == "task":
        await manager.bind_group(project.id, "task-1", bot["id"], "group")
    await manager.handle_message(IncomingMessage(
        bot["id"], "allowed", "group", "group", "sender", "进度？",
    ))
    assert resolved == ["local"]
    assert len(adapters[bot["id"]].sent) == 1
    assert "回复：" in adapters[bot["id"]].sent[0][1]

    service.policy_cache.current = replace(service.policy_cache.current, allow_local_providers=False)
    await manager.handle_message(IncomingMessage(
        bot["id"], "revoked", "group", "group", "sender", "继续",
    ))
    assert resolved == ["local", "local"]
    assert "回复：" in adapters[bot["id"]].sent[-1][1]


async def test_remote_project_provider_and_model_catalogs_use_host_device(bots, local_provider, monkeypatch):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    import api.engine as engine_api
    import api.provider as provider_api

    manager, project, _, _, _, _ = bots
    service, store = local_provider
    service.policy_cache.current = replace(
        service.policy_cache.current, allowed_provider_ids=frozenset({"device-provider"}),
    )
    store.set_managed_gateway_id("gateway-test", provider_guard=lambda provider_id: bool(
        service.policy_cache.current and service.policy_cache.current.valid
        and provider_id in service.policy_cache.current.allowed_provider_ids
    ))
    store.apply_managed_providers("gateway-test", 1, [{
        "id": "device-provider", "name": "Device provider", "type": "custom",
        "protocols": ["openai_responses"], "api_key": "device-test-secret",
        "protocol_base_urls": {"openai_responses": "https://api.example.test/v1"},
        "models": ["device-model"],
    }], user_id="user-1")
    store.set_engine_default_model("codex_sdk", "device-model")
    store.set_provider_models("local", [{"id": "local-model"}], "test", "openai_responses")
    monkeypatch.setattr(provider_api, "config_store", store)
    monkeypatch.setattr(engine_api, "config_store", store)
    monkeypatch.setattr(engine_api, "project_manager", manager._project_manager)
    monkeypatch.setattr(engine_api, "refresh_registry", lambda **_kwargs: None)
    monkeypatch.setattr(engine_api, "create_engine", lambda _id: CodexSDKEngine())
    monkeypatch.setattr("services.providers.config_store", store)
    app = FastAPI()
    app.include_router(provider_api.router)
    app.include_router(engine_api.router)
    visitor = ActorSnapshot(
        "visitor", "Visitor", "visitor-device", "PC", "managed", project_id=project.id,
        provider_ids=frozenset({"elsewhere-provider"}),
        provider_grant_expires_at=int(time.time()) + 60,
    )
    with actor_context(visitor):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/provider/list", params={"project_id": project.id})
            assert response.status_code == 200
            providers = response.json()["providers"]
            assert {item["id"] for item in providers} == {"local", "device-provider"}
            assert all(not item["has_key"] and not item["base_url"] for item in providers)
            for provider_id, models in (("local", ["local-model"]), ("device-provider", ["device-model"]),
                                        ("elsewhere-provider", [])):
                response = await client.get("/api/engine/codex_sdk/models", params={
                    "project_id": project.id, "provider_id": provider_id,
                })
                assert response.status_code == 200
                assert [item["id"] for item in response.json()["models"]] == models
                assert bool(response.json()["error"]) is (provider_id == "elsewhere-provider")
            service.policy_cache.clear()
            response = await client.get("/api/provider/list", params={"project_id": project.id})
            assert [item["id"] for item in response.json()["providers"]] == ["local"]


@pytest.mark.parametrize("source", ["managed", "browser", "remote"])
async def test_failed_message_retry_resolves_current_default_provider(bots, local_provider, monkeypatch, source):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    import main
    from api.task import router
    from engines.core.events import InternalEvent
    from engines.core.registry import ENGINE_REGISTRY
    from models import Message, StepRun, Task
    from models.fields import utc_now
    from services.workflow_runtime import WorkflowRuntime

    manager, project, _, _, _, _ = bots
    projects = manager._project_manager
    _, store = local_provider
    bus = manager._event_bus
    runtime = WorkflowRuntime(bus, projects)
    monkeypatch.setattr(main, "project_manager", projects)
    monkeypatch.setattr(main, "workflow_runtime", runtime)
    observed = []

    class ProviderEngine(CodexSDKEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            provider_id = (kwargs.get("config_overrides") or {}).get("provider_id")
            resolved = await asyncio.to_thread(self.resolve_provider_runtime, provider_id, "gpt-5.5")
            observed.append((get_current_actor().actor_id, resolved.provider_id))
            yield InternalEvent(type="agent_message_chunk", data={"content": {"text": "已恢复"}})

    monkeypatch.setitem(ENGINE_REGISTRY, "codex_sdk", ProviderEngine)

    def create_task(_project):
        now = utc_now()
        workflow = projects.create_workflow(
            project, "Retry", steps={"nodes": [{
                "id": 1, "type": "ui", "title": "UI 设计", "engine": "codex_sdk",
                "prompt": "设计", "review": {"mode": "skip"},
            }]},
        )
        return Task.create(
            id="provider-retry", title="Retry", workflow_id=workflow["id"],
            cwd=str(project.path), engine="codex_sdk", created_at=now, updated_at=now,
        ).id

    task_id = await projects.run_db(project.id, create_task)
    owner = ActorSnapshot("user-1", "Owner", "device-1", "PC", source)
    app = FastAPI()
    app.include_router(router)
    try:
        with actor_context(owner):
            store.set_engine_provider("codex_sdk", "missing")
            handle = await runtime.start(project.id, task_id, "")
            await runtime.wait(handle)

            def failed_message(_project):
                row = Message.get((Message.task == task_id) & (Message.role == "assistant")
                                  & (Message.channel == "execution"))
                assert row.run_status == "failed"
                assert "供应商不存在" in StepRun.get_by_id(row.step_run_id).error
                return row.id

            message_id = await projects.run_db(project.id, failed_message)
            store.set_engine_provider("codex_sdk", "local")
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.post(
                    f"/api/task/{task_id}/messages/{message_id}/retry",
                    params={"project_id": project.id},
                )
            assert response.status_code == 200, response.text
            assert response.json()["message_id"] == message_id
            await asyncio.gather(*tuple(runtime._active_tasks))

        def recovered_message(_project):
            row = Message.get_by_id(message_id)
            assert row.run_status == "succeeded"
            assert row.content == "已恢复"
            assert Message.select().where((Message.task == task_id) & (Message.role == "assistant")
                                          & (Message.channel == "execution")).count() == 1

        await projects.run_db(project.id, recovered_message)
        assert observed == [("user-1", "local")]
    finally:
        await runtime.shutdown()
