"""Assistant registry settings API and per-assistant default config tests."""

import pytest
from httpx import ASGITransport, AsyncClient

import api.assistant as assistant_api
import main
import services.config as config_module
from services.config import ConfigStore


def _config_store(tmp_path, monkeypatch) -> ConfigStore:
    monkeypatch.setattr(config_module, "CONFIG_FILE", tmp_path / "config.json")
    return ConfigStore()


def test_assistant_defaults_fallback_and_overlay(tmp_path, monkeypatch):
    store = _config_store(tmp_path, monkeypatch)
    store.set_execution_default_engine("codex_sdk")
    store.set_coordinator_defaults("claude", "m1", "m2", "m3", "medium")
    defaults = store.get_assistant_defaults("task_create")
    assert defaults == {
        "engine": "codex_sdk",
        "model": "",
        "fast_model": "",
        "vision_model": "",
        "thinking_effort": "",
        "provider_id": "",
    }
    store.set_assistant_defaults("task_create", engine="codex", model="gm")
    defaults = store.get_assistant_defaults("task_create")
    assert defaults["engine"] == "codex"
    assert defaults["model"] == "gm"
    # 未覆盖的字段继续跟随全局执行引擎自己的默认配置。
    assert defaults["fast_model"] == ""
    store.set_assistant_defaults("task_create", model="")
    assert store.get_assistant_defaults("task_create")["model"] == ""
    # 协调 Agent 走旧键，保证既有配置与每任务协调配置兼容
    store.set_assistant_defaults("task_coordinator", engine="hermes")
    assert store.get_coordinator_default_engine() == "hermes"
    assert store.get_assistant_defaults("task_coordinator")["engine"] == "hermes"


def test_all_unconfigured_assistants_follow_execution_default(tmp_path, monkeypatch):
    store = _config_store(tmp_path, monkeypatch)
    store.set_execution_default_engine("codex_sdk")

    for name in ("task_coordinator", "task_create", "workflow_gen", "chat_session", "channel_chat"):
        assert store.get_assistant_defaults(name)["engine"] == "codex_sdk"


def test_assistant_configured_values_keep_unset_fields_empty(tmp_path, monkeypatch):
    store = _config_store(tmp_path, monkeypatch)
    store.set_coordinator_defaults("claude", "m1", "m2", "m3", "medium")

    configured = store.get_assistant_config("task_create")
    assert configured == {
        "engine": "",
        "model": "",
        "fast_model": "",
        "vision_model": "",
        "thinking_effort": "",
        "provider_id": "",
    }

    store.set_assistant_defaults("task_create", engine="codex", thinking_effort="high")
    configured = store.get_assistant_config("task_create")
    assert configured["engine"] == "codex"
    assert configured["thinking_effort"] == "high"
    assert configured["model"] == ""

    store.set_assistant_defaults("task_create", engine="codex", thinking_effort="")
    configured = store.get_assistant_config("task_create")
    assert configured["thinking_effort"] == ""
    # 跟随默认时不继承任务协调助手的独立思考强度。
    assert store.get_assistant_defaults("task_create")["thinking_effort"] == ""


@pytest.fixture
async def assistant_client(tmp_path, monkeypatch):
    # 其余助手在模块 __init__ 里注册；ASGITransport 不跑 lifespan，
    # 这里手动实例化以填充 assistant_registry。
    from agent_assistants.chat_session import ChatSessionModule
    from agent_assistants.channel_chat import ChannelChatModule
    from agent_assistants.coordinator import CoordinatorModule
    from agent_assistants.task_draft import TaskDraftModule
    from agent_assistants.workflow_gen import WorkflowGenModule
    from services.project import ProjectManager
    from streaming.bus import EventBus

    bus = EventBus()
    manager = ProjectManager()
    CoordinatorModule(bus, manager, None)
    WorkflowGenModule(bus, manager)
    TaskDraftModule(bus, manager)
    ChatSessionModule(bus, manager)
    ChannelChatModule(bus, manager)
    store = _config_store(tmp_path, monkeypatch)
    monkeypatch.setattr(assistant_api, "config_store", store)
    client = AsyncClient(
        transport=ASGITransport(app=main.app),
        base_url="http://test",
    )
    yield client, store
    await client.aclose()


