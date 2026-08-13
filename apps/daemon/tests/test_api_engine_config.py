"""Contracts for engine configuration and provider (供应商) settings."""

import asyncio
import json
import sqlite3
import stat

import pytest
from httpx import ASGITransport, AsyncClient

import api.engine as engine_api
import api.provider as provider_api
import engines.pydantic_ai.engine as pydantic_ai_engine_module
import engines.core.registry as engine_registry
import main
import services.config as config_module
from services.config import ConfigStore
from engines.pydantic_ai import PydanticAIEngine
from engines.core.base import EngineModel, EngineInstallResult, EngineTestResult
from engines.core.events import InternalEvent


class MemoryEngineConfigStore:
    """In-memory stand-in for ConfigStore covering engine + provider config."""

    def __init__(self):
        self.providers: list[dict] = []
        self.pydantic_ai_config = {"provider_id": "", "model": "", "mcp_servers": []}
        self.default_models = {}
        self.execution_default_engine = ""
        self.coordinator_default_engine = ""
        self.coordinator_default_model = ""
        self.coordinator_default_fast_model = ""
        self.coordinator_default_vision_model = ""
        self.coordinator_default_thinking_effort = ""
        self.verified_engines = set()

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

    def is_provider_in_use(self, provider_id):
        return (
            bool(self.pydantic_ai_config.get("provider_id"))
            and self.pydantic_ai_config["provider_id"] == provider_id
        )

    # --- Pydantic AI engine ---

    def get_pydantic_ai_engine_config(self):
        config = dict(self.pydantic_ai_config)
        if not config.get("model"):
            config["model"] = self.get_engine_default_model("pydantic_ai") or ""
        return config

    def set_pydantic_ai_engine_config(self, *, provider_id, model, mcp_servers=None):
        self.pydantic_ai_config = {
            "provider_id": provider_id,
            "model": model,
            "mcp_servers": list(mcp_servers or []),
        }
        self.default_models["pydantic_ai"] = model

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
    monkeypatch.setattr(engine_api, "config_store", store)
    monkeypatch.setattr(provider_api, "config_store", store)
    monkeypatch.setattr(pydantic_ai_engine_module, "config_store", store)
    monkeypatch.setattr(engine_registry, "config_store", store)
    engine_registry.refresh_registry()
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, store
    engine_registry.refresh_registry()


def _add_provider(store, name="DeepSeek 主账号", type_id="deepseek"):
    provider = {
        "id": f"prov_{len(store.get_providers()) + 1}",
        "name": name,
        "type": type_id,
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "secret-value",
        "enabled": True,
        "verified": False,
        "created_at": "2026-01-01T00:00:00",
    }
    store.save_provider(provider)
    return provider


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


@pytest.mark.anyio
async def test_provider_test_and_models(engine_client, monkeypatch):
    client, store = engine_client
    provider = _add_provider(store)

    async def fake_test(provider, timeout_seconds=30, transport=None):
        return EngineTestResult(success=True, message="连接成功，读取到 2 个模型", duration_ms=12)

    async def fake_models(provider, transport=None):
        return [EngineModel(id="deepseek-chat", label="DeepSeek Chat")]

    monkeypatch.setattr(provider_api.provider_service, "test_connection", fake_test)
    monkeypatch.setattr(provider_api.provider_service, "fetch_models", fake_models)

    tested = await client.post(f"/api/provider/{provider['id']}/test", json={"timeout_seconds": 3})
    assert tested.json()["success"] is True
    assert store.get_provider(provider["id"])["verified"] is True

    models = await client.get(f"/api/provider/{provider['id']}/models")
    assert models.json()["models"] == [
        {"id": "deepseek-chat", "label": "DeepSeek Chat", "description": None}
    ]
    assert models.json()["error"] is None


@pytest.mark.anyio
async def test_provider_models_error_is_surfaced(engine_client, monkeypatch):
    client, store = engine_client
    provider = _add_provider(store)

    async def boom(provider, transport=None):
        raise RuntimeError("401 Unauthorized")

    monkeypatch.setattr(provider_api.provider_service, "fetch_models", boom)
    models = await client.get(f"/api/provider/{provider['id']}/models")
    assert models.json()["models"] == []
    assert "401" in models.json()["error"]


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

    async def fake_models(provider, transport=None):
        called["provider"] = dict(provider)
        return [EngineModel(id="deepseek-chat", label="DeepSeek Chat")]

    monkeypatch.setattr(
        pydantic_ai_engine_module.provider_service,
        "fetch_models",
        fake_models,
    )
    response = await client.get("/api/engine/pydantic_ai/models")
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


