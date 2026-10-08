"""Contracts for engine configuration and provider (供应商) settings."""

import asyncio
import json
import sqlite3
import stat
import time

import pytest
from httpx import ASGITransport, AsyncClient

import api.engine as engine_api
import api.provider as provider_api
import engines.claude_agent_sdk as claude_agent_sdk_engine_module
import engines.claude_code as claude_code_engine_module
import engines.deepseek_harness as deepseek_harness_engine_module
import engines.pydantic_ai.engine as pydantic_ai_engine_module
import engines.core.registry as engine_registry
import main
import services.config as config_module
from services import providers as provider_service
from services.config import ConfigStore
from engines.pydantic_ai import PydanticAIEngine
from engines.core.base import EngineModel, EngineInstallResult, EngineTestResult
from engines.core.events import InternalEvent


class MemoryEngineConfigStore:
    """In-memory stand-in for ConfigStore covering engine + provider config."""

    def __init__(self):
        self.providers: list[dict] = []
        self.provider_models: dict[str, dict] = {}
        self.engine_models: dict[str, dict] = {}
        self.pydantic_ai_config = {
            "provider_id": "", "model": "", "mcp_servers": [], "sandbox": "workspace-write",
        }
        self.deepseek_harness_config = {
            "provider_id": "",
            "model": "deepseek-v4-flash",
            "max_tokens": "",
            "preset": "standard",
        }
        self.default_models = {}
        self.execution_default_engine = ""
        self.coordinator_default_engine = ""
        self.coordinator_default_model = ""
        self.coordinator_default_fast_model = ""
        self.coordinator_default_vision_model = ""
        self.coordinator_default_thinking_effort = ""
        self.verified_engines = set()
        self.engine_providers = {}
        self.claude_permission_mode = ""
        self.claude_code_model_map = ""
        self.claude_code_custom_settings = ""
        self.claude_agent_sdk_config = {
            "permission_mode": "",
            "max_turns": "",
            "fallback_model": "",
            "model_map": "",
            "custom_settings": "",
        }

    # --- providers ---

    def get_providers(self):
        return [dict(item) for item in self.providers]

    def get_provider(self, provider_id):
        for item in self.providers:
            if item.get("id") == provider_id:
                return dict(item)
        return None

    def save_provider(self, provider):
        for index, item in enumerate(self.providers):
            if item.get("id") == provider.get("id"):
                self.providers[index] = dict(provider)
                return dict(provider)
        self.providers.append(dict(provider))
        return dict(provider)

    def delete_provider(self, provider_id):
        remaining = [item for item in self.providers if item.get("id") != provider_id]
        removed = len(remaining) != len(self.providers)
        self.providers = remaining
        return removed

    # --- provider model list cache ---

    def get_provider_models(self, provider_id, protocol=""):
        entry = self.provider_models.get(
            f"{provider_id}::{protocol}" if protocol else provider_id
        )
        if not entry and protocol:
            entry = self.provider_models.get(provider_id)
        return dict(entry) if entry else {}

    def set_provider_models(self, provider_id, models, fetched_at, protocol=""):
        entry = {"models": list(models), "fetched_at": fetched_at}
        self.provider_models[provider_id] = entry
        if protocol:
            self.provider_models[f"{provider_id}::{protocol}"] = entry

    def clear_provider_models(self, provider_id):
        self.provider_models.pop(provider_id, None)
        for key in list(self.provider_models):
            if key.startswith(f"{provider_id}::"):
                self.provider_models.pop(key, None)

    def get_engine_models(self, engine_id):
        entry = self.engine_models.get(engine_id)
        return dict(entry) if entry else {}

    def set_engine_models(self, engine_id, models, fetched_at):
        self.engine_models[engine_id] = {
            "models": list(models),
            "fetched_at": fetched_at,
        }

    def clear_engine_models(self, engine_id):
        self.engine_models.pop(engine_id, None)

    def is_provider_in_use(self, provider_id):
        return (
            self.pydantic_ai_config.get("provider_id") == provider_id
            or self.deepseek_harness_config.get("provider_id") == provider_id
            or provider_id in self.engine_providers.values()
        )

    def get_engine_provider(self, engine_id):
        return self.engine_providers.get(engine_id, "")

    def set_engine_provider(self, engine_id, provider_id):
        if provider_id:
            self.engine_providers[engine_id] = provider_id
        else:
            self.engine_providers.pop(engine_id, None)

    # --- Claude engines ---

    def get_claude_permission_mode(self):
        return self.claude_permission_mode

    def set_claude_permission_mode(self, mode):
        self.claude_permission_mode = mode
        self.claude_agent_sdk_config["permission_mode"] = mode

    def get_claude_code_config(self):
        return {
            "model_map": self.claude_code_model_map,
            "custom_settings": self.claude_code_custom_settings,
        }

    def set_claude_code_config(self, model_map=None, custom_settings=None):
        from services.config import (
            claude_model_map_json,
            normalize_claude_custom_settings,
            normalize_claude_model_map,
        )
        if model_map is not None:
            self.claude_code_model_map = claude_model_map_json(
                normalize_claude_model_map(model_map)
            )
        if custom_settings is not None:
            self.claude_code_custom_settings = normalize_claude_custom_settings(
                custom_settings
            )

    def set_claude_code_model_map(self, model_map):
        self.set_claude_code_config(model_map=model_map)

    def get_claude_agent_sdk_config(self):
        return dict(self.claude_agent_sdk_config)

    def set_claude_agent_sdk_config(
        self,
        max_turns="",
        permission_mode=None,
        fallback_model="",
        model_map=None,
        custom_settings=None,
    ):
        if permission_mode is not None:
            self.set_claude_permission_mode(permission_mode)
        from services.config import (
            claude_model_map_json,
            normalize_claude_custom_settings,
            normalize_claude_model_map,
        )
        self.claude_agent_sdk_config.update({
            "max_turns": str(max_turns or ""),
            "fallback_model": str(fallback_model or ""),
        })
        if model_map is not None:
            self.claude_agent_sdk_config["model_map"] = claude_model_map_json(
                normalize_claude_model_map(model_map)
            )
        if custom_settings is not None:
            self.claude_agent_sdk_config["custom_settings"] = (
                normalize_claude_custom_settings(custom_settings)
            )

    # --- Pydantic AI engine ---

    def get_pydantic_ai_engine_config(self):
        config = dict(self.pydantic_ai_config)
        if not config.get("model"):
            config["model"] = self.get_engine_default_model("pydantic_ai") or ""
        config.setdefault("harness", "auto")
        config.setdefault("sandbox", "workspace-write")
        return config

    def set_pydantic_ai_engine_config(self, *, provider_id, model, mcp_servers=None, harness="auto", sandbox="workspace-write"):
        self.pydantic_ai_config = {
            "provider_id": provider_id,
            "model": model,
            "mcp_servers": list(mcp_servers or []),
            "harness": harness,
            "sandbox": sandbox,
        }
        self.default_models["pydantic_ai"] = model

    # --- DeepSeek Harness engine ---

    def get_deepseek_harness_config(self):
        return dict(self.deepseek_harness_config)

    def set_deepseek_harness_config(
        self,
        *,
        provider_id,
        model,
        max_tokens="",
        preset="standard",
    ):
        self.deepseek_harness_config = {
            "provider_id": provider_id,
            "model": model,
            "max_tokens": max_tokens,
            "preset": preset,
        }
        self.default_models["deepseek_harness"] = model

    # --- engine defaults ---

    def get_engine_default_model(self, engine_id):
        return self.default_models.get(engine_id, "")

    def set_engine_default_model(self, engine_id, model):
        self.default_models[engine_id] = model

    def get_engine_binary_path(self, engine_id):
        return ""

    def get_execution_default_engine(self):
        return self.execution_default_engine

    def set_execution_default_engine(self, engine):
        self.execution_default_engine = engine

    def get_coordinator_default_engine(self):
        return self.coordinator_default_engine

    def get_coordinator_default_model(self):
        return self.coordinator_default_model

    def get_coordinator_default_fast_model(self):
        return self.coordinator_default_fast_model

    def get_coordinator_default_vision_model(self):
        return self.coordinator_default_vision_model

    def get_coordinator_default_thinking_effort(self):
        return self.coordinator_default_thinking_effort

    def set_coordinator_defaults(
        self, engine, model="", fast_model="", vision_model="", thinking_effort=""
    ):
        self.coordinator_default_engine = engine
        self.coordinator_default_model = model
        self.coordinator_default_fast_model = fast_model
        self.coordinator_default_vision_model = vision_model
        self.coordinator_default_thinking_effort = thinking_effort

    def is_engine_verified(self, engine_id):
        return engine_id in self.verified_engines

    def set_engine_verified(self, engine_id, verified):
        if verified:
            self.verified_engines.add(engine_id)
        else:
            self.verified_engines.discard(engine_id)


@pytest.fixture
async def engine_client(monkeypatch):
    store = MemoryEngineConfigStore()
    monkeypatch.setattr(config_module, "config_store", store)
    monkeypatch.setattr(engine_api, "config_store", store)
    monkeypatch.setattr(provider_api, "config_store", store)
    monkeypatch.setattr(provider_service, "config_store", store)
    monkeypatch.setattr(pydantic_ai_engine_module, "config_store", store)
    monkeypatch.setattr(deepseek_harness_engine_module, "config_store", store)
    monkeypatch.setattr(claude_code_engine_module, "config_store", store)
    monkeypatch.setattr(claude_agent_sdk_engine_module, "config_store", store)
    monkeypatch.setattr(engine_registry, "config_store", store)
    engine_registry.refresh_registry()
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, store
    engine_registry.refresh_registry()


def _add_provider(
    store,
    name="DeepSeek 主账号",
    type_id="deepseek",
    protocol="openai_chat_completions",
):
    provider = {
        "id": f"prov_{len(store.get_providers()) + 1}",
        "name": name,
        "type": type_id,
        "protocol": protocol,
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "secret-value",
        "enabled": True,
        "verified": False,
        "created_at": "2026-01-01T00:00:00",
    }
    store.save_provider(provider)
    return provider


@pytest.mark.anyio
async def test_engine_refresh_does_not_block_health_check(engine_client, monkeypatch):
    client, _ = engine_client

    def slow_refresh(*, invalidate_scan=True):
        time.sleep(0.25)

    monkeypatch.setattr(engine_api, "refresh_registry", slow_refresh)
    monkeypatch.setattr(engine_api, "_engine_summaries", lambda: [])
    started = time.perf_counter()
    refresh = asyncio.create_task(client.post("/api/engine/refresh"))
    await asyncio.sleep(0.02)
    health = await client.get("/api/health")
    elapsed = time.perf_counter() - started
    refreshed = await refresh

    assert health.status_code == 200
    assert refreshed.status_code == 200
    assert elapsed < 0.15