async def test_enhance_config_round_trip(assistant_client):
    client, store = assistant_client
    store.save_provider({
        "id": "p-enhance",
        "name": "Enhance Provider",
        "type": "deepseek",
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "sk-test",
        "enabled": True,
    })
    response = await client.get("/api/assistant/enhance-config")
    assert response.status_code == 200
    payload = response.json()
    assert payload["provider_id"] == ""
    assert payload["model"] == ""
    assert payload["protocol"] == ""
    assert any(item["id"] == "p-enhance" for item in payload["providers"])

    response = await client.put("/api/assistant/enhance-config", json={
        "provider_id": "p-enhance",
        "model": "deepseek-v4-flash",
        "protocol": "openai_chat_completions",
    })
    assert response.status_code == 200
    assert response.json()["model"] == "deepseek-v4-flash"
    assert store.get_prompt_enhance_config() == {
        "provider_id": "p-enhance",
        "model": "deepseek-v4-flash",
        "protocol": "openai_chat_completions",
    }

    # 清空
    response = await client.put("/api/assistant/enhance-config", json={
        "provider_id": "",
        "model": "",
        "protocol": "",
    })
    assert response.status_code == 200
    assert store.get_prompt_enhance_config() == {"provider_id": "", "model": "", "protocol": ""}


async def test_enhance_config_accepts_anthropic_messages(assistant_client):
    client, store = assistant_client
    store.save_provider({
        "id": "anthropic-enhance",
        "name": "Anthropic Enhance",
        "type": "custom",
        "protocols": ["anthropic_messages"],
        "protocol_base_urls": {
            "anthropic_messages": "https://gateway.example.com/v1",
        },
        "api_key": "sk-test",
        "enabled": True,
    })

    response = await client.put("/api/assistant/enhance-config", json={
        "provider_id": "anthropic-enhance",
        "model": "claude-model",
        "protocol": "anthropic_messages",
    })

    assert response.status_code == 200
    assert store.get_prompt_enhance_config() == {
        "provider_id": "anthropic-enhance",
        "model": "claude-model",
        "protocol": "anthropic_messages",
    }


async def test_enhance_config_validates_provider(assistant_client):
    client, _ = assistant_client
    response = await client.put("/api/assistant/enhance-config", json={
        "provider_id": "missing-provider",
        "model": "m",
    })
    assert response.status_code == 404

    response = await client.put("/api/assistant/enhance-config", json={
        "provider_id": "",
        "model": "m",
    })
    assert response.status_code == 400


async def test_assistant_list_lists_all_assistants(assistant_client):
    client, _ = assistant_client
    response = await client.get("/api/assistant/list")
    assert response.status_code == 200
    assistants = response.json()["assistants"]
    names = {item["name"] for item in assistants}
    assert {"task_coordinator", "task_create", "workflow_gen", "chat_session", "channel_chat"} <= names
    by_name = {item["name"]: item for item in assistants}
    expected_fields = [
        "engine",
        "model",
        "fast_model",
        "vision_model",
        "thinking_effort",
        "provider_id",
    ]
    for item in assistants:
        assert item["fields"] == expected_fields
    assert by_name["task_coordinator"]["available_engines"]