@pytest.mark.anyio
async def test_provider_delete_blocked_while_in_use(engine_client):
    client, store = engine_client
    provider = _add_provider(store)
    store.set_pydantic_ai_engine_config(provider_id=provider["id"], model="deepseek-chat")

    blocked = await client.delete(f"/api/provider/{provider['id']}")
    assert blocked.status_code == 400
    assert "Pydantic AI" in blocked.json()["detail"]
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
    config = pydantic["config"]
    assert config is not None
    fields = {field["key"]: field for field in config["fields"]}
    assert list(fields) == ["provider_id", "mcp_servers"]
    assert fields["provider_id"]["type"] == "select"
    option_values = [option["value"] for option in fields["provider_id"]["options"]]
    assert option_values == ["prov_1"]
    assert config["values"] == {"provider_id": "", "mcp_servers": ""}
    assert config["secrets"] == {}

    assert engines["claude"]["config"] is not None
    assert {field["key"] for field in engines["claude"]["config"]["fields"]} == {
        "permission_mode"
    }


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
    assert body["values"] == {"provider_id": provider["id"], "mcp_servers": ""}
    assert body["secrets"] == {}
    assert body["configured"] is False  # model not set yet

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
    assert store.is_engine_verified("pydantic_ai") is False


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
async def test_pydantic_ai_spawn_uses_provider_config(monkeypatch):
    store = MemoryEngineConfigStore()
    provider = _add_provider(store, name="主账号")
    store.set_pydantic_ai_engine_config(provider_id=provider["id"], model="agent-model")
    monkeypatch.setattr(pydantic_ai_engine_module, "config_store", store)
    loaded = {}

    def fake_build_model(*, provider, model_name):
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
        self, *, prompt, cwd, add_dirs, model, on_event, live_message_queue=None, images=None
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

    async def fake_stream_agent_run(self, agent, *, prompt, on_event, message_history=None):
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

    async def fake_stream_agent_run(self, agent, *, prompt, on_event, message_history=None):
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
        self, *, prompt, cwd, add_dirs, model, on_event, live_message_queue=None, images=None
    ):
        captured["live_message_queue"] = live_message_queue
        return FakeResult(), None

    monkeypatch.setattr(PydanticAIEngine, "_run_agent", fake_run_agent)
    monkeypatch.setattr(
        PydanticAIEngine,
        "build_model",
        staticmethod(lambda *, provider, model_name: object()),
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
async def test_pydantic_ai_spawn_seeds_history_and_reports_engine_state(monkeypatch):
    """spawn 用序列化历史恢复上下文，并在结束后上报 engine_state。"""
    from pydantic_ai.messages import (
        ModelMessagesTypeAdapter,
        ModelRequest,
        ModelResponse,
        TextPart,
        UserPromptPart,
    )

    store = MemoryEngineConfigStore()
    provider = _add_provider(store, name="主账号")
    store.set_pydantic_ai_engine_config(provider_id=provider["id"], model="agent-model")
    monkeypatch.setattr(pydantic_ai_engine_module, "config_store", store)
    captured = {}

    class FakeResult:
        output = "ok"
        usage = None

        def all_messages(self):
            return [
                ModelRequest(parts=[UserPromptPart(content="前一问")]),
                ModelResponse(parts=[TextPart(content="前答")]),
            ]

    async def fake_run_agent(
        self, *, prompt, cwd, add_dirs, model, on_event,
        live_message_queue=None, images=None, message_history=None,
    ):
        captured["message_history"] = message_history
        return FakeResult(), None

    monkeypatch.setattr(PydanticAIEngine, "_run_agent", fake_run_agent)
    monkeypatch.setattr(
        PydanticAIEngine,
        "build_model",
        staticmethod(lambda *, provider, model_name: object()),
    )

    prior_state = ModelMessagesTypeAdapter.dump_python(
        [ModelRequest(parts=[UserPromptPart(content="前一问")])],
        mode="json",
    )
    events = [
        event async for event in PydanticAIEngine().spawn(
            prompt="hi",
            cwd="/tmp",
            session_id="stable-1",
            message_history=prior_state,
            report_engine_state=True,
        )
    ]

    assert captured["message_history"] is not None
    assert captured["message_history"][0].parts[0].content == "前一问"
    assert [event.type for event in events] == [
        "session_started",
        "status",
        "agent_message_chunk",
        "engine_state",
        "status",
    ]
    assert events[0].data["session_id"] == "stable-1"
    assert events[3].data["state"][0]["parts"][0]["content"] == "前一问"


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
        "mcp_servers": [],
    }

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
    migrated = json.loads(config_file.read_text())
    assert "api_engine" not in migrated
    assert migrated["execution_default_engine"] == ""
    assert migrated["coordinator_default_engine"] == ""
    assert "api" not in migrated["engine_default_models"]
    assert "api" not in migrated["verified_engines"]
    assert migrated["providers"] == store.get_providers()


