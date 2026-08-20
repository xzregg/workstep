"""Provider reuse contracts exposed through the engine interface."""

import json
import asyncio

import pytest
from fastapi import HTTPException

import services.config as config_module
from engines.claude_agent_sdk import ClaudeAgentSDKEngine
from engines.claude_code import ClaudeCodeEngine
from engines.codex import CodexEngine
from engines.codex_sdk import CodexSDKEngine
from engines.deepseek_harness import DeepSeekHarnessEngine
from engines.hermes import HermesEngine
from engines.openclaw import OpenClawEngine
from engines.pydantic_ai import PydanticAIEngine
from engines.qoder_sdk import QoderSDKEngine
from services.config import ConfigStore
from api.workflow import _validate_steps


@pytest.fixture
def provider_store(tmp_path, monkeypatch):
    config_dir = tmp_path / ".workstep"
    monkeypatch.setattr(config_module, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(config_module, "CONFIG_FILE", config_dir / "config.json")
    store = ConfigStore()
    monkeypatch.setattr(config_module, "config_store", store)
    for module_name in (
        "engines.claude_code",
        "engines.claude_agent_sdk",
        "engines.codex",
        "engines.codex_sdk",
        "engines.hermes",
        "engines.pydantic_ai.engine",
    ):
        module = __import__(module_name, fromlist=["config_store"])
        if hasattr(module, "config_store"):
            monkeypatch.setattr(module, "config_store", store)
    return store


def _provider(provider_id: str, protocol: str, *, type_id: str = "custom") -> dict:
    return {
        "id": provider_id,
        "name": provider_id,
        "type": type_id,
        "protocol": protocol,
        "base_url": f"https://{provider_id}.example.com/v1",
        "api_key": f"secret-{provider_id}",
        "enabled": True,
    }


def test_legacy_providers_gain_protocol_when_loaded(tmp_path, monkeypatch):
    config_dir = tmp_path / ".workstep"
    config_file = config_dir / "config.json"
    config_dir.mkdir()
    config_file.write_text(json.dumps({"providers": [
        {"id": "anthropic", "type": "anthropic"},
        {"id": "openai", "type": "openai"},
        {"id": "custom", "type": "custom"},
    ]}))
    monkeypatch.setattr(config_module, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(config_module, "CONFIG_FILE", config_file)

    providers = ConfigStore().get_providers()

    assert [item["protocol"] for item in providers] == [
        "anthropic_messages",
        "openai_responses",
        "openai_chat_completions",
    ]


def test_engine_protocol_declarations_are_adapter_owned():
    assert ClaudeCodeEngine.supported_provider_protocols() == {
        "anthropic_messages"
    }
    assert ClaudeAgentSDKEngine.supported_provider_protocols() == {
        "anthropic_messages"
    }
    assert CodexEngine.supported_provider_protocols() == {"openai_responses"}
    assert CodexSDKEngine.supported_provider_protocols() == {"openai_responses"}
    assert HermesEngine.supported_provider_protocols() == {
        "openai_chat_completions"
    }
    assert PydanticAIEngine.supported_provider_protocols() == {
        "anthropic_messages",
        "openai_responses",
        "openai_chat_completions",
    }
    assert DeepSeekHarnessEngine.supported_provider_protocols() == {
        "openai_chat_completions"
    }
    assert OpenClawEngine.supported_provider_protocols() == set()
    assert QoderSDKEngine.supported_provider_protocols() == set()


def test_pydantic_ai_builds_protocol_specific_openai_models():
    anthropic = PydanticAIEngine.build_model(
        provider=_provider("anthropic", "anthropic_messages"),
        model_name="claude-compatible",
    )
    chat = PydanticAIEngine.build_model(
        provider=_provider("chat", "openai_chat_completions"),
        model_name="chat-model",
    )
    responses = PydanticAIEngine.build_model(
        provider=_provider("responses", "openai_responses"),
        model_name="responses-model",
    )

    assert type(anthropic).__name__ == "AnthropicModel"
    assert type(chat).__name__ == "OpenAIChatModel"
    assert type(responses).__name__ == "OpenAIResponsesModel"


def test_provider_resolution_uses_turn_override_then_engine_default(provider_store):
    provider_store.save_provider(_provider("default", "anthropic_messages"))
    provider_store.save_provider(_provider("turn", "anthropic_messages"))
    provider_store.set_engine_provider("claude", "default")
    engine = ClaudeCodeEngine()

    default_runtime = engine.resolve_provider_runtime(model="claude-default")
    turn_runtime = engine.resolve_provider_runtime(
        provider_id="turn", model="claude-turn"
    )

    assert default_runtime.provider_id == "default"
    assert default_runtime.model == "claude-default"
    assert turn_runtime.provider_id == "turn"
    assert turn_runtime.model == "claude-turn"


def test_provider_resolution_rejects_disabled_or_incompatible_provider(provider_store):
    provider_store.save_provider(_provider("chat", "openai_chat_completions"))
    provider_store.save_provider({
        **_provider("disabled", "openai_responses"),
        "enabled": False,
    })
    engine = CodexEngine()

    with pytest.raises(ValueError, match="协议"):
        engine.resolve_provider_runtime(provider_id="chat", model="gpt-test")
    with pytest.raises(ValueError, match="停用"):
        engine.resolve_provider_runtime(provider_id="disabled", model="gpt-test")


def test_claude_provider_runtime_is_isolated_from_parent_environment(provider_store):
    provider_store.save_provider(
        _provider("claude-gateway", "anthropic_messages", type_id="anthropic")
    )

    runtime = ClaudeCodeEngine().resolve_provider_runtime(
        provider_id="claude-gateway", model="claude-custom"
    )
    sdk_runtime = ClaudeAgentSDKEngine().resolve_provider_runtime(
        provider_id="claude-gateway", model="claude-custom"
    )

    assert runtime.env == {
        "ANTHROPIC_BASE_URL": "https://claude-gateway.example.com/v1",
        "ANTHROPIC_API_KEY": "secret-claude-gateway",
    }
    assert runtime.unset_env == {
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
    }
    assert sdk_runtime.env == runtime.env
    assert sdk_runtime.unset_env == runtime.unset_env
    assert "secret-claude-gateway" not in runtime.safe_summary


def test_codex_provider_runtime_uses_ephemeral_model_provider(provider_store):
    provider_store.save_provider(_provider("responses", "openai_responses"))

    runtime = CodexEngine().resolve_provider_runtime(
        provider_id="responses", model="gpt-custom"
    )
    sdk_runtime = CodexSDKEngine().resolve_provider_runtime(
        provider_id="responses", model="gpt-custom"
    )

    assert runtime.env == {"WORKSTEP_LLM_API_KEY": "secret-responses"}
    assert runtime.engine_config == (
        'model_provider="workstep"',
        'model_providers.workstep.name="WorkStep"',
        'model_providers.workstep.base_url="https://responses.example.com/v1"',
        'model_providers.workstep.env_key="WORKSTEP_LLM_API_KEY"',
        'model_providers.workstep.wire_api="responses"',
    )
    assert sdk_runtime.env == runtime.env
    assert sdk_runtime.engine_config == runtime.engine_config


def test_hermes_provider_runtime_uses_openai_compatible_environment(provider_store):
    provider_store.save_provider(_provider("hermes", "openai_chat_completions"))

    runtime = HermesEngine().resolve_provider_runtime(
        provider_id="hermes", model="qwen-custom"
    )

    assert runtime.env == {
        "OPENAI_BASE_URL": "https://hermes.example.com/v1",
        "OPENAI_API_KEY": "secret-hermes",
    }


class _FakeStdin:
    def write(self, _data):
        return None

    async def drain(self):
        return None

    def close(self):
        return None


class _FakeProcess:
    def __init__(self):
        self.stdin = _FakeStdin()
        self.stdout = asyncio.StreamReader()
        self.stdout.feed_eof()
        self.stderr = asyncio.StreamReader()
        self.stderr.feed_eof()
        self.returncode = 0

    async def wait(self):
        return self.returncode


@pytest.mark.anyio
async def test_codex_spawn_applies_bound_provider_to_command_and_child_env(
    provider_store,
    monkeypatch,
):
    provider_store.save_provider(_provider("responses", "openai_responses"))
    provider_store.set_engine_provider("codex", "responses")
    captured = {}

    async def fake_create_subprocess_exec(*args, **kwargs):
        captured["args"] = args
        captured["env"] = kwargs.get("env")
        return _FakeProcess()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(CodexEngine, "resolve_binary", staticmethod(lambda: "/fake/codex"))

    events = [
        event
        async for event in CodexEngine().spawn(
            prompt="hello", cwd="/tmp", model="gpt-custom"
        )
    ]

    assert 'model_provider="workstep"' in captured["args"]
    assert captured["env"]["WORKSTEP_LLM_API_KEY"] == "secret-responses"
    assert any(event.type == "status" for event in events)


@pytest.mark.anyio
async def test_switching_provider_clears_unavailable_engine_default_model(
    provider_store,
):
    provider_store.save_provider(_provider("old", "anthropic_messages"))
    provider_store.save_provider(_provider("new", "anthropic_messages"))
    provider_store.set_engine_provider("claude", "old")
    provider_store.set_engine_default_model("claude", "old-only-model")
    provider_store.set_provider_models(
        "new",
        [{"id": "new-model", "label": "New model"}],
        "2026-08-20T00:00:00Z",
    )

    await ClaudeCodeEngine().save_full_config_values({
        "provider_id": "new",
        "permission_mode": "auto",
    })

    assert provider_store.get_engine_provider("claude") == "new"
    assert provider_store.get_engine_default_model("claude") == ""


@pytest.mark.anyio
async def test_switching_provider_keeps_cached_engine_default_model(provider_store):
    provider_store.save_provider(_provider("old", "anthropic_messages"))
    provider_store.save_provider(_provider("new", "anthropic_messages"))
    provider_store.set_engine_provider("claude", "old")
    provider_store.set_engine_default_model("claude", "shared-model")
    provider_store.set_provider_models(
        "new",
        [{"id": "shared-model", "label": "Shared model"}],
        "2026-08-20T00:00:00Z",
    )

    await ClaudeCodeEngine().save_full_config_values({
        "provider_id": "new",
        "permission_mode": "auto",
    })

    assert provider_store.get_engine_default_model("claude") == "shared-model"


@pytest.mark.anyio
async def test_pydantic_provider_switch_clears_its_stored_model(provider_store):
    provider_store.save_provider(_provider("old", "openai_responses"))
    provider_store.save_provider(_provider("new", "openai_responses"))
    provider_store.set_pydantic_ai_engine_config(
        provider_id="old", model="old-only-model"
    )

    await PydanticAIEngine().save_full_config_values({"provider_id": "new"})

    assert provider_store.get_pydantic_ai_engine_config()["provider_id"] == "new"
    assert provider_store.get_pydantic_ai_engine_config()["model"] == ""


def test_workflow_stage_rejects_incompatible_provider(provider_store):
    provider_store.save_provider(_provider("chat", "openai_chat_completions"))

    with pytest.raises(HTTPException) as exc_info:
        _validate_steps({
            "steps": [{
                "key": "write",
                "label": "Write",
                "engine": "claude",
                "prompt": "Write it",
                "config": {"provider_id": "chat"},
            }],
        })
    assert "供应商协议与引擎不兼容" in exc_info.value.detail