@pytest.mark.anyio
async def test_engine_quota_uses_optional_backend_capability(engine_client, monkeypatch):
    client, _ = engine_client
    captured = {}

    class QuotaEngine:
        async def get_quota(self, cwd=""):
            captured["cwd"] = cwd
            return {"engine_id": "codex_sdk", "primary": {"remaining_percent": 81}}

    monkeypatch.setattr(engine_api, "create_engine", lambda engine_id: QuotaEngine())
    response = await client.get("/api/engine/codex_sdk/quota")

    assert response.status_code == 200
    assert response.json()["supported"] is True
    assert response.json()["quota"]["primary"]["remaining_percent"] == 81
    assert captured["cwd"]


@pytest.mark.anyio
async def test_engine_quota_is_hidden_for_unsupported_engine(engine_client, monkeypatch):
    client, _ = engine_client
    monkeypatch.setattr(engine_api, "create_engine", lambda engine_id: object())

    response = await client.get("/api/engine/claude/quota")

    assert response.json() == {
        "engine_id": "claude",
        "supported": False,
        "quota": None,
    }


def _write_cc_switch_db(path, providers):
    """Create a cc-switch style SQLite DB with the given providers."""
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE providers ("
        "id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL, "
        "settings_config TEXT NOT NULL, category TEXT, sort_index INTEGER, "
        "PRIMARY KEY (id, app_type))"
    )
    for provider in providers:
        conn.execute(
            "INSERT INTO providers (id, app_type, name, settings_config, category, sort_index) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                provider["id"],
                provider.get("app_type", "codex"),
                provider["name"],
                json.dumps(provider["settings"]),
                provider.get("category", ""),
                provider.get("sort_index", 0),
            ),
        )
    conn.commit()
    conn.close()


def _cc_switch_providers():
    return [
        {
            "id": "deepseek-id",
            "name": "DeepSeek",
            "settings": {
                "auth": {"OPENAI_API_KEY": "sk-deepseek-secret"},
                "config": (
                    'model_provider = "custom"\n'
                    'model = "deepseek-v4-pro[1m]"\n'
                    "[model_providers.custom]\n"
                    'name = "deepseek"\n'
                    'base_url = "https://api.deepseek.com"\n'
                    'wire_api = "responses"\n'
                ),
                "modelCatalog": {
                    "models": [{"model": "deepseek-v4-flash"}],
                },
            },
        },
        {
            "id": "local-id",
            "name": "本地中转",
            "settings": {
                "auth": {"OPENAI_API_KEY": "sk-local"},
                "config": (
                    "[model_providers.custom]\n"
                    'base_url = "http://localhost:3000/v1"\n'
                    'wire_api = "responses"\n'
                ),
            },
        },
        {
            "id": "lan-id",
            "name": "内网中转",
            "settings": {
                "auth": {"OPENAI_API_KEY": "sk-lan"},
                "config": (
                    "[model_providers.custom]\n"
                    'base_url = "http://192.168.50.21:3000/v1"\n'
                ),
            },
        },
        {
            "id": "claude-id",
            "app_type": "claude",
            "name": "Claude 中转",
            "settings": {
                "env": {
                    "ANTHROPIC_AUTH_TOKEN": "sk-claude",
                    "ANTHROPIC_BASE_URL": "https://claude.example.com/v1",
                    "ANTHROPIC_MODEL": "claude-model",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL": "qwen3-max",
                    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "Qwen Max",
                },
            },
        },
        {
            "id": "missing-url-id",
            "app_type": "opencode",
            "name": "缺少地址",
            "settings": {"options": {}, "models": {}},
        },
    ]


# --- Provider settings API ---


@pytest.mark.anyio
async def test_provider_crud_masks_and_reveals_key(engine_client):
    client, store = engine_client

    created = await client.post(
        "/api/provider",
        json={
            "name": "我的 DeepSeek",
            "type": "deepseek",
            "protocol": "openai_chat_completions",
            "base_url": "https://api.deepseek.com/v1",
            "api_key": "sk-secret-value",
            "enabled": True,
        },
    )
    body = created.json()
    assert body["saved"] is True
    provider = body["provider"]
    assert provider["name"] == "我的 DeepSeek"
    assert provider["type"] == "deepseek"
    assert provider["protocol"] == "openai_chat_completions"
    assert provider["protocols"] == ["openai_chat_completions"]
    assert provider["protocol_base_urls"] == {
        "openai_chat_completions": "https://api.deepseek.com/v1"
    }
    assert provider["base_url"] == "https://api.deepseek.com/v1"
    assert provider["has_key"] is True
    assert provider["api_key"] == ""
    assert "sk-secret-value" not in created.text
    assert len(store.get_providers()) == 1
    assert store.get_provider(provider["id"])["api_key"] == "sk-secret-value"

    # Update keeps the stored key when no new key is sent
    updated = await client.post(
        "/api/provider",
        json={
            "id": provider["id"],
            "name": "我的 DeepSeek 2",
            "type": "deepseek",
            "base_url": "https://api.deepseek.com/v1",
            "enabled": True,
        },
    )
    assert updated.json()["saved"] is True
    assert updated.json()["provider"]["name"] == "我的 DeepSeek 2"
    assert store.get_provider(provider["id"])["api_key"] == "sk-secret-value"

    # Explicit reveal returns the secret
    revealed = await client.post(f"/api/provider/{provider['id']}/reveal")
    assert revealed.json() == {"key": "api_key", "value": "sk-secret-value"}
    assert revealed.headers["cache-control"] == "no-store"

    # Clear the key
    cleared = await client.post(
        "/api/provider",
        json={
            "id": provider["id"],
            "name": "我的 DeepSeek 2",
            "type": "deepseek",
            "base_url": "https://api.deepseek.com/v1",
            "enabled": True,
            "clear": {"api_key": True},
        },
    )
    assert cleared.json()["saved"] is True
    assert cleared.json()["provider"]["has_key"] is False
    assert store.get_provider(provider["id"])["api_key"] == ""

    listed = await client.get("/api/provider/list")
    items = listed.json()["providers"]
    assert len(items) == 1
    assert items[0]["id"] == provider["id"]
    assert "sk-secret-value" not in listed.text


@pytest.mark.anyio
async def test_provider_list_embeds_type_presets(engine_client):
    client, _ = engine_client
    body = (await client.get("/api/provider/list")).json()
    types = {item["id"]: item for item in body["types"]}
    assert types["deepseek"]["default_base_url"] == "https://api.deepseek.com/v1"
    assert types["moonshot"]["default_base_url"] == "https://api.moonshot.cn/v1"
    assert types["openai"]["default_base_url"] == "https://api.openai.com/v1"
    assert types["anthropic"]["default_base_url"] == "https://api.anthropic.com/v1"
    assert types["ollama"]["default_base_url"] == "http://localhost:11434/v1"
    assert types["custom"]["default_base_url"] == ""
    assert all(item["supports_balance"] is False for item in body["types"])


@pytest.mark.anyio
async def test_provider_save_validates_input(engine_client):
    client, _ = engine_client

    missing_name = await client.post(
        "/api/provider",
        json={"name": "", "type": "deepseek", "base_url": "https://api.deepseek.com/v1"},
    )
    assert missing_name.json()["saved"] is False
    assert "名称" in missing_name.json()["message"]

    unknown_type = await client.post(
        "/api/provider",
        json={"name": "x", "type": "not-a-type", "base_url": "https://api.x.com/v1"},
    )
    assert unknown_type.json()["saved"] is False
    assert "供应商类型" in unknown_type.json()["message"]

    plain_http = await client.post(
        "/api/provider",
        json={"name": "x", "type": "custom", "base_url": "http://192.168.1.20:11434/v1"},
    )
    assert plain_http.json()["saved"] is True

    empty_protocols = await client.post(
        "/api/provider",
        json={
            "name": "x",
            "type": "custom",
            "protocols": [],
            "base_url": "https://api.x.com",
        },
    )
    assert empty_protocols.json()["saved"] is False
    assert "至少选择一个" in empty_protocols.json()["message"]

    invalid_protocol = await client.post(
        "/api/provider",
        json={
            "name": "x",
            "type": "custom",
            "protocols": ["not-a-protocol"],
            "protocol_base_urls": {"not-a-protocol": "https://api.x.com"},
            "base_url": "https://api.x.com",
        },
    )
    assert invalid_protocol.json()["saved"] is False
    assert "供应商协议" in invalid_protocol.json()["message"]

    missing_protocol_url = await client.post(
        "/api/provider",
        json={
            "name": "x",
            "type": "custom",
            "protocols": ["openai_responses", "anthropic_messages"],
            "protocol_base_urls": {
                "openai_responses": "https://openai.example.com",
            },
            "base_url": "",
        },
    )
    assert missing_protocol_url.json()["saved"] is False
    assert "Anthropic Messages" in missing_protocol_url.json()["message"]


@pytest.mark.anyio
async def test_provider_saves_independent_protocol_base_urls(engine_client):
    client, store = engine_client
    response = await client.post(
        "/api/provider",
        json={
            "name": "多协议网关",
            "type": "custom",
            "protocols": ["openai_responses", "anthropic_messages"],
            "protocol_base_urls": {
                "openai_responses": "https://openai.example.com/api/v2/",
                "anthropic_messages": "https://anthropic.example.com/proxy/v1",
            },
            "base_url": "https://ignored.example.com",
            "api_key": "shared-key",
        },
    )

    body = response.json()
    assert body["saved"] is True
    assert body["provider"]["protocol_base_urls"] == {
        "openai_responses": "https://openai.example.com/api/v2",
        "anthropic_messages": "https://anthropic.example.com/proxy/v1",
    }
    assert body["provider"]["base_url"] == "https://openai.example.com/api/v2"
    saved = store.get_provider(body["provider"]["id"])
    assert saved["protocol_base_urls"] == body["provider"]["protocol_base_urls"]


@pytest.mark.anyio
async def test_provider_test_and_models(engine_client, monkeypatch):
    client, store = engine_client
    provider = _add_provider(store)

    async def fake_test(provider, timeout_seconds=30, transport=None, protocol=None):
        return EngineTestResult(success=True, message="连接成功，读取到 2 个模型", duration_ms=12)

    async def fake_models(provider, transport=None, protocol=None):
        return [EngineModel(id="deepseek-chat", label="DeepSeek Chat")]

    monkeypatch.setattr(provider_api.provider_service, "test_connection", fake_test)
    monkeypatch.setattr(provider_api.provider_service, "fetch_models", fake_models)

    tested = await client.post(f"/api/provider/{provider['id']}/test", json={"timeout_seconds": 3})
    assert tested.json()["success"] is True
    assert store.get_provider(provider["id"])["verified"] is True

    models = await client.get(f"/api/provider/{provider['id']}/models?refresh=1")
    assert models.json()["models"] == [
        {"id": "deepseek-chat", "label": "DeepSeek Chat", "description": None}
    ]
    assert models.json()["error"] is None