def test_claude_agent_sdk_and_codex_configs_roundtrip(tmp_path, monkeypatch):
    config_dir = tmp_path / ".workstep"
    config_file = config_dir / "config.json"
    monkeypatch.setattr(config_module, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(config_module, "CONFIG_FILE", config_file)
    store = ConfigStore()

    store.set_claude_agent_sdk_config(
        max_turns="25",
        permission_mode="acceptEdits",
        fallback_model="claude-haiku-latest",
    )
    sdk = store.get_claude_agent_sdk_config()
    assert sdk["max_turns"] == "25"
    assert sdk["fallback_model"] == "claude-haiku-latest"
    assert sdk["permission_mode"] == "acceptEdits"

    store.set_codex_config(
        sandbox_mode="danger-full-access",
        model_reasoning_effort="high",
        approval_policy="never",
    )
    assert store.get_codex_config() == {
        "sandbox_mode": "danger-full-access",
        "model_reasoning_effort": "high",
        "approval_policy": "never",
    }

    store.set_codex_sdk_config(
        model_reasoning_effort="medium",
        approval_mode="deny_all",
        sandbox="read-only",
    )
    assert store.get_codex_sdk_config() == {
        "model_reasoning_effort": "medium",
        "approval_mode": "deny_all",
        "sandbox": "read-only",
    }


def test_claude_agent_sdk_and_codex_configs_validate_input(tmp_path, monkeypatch):
    config_dir = tmp_path / ".workstep"
    config_file = config_dir / "config.json"
    monkeypatch.setattr(config_module, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(config_module, "CONFIG_FILE", config_file)
    store = ConfigStore()

    with pytest.raises(ValueError):
        store.set_claude_agent_sdk_config(max_turns="abc")
    with pytest.raises(ValueError):
        store.set_claude_agent_sdk_config(max_turns="0")
    with pytest.raises(ValueError):
        store.set_codex_config(sandbox_mode="weird")
    with pytest.raises(ValueError):
        store.set_codex_config(model_reasoning_effort="ultra")
    with pytest.raises(ValueError):
        store.set_codex_sdk_config(approval_mode="prompt")
    with pytest.raises(ValueError):
        store.set_codex_sdk_config(sandbox="nope")


# --- Engine install endpoints ---


@pytest.mark.anyio
async def test_engine_install_endpoint_runs_install(engine_client, monkeypatch):
    client, _store = engine_client

    async def fake_install(self):
        return EngineInstallResult(success=True, message="Codex CLI 安装完成")

    monkeypatch.setattr(
        "engines.codex.CodexEngine.is_installed",
        staticmethod(lambda: False),
    )
    monkeypatch.setattr("engines.codex.CodexEngine.install", fake_install)
    engine_registry.refresh_registry()

    resp = await client.post("/api/engine/codex/install")
    assert resp.status_code == 200
    body = resp.json()
    assert body["engine_id"] == "codex"
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
    assert {skill["name"] for skill in body["skills"]} == {"code-review", "deploy"}
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


def test_engine_list_stage_fields_exclude_sensitive():
    """stage_fields 剔除 sensitive 与 password 类型字段。"""
    from engines.core.registry import get_available_engines

    engines = get_available_engines()
    qoder = next((e for e in engines if e["id"] == "qoder_sdk"), None)
    assert qoder is not None
    config = qoder["config"]
    assert config is not None
    stage_fields = config["stage_fields"]
    keys = {f["key"] for f in stage_fields}
    assert "personal_access_token" not in keys
    for field in stage_fields:
        assert field["type"] != "password"
        assert field["sensitive"] is not True