async def test_assistant_list_separates_configured_override_from_resolved_default(
    assistant_client,
    monkeypatch,
):
    client, store = assistant_client
    import api.assistant as _assistant_api
    from engines.core.registry import _ALL_ENGINES as _AE
    def _fake_create(engine_id):
        cls = _AE.get(engine_id)
        return cls() if cls is not None else None
    monkeypatch.setattr(_assistant_api, "create_engine", _fake_create)

    store.set_coordinator_defaults("claude", "m1", "", "", "medium")
    store.set_codex_sdk_config(model_reasoning_effort="low")
    store.set_assistant_defaults("chat_session", engine="codex_sdk")
    response = await client.get("/api/assistant/list")
    assert response.status_code == 200
    item = next(
        item
        for item in response.json()["assistants"]
        if item["name"] == "chat_session"
    )
    assert item["configured"]["engine"] == "codex_sdk"
    assert item["configured"]["thinking_effort"] == ""
    assert item["resolved"]["engine"] == "codex_sdk"
    assert item["resolved"]["thinking_effort"] == "low"

    saved = await client.put(
        "/api/assistant/chat_session/config",
        json={
            "engine": "codex_sdk",
            "model": "",
            "fast_model": "",
            "vision_model": "",
            "thinking_effort": "",
            "provider_id": "",
        },
    )
    assert saved.status_code == 200
    assert saved.json()["configured"]["engine"] == "codex_sdk"
    assert saved.json()["configured"]["thinking_effort"] == ""
    assert saved.json()["resolved"]["thinking_effort"] == "low"

    response = await client.get("/api/assistant/list")
    item = next(
        item
        for item in response.json()["assistants"]
        if item["name"] == "chat_session"
    )
    assert item["configured"]["engine"] == "codex_sdk"
    assert item["configured"]["thinking_effort"] == ""


async def test_task_coordinator_resolves_engine_default_thinking_effort(
    assistant_client,
):
    client, store = assistant_client
    store.set_execution_default_engine("codex_sdk")
    store.set_codex_sdk_config(model_reasoning_effort="auto")

    response = await client.get("/api/assistant/list")

    assert response.status_code == 200
    item = next(
        item
        for item in response.json()["assistants"]
        if item["name"] == "task_coordinator"
    )
    assert item["configured"]["engine"] == ""
    assert item["configured"]["thinking_effort"] == ""
    assert item["resolved"]["engine"] == "codex_sdk"
    assert item["resolved"]["thinking_effort"] == "auto"


async def test_assistant_set_and_read_config(assistant_client, monkeypatch):
    client, store = assistant_client
    import api.assistant as _assistant_api
    from engines.core.registry import _ALL_ENGINES as _AE
    def _fake_create(engine_id):
        cls = _AE.get(engine_id)
        return cls() if cls is not None else None
    monkeypatch.setattr(_assistant_api, "create_engine", _fake_create)
    response = await client.put(
        "/api/assistant/task_create/config",
        json={
            "engine": "claude_agent_sdk",
            "model": "gm",
            "fast_model": "gf",
            "vision_model": "gv",
            "thinking_effort": "high",
        },
    )
    assert response.status_code == 200
    assert response.json()["saved"] is True
    defaults = store.get_assistant_defaults("task_create")
    assert defaults["engine"] == "claude_agent_sdk"
    assert defaults["model"] == "gm"
    assert defaults["fast_model"] == "gf"
    assert defaults["vision_model"] == "gv"
    assert defaults["thinking_effort"] == "high"
    response = await client.get("/api/assistant/list")
    item = next(
        item
        for item in response.json()["assistants"]
        if item["name"] == "task_create"
    )
    assert item["configured"]["model"] == "gm"


async def test_chat_session_config_stores_full_defaults(assistant_client, monkeypatch):
    client, store = assistant_client
    import api.assistant as _assistant_api
    from engines.core.registry import _ALL_ENGINES as _AE
    def _fake_create(engine_id):
        cls = _AE.get(engine_id)
        return cls() if cls is not None else None
    monkeypatch.setattr(_assistant_api, "create_engine", _fake_create)
    response = await client.put(
        "/api/assistant/chat_session/config",
        json={
            "engine": "hermes",
            "model": "cm",
            "fast_model": "cf",
            "vision_model": "cv",
            "thinking_effort": "low",
        },
    )
    assert response.status_code == 200
    defaults = store.get_assistant_defaults("chat_session")
    assert defaults["engine"] == "hermes"
    assert defaults["model"] == "cm"
    assert defaults["fast_model"] == "cf"
    assert defaults["vision_model"] == "cv"
    assert defaults["thinking_effort"] == "low"


async def test_assistant_config_validates_unknown_name(assistant_client):
    client, _ = assistant_client
    response = await client.put("/api/assistant/nope/config", json={"engine": ""})
    assert response.status_code == 404