@pytest.mark.anyio
async def test_provider_is_verified_only_after_every_protocol_passes(
    engine_client, monkeypatch
):
    client, store = engine_client
    provider = {
        "id": "prov_multi",
        "name": "Multi",
        "type": "custom",
        "protocols": ["openai_responses", "anthropic_messages"],
        "protocol": "openai_responses",
        "protocol_base_urls": {
            "openai_responses": "https://openai.example.com/v2",
            "anthropic_messages": "https://anthropic.example.com/v1",
        },
        "base_url": "https://openai.example.com/v2",
        "api_key": "shared-key",
        "enabled": True,
        "verified": False,
    }
    store.save_provider(provider)

    async def fake_test(provider, timeout_seconds=30, transport=None, protocol=None):
        return EngineTestResult(success=True, message=protocol, duration_ms=1)

    monkeypatch.setattr(provider_api.provider_service, "test_connection", fake_test)

    first = await client.post(
        "/api/provider/prov_multi/test",
        json={"timeout_seconds": 3, "protocol": "openai_responses"},
    )
    assert first.json()["success"] is True
    assert store.get_provider("prov_multi")["verified"] is False

    second = await client.post(
        "/api/provider/prov_multi/test",
        json={"timeout_seconds": 3, "protocol": "anthropic_messages"},
    )
    assert second.json()["success"] is True
    assert store.get_provider("prov_multi")["verified"] is True


@pytest.mark.anyio
async def test_provider_save_only_fetches_models_after_explicit_refresh(
    engine_client, monkeypatch
):
    client, _ = engine_client
    calls = {"count": 0}

    async def fake_models(provider, transport=None, protocol=None):
        calls["count"] += 1
        return [EngineModel(id="cached-model", label="Cached Model")]

    monkeypatch.setattr(provider_api.provider_service, "fetch_models", fake_models)

    created = await client.post("/api/provider", json={
        "name": "按需刷新",
        "type": "custom",
        "protocol": "openai_chat_completions",
        "base_url": "https://gateway.example.com/v1",
        "api_key": "secret",
    })
    provider_id = created.json()["provider"]["id"]
    cached = await client.get(f"/api/provider/{provider_id}/models")

    assert calls["count"] == 0
    assert cached.json()["models"] == []

    refreshed = await client.get(f"/api/provider/{provider_id}/models?refresh=1")
    assert calls["count"] == 1
    assert refreshed.json()["models"][0]["id"] == "cached-model"


@pytest.mark.anyio
async def test_provider_models_error_is_surfaced(engine_client, monkeypatch):
    client, store = engine_client
    provider = _add_provider(store)

    async def boom(provider, transport=None, protocol=None):
        raise RuntimeError("401 Unauthorized")

    monkeypatch.setattr(provider_api.provider_service, "fetch_models", boom)
    models = await client.get(f"/api/provider/{provider['id']}/models?refresh=1")
    assert models.json()["models"] == []
    assert "401" in models.json()["error"]


@pytest.mark.anyio
async def test_provider_models_returns_saved_copy_without_refetch(engine_client, monkeypatch):
    """模型列表保存后，再次读取不再请求供应商地址。"""
    client, store = engine_client
    provider = _add_provider(store)
    calls = {"count": 0}

    async def fake_models(provider, transport=None, protocol=None):
        calls["count"] += 1
        return [EngineModel(id="deepseek-chat", label="DeepSeek Chat")]

    monkeypatch.setattr(provider_api.provider_service, "fetch_models", fake_models)

    empty = await client.get(f"/api/provider/{provider['id']}/models")
    assert empty.json()["models"] == []
    assert calls["count"] == 0

    refreshed = await client.get(f"/api/provider/{provider['id']}/models?refresh=1")
    assert refreshed.json()["models"] == [
        {"id": "deepseek-chat", "label": "DeepSeek Chat", "description": None}
    ]
    assert calls["count"] == 1

    second = await client.get(f"/api/provider/{provider['id']}/models")
    assert second.json()["models"] == [
        {"id": "deepseek-chat", "label": "DeepSeek Chat", "description": None}
    ]
    assert second.json()["fetched_at"] is not None
    # 第二次读取走本地保存副本，不再调供应商。
    assert calls["count"] == 1

    refreshed_again = await client.get(f"/api/provider/{provider['id']}/models?refresh=1")
    assert refreshed_again.json()["models"] == [
        {"id": "deepseek-chat", "label": "DeepSeek Chat", "description": None}
    ]
    assert calls["count"] == 2


@pytest.mark.anyio
async def test_provider_list_includes_saved_model_status(engine_client, monkeypatch):
    """供应商列表透出已保存的模型数量与获取时间。"""
    client, store = engine_client
    provider = _add_provider(store)

    async def fake_models(provider, transport=None, protocol=None):
        return [
            EngineModel(id="deepseek-chat", label="DeepSeek Chat"),
            EngineModel(id="deepseek-reasoner", label="DeepSeek Reasoner"),
        ]

    monkeypatch.setattr(provider_api.provider_service, "fetch_models", fake_models)
    await client.get(f"/api/provider/{provider['id']}/models?refresh=1")

    listed = await client.get("/api/provider/list")
    row = next(item for item in listed.json()["providers"] if item["id"] == provider["id"])
    assert row["model_count"] == 2
    assert row["models_fetched_at"] is not None


@pytest.mark.anyio
async def test_engine_pydantic_ai_models_uses_saved_copy(engine_client, monkeypatch):
    """引擎模型接口默认读已保存副本；refresh=1 才重新拉取。"""
    client, store = engine_client
    provider = _add_provider(store)
    store.set_pydantic_ai_engine_config(
        provider_id=provider["id"],
        model="deepseek-chat",
    )
    calls = {"count": 0}

    async def fake_models(provider, transport=None, protocol=None):
        calls["count"] += 1
        return [EngineModel(id="deepseek-chat", label="DeepSeek Chat")]

    monkeypatch.setattr(
        pydantic_ai_engine_module.provider_service,
        "fetch_models",
        fake_models,
    )

    empty = await client.get("/api/engine/pydantic_ai/models")
    assert empty.json()["models"] == []
    assert calls["count"] == 0
    refreshed = await client.get("/api/engine/pydantic_ai/models?refresh=1")
    assert refreshed.json()["models"] != []
    assert calls["count"] == 1
    second = await client.get("/api/engine/pydantic_ai/models")
    assert second.json()["models"] != []
    assert calls["count"] == 1
    refreshed_again = await client.get("/api/engine/pydantic_ai/models?refresh=1")
    assert refreshed_again.json()["models"] != []
    assert calls["count"] == 2


@pytest.mark.anyio
async def test_native_engine_models_are_persisted_and_reused(engine_client, monkeypatch):
    client, store = engine_client
    calls = {"count": 0}

    class NativeEngine:
        def resolve_provider_runtime(self, provider_id=""):
            return None

        async def list_models(self, cwd):
            calls["count"] += 1
            return [EngineModel(id="native-model", label="Native Model")]

    monkeypatch.setattr(engine_api, "create_engine", lambda _engine_id: NativeEngine())
    monkeypatch.setattr(engine_api, "refresh_registry", lambda **_kwargs: None)

    empty = await client.get("/api/engine/native/models")
    first = await client.get("/api/engine/native/models?refresh=1")
    second = await client.get("/api/engine/native/models")
    refreshed = await client.get("/api/engine/native/models?refresh=1")

    assert empty.json()["models"] == []
    assert first.json()["models"] == second.json()["models"] == [{
        "id": "native-model",
        "label": "Native Model",
        "description": None,
    }]
    assert store.get_engine_models("native")["fetched_at"]
    assert refreshed.json()["fetched_at"]
    assert calls["count"] == 2


@pytest.mark.anyio
async def test_engine_deepseek_harness_models_delegates_to_bound_provider(
    engine_client,
    monkeypatch,
):
    """DeepSeek Harness 复用绑定供应商的模型缓存与刷新接口。"""
    client, store = engine_client
    provider = _add_provider(store)
    store.set_deepseek_harness_config(
        provider_id=provider["id"],
        model="deepseek-v4-flash",
    )
    calls = {"count": 0}

    async def fake_models(provider, transport=None, protocol=None):
        calls["count"] += 1
        return [EngineModel(id="deepseek-v4-flash", label="DeepSeek V4 Flash")]

    monkeypatch.setattr(
        deepseek_harness_engine_module.provider_service,
        "fetch_models",
        fake_models,
    )
    engine = deepseek_harness_engine_module.DeepSeekHarnessEngine()
    monkeypatch.setattr(engine_api, "refresh_registry", lambda **_kwargs: None)
    monkeypatch.setattr(engine_api, "create_engine", lambda engine_id: (
        engine if engine_id == "deepseek_harness" else None
    ))

    empty = await client.get("/api/engine/deepseek_harness/models")
    first = await client.get("/api/engine/deepseek_harness/models?refresh=1")
    refreshed = await client.get("/api/engine/deepseek_harness/models?refresh=1")

    assert empty.json()["models"] == []
    assert first.status_code == 200
    assert first.json()["models"] == [{
        "id": "deepseek-v4-flash",
        "label": "DeepSeek V4 Flash",
        "description": None,
    }]
    assert first.json()["fetched_at"] is not None
    assert refreshed.status_code == 200
    assert calls["count"] == 2


@pytest.mark.anyio
async def test_engine_pydantic_ai_models_delegates_to_provider(engine_client, monkeypatch):
    """GET /api/engine/pydantic_ai/models 直接调用绑定供应商的模型接口。"""
    client, store = engine_client
    provider = _add_provider(store)
    store.set_pydantic_ai_engine_config(
        provider_id=provider["id"],
        model="deepseek-chat",
    )

    called: dict = {}

    async def fake_models(provider, transport=None, protocol=None):
        called["provider"] = dict(provider)
        called["protocol"] = protocol
        return [EngineModel(id="deepseek-chat", label="DeepSeek Chat")]

    monkeypatch.setattr(
        pydantic_ai_engine_module.provider_service,
        "fetch_models",
        fake_models,
    )
    response = await client.get("/api/engine/pydantic_ai/models?refresh=1")
    assert response.status_code == 200
    payload = response.json()
    assert payload["engine_id"] == "pydantic_ai"
    assert payload["models"] == [
        {"id": "deepseek-chat", "label": "DeepSeek Chat", "description": None}
    ]
    assert payload["error"] is None
    assert called["provider"]["id"] == provider["id"]
    assert called["provider"]["base_url"] == provider["base_url"]
    assert called["provider"]["api_key"] == provider["api_key"]
    assert called["protocol"] == "openai_chat_completions"


