"""Contracts for the built-in API / BYOK engine configuration."""

import stat

import httpx
import pytest
from httpx import ASGITransport, AsyncClient

import api.engine as engine_api
import engines.api as api_engine_module
import engines.pydantic_ai as pydantic_ai_engine_module
import engines.registry as engine_registry
import main
import services.config as config_module
from services.config import ConfigStore
from engines.api import APIEngine
from engines.pydantic_ai import PydanticAIEngine
from engines.base import EngineModel
from engines.events import InternalEvent


class MemoryEngineConfigStore:
    def __init__(self):
        self.api_config = {
            "provider": "openai",
            "base_url": "https://api.openai.com/v1",
            "api_key": "",
            "model": "",
        }
        self.default_models = {}
        self.pydantic_ai_config = {
            "provider": "openai",
            "base_url": "https://api.openai.com/v1",
            "api_key": "",
            "model": "",
        }
        self.execution_default_engine = ""
        self.coordinator_default_engine = ""
        self.coordinator_default_model = ""
        self.coordinator_default_fast_model = ""
        self.verified_engines = set()

    def get_api_engine_config(self):
        return dict(self.api_config)

    def set_api_engine_config(self, *, provider, base_url, api_key, model):
        self.api_config = {
            "provider": provider,
            "base_url": base_url,
            "api_key": self.api_config["api_key"] if api_key is None else api_key,
            "model": model,
        }
        self.default_models["api"] = model

    def get_pydantic_ai_engine_config(self):
        return dict(self.pydantic_ai_config)

    def set_pydantic_ai_engine_config(
        self, *, provider, base_url, api_key, model
    ):
        self.pydantic_ai_config = {
            "provider": provider,
            "base_url": base_url,
            "api_key": (
                self.pydantic_ai_config["api_key"]
                if api_key is None
                else api_key
            ),
            "model": model,
        }
        self.default_models["pydantic_ai"] = model

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

    def set_coordinator_defaults(self, engine, model="", fast_model=""):
        self.coordinator_default_engine = engine
        self.coordinator_default_model = model
        self.coordinator_default_fast_model = fast_model

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
    monkeypatch.setattr(api_engine_module, "config_store", store)
    monkeypatch.setattr(pydantic_ai_engine_module, "config_store", store)
    monkeypatch.setattr(engine_registry, "config_store", store)
    engine_registry.refresh_registry()
    transport = ASGITransport(app=main.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, store
    engine_registry.refresh_registry()


@pytest.mark.anyio
async def test_api_engine_configuration_and_key_are_preserved(engine_client):
    client, store = engine_client

    initial = await client.get("/api/engine/list")
    api_engine = next(item for item in initial.json()["engines"] if item["id"] == "api")
    assert api_engine["installed"] is True
    assert api_engine["built_in"] is False
    assert api_engine["configured"] is False

    saved = await client.put(
        "/api/engine/api/config",
        json={
            "provider": "openai",
            "base_url": "https://gateway.example.com/v1",
            "api_key": "secret-value",
            "model": "custom-model",
        },
    )
    assert saved.status_code == 200
    body = saved.json()
    assert body["saved"] is True
    assert body["config"]["has_api_key"] is True
    assert body["config"]["configured"] is True
    assert "api_key" not in body["config"]
    assert "secret-value" not in saved.text
    assert store.api_config["api_key"] == "secret-value"

    revealed = await client.post("/api/engine/api/key")
    assert revealed.json() == {"api_key": "secret-value"}
    assert revealed.headers["cache-control"] == "no-store"

    loaded = await client.get("/api/engine/api/config")
    assert loaded.json() == {
        "provider": "openai",
        "base_url": "https://gateway.example.com/v1",
        "model": "custom-model",
        "has_api_key": True,
        "configured": True,
    }


@pytest.mark.anyio
async def test_pydantic_ai_has_separate_provider_configuration(engine_client):
    client, store = engine_client
    initial_api_config = dict(store.api_config)

    initial = await client.get("/api/engine/list")
    engine = next(
        item for item in initial.json()["engines"]
        if item["id"] == "pydantic_ai"
    )
    assert engine["built_in"] is True

    saved = await client.put(
        "/api/engine/pydantic-ai/config",
        json={
            "provider": "anthropic",
            "base_url": "https://anthropic-gateway.example.com/v1",
            "api_key": "pydantic-secret",
            "model": "claude-custom",
        },
    )
    body = saved.json()
    assert body["saved"] is True
    assert body["engine"]["id"] == "pydantic_ai"
    assert body["engine"]["built_in"] is True
    assert store.pydantic_ai_config["api_key"] == "pydantic-secret"
    assert store.api_config == initial_api_config
    assert "pydantic-secret" not in saved.text

    revealed = await client.post("/api/engine/pydantic-ai/key")
    assert revealed.json() == {"api_key": "pydantic-secret"}
    assert revealed.headers["cache-control"] == "no-store"

    loaded = await client.get("/api/engine/pydantic-ai/config")
    assert loaded.json() == {
        "provider": "anthropic",
        "base_url": "https://anthropic-gateway.example.com/v1",
        "model": "claude-custom",
        "has_api_key": True,
        "configured": True,
    }


@pytest.mark.anyio
async def test_execution_and_coordinator_defaults_are_saved_without_remote_validation(
    engine_client,
    monkeypatch,
):
    client, store = engine_client
    configured = await client.put(
        "/api/engine/api/config",
        json={
            "provider": "openai",
            "base_url": "https://gateway.example.com/v1",
            "model": "configured-model",
        },
    )
    assert configured.json()["saved"] is True
    store.set_engine_verified("api", True)

    async def fail_if_called(*args, **kwargs):
        raise AssertionError("remote validation must not run while saving defaults")

    monkeypatch.setattr(APIEngine, "list_models", fail_if_called)
    monkeypatch.setattr(APIEngine, "test_connection", fail_if_called)

    execution = await client.put(
        "/api/engine/execution/config",
        json={"engine": "api"},
    )
    coordinator = await client.put(
        "/api/engine/coordinator/config",
        json={
            "engine": "api",
            "model": "reasoning-model",
            "fast_model": "fast-model",
        },
    )

    assert execution.json() == {
        "saved": True,
        "engine": "api",
        "resolved_engine": "api",
    }
    assert coordinator.json() == {
        "saved": True,
        "engine": "api",
        "model": "reasoning-model",
        "fast_model": "fast-model",
    }
    assert store.execution_default_engine == "api"
    assert store.coordinator_default_engine == "api"
    assert store.coordinator_default_model == "reasoning-model"
    assert store.coordinator_default_fast_model == "fast-model"

    loaded = await client.get("/api/engine/coordinator/config")
    assert loaded.json()["engine"] == "api"
    assert loaded.json()["model"] == "reasoning-model"
    assert loaded.json()["fast_model"] == "fast-model"
    assert any(
        item["id"] == "api"
        for item in loaded.json()["available_engines"]
    )

    cleared_execution = await client.put(
        "/api/engine/execution/config",
        json={"engine": ""},
    )
    cleared_coordinator = await client.put(
        "/api/engine/coordinator/config",
        json={"engine": "", "model": "", "fast_model": ""},
    )
    assert cleared_execution.json()["resolved_engine"] == "claude"
    assert cleared_coordinator.json()["engine"] == ""
    assert store.execution_default_engine == ""
    assert store.coordinator_default_engine == ""


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


@pytest.mark.anyio
async def test_engine_must_pass_connection_test_before_selection(
    engine_client,
    monkeypatch,
):
    from engines.base import EngineTestResult

    client, store = engine_client
    await client.put(
        "/api/engine/api/config",
        json={
            "provider": "openai",
            "base_url": "https://gateway.example.com/v1",
            "model": "configured-model",
        },
    )

    rejected = await client.put(
        "/api/engine/execution/config",
        json={"engine": "api"},
    )
    assert rejected.status_code == 400
    assert "测试" in rejected.json()["detail"]

    async def successful_test(*args, **kwargs):
        return EngineTestResult(True, "连接和对话测试通过", 12)

    monkeypatch.setattr(APIEngine, "test_connection", successful_test)
    tested = await client.post(
        "/api/engine/test",
        json={"engine_id": "api", "timeout_seconds": 3},
    )
    assert tested.json()["success"] is True
    assert tested.json()["engine"]["verified"] is True
    assert store.is_engine_verified("api") is True

    accepted = await client.put(
        "/api/engine/execution/config",
        json={"engine": "api"},
    )
    assert accepted.status_code == 200

    await client.put(
        "/api/engine/api/config",
        json={
            "provider": "openai",
            "base_url": "https://gateway.example.com/v1",
            "model": "changed-model",
        },
    )
    assert store.is_engine_verified("api") is False


@pytest.mark.anyio
async def test_api_engine_rejects_remote_plain_http(engine_client):
    client, _ = engine_client
    response = await client.put(
        "/api/engine/api/config",
        json={
            "provider": "openai",
            "base_url": "http://192.168.1.20:11434/v1",
            "model": "local-model",
        },
    )
    assert response.json()["saved"] is False
    assert "HTTPS" in response.json()["message"]


@pytest.mark.anyio
async def test_api_engine_reads_models_from_configured_endpoint():
    async def handler(request):
        assert request.url.path == "/v1/models"
        assert request.headers["authorization"] == "Bearer secret-value"
        return httpx.Response(200, json={
            "data": [
                {"id": "model-b", "owned_by": "vendor"},
                {"id": "model-a", "name": "Model A"},
            ]
        })

    engine = APIEngine(transport=httpx.MockTransport(handler))
    models = await engine.list_models_for_config(
        provider="openai",
        base_url="https://gateway.example.com/v1",
        api_key="secret-value",
    )

    assert models == [
        EngineModel(id="model-a", label="Model A", description=None),
        EngineModel(id="model-b", label="model-b", description="vendor"),
    ]


@pytest.mark.anyio
async def test_api_model_discovery_uses_unsaved_form_values(
    engine_client,
    monkeypatch,
):
    client, _ = engine_client

    async def fake_list_models(self, *, provider, base_url, api_key):
        assert provider == "anthropic"
        assert base_url == "https://gateway.example.com/v1"
        assert api_key == "draft-key"
        return [EngineModel(id="claude-test", label="Claude Test")]

    monkeypatch.setattr(APIEngine, "list_models_for_config", fake_list_models)
    response = await client.post(
        "/api/engine/api/models",
        json={
            "provider": "anthropic",
            "base_url": "https://gateway.example.com/v1",
            "api_key": "draft-key",
        },
    )

    assert response.json() == {
        "models": [
            {"id": "claude-test", "label": "Claude Test", "description": None}
        ],
        "error": None,
    }


def test_pydantic_ai_builds_the_configured_provider():
    from pydantic_ai.models.anthropic import AnthropicModel
    from pydantic_ai.models.openai import OpenAIChatModel

    openai_model = PydanticAIEngine.build_model(
        provider="openai",
        base_url="https://openai-gateway.example.com/v1",
        api_key="openai-secret",
        model_name="openai-model",
    )
    anthropic_model = PydanticAIEngine.build_model(
        provider="anthropic",
        base_url="https://anthropic-gateway.example.com/v1",
        api_key="anthropic-secret",
        model_name="anthropic-model",
    )

    assert isinstance(openai_model, OpenAIChatModel)
    assert openai_model.model_name == "openai-model"
    assert isinstance(anthropic_model, AnthropicModel)
    assert anthropic_model.model_name == "anthropic-model"


@pytest.mark.anyio
async def test_pydantic_ai_spawn_uses_its_own_config(monkeypatch):
    store = MemoryEngineConfigStore()
    store.set_pydantic_ai_engine_config(
        provider="openai",
        base_url="https://agent-gateway.example.com/v1",
        api_key="agent-secret",
        model="agent-model",
    )
    monkeypatch.setattr(pydantic_ai_engine_module, "config_store", store)
    loaded = {}

    def fake_build_model(**config):
        loaded.update(config)
        return object()

    class FakeUsage:
        input_tokens = 3
        output_tokens = 2
        total_tokens = 5
        cache_write_tokens = 4
        cache_read_tokens = 1
        requests = 1

    class FakeResult:
        output = "agent result"
        usage = FakeUsage()

    async def fake_run_agent(self, *, prompt, cwd, add_dirs, model, on_event):
        assert prompt == "do work"
        assert cwd == "/tmp/project"
        assert add_dirs is None
        await on_event(InternalEvent(type="text_delta", data={"delta": "agent "}))
        await on_event(InternalEvent(type="text_delta", data={"delta": "result"}))
        return FakeResult()

    monkeypatch.setattr(
        PydanticAIEngine,
        "build_model",
        staticmethod(fake_build_model),
    )
    monkeypatch.setattr(PydanticAIEngine, "_run_agent", fake_run_agent)

    events = [
        event async for event in PydanticAIEngine().spawn(
            prompt="do work",
            cwd="/tmp/project",
        )
    ]

    assert loaded == {
        "provider": "openai",
        "base_url": "https://agent-gateway.example.com/v1",
        "api_key": "agent-secret",
        "model_name": "agent-model",
    }
    assert [event.type for event in events] == [
        "status",
        "text_delta",
        "text_delta",
        "usage",
        "status",
    ]
    assert [events[1].data["delta"], events[2].data["delta"]] == [
        "agent ",
        "result",
    ]
    assert events[3].data == {
        "input_tokens": 3,
        "output_tokens": 2,
        "cache_creation_input_tokens": 4,
        "cache_read_input_tokens": 1,
        "total_tokens": 5,
        "requests": 1,
    }


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
        "text_delta",
        "text_delta",
        "thinking_delta",
        "thinking_delta",
        "tool_use",
        "tool_result",
    ]
    assert mapped[4].data == {
        "id": "tool-1",
        "name": "read_file",
        "input": {"path": "README.md"},
    }
    assert mapped[5].data == {
        "tool_use_id": "tool-1",
        "content": "文件内容",
        "is_error": False,
    }