async def test_assistant_config_rejects_model_without_engine(assistant_client):
    client, _ = assistant_client
    response = await client.put(
        "/api/assistant/task_create/config",
        json={"model": "gm"},
    )
    assert response.status_code == 400


@pytest.mark.parametrize("engine,effort", [
    ("hermes", "auto"), ("hermes", "xhigh"),
    ("codex_sdk", "none"), ("codex_sdk", "max"), ("codex_sdk", "ultra"),
])
async def test_assistant_config_accepts_native_efforts(assistant_client, monkeypatch, engine, effort):
    client, store = assistant_client
    import api.assistant as _assistant_api
    from engines.core.registry import _ALL_ENGINES as _AE
    def _fake_create(engine_id):
        cls = _AE.get(engine_id)
        return cls() if cls is not None else None
    monkeypatch.setattr(_assistant_api, "create_engine", _fake_create)
    response = await client.put(
        "/api/assistant/task_coordinator/config",
        json={"engine": engine, "thinking_effort": effort},
    )
    assert response.status_code == 200
    assert store.get_coordinator_default_thinking_effort() == effort
    response = await client.put(
        "/api/assistant/task_create/config",
        json={"engine": engine, "thinking_effort": effort},
    )
    assert response.status_code == 200
    assert store.get_assistant_defaults("task_create")["thinking_effort"] == effort
    # 非法强度仍然拒绝
    response = await client.put(
        "/api/assistant/task_create/config",
        json={"engine": engine, "thinking_effort": "invalid-effort"},
    )
    assert response.status_code == 400


def test_assistant_defaults_provider_override(tmp_path, monkeypatch):
    """供应商作为引擎动态配置存于助手默认值；未设置时为空（跟随引擎配置）。"""
    store = _config_store(tmp_path, monkeypatch)
    store.save_provider({
        "id": "p-b",
        "name": "Builtin Provider",
        "type": "deepseek",
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "sk-test",
        "enabled": True,
    })
    assert store.get_assistant_defaults("task_create")["provider_id"] == ""
    store.set_assistant_defaults("task_create", engine="pydantic_ai", provider_id="p-b")
    assert store.get_assistant_defaults("task_create")["provider_id"] == "p-b"
    store.set_assistant_defaults("task_create", provider_id="")
    assert store.get_assistant_defaults("task_create")["provider_id"] == ""
    # 协调 Agent 走旧键；provider 单独存 overlay，仍能回读
    store.set_assistant_defaults("task_coordinator", engine="pydantic_ai", provider_id="p-b")
    assert store.get_assistant_defaults("task_coordinator")["provider_id"] == "p-b"
    store.set_assistant_defaults("task_coordinator", provider_id="")
    assert store.get_assistant_defaults("task_coordinator")["provider_id"] == ""


async def test_assistant_config_provider_round_trip(assistant_client):
    """内置引擎（Pydantic AI）可设置供应商；列表接口透出并支持清空。"""
    client, store = assistant_client
    store.save_provider({
        "id": "p-b",
        "name": "Builtin Provider",
        "type": "deepseek",
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "sk-test",
        "enabled": True,
    })
    response = await client.put(
        "/api/assistant/task_create/config",
        json={"engine": "pydantic_ai", "provider_id": "p-b"},
    )
    assert response.status_code == 200
    assert store.get_assistant_defaults("task_create")["provider_id"] == "p-b"
    response = await client.get("/api/assistant/list")
    item = next(
        item for item in response.json()["assistants"]
        if item["name"] == "task_create"
    )
    assert item["configured"]["provider_id"] == "p-b"
    assert "provider_id" in item["fields"]
    response = await client.put(
        "/api/assistant/task_create/config",
        json={"engine": "pydantic_ai", "provider_id": ""},
    )
    assert response.status_code == 200
    assert store.get_assistant_defaults("task_create")["provider_id"] == ""


async def test_assistant_config_provider_requires_builtin_engine(assistant_client):
    """协议不兼容的供应商不能绑定到助手引擎。"""
    client, store = assistant_client
    store.save_provider({
        "id": "p-b",
        "name": "Builtin Provider",
        "type": "deepseek",
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "sk-test",
        "enabled": True,
    })
    response = await client.put(
        "/api/assistant/task_create/config",
        json={"engine": "hermes", "provider_id": "p-b"},
    )
    assert response.status_code == 400