@pytest.mark.anyio
async def test_engine_pydantic_ai_models_provider_override(engine_client, monkeypatch):
    """引擎动态配置：模型列表可按调用指定的供应商获取（覆盖全局配置）。"""
    client, store = engine_client
    provider = _add_provider(store, name="Global Provider")
    other = _add_provider(store, name="Assistant Provider")
    store.set_pydantic_ai_engine_config(
        provider_id=provider["id"],
        model="deepseek-chat",
    )

    called: dict = {}

    async def fake_models(provider, transport=None, protocol=None):
        called["provider"] = dict(provider)
        return [EngineModel(id="other-model", label="Other Model")]

    monkeypatch.setattr(
        pydantic_ai_engine_module.provider_service,
        "fetch_models",
        fake_models,
    )
    response = await client.get(
        f"/api/engine/pydantic_ai/models?provider_id={other['id']}&refresh=1"
    )
    assert response.status_code == 200
    assert called["provider"]["id"] == other["id"]
    payload = response.json()
    assert payload["models"] == [
        {"id": "other-model", "label": "Other Model", "description": None}
    ]
    assert payload["error"] is None


@pytest.mark.anyio
async def test_compatible_engine_models_use_provider_cache(engine_client, monkeypatch):
    client, store = engine_client
    provider = _add_provider(
        store,
        name="Responses Gateway",
        type_id="openai",
        protocol="openai_responses",
    )
    store.set_provider_models(
        provider["id"],
        [{"id": "gpt-gateway", "label": "GPT Gateway", "description": None}],
        "2026-08-20T00:00:00+00:00",
    )
    from engines.codex import CodexEngine

    monkeypatch.setattr(engine_api, "create_engine", lambda _engine_id: CodexEngine())
    monkeypatch.setattr(engine_api, "refresh_registry", lambda **_kwargs: None)

    async def unexpected_list_models(*_args, **_kwargs):
        raise AssertionError("provider-backed model reads must not call the CLI")

    monkeypatch.setattr(CodexEngine, "list_models", unexpected_list_models)

    result = (await client.get(
        f"/api/engine/codex/models?provider_id={provider['id']}"
    )).json()

    assert result["error"] is None
    assert result["models"] == [
        {"id": "gpt-gateway", "label": "GPT Gateway", "description": None}
    ]
    assert result["fetched_at"] == "2026-08-20T00:00:00+00:00"


@pytest.mark.anyio
async def test_provider_balance_placeholder(engine_client):
    client, store = engine_client
    provider = _add_provider(store)
    balance = await client.get(f"/api/provider/{provider['id']}/balance")
    body = balance.json()
    assert body["supported"] is False
    assert body["balance"] is None
    assert "后续版本" in body["message"]


@pytest.mark.anyio
async def test_cc_switch_import_sources_masks_keys(engine_client, monkeypatch, tmp_path):
    client, store = engine_client
    db_path = tmp_path / "cc-switch.db"
    _write_cc_switch_db(db_path, _cc_switch_providers())
    monkeypatch.setattr(
        provider_api.provider_service,
        "CC_SWITCH_DB_PATH",
        db_path,
    )

    response = await client.get("/api/provider/import/sources")
    assert response.status_code == 200
    sources = response.json()["sources"]
    assert len(sources) == 1
    source = sources[0]
    assert source["id"] == "cc-switch"
    assert source["name"] == "cc-switch"
    assert source["provider_count"] == 4
    assert source["description"] == "发现 4 个 CC Switch 供应商配置"
    by_id = {item["id"]: item for item in source["providers"]}
    assert "missing-url-id" not in by_id
    deepseek = by_id["deepseek-id"]
    assert "api_key" not in deepseek
    assert deepseek["has_key"] is True
    assert deepseek["error"] is None
    assert deepseek["model_ids"] == ["deepseek-v4-pro[1m]", "deepseek-v4-flash"]
    assert by_id["lan-id"]["error"] is None
    assert by_id["claude-id"]["source_type"] == "claude"
    assert by_id["claude-id"]["type"] == "anthropic"
    assert all(item["already_exists"] is False for item in source["providers"])


@pytest.mark.anyio
async def test_cc_switch_import_creates_skips_and_rejects(engine_client, monkeypatch, tmp_path):
    client, store = engine_client
    db_path = tmp_path / "cc-switch.db"
    _write_cc_switch_db(db_path, _cc_switch_providers())
    monkeypatch.setattr(
        provider_api.provider_service,
        "CC_SWITCH_DB_PATH",
        db_path,
    )
    # 已存在同名供应商，导入时应跳过
    store.save_provider({
        "id": "prov_existing",
        "name": "DeepSeek",
        "type": "deepseek",
        "base_url": "https://api.deepseek.com",
        "api_key": "old-key",
        "enabled": True,
        "verified": False,
        "created_at": "2026-01-01T00:00:00",
    })
    store.set_claude_agent_sdk_config(max_turns="77", fallback_model="fallback")

    response = await client.post(
        "/api/provider/import/cc-switch",
        json={"provider_ids": [
            "deepseek-id", "local-id", "lan-id", "claude-id", "missing-id",
        ]},
    )
    assert response.status_code == 200
    body = response.json()
    assert [item["name"] for item in body["imported"]] == [
        "本地中转", "内网中转", "Claude 中转",
    ]
    assert body["skipped"] == [
        {"id": "deepseek-id", "name": "DeepSeek", "message": "已存在同名供应商"}
    ]
    assert [item["id"] for item in body["errors"]] == ["missing-id"]

    imported_provider = next(
        item for item in store.get_providers() if item["name"] == "本地中转"
    )
    assert imported_provider["base_url"] == "http://localhost:3000/v1"
    assert imported_provider["api_key"] == "sk-local"
    assert imported_provider["type"] == "custom"
    claude_provider = next(
        item for item in store.get_providers() if item["name"] == "Claude 中转"
    )
    assert claude_provider["type"] == "anthropic"
    assert claude_provider["api_key"] == "sk-claude"
    assert store.get_provider("prov_existing") is not None
    expected_map = json.dumps({
        "sonnet": {"model": "qwen3-max", "name": "Qwen Max"},
    }, sort_keys=True, ensure_ascii=False)
    assert store.get_claude_agent_sdk_config()["model_map"] == expected_map
    sdk = store.get_claude_agent_sdk_config()
    assert sdk["model_map"] == expected_map
    assert sdk["max_turns"] == "77"
    assert sdk["fallback_model"] == "fallback"


@pytest.mark.anyio
async def test_cc_switch_import_keeps_existing_claude_model_maps(
    engine_client, monkeypatch, tmp_path
):
    client, store = engine_client
    db_path = tmp_path / "cc-switch.db"
    _write_cc_switch_db(db_path, _cc_switch_providers())
    monkeypatch.setattr(provider_api.provider_service, "CC_SWITCH_DB_PATH", db_path)
    existing = json.dumps({"opus": {"model": "my-opus"}})
    store.set_claude_code_model_map(existing)
    store.set_claude_agent_sdk_config(model_map=existing)

    response = await client.post(
        "/api/provider/import/cc-switch",
        json={"provider_ids": ["claude-id"]},
    )

    assert response.json()["errors"] == []
    assert "my-opus" in store.get_claude_agent_sdk_config()["model_map"]
    assert "my-opus" in store.get_claude_agent_sdk_config()["model_map"]


@pytest.mark.anyio
async def test_cc_switch_import_does_not_prefill_non_claude_sources(
    engine_client, monkeypatch
):
    client, store = engine_client
    candidate = {
        "id": "codex-with-map",
        "source_type": "codex",
        "name": "Codex Gateway",
        "type": "custom",
        "protocol": "openai_responses",
        "base_url": "https://gateway.example.com/v1",
        "api_key": "secret",
        "model_map": {"sonnet": {"model": "must-not-apply", "name": "x"}},
        "error": None,
    }
    monkeypatch.setattr(
        provider_api.provider_service,
        "scan_cc_switch_providers",
        lambda: [candidate],
    )

    response = await client.post(
        "/api/provider/import/cc-switch",
        json={"provider_ids": ["codex-with-map"]},
    )

    assert response.json()["errors"] == []
    assert store.get_claude_agent_sdk_config()["model_map"] == ""
    assert store.get_claude_agent_sdk_config()["model_map"] == ""


@pytest.mark.anyio
async def test_provider_delete_blocked_while_in_use(engine_client):
    client, store = engine_client
    provider = _add_provider(store)
    store.set_pydantic_ai_engine_config(provider_id=provider["id"], model="deepseek-chat")

    blocked = await client.delete(f"/api/provider/{provider['id']}")
    assert blocked.status_code == 400
    assert "引擎或助手" in blocked.json()["detail"]
    assert store.get_provider(provider["id"]) is not None

    store.set_pydantic_ai_engine_config(provider_id="", model="")
    deleted = await client.delete(f"/api/provider/{provider['id']}")
    assert deleted.json()["deleted"] is True
    assert store.get_provider(provider["id"]) is None


# --- Engine list / config contracts ---


@pytest.mark.anyio
async def test_engine_list_drops_api_engine_and_embeds_provider_select(engine_client):
    client, store = engine_client
    _add_provider(store, name="主账号")
    store.set_engine_default_model("pydantic_ai", "deepseek-chat")

    response = await client.get("/api/engine/list")
    engines = {item["id"]: item for item in response.json()["engines"]}
    assert "api" not in engines
    assert "pydantic_ai" in engines

    pydantic = engines["pydantic_ai"]
    assert pydantic["built_in"] is True
    assert pydantic["default_model"] == "deepseek-chat"
    config = pydantic["config"]
    assert config is not None
    fields = {field["key"]: field for field in config["fields"]}
    assert list(fields) == ["provider_id", "sandbox"]
    assert fields["provider_id"]["type"] == "select"
    option_values = [option["value"] for option in fields["provider_id"]["options"]]
    assert option_values == ["prov_1"]
    assert config["values"] == {
        "provider_id": "",
        "sandbox": "workspace-write",
    }
    assert config["secrets"] == {}

    assert engines["claude_agent_sdk"]["config"] is not None
    assert {field["key"] for field in engines["claude_agent_sdk"]["config"]["fields"]} == {
        "permission_mode",
        "provider_id",
        "model_map",
        "custom_settings",
        "max_turns",
        "fallback_model",
    }
    claude_fields = {field["key"]: field for field in engines["claude_agent_sdk"]["config"]["fields"]}
    assert claude_fields["model_map"]["type"] == "model_map"
    assert claude_fields["model_map"]["step_hidden"] is True
    assert claude_fields["custom_settings"]["type"] == "json"
    assert claude_fields["custom_settings"]["step_hidden"] is True
    # 结构化映射与自定义 JSON 不进阶段配置模板，避免阶段覆盖整段替换全局值。
    step_keys = {
        field["key"] for field in engines["claude_agent_sdk"]["config"]["step_fields"]
    }
    assert "model_map" not in step_keys
    assert "custom_settings" not in step_keys