def test_config_file_is_owner_only_when_api_key_is_saved(tmp_path, monkeypatch):
    config_dir = tmp_path / ".workstep"
    config_file = config_dir / "config.json"
    monkeypatch.setattr(config_module, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(config_module, "CONFIG_FILE", config_file)
    store = ConfigStore()

    store.set_api_engine_config(
        provider="openai",
        base_url="https://gateway.example.com/v1",
        api_key="secret-value",
        model="custom-model",
    )

    assert stat.S_IMODE(config_file.stat().st_mode) == 0o600
    assert "secret-value" in config_file.read_text()


def test_pydantic_ai_config_uses_a_separate_storage_key(tmp_path, monkeypatch):
    config_dir = tmp_path / ".workstep"
    config_file = config_dir / "config.json"
    monkeypatch.setattr(config_module, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(config_module, "CONFIG_FILE", config_file)
    store = ConfigStore()
    store.set_api_engine_config(
        provider="openai",
        base_url="https://api-gateway.example.com/v1",
        api_key="api-secret",
        model="api-model",
    )

    store.set_pydantic_ai_engine_config(
        provider="anthropic",
        base_url="https://agent-gateway.example.com/v1",
        api_key="agent-secret",
        model="agent-model",
    )

    data = config_file.read_text()
    assert '"api_engine"' in data
    assert '"pydantic_ai_engine"' in data
    assert "api-secret" in data
    assert "agent-secret" in data
    assert store.get_api_engine_config()["model"] == "api-model"
    assert store.get_pydantic_ai_engine_config()["model"] == "agent-model"