async def test_assistant_config_accepts_compatible_external_engine_provider(
    assistant_client,
    monkeypatch,
):
    client, store = assistant_client
    store.save_provider({
        "id": "p-claude",
        "name": "Claude Gateway",
        "type": "anthropic",
        "protocol": "anthropic_messages",
        "base_url": "https://claude.example.com/v1",
        "api_key": "sk-test",
        "enabled": True,
    })

    import api.assistant as _assistant_api2
    from engines.claude_agent_sdk import ClaudeAgentSDKEngine as _CASE
    monkeypatch.setattr(_assistant_api2, "create_engine", lambda eid: _CASE() if eid == "claude_agent_sdk" else None)
    response = await client.put(
        "/api/assistant/task_create/config",
        json={"engine": "claude_agent_sdk", "provider_id": "p-claude"},
    )

    assert response.status_code == 200
    assert store.get_assistant_defaults("task_create")["provider_id"] == "p-claude"


async def test_assistant_config_provider_must_exist_and_be_enabled(assistant_client):
    client, store = assistant_client
    response = await client.put(
        "/api/assistant/task_create/config",
        json={"engine": "pydantic_ai", "provider_id": "missing"},
    )
    assert response.status_code == 404
    store.save_provider({
        "id": "p-off",
        "name": "Disabled Provider",
        "type": "deepseek",
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "sk-test",
        "enabled": False,
    })
    response = await client.put(
        "/api/assistant/task_create/config",
        json={"engine": "pydantic_ai", "provider_id": "p-off"},
    )
    assert response.status_code == 400


@pytest.mark.anyio
async def test_invoke_engine_merges_provider_config_overrides(monkeypatch):
    """供应商以引擎动态配置（config_overrides）传给内置引擎 spawn。"""
    import agent_assistants.base as base
    from types import SimpleNamespace

    captured: dict = {}

    class BuiltinEngine:
        capabilities = SimpleNamespace(
            supports_thinking_effort=False,
            supports_workstep_tools=False,
        )
        supports_resume = False
        supports_message_history = False

        async def spawn(self, prompt, cwd, model, session_id, **kwargs):
            captured["config_overrides"] = kwargs.get("config_overrides")
            if False:
                yield None

    monkeypatch.setattr(base, "create_engine", lambda engine_id: BuiltinEngine())
    await base.invoke_engine(
        "pydantic_ai",
        None,
        "/tmp",
        "hi",
        None,
        config_overrides={"provider_id": "p-b"},
    )
    assert captured["config_overrides"] == {"provider_id": "p-b"}
    # 与计划模式覆盖合并，互不覆盖
    captured.clear()
    await base.invoke_engine(
        "pydantic_ai",
        None,
        "/tmp",
        "hi",
        None,
        config_overrides={"provider_id": "p-b"},
        plan_mode=True,
    )
    assert captured["config_overrides"] == {"provider_id": "p-b", "sandbox": "read-only"}


@pytest.mark.anyio
async def test_invoke_engine_keeps_progress_out_of_structured_reply(monkeypatch):
    import agent_assistants.base as base
    from types import SimpleNamespace
    from engines.core.events import InternalEvent

    class Engine:
        capabilities = SimpleNamespace(supports_thinking_effort=False, supports_workstep_tools=False)
        supports_resume = False
        supports_message_history = False

        async def spawn(self, **kwargs):
            yield InternalEvent("agent_message_chunk", {
                "content": {"text": "我先检查。"}, "phase": "commentary", "source_item_id": "p1",
            })
            yield InternalEvent("agent_message_chunk", {
                "content": {"text": '{"reply":"完成"}'}, "phase": "final_answer",
            })

    monkeypatch.setattr(base, "create_engine", lambda _: Engine())
    published = []

    async def record(event):
        published.append(event)

    result = await base.invoke_engine("pydantic_ai", None, "/tmp", "hi", None, on_event=record)
    assert result[0] == '{"reply":"完成"}'
    assert published[0].data["phase"] == "commentary"
    assert result[1][0]["data"]["source_item_id"] == "p1"