@pytest.mark.anyio
async def test_pydantic_ai_engine_config_saves_provider_id(engine_client):
    client, store = engine_client
    provider = _add_provider(store, name="主账号")

    saved = await client.put(
        "/api/engine/pydantic-ai/config",
        json={"values": {"provider_id": provider["id"]}},
    )
    body = saved.json()
    assert body["saved"] is True
    assert store.pydantic_ai_config["provider_id"] == provider["id"]
    assert body["values"] == {
        "provider_id": provider["id"],
        "sandbox": "workspace-write",
    }
    assert body["secrets"] == {}
    assert body["configured"] is False  # model not set yet

    # 客户端即使提交 off 也被忽略，始终保存为 auto
    forced = await client.put(
        "/api/engine/pydantic-ai/config",
        json={
            "values": {
                "provider_id": provider["id"],
                "harness": "off",
            }
        },
    )
    assert forced.json()["saved"] is True
    assert store.pydantic_ai_config["harness"] == "auto"

    model = await client.put(
        "/api/engine/pydantic_ai/default-model",
        json={"model": "deepseek-chat"},
    )
    assert model.json()["saved"] is True
    loaded = await client.get("/api/engine/pydantic-ai/config")
    assert loaded.json()["configured"] is True

    rejected = await client.put(
        "/api/engine/pydantic-ai/config",
        json={"values": {"provider_id": "prov_missing"}},
    )
    assert rejected.json()["saved"] is False
    assert "不存在" in rejected.json()["message"]


@pytest.mark.anyio
async def test_execution_and_coordinator_defaults_are_saved_without_remote_validation(
    engine_client,
):
    client, store = engine_client
    provider = _add_provider(store, name="主账号")
    store.set_pydantic_ai_engine_config(provider_id=provider["id"], model="deepseek-chat")
    store.set_engine_verified("pydantic_ai", True)

    execution = await client.put(
        "/api/engine/execution/config",
        json={"engine": "pydantic_ai"},
    )
    coordinator = await client.put(
        "/api/engine/coordinator/config",
        json={
            "engine": "pydantic_ai",
            "model": "reasoning-model",
            "fast_model": "fast-model",
            "vision_model": "vision-model",
            "thinking_effort": "high",
        },
    )
    assert execution.json() == {
        "saved": True,
        "engine": "pydantic_ai",
        "resolved_engine": "pydantic_ai",
    }
    assert coordinator.json()["engine"] == "pydantic_ai"
    assert store.execution_default_engine == "pydantic_ai"
    assert store.coordinator_default_engine == "pydantic_ai"
    assert store.coordinator_default_thinking_effort == "high"

    loaded = await client.get("/api/engine/coordinator/config")
    assert loaded.json()["engine"] == "pydantic_ai"
    assert loaded.json()["thinking_effort"] == "high"
    assert any(
        item["id"] == "pydantic_ai"
        for item in loaded.json()["available_engines"]
    )

    cleared_execution = await client.put(
        "/api/engine/execution/config",
        json={"engine": ""},
    )
    cleared_coordinator = await client.put(
        "/api/engine/coordinator/config",
        json={
            "engine": "",
            "model": "",
            "fast_model": "",
            "vision_model": "",
            "thinking_effort": "",
        },
    )
    assert cleared_execution.json()["resolved_engine"] == "pydantic_ai"
    assert cleared_coordinator.json()["engine"] == ""


@pytest.mark.anyio
async def test_coordinator_default_rejects_model_without_engine(engine_client):
    client, _ = engine_client
    response = await client.put(
        "/api/engine/coordinator/config",
        json={"engine": "", "model": "orphan-model"},
    )
    assert response.status_code == 400


@pytest.mark.anyio
async def test_compatible_engine_config_exposes_and_saves_common_provider(engine_client):
    client, store = engine_client
    provider = _add_provider(
        store,
        name="Claude Gateway",
        type_id="anthropic",
        protocol="anthropic_messages",
    )

    loaded = (await client.get("/api/engine/claude-agent-sdk/config")).json()
    fields = {field["key"]: field for field in loaded["fields"]}
    assert fields["provider_id"]["required"] is False
    assert fields["provider_id"]["options"] == [
        {"value": provider["id"], "label": "Claude Gateway"}
    ]

    saved = await client.put(
        "/api/engine/claude-agent-sdk/config",
        json={
            "values": {
                "permission_mode": "acceptEdits",
                "provider_id": provider["id"],
            }
        },
    )
    assert saved.json()["saved"] is True
    assert saved.json()["values"]["provider_id"] == provider["id"]
    assert store.get_engine_provider("claude_agent_sdk") == provider["id"]


@pytest.mark.anyio
async def test_engine_config_save_persists_and_echoes_model_map(engine_client):
    client, store = engine_client
    payload = json.dumps({
        "sonnet": {"model": "qwen3-max", "name": ""},
        "opus": {"model": "deepseek-v4", "name": "DeepSeek V4"},
    })

    saved = await client.put(
        "/api/engine/claude-agent-sdk/config",
        json={"values": {"permission_mode": "acceptEdits", "model_map": payload}},
    )

    body = saved.json()
    assert body["saved"] is True
    assert json.loads(body["values"]["model_map"]) == {
        "opus": {"model": "deepseek-v4", "name": "DeepSeek V4"},
        "sonnet": {"model": "qwen3-max", "name": "qwen3-max"},
    }
    assert body["values"]["model_map"] == store.get_claude_agent_sdk_config()["model_map"]

    rejected = await client.put(
        "/api/engine/claude-agent-sdk/config",
        json={"values": {
            "permission_mode": "acceptEdits",
            "model_map": '{"sonnet":"bad-shape"}',
        }},
    )
    assert rejected.json()["saved"] is False
    assert "格式不正确" in rejected.json()["message"]
    assert store.get_claude_agent_sdk_config()["model_map"] == body["values"]["model_map"]


@pytest.mark.anyio
async def test_engine_config_save_persists_custom_settings_for_both_claude_engines(engine_client):
    client, store = engine_client
    custom = json.dumps({
        "env": {"ANTHROPIC_BASE_URL": "http://192.168.50.21:3000"},
        "permissions": {"ask": ["Bash(rm\\s)"]},
        "model": "sonnet",
    }, ensure_ascii=False)

    for engine_id in ("claude-agent-sdk",):
        saved = await client.put(
            f"/api/engine/{engine_id}/config",
            json={
                "values": {
                    "permission_mode": "acceptEdits",
                    "custom_settings": custom,
                }
            },
        )
        body = saved.json()
        assert body["saved"] is True, body
        assert json.loads(body["values"]["custom_settings"])["env"] == {
            "ANTHROPIC_BASE_URL": "http://192.168.50.21:3000",
        }
        # 保存不改写用户文本：空格与换行原样回显。
        assert body["values"]["custom_settings"] == custom
    assert json.loads(store.get_claude_agent_sdk_config()["custom_settings"])["model"] == "sonnet"
    assert json.loads(
        store.get_claude_agent_sdk_config()["custom_settings"]
    )["model"] == "sonnet"

    rejected = await client.put(
        "/api/engine/claude-agent-sdk/config",
        json={"values": {"permission_mode": "acceptEdits", "custom_settings": "{bad"}},
    )
    assert rejected.json()["saved"] is False
    assert "JSON" in rejected.json()["message"]


@pytest.mark.anyio
async def test_engine_config_resaves_stable_model_map_without_invalidating(engine_client):
    client, store = engine_client
    first = json.dumps({
        "sonnet": {"model": "b"},
        "opus": {"model": "a"},
    })
    await client.put(
        "/api/engine/claude-agent-sdk/config",
        json={"values": {"permission_mode": "acceptEdits", "model_map": first}},
    )
    store.set_engine_verified("claude-agent-sdk", True)
    store.set_engine_models("claude-agent-sdk", [{"id": "cached"}], "now")

    reordered = json.dumps({
        "opus": {"name": "a", "model": "a"},
        "sonnet": {"name": "b", "model": "b"},
    })
    saved = await client.put(
        "/api/engine/claude-agent-sdk/config",
        json={"values": {"permission_mode": "acceptEdits", "model_map": reordered}},
    )

    assert saved.json()["saved"] is True
    assert store.is_engine_verified("claude-agent-sdk") is True
    assert store.get_engine_models("claude-agent-sdk")["models"] == [{"id": "cached"}]


@pytest.mark.anyio
async def test_engine_config_rejects_incompatible_common_provider(engine_client):
    client, store = engine_client
    provider = _add_provider(store)

    response = await client.put(
        "/api/engine/claude-agent-sdk/config",
        json={
            "values": {
                "permission_mode": "acceptEdits",
                "provider_id": provider["id"],
            }
        },
    )

    assert response.json()["saved"] is False
    assert "协议" in response.json()["message"]

    fast_response = await client.put(
        "/api/engine/coordinator/config",
        json={"engine": "", "model": "", "fast_model": "orphan-fast-model"},
    )
    assert fast_response.status_code == 400

    vision_response = await client.put(
        "/api/engine/coordinator/config",
        json={"engine": "", "model": "", "fast_model": "", "vision_model": "orphan-vision-model"},
    )
    assert vision_response.status_code == 400


@pytest.mark.anyio
@pytest.mark.parametrize("outcome", ["success", "error"])
async def test_engine_connection_does_not_pollute_daemon_directory(
    engine_client, monkeypatch, tmp_path, outcome,
):
    from pathlib import Path

    from services.skill_center import SkillCenter

    client, store = engine_client
    daemon_dir = tmp_path / "daemon"
    daemon_dir.mkdir()
    monkeypatch.chdir(daemon_dir)
    monkeypatch.setattr(
        "services.skill_center.skill_center",
        SkillCenter(source_roots={"empty": tmp_path / "no-skills"}),
    )
    working_dirs = []

    async def spawn(self, *, cwd, **kwargs):
        root = Path(cwd)
        working_dirs.append(root)
        await asyncio.to_thread(self.project_skills, cwd)
        assert (root / ".workstep/skills/.workstep-manifest.json").is_file()
        if outcome == "error":
            raise RuntimeError("connection failed")
        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": "WORKSTEP_ENGINE_OK"}},
        )

    monkeypatch.setattr(PydanticAIEngine, "spawn", spawn)
    response = await client.post(
        "/api/engine/test",
        json={"engine_id": "pydantic_ai", "timeout_seconds": 3},
    )

    assert response.status_code == 200
    assert response.json()["success"] is (outcome == "success")
    assert store.is_engine_verified("pydantic_ai") is (outcome == "success")
    assert not (daemon_dir / ".workstep").exists()
    assert working_dirs
    assert all(not root.exists() for root in working_dirs)


@pytest.mark.anyio
async def test_engine_must_pass_connection_test_before_selection(
    engine_client,
    monkeypatch,
):
    from engines.core.base import EngineTestResult

    client, store = engine_client
    provider = _add_provider(store, name="主账号")
    store.set_pydantic_ai_engine_config(provider_id=provider["id"], model="deepseek-chat")

    rejected = await client.put(
        "/api/engine/execution/config",
        json={"engine": "pydantic_ai"},
    )
    assert rejected.status_code == 400
    assert "测试" in rejected.json()["detail"]

    async def successful_test(self, cwd, timeout_seconds=30):
        return EngineTestResult(True, "连接和对话测试通过", 12)

    monkeypatch.setattr(PydanticAIEngine, "test_connection", successful_test)
    tested = await client.post(
        "/api/engine/test",
        json={"engine_id": "pydantic_ai", "timeout_seconds": 3},
    )
    assert tested.json()["success"] is True
    assert store.is_engine_verified("pydantic_ai") is True

    accepted = await client.put(
        "/api/engine/execution/config",
        json={"engine": "pydantic_ai"},
    )
    assert accepted.status_code == 200

    await client.put(
        "/api/engine/pydantic-ai/config",
        json={"values": {"provider_id": provider["id"]}},
    )
    assert store.is_engine_verified("pydantic_ai") is True

    await client.put(
        "/api/engine/pydantic-ai/config",
        json={
            "values": {
                "provider_id": provider["id"],
                "sandbox": "read-only",
            }
        },
    )
    assert store.is_engine_verified("pydantic_ai") is True

    second_provider = _add_provider(store, name="备用账号")
    await client.put(
        "/api/engine/pydantic-ai/config",
        json={"values": {"provider_id": second_provider["id"]}},
    )
    assert store.is_engine_verified("pydantic_ai") is False


@pytest.mark.anyio
async def test_engine_default_model_save_keeps_verified(engine_client):
    client, store = engine_client
    _add_provider(store, name="主账号")
    store.set_pydantic_ai_engine_config(provider_id="prov_1", model="deepseek-chat")
    store.set_engine_verified("pydantic_ai", True)

    saved = await client.put(
        "/api/engine/pydantic_ai/default-model",
        json={"model": "deepseek-reasoner"},
    )

    assert saved.json()["saved"] is True
    assert store.get_engine_default_model("pydantic_ai") == "deepseek-reasoner"
    assert store.is_engine_verified("pydantic_ai") is True


# --- Pydantic AI engine behaviour ---


def test_pydantic_ai_builds_model_from_provider():
    from pydantic_ai.models.anthropic import AnthropicModel
    from pydantic_ai.models.openai import OpenAIChatModel

    openai_model = PydanticAIEngine.build_model(
        provider={
            "type": "deepseek",
            "base_url": "https://api.deepseek.com/v1",
            "api_key": "openai-secret",
        },
        model_name="deepseek-chat",
    )
    anthropic_model = PydanticAIEngine.build_model(
        provider={
            "type": "anthropic",
            "base_url": "https://anthropic-gateway.example.com/v1",
            "api_key": "anthropic-secret",
        },
        model_name="claude-test",
    )

    assert isinstance(openai_model, OpenAIChatModel)
    assert openai_model.model_name == "deepseek-chat"
    assert isinstance(anthropic_model, AnthropicModel)
    assert anthropic_model.model_name == "claude-test"


@pytest.mark.anyio
async def test_pydantic_ai_run_simple_does_not_print_provider_request_in_dev(
    monkeypatch,
    capsys,
):
    from pydantic_ai.messages import ModelResponse, TextPart
    from pydantic_ai.models.function import FunctionModel

    store = MemoryEngineConfigStore()
    provider = _add_provider(store, name="主账号")
    store.set_pydantic_ai_engine_config(
        provider_id=provider["id"],
        model="agent-model",
        harness="off",
    )
    monkeypatch.setattr(pydantic_ai_engine_module, "config_store", store)
    monkeypatch.setenv("WORKSTEP_ENV", "dev")

    async def respond(messages, info):
        return ModelResponse(parts=[TextPart("增强结果")])

    monkeypatch.setattr(
        PydanticAIEngine,
        "build_model",
        staticmethod(
            lambda *, provider, model_name, protocol=None: FunctionModel(function=respond)
        ),
    )

    usage_details = {}
    result = await PydanticAIEngine.run_simple(
        "单轮提示词\n第二行", usage_details=usage_details,
    )

    assert result == "增强结果"
    assert usage_details["model"] == "agent-model"
    assert usage_details["provider"]["id"] == provider["id"]
    assert "usage" in usage_details
    assert capsys.readouterr().out == ""


@pytest.mark.anyio
async def test_pydantic_ai_run_simple_does_not_print_prompt_outside_dev(
    monkeypatch,
    capsys,
):
    from pydantic_ai.messages import ModelResponse, TextPart
    from pydantic_ai.models.function import FunctionModel

    store = MemoryEngineConfigStore()
    provider = _add_provider(store, name="主账号")
    store.set_pydantic_ai_engine_config(
        provider_id=provider["id"],
        model="agent-model",
        harness="off",
    )
    monkeypatch.setattr(pydantic_ai_engine_module, "config_store", store)
    monkeypatch.setenv("WORKSTEP_ENV", "prod")

    async def respond(messages, info):
        return ModelResponse(parts=[TextPart("正常结果")])

    monkeypatch.setattr(
        PydanticAIEngine,
        "build_model",
        staticmethod(
            lambda *, provider, model_name, protocol=None: FunctionModel(function=respond)
        ),
    )

    result = await PydanticAIEngine.run_simple("不应写入日志的提示词")

    assert result == "正常结果"
    assert capsys.readouterr().out == ""


@pytest.mark.anyio
async def test_pydantic_ai_spawn_uses_provider_config(monkeypatch):
    store = MemoryEngineConfigStore()
    provider = _add_provider(store, name="主账号")
    store.set_pydantic_ai_engine_config(provider_id=provider["id"], model="agent-model")
    monkeypatch.setattr(pydantic_ai_engine_module, "config_store", store)
    loaded = {}

    def fake_build_model(*, provider, model_name, protocol=None):
        loaded["provider"] = provider
        loaded["model_name"] = model_name
        return object()

    class FakeUsage:
        input_tokens = 3
        output_tokens = 2
        total_tokens = 5
        cache_write_tokens = 4
        cache_read_tokens = 1
        requests = 1
        cost = 0.123

    class FakeResult:
        output = "agent result"
        usage = FakeUsage()

    async def fake_run_agent(
        self, *, prompt, cwd, add_dirs, model, on_event, live_message_queue=None, images=None, session_id=None, sandbox=None
    ):
        assert prompt == "do work"
        assert cwd == "/tmp/project"
        await on_event(InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": "agent "}},
        ))
        await on_event(InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": "result"}},
        ))
        return FakeResult(), FakeUsage()

    monkeypatch.setattr(PydanticAIEngine, "build_model", staticmethod(fake_build_model))
    monkeypatch.setattr(PydanticAIEngine, "_run_agent", fake_run_agent)

    events = [
        event async for event in PydanticAIEngine().spawn(
            prompt="do work",
            cwd="/tmp/project",
        )
    ]

    assert loaded["model_name"] == "agent-model"
    assert loaded["provider"]["id"] == provider["id"]
    assert loaded["provider"]["api_key"] == "secret-value"
    assert [event.type for event in events] == [
        "session_started",
        "status",
        "agent_message_chunk",
        "agent_message_chunk",
        "usage_update",
        "status",
    ]
    assert events[4].data["cost"] == {"amount": 0.123, "currency": "USD"}


@pytest.mark.anyio
async def test_pydantic_ai_spawn_does_not_print_provider_requests_in_dev(
    monkeypatch,
    tmp_path,
    capsys,
):
    from pydantic_ai.models.function import FunctionModel

    from engines.core.schema import EngineImage

    store = MemoryEngineConfigStore()
    provider = _add_provider(store, name="主账号")
    store.set_pydantic_ai_engine_config(
        provider_id=provider["id"],
        model="agent-model",
        harness="off",
    )
    monkeypatch.setattr(pydantic_ai_engine_module, "config_store", store)
    monkeypatch.setenv("WORKSTEP_ENV", "dev")

    async def respond(messages, info):
        yield "ok"

    monkeypatch.setattr(
        PydanticAIEngine,
        "build_model",
        staticmethod(
            lambda *, provider, model_name, protocol=None: FunctionModel(stream_function=respond)
        ),
    )
    queue = asyncio.Queue()
    queue.put_nowait(("message-1", "补充提示词\n第二行"))

    events = [
        event
        async for event in PydanticAIEngine().spawn(
            prompt="初始提示词\n第二行",
            cwd=str(tmp_path),
            live_message_queue=queue,
            images=[EngineImage(url="data:image/png;base64,c2VjcmV0LWltYWdl")],
        )
    ]

    assert capsys.readouterr().out == ""
    assert events[-1].data["status"] == "done"


def test_pydantic_ai_maps_text_thinking_and_tool_events():
    from pydantic_ai.messages import (
        FunctionToolCallEvent,
        FunctionToolResultEvent,
        PartDeltaEvent,
        PartStartEvent,
        TextPart,
        TextPartDelta,
        ThinkingPart,
        ThinkingPartDelta,
        ToolCallPart,
        ToolReturnPart,
    )

    source_events = [
        PartStartEvent(index=0, part=TextPart("正文")),
        PartDeltaEvent(index=0, delta=TextPartDelta("增量")),
        PartStartEvent(index=1, part=ThinkingPart("分析")),
        PartDeltaEvent(
            index=1,
            delta=ThinkingPartDelta(content_delta="过程"),
        ),
        FunctionToolCallEvent(
            ToolCallPart("read_file", {"path": "README.md"}, "tool-1")
        ),
        FunctionToolResultEvent(
            ToolReturnPart("read_file", "文件内容", "tool-1")
        ),
    ]

    mapped = [
        PydanticAIEngine._map_stream_event(event)
        for event in source_events
    ]

    assert [event.type for event in mapped if event is not None] == [
        "agent_message_chunk",
        "agent_message_chunk",
        "agent_thought_chunk",
        "agent_thought_chunk",
        "tool_call",
        "tool_call_update",
    ]
    assert mapped[4].data == {
        "tool_call_id": "tool-1",
        "title": "read_file",
        "raw_input": {"path": "README.md"},
    }
    assert mapped[5].data == {
        "tool_call_id": "tool-1",
        "status": "completed",
        "raw_output": "文件内容",
    }