@pytest.mark.anyio
async def test_assistant_runtime_injects_assistant_provider(monkeypatch):
    """AssistantRuntime 把该助手的供应商作为引擎动态配置注入 spawn。"""
    import agent_assistants.base as base
    from types import SimpleNamespace

    captured: dict = {}

    class BuiltinEngine:
        capabilities = SimpleNamespace(
            supports_thinking_effort=False,
            supports_workstep_tools=False,
        )
        supports_resume = False
        supports_message_history = False

        async def spawn(self, prompt, cwd, model, session_id, **kwargs):
            captured["config_overrides"] = kwargs.get("config_overrides")
            if False:
                yield None

    monkeypatch.setattr(base, "create_engine", lambda engine_id: BuiltinEngine())
    monkeypatch.setattr(
        base.config_store,
        "get_assistant_defaults",
        lambda name: {"provider_id": "p-b"} if name == "task_create" else {},
    )
    runtime = base.AssistantRuntime.__new__(base.AssistantRuntime)
    runtime._config = SimpleNamespace(
        name="task_create", engine_label="Test", workstep_tools=False, system_prompt_transport=False
    )
    runtime._turn_states = {}
    runtime._turn_tasks = {}
    runtime._running_engines = {}
    runtime._prompt_input_callbacks = {}
    await runtime._invoke("pydantic_ai", None, "/tmp", "hi", None)
    assert captured["config_overrides"] == {"provider_id": "p-b"}
    # 兼容性已在保存/排队 seam 校验；运行时对所有引擎统一注入覆盖。
    captured.clear()
    await runtime._invoke("claude", None, "/tmp", "hi", None)
    assert captured["config_overrides"] == {"provider_id": "p-b"}


async def test_assistant_config_provider_requires_explicit_builtin_engine(assistant_client):
    """供应商只绑定显式选择的 Pydantic AI 引擎，与默认引擎（跟随）无关。"""
    client, store = assistant_client
    store.save_provider({
        "id": "p-b",
        "name": "Builtin Provider",
        "type": "deepseek",
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "sk-test",
        "enabled": True,
    })
    response = await client.put(
        "/api/assistant/task_create/config",
        json={"engine": "", "provider_id": "p-b"},
    )
    assert response.status_code == 400
    response = await client.put(
        "/api/assistant/task_create/config",
        json={"engine": "pydantic_ai", "provider_id": "p-b"},
    )
    assert response.status_code == 200
    assert store.get_assistant_defaults("task_create")["provider_id"] == "p-b"


@pytest.mark.anyio
async def test_assistant_runtime_resolves_builtin_engine_when_provider_set(monkeypatch):
    """显式选择 Pydantic AI + 供应商 → 运行时解析为内置引擎；
    引擎留空（跟随）时供应商不生效，仍走 claude 回退。"""
    import agent_assistants.base as base
    from types import SimpleNamespace

    monkeypatch.setattr(
        base.config_store,
        "get_assistant_defaults",
        lambda name: {"engine": "pydantic_ai", "provider_id": "p-b"},
    )
    monkeypatch.setattr(
        base,
        "create_engine",
        lambda engine_id: SimpleNamespace() if engine_id in ("pydantic_ai", "codex_sdk") else None,
    )
    monkeypatch.setattr(base, "resolve_execution_engine", lambda engine_id: "codex_sdk")
    runtime = base.AssistantRuntime.__new__(base.AssistantRuntime)
    runtime._config = SimpleNamespace(
        name="chat_session", resolve_engine_models=None, engine_label="Chat engine"
    )
    engine_id, model, _ = runtime._resolve_engine_models()
    assert engine_id == "pydantic_ai"
    assert model is None

    # 引擎留空（跟随默认引擎）时不因供应商改用内置引擎
    monkeypatch.setattr(
        base.config_store,
        "get_assistant_defaults",
        lambda name: {"engine": "", "provider_id": "p-b"},
    )
    engine_id, model, _ = runtime._resolve_engine_models()
    assert engine_id == "codex_sdk"