@pytest.mark.anyio
async def test_pydantic_ai_run_agent_injects_queued_live_messages(monkeypatch):
    """Pydantic AI 引擎在轮次之间注入插入消息并回执 live_message delivered。"""
    from pydantic_ai.models.test import TestModel

    calls = []

    class FakeUsage:
        input_tokens = 1
        output_tokens = 1
        total_tokens = 2
        cache_write_tokens = 0
        cache_read_tokens = 0
        requests = 1
        cost = None

        def __add__(self, other):
            return self

    class FakeResult:
        def __init__(self):
            self.usage = FakeUsage()

        def all_messages(self):
            return ["history-1"]

    async def fake_stream_agent_run(self, agent, *, prompt, on_event, message_history=None, conversation_id=None):
        calls.append((prompt, message_history))
        return FakeResult()

    monkeypatch.setattr(PydanticAIEngine, "_stream_agent_run", fake_stream_agent_run)

    engine = PydanticAIEngine()
    queue = asyncio.Queue()
    queue.put_nowait(("m1", "第一条插入消息"))
    queue.put_nowait(("m2", "第二条插入消息"))
    events = []

    async def on_event(event):
        events.append(event)

    await engine._run_agent(
        prompt="初始提示",
        cwd="/tmp",
        add_dirs=None,
        model=TestModel(),
        on_event=on_event,
        live_message_queue=queue,
    )

    assert [prompt for prompt, _ in calls] == [
        "初始提示",
        "第一条插入消息\n\n第二条插入消息",
    ]
    assert calls[1][1] == ["history-1"]
    delivered = [event for event in events if event.type == "live_message"]
    assert [event.data["message_id"] for event in delivered] == ["m1", "m2"]
    assert all(event.data["status"] == "delivered" for event in delivered)


@pytest.mark.anyio
async def test_pydantic_ai_run_agent_ignores_message_after_turn(monkeypatch):
    """回合结束、插入队列为空时引擎立即收尾：随后到达的插入消息不再注入。"""
    from pydantic_ai.models.test import TestModel

    calls = []

    class FakeUsage:
        input_tokens = 1
        output_tokens = 1
        total_tokens = 2
        cache_write_tokens = 0
        cache_read_tokens = 0
        requests = 1
        cost = None

        def __add__(self, other):
            return self

    class FakeResult:
        def __init__(self):
            self.usage = FakeUsage()

        def all_messages(self):
            return ["history-1"]

    async def fake_stream_agent_run(self, agent, *, prompt, on_event, message_history=None, conversation_id=None):
        calls.append((prompt, message_history))
        return FakeResult()

    monkeypatch.setattr(PydanticAIEngine, "_stream_agent_run", fake_stream_agent_run)

    engine = PydanticAIEngine()
    queue = asyncio.Queue()
    events = []

    async def on_event(event):
        events.append(event)

    await engine._run_agent(
        prompt="初始提示",
        cwd="/tmp",
        add_dirs=None,
        model=TestModel(),
        on_event=on_event,
        live_message_queue=queue,
    )

    # 引擎已收尾：之后放入的消息不会被注入，也不会被投递。
    queue.put_nowait(("m1", "刚发出的插入消息"))
    await asyncio.sleep(0)

    assert [prompt for prompt, _ in calls] == ["初始提示"]
    assert not any(
        event.type == "live_message"
        and event.data.get("status") == "delivered"
        for event in events
    )


@pytest.mark.anyio
async def test_pydantic_ai_spawn_forwards_live_message_queue(monkeypatch):
    """spawn 把插入消息队列原样转发给 _run_agent。"""
    store = MemoryEngineConfigStore()
    provider = _add_provider(store, name="主账号")
    store.set_pydantic_ai_engine_config(provider_id=provider["id"], model="agent-model")
    monkeypatch.setattr(pydantic_ai_engine_module, "config_store", store)
    captured = {}

    class FakeResult:
        output = "agent result"
        usage = None

    async def fake_run_agent(
        self, *, prompt, cwd, add_dirs, model, on_event, live_message_queue=None, images=None, session_id=None, sandbox=None
    ):
        captured["live_message_queue"] = live_message_queue
        return FakeResult(), None

    monkeypatch.setattr(PydanticAIEngine, "_run_agent", fake_run_agent)
    monkeypatch.setattr(
        PydanticAIEngine,
        "build_model",
        staticmethod(lambda *, provider, model_name, protocol=None: object()),
    )

    engine = PydanticAIEngine()
    queue = asyncio.Queue()
    events = [
        event async for event in engine.spawn(
            prompt="hi", cwd="/tmp", live_message_queue=queue
        )
    ]

    assert captured["live_message_queue"] is queue
    assert [event.type for event in events] == [
        "session_started",
        "status",
        "agent_message_chunk",
        "status",
    ]


@pytest.mark.anyio
async def test_pydantic_ai_spawn_does_not_roundtrip_engine_state(monkeypatch, tmp_path):
    """supports_message_history=False：spawn 不回灌 message_history、不上报
    engine_state，跨轮上下文完全交给 harness StepPersistence。"""
    calls = []

    class FakeResult:
        output = "ok"
        usage = None

        def all_messages(self):
            return []

    async def fake_run_agent(
        self, *, prompt, cwd, add_dirs, model, on_event,
        live_message_queue=None, images=None, session_id=None,
        sandbox=None,
    ):
        # 无 message_history 形参：若 spawn 仍回灌外部历史，此处将抛 TypeError。
        calls.append(prompt)
        return FakeResult(), None

    monkeypatch.setattr(PydanticAIEngine, "_run_agent", fake_run_agent)
    monkeypatch.setattr(
        PydanticAIEngine,
        "build_model",
        staticmethod(lambda *, provider, model_name, protocol=None: object()),
    )

    store = MemoryEngineConfigStore()
    provider = _add_provider(store, name="主账号")
    store.set_pydantic_ai_engine_config(provider_id=provider["id"], model="agent-model")
    monkeypatch.setattr(pydantic_ai_engine_module, "config_store", store)

    assert PydanticAIEngine().supports_message_history is False
    events = [
        event async for event in PydanticAIEngine().spawn(
            prompt="hi",
            cwd=str(tmp_path),
            session_id="stable-1",
        )
    ]

    assert calls == ["hi"]
    assert [event.type for event in events] == [
        "session_started",
        "status",
        "agent_message_chunk",
        "status",
    ]
    assert "engine_state" not in [event.type for event in events]
    assert events[0].data["session_id"] == "stable-1"


# --- Config file persistence ---


def test_config_file_is_owner_only_when_provider_key_is_saved(tmp_path, monkeypatch):
    config_dir = tmp_path / ".workstep"
    config_file = config_dir / "config.json"
    monkeypatch.setattr(config_module, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(config_module, "CONFIG_FILE", config_file)
    store = ConfigStore()
    store.save_provider({
        "id": "prov_1",
        "name": "DeepSeek",
        "type": "deepseek",
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "secret-value",
        "enabled": True,
        "verified": False,
        "created_at": "2026-01-01T00:00:00",
    })
    mode = stat.S_IMODE(config_file.stat().st_mode)
    assert mode == 0o600


def test_provider_storage_and_legacy_migration(tmp_path, monkeypatch):
    config_dir = tmp_path / ".workstep"
    config_file = config_dir / "config.json"
    monkeypatch.setattr(config_module, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(config_module, "CONFIG_FILE", config_file)
    store = ConfigStore()

    store.save_provider({
        "id": "prov_1",
        "name": "DeepSeek",
        "type": "deepseek",
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "secret-value",
        "enabled": True,
        "verified": False,
        "created_at": "2026-01-01T00:00:00",
    })
    store.set_pydantic_ai_engine_config(provider_id="prov_1", model="deepseek-chat")
    store.set_execution_default_engine("pydantic_ai")

    data = config_file.read_text()
    assert '"providers"' in data
    assert '"pydantic_ai_engine"' in data
    assert "secret-value" in data
    assert store.get_provider("prov_1")["api_key"] == "secret-value"
    assert store.get_pydantic_ai_engine_config() == {
        "provider_id": "prov_1",
        "model": "deepseek-chat",
        "fast_model": "",
        "mcp_servers": [],
        "harness": "auto",
        "sandbox": "workspace-write",
    }

    # 引擎未显式配置 fast_model 时，回退 coordinator 快速模型
    store.set_coordinator_defaults(engine="task_coordinator", fast_model="coord-fast")
    assert store.get_pydantic_ai_engine_config()["fast_model"] == "coord-fast"

    # Legacy api engine values are cleaned up by migration
    legacy = {
        "api_engine": {"provider": "openai", "base_url": "https://api.openai.com/v1"},
        "execution_default_engine": "api",
        "coordinator_default_engine": "api",
        "engine_default_models": {"api": "gpt-x"},
        "verified_engines": {"api": True},
    }
    import json
    raw = json.loads(data)
    raw.update(legacy)
    config_file.write_text(json.dumps(raw, ensure_ascii=False))
    store.invalidate()
    store.migrate_legacy_config()
    providers = store.get_providers()
    migrated = json.loads(config_file.read_text())
    assert "api_engine" not in migrated
    assert migrated["execution_default_engine"] == ""
    assert migrated["coordinator_default_engine"] == ""
    assert "api" not in migrated["engine_default_models"]
    assert "api" not in migrated["verified_engines"]
    assert migrated["providers"] == providers
    assert migrated["providers"][0]["protocol"] == "openai_chat_completions"


def test_claude_agent_sdk_and_codex_configs_roundtrip(tmp_path, monkeypatch):
    config_dir = tmp_path / ".workstep"
    config_file = config_dir / "config.json"
    monkeypatch.setattr(config_module, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(config_module, "CONFIG_FILE", config_file)
    store = ConfigStore()

    custom = json.dumps({"env": {"FOO": "bar"}, "permissions": {"ask": ["Bash(rm\\s)"]}})
    store.set_claude_agent_sdk_config(
        max_turns="25",
        permission_mode="acceptEdits",
        fallback_model="claude-haiku-latest",
        custom_settings=custom,
    )
    sdk = store.get_claude_agent_sdk_config()
    assert sdk["max_turns"] == "25"
    assert sdk["fallback_model"] == "claude-haiku-latest"
    assert sdk["permission_mode"] == "acceptEdits"
    assert json.loads(sdk["custom_settings"]) == {
        "env": {"FOO": "bar"},
        "permissions": {"ask": ["Bash(rm\\s)"]},
    }

    codex_custom = "model_context_window = 128000\n# comment\nmodel_max_output_tokens = 8192\n"
    store.set_codex_config(
        sandbox_mode="danger-full-access",
        model_reasoning_effort="high",
        approval_policy="never",
        custom_config=codex_custom,
    )
    assert store.get_codex_config() == {
        "sandbox_mode": "danger-full-access",
        "model_reasoning_effort": "high",
        "approval_policy": "never",
        "custom_config": codex_custom,
    }

    store.set_codex_sdk_config(
        model_reasoning_effort="medium",
        approval_mode="deny_all",
        sandbox="read-only",
        custom_config=codex_custom,
    )
    assert store.get_codex_sdk_config() == {
        "model_reasoning_effort": "medium",
        "approval_mode": "deny_all",
        "sandbox": "read-only",
        "custom_config": codex_custom,
    }


def test_claude_custom_settings_preserves_user_whitespace(tmp_path, monkeypatch):
    """保存不应重排 JSON：用户输入的空格与换行原样保留。"""
    config_dir = tmp_path / ".workstep"
    config_file = config_dir / "config.json"
    monkeypatch.setattr(config_module, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(config_module, "CONFIG_FILE", config_file)
    store = ConfigStore()

    pretty = '{\n  "env": {\n    "FOO": "bar"\n  },\n  "model": "sonnet"\n}\n'
    store.set_claude_code_config(custom_settings=pretty)
    store.set_claude_agent_sdk_config(custom_settings=pretty)

    assert store.get_claude_agent_sdk_config()["custom_settings"] == pretty
    assert store.get_claude_agent_sdk_config()["custom_settings"] == pretty


def test_claude_agent_sdk_and_codex_configs_validate_input(tmp_path, monkeypatch):
    config_dir = tmp_path / ".workstep"
    config_file = config_dir / "config.json"
    monkeypatch.setattr(config_module, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(config_module, "CONFIG_FILE", config_file)
    store = ConfigStore()

    with pytest.raises(ValueError):
        store.set_claude_agent_sdk_config(max_turns="abc")
    with pytest.raises(ValueError):
        store.set_claude_agent_sdk_config(custom_settings="{not json")
    with pytest.raises(ValueError):
        store.set_claude_agent_sdk_config(custom_settings="[]")
    with pytest.raises(ValueError):
        store.set_claude_agent_sdk_config(custom_settings='{"env": []}')
    with pytest.raises(ValueError):
        store.set_claude_agent_sdk_config(max_turns="0")
    with pytest.raises(ValueError):
        store.set_codex_config(sandbox_mode="weird")
    with pytest.raises(ValueError):
        store.set_codex_config(custom_config="not-a-kv-line")
    with pytest.raises(ValueError):
        store.set_codex_sdk_config(custom_config="=missing-key")
    with pytest.raises(ValueError):
        store.set_codex_config(model_reasoning_effort="invalid-effort")
    with pytest.raises(ValueError):
        store.set_codex_sdk_config(approval_mode="prompt")
    with pytest.raises(ValueError):
        store.set_codex_sdk_config(sandbox="nope")

    for effort in ("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"):
        store.set_codex_config(model_reasoning_effort=effort)
        store.set_codex_sdk_config(model_reasoning_effort=effort)
        reloaded = ConfigStore()
        assert reloaded.get_codex_config()["model_reasoning_effort"] == effort
        assert reloaded.get_codex_sdk_config()["model_reasoning_effort"] == effort


# --- Engine install endpoints ---


@pytest.mark.anyio
async def test_engine_install_endpoint_runs_install(engine_client, monkeypatch):
    client, _store = engine_client

    async def fake_install(self):
        return EngineInstallResult(success=True, message="Codex SDK 安装完成")

    monkeypatch.setattr(
        "engines.codex_sdk.CodexSDKEngine.is_installed",
        staticmethod(lambda: False),
    )
    monkeypatch.setattr("engines.codex_sdk.CodexSDKEngine.install", fake_install)
    engine_registry.refresh_registry()

    resp = await client.post("/api/engine/codex_sdk/install")
    assert resp.status_code == 200
    body = resp.json()
    assert body["engine_id"] == "codex_sdk"
    assert body["success"] is True
    assert body["already_installed"] is False
    assert "安装完成" in body["message"]
    assert body["engine"] is not None


@pytest.mark.anyio
async def test_engine_install_endpoint_already_installed(engine_client):
    client, _store = engine_client

    resp = await client.post("/api/engine/pydantic_ai/install")
    assert resp.status_code == 200
    body = resp.json()
    assert body["engine_id"] == "pydantic_ai"
    assert body["success"] is True
    assert body["already_installed"] is True


@pytest.mark.anyio
async def test_engine_update_endpoint_updates_installed_sdk(engine_client, monkeypatch):
    client, store = engine_client
    called = False

    async def fake_update(self):
        nonlocal called
        called = True
        return EngineInstallResult(success=True, message="openai-codex 更新完成，请重启 daemon")

    monkeypatch.setattr(
        "engines.codex_sdk.CodexSDKEngine.is_installed",
        staticmethod(lambda: True),
    )
    monkeypatch.setattr("engines.codex_sdk.CodexSDKEngine.update", fake_update)
    engine_registry.refresh_registry()

    resp = await client.post("/api/engine/codex_sdk/update")

    assert resp.status_code == 200
    body = resp.json()
    assert called is True
    assert body["engine_id"] == "codex_sdk"
    assert body["success"] is True
    assert body["engine"]["updatable"] is True
    assert store.is_engine_verified("codex_sdk") is False


@pytest.mark.anyio
async def test_engine_update_endpoint_rejects_non_sdk_engine(engine_client):
    client, _store = engine_client

    resp = await client.post("/api/engine/pydantic_ai/update")

    assert resp.status_code == 400
    assert "不支持自动更新" in resp.json()["detail"]


@pytest.mark.anyio
async def test_engine_install_endpoint_rejects_non_installable(engine_client, monkeypatch):
    client, _store = engine_client

    monkeypatch.setattr(
        "engines.openclaw.OpenClawEngine.is_installed",
        staticmethod(lambda: False),
    )
    engine_registry.refresh_registry()

    resp = await client.post("/api/engine/openclaw/install")
    assert resp.status_code == 400


@pytest.mark.anyio
async def test_qoder_install_requires_explicit_third_party_terms_acceptance(
    engine_client, monkeypatch
):
    client, _store = engine_client
    called = False

    async def fake_install(self):
        nonlocal called
        called = True
        return EngineInstallResult(success=True, message="Qoder SDK 安装完成")

    monkeypatch.setattr(
        "engines.qoder_sdk.QoderSDKEngine.is_installed",
        staticmethod(lambda: False),
    )
    monkeypatch.setattr("engines.qoder_sdk.QoderSDKEngine.install", fake_install)
    engine_registry.refresh_registry()

    rejected = await client.post("/api/engine/qoder_sdk/install", json={})
    assert rejected.status_code == 400
    assert called is False
    assert "第三方" in rejected.json()["detail"]

    accepted = await client.post(
        "/api/engine/qoder_sdk/install",
        json={"accept_third_party_terms": True},
    )
    assert accepted.status_code == 200
    assert accepted.json()["success"] is True
    assert called is True


@pytest.mark.anyio
async def test_engine_list_exposes_qoder_third_party_terms(engine_client):
    client, _store = engine_client
    response = await client.get("/api/engine/list")
    qoder = next(item for item in response.json()["engines"] if item["id"] == "qoder_sdk")

    assert qoder["requires_third_party_terms_acceptance"] is True
    assert qoder["third_party_terms_url"] == "https://qoder.com/product-service"


@pytest.mark.anyio
async def test_pydantic_ai_inspect_capabilities(engine_client, tmp_path):
    client, store = engine_client

    claude_skill = tmp_path / ".claude" / "skills" / "code-review"
    claude_skill.mkdir(parents=True)
    (claude_skill / "SKILL.md").write_text(
        "---\nname: code-review\ndescription: 审查代码质量\n---\n# 审查规则\n",
        encoding="utf-8",
    )
    codex_skill = tmp_path / ".codex" / "skills" / "deploy"
    codex_skill.mkdir(parents=True)
    (codex_skill / "SKILL.md").write_text(
        "---\nname: deploy\ndescription: 部署到服务器\n---\n# 部署步骤\n",
        encoding="utf-8",
    )
    shared_skill = tmp_path / ".workstep" / "skills" / "shared"
    shared_skill.mkdir(parents=True)
    (shared_skill / "SKILL.md").write_text(
        "---\nname: shared\ndescription: WorkStep 共享技能\n---\n# 共享规则\n",
        encoding="utf-8",
    )
    store.set_pydantic_ai_engine_config(
        provider_id="",
        model="",
        mcp_servers=[
            {
                "name": "filesystem",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
                "env": {},
            }
        ],
    )

    response = await client.get(
        "/api/engine/pydantic_ai/inspect",
        params={"project_root": str(tmp_path)},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["engine_id"] == "pydantic_ai"
    assert body["project_root"] == str(tmp_path.resolve())
    assert {skill["name"] for skill in body["skills"]} == {"shared", "workstep-cli"}
    assert [item["name"] for item in body["input_items"]] == [
        "plan", "reasoning", "status", "shared", "workstep-cli",
    ]
    assert all("description" in skill and "source_dir" in skill for skill in body["skills"])
    assert body["mcp_servers"] == [{
        "name": "filesystem",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    }]
    assert body["mcp_supported"] is False  # fastmcp 不在测试环境依赖里
    assert body["mcp_error"]  # 缺失依赖时应给出安装提示

    # 未传项目目录时技能为空，但 MCP 配置仍返回
    without_project = await client.get("/api/engine/pydantic_ai/inspect")
    assert without_project.status_code == 200
    assert without_project.json()["project_root"] is None
    assert without_project.json()["skills"] == []
    assert len(without_project.json()["mcp_servers"]) == 1

    # 未知引擎 -> 404
    missing = await client.get("/api/engine/not-a-real-engine/inspect")
    assert missing.status_code == 404


def test_engine_list_step_fields_exclude_sensitive():
    """step_fields 剔除 sensitive 与 password 类型字段。"""
    from engines.core.registry import get_available_engines

    engines = get_available_engines()
    qoder = next((e for e in engines if e["id"] == "qoder_sdk"), None)
    assert qoder is not None
    config = qoder["config"]
    assert config is not None
    step_fields = config["step_fields"]
    keys = {f["key"] for f in step_fields}
    assert "personal_access_token" not in keys
    for field in step_fields:
        assert field["type"] != "password"
        assert field["sensitive"] is not True


@pytest.mark.anyio
async def test_provider_delete_blocked_by_project_reference(engine_client, monkeypatch):
    """删除被项目流程/任务引用的供应商时返回 400 并列出位置。"""
    client, store = engine_client
    provider = _add_provider(store)

    class FakeProjectManager:
        def provider_references(self, provider_id):
            assert provider_id == provider["id"]
            return [
                {"project_name": "sass", "location": "步骤「需求」执行配置"},
                {"project_name": "sass", "location": "步骤「UI 设计」执行配置"},
            ]

    monkeypatch.setattr(provider_api, "project_manager", FakeProjectManager())
    blocked = await client.delete(f"/api/provider/{provider['id']}")
    assert blocked.status_code == 400
    detail = blocked.json()["detail"]
    assert "2 处流程或任务引用" in detail
    assert "sass：步骤「需求」执行配置" in detail
    assert store.get_provider(provider["id"]) is not None


@pytest.mark.anyio
async def test_provider_delete_allowed_without_references(engine_client, monkeypatch):
    """无任何引用时供应商可正常删除。"""
    client, store = engine_client
    provider = _add_provider(store)

    class FakeProjectManager:
        def provider_references(self, provider_id):
            return []

    monkeypatch.setattr(provider_api, "project_manager", FakeProjectManager())
    deleted = await client.delete(f"/api/provider/{provider['id']}")
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True}
    assert store.get_provider(provider["id"]) is None
