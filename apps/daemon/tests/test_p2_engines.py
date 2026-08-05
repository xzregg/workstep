"""Tests for P2 engines: Codex, Hermes, ACP engines, registry strategy."""

import pytest
from acp import schema
from engines.codex import CodexEngine
from engines.hermes import HermesEngine
from engines.claude_code_acp import ClaudeCodeAcpEngine
from engines.codex_acp import CodexAcpEngine
from engines.qoder_acp import QoderAcpEngine
from engines.api import APIEngine
from engines.registry import (
    ENGINE_REGISTRY,
    get_available_engines,
    create_engine,
    refresh_registry,
    _ALL_ENGINES,
)
from engines.events import InternalEvent


# --- CodexEngine ---

def test_codex_resolve_binary():
    binary = CodexEngine.resolve_binary()
    assert binary is None or isinstance(binary, str)


def test_codex_broken_launcher_is_not_reported_as_installed(monkeypatch):
    """A PATH shim that cannot start Codex is not a usable engine."""
    class FailedVersion:
        returncode = 1
        stdout = ""

    monkeypatch.setattr(CodexEngine, "resolve_binary", staticmethod(lambda: "/fake/codex"))
    monkeypatch.setattr("subprocess.run", lambda *args, **kwargs: FailedVersion())

    assert CodexEngine.is_installed() is False


def test_codex_not_resume():
    engine = CodexEngine()
    assert engine.supports_resume is False
    assert engine.supports_interactive is False


def test_codex_map_thread_started():
    engine = CodexEngine()
    event = engine._map_event({"type": "thread.started"})
    assert event is not None
    assert event.type == "status"
    assert event.data["status"] == "initializing"


def test_codex_map_agent_message():
    engine = CodexEngine()
    event = engine._map_event({
        "type": "item.completed",
        "item": {"type": "agent_message", "message": "Hello from Codex"},
    })
    assert event is not None
    assert event.type == "text_delta"
    assert event.data["delta"] == "Hello from Codex"


def test_codex_map_command_execution():
    engine = CodexEngine()
    # tool_use (started)
    event = engine._map_event({
        "type": "item.started",
        "item": {"type": "command_execution", "id": "cmd1", "command": "ls -la"},
    })
    assert event is not None
    assert event.type == "tool_use"
    assert event.data["name"] == "Bash"

    # tool_result (completed)
    event = engine._map_event({
        "type": "item.completed",
        "item": {"type": "command_execution", "id": "cmd1", "output": "file1\nfile2", "exit_code": 0},
    })
    assert event is not None
    assert event.type == "tool_result"
    assert not event.data["is_error"]


def test_codex_map_turn_completed():
    engine = CodexEngine()
    event = engine._map_event({
        "type": "turn.completed",
        "usage": {"input_tokens": 200, "output_tokens": 100},
    })
    assert event is not None
    assert event.type == "usage"
    assert event.data["input_tokens"] == 200


def test_codex_map_turn_completed_with_cache():
    """Codex turn usage includes cache hit tokens (creation + read)."""
    engine = CodexEngine()
    event = engine._map_event({
        "type": "turn.completed",
        "usage": {
            "input_tokens": 300,
            "output_tokens": 100,
            "cache_creation_input_tokens": 150,
            "cache_read_input_tokens": 120,
        },
    })
    assert event is not None
    assert event.type == "usage"
    assert event.data["input_tokens"] == 300
    assert event.data["output_tokens"] == 100
    assert event.data["cache_creation_input_tokens"] == 150
    assert event.data["cache_read_input_tokens"] == 120


def test_codex_map_error():
    engine = CodexEngine()
    event = engine._map_event({"type": "error", "message": "something broke"})
    assert event is not None
    assert event.type == "error"


def test_codex_sandbox_default():
    sandbox = CodexEngine._default_sandbox()
    assert sandbox in ("workspace-write", "danger-full-access")


# --- HermesEngine ---

def test_hermes_resolve_binary():
    binary = HermesEngine.resolve_binary()
    assert binary is None or isinstance(binary, str)


def test_hermes_supports_interactive():
    engine = HermesEngine()
    assert engine.supports_interactive is True
    assert engine.supports_resume is False


def test_hermes_map_update_text():
    engine = HermesEngine()
    event = engine._map_update({
        "type": "agent_message_chunk",
        "content": {"type": "text", "text": "Hello"},
    })
    assert event is not None
    assert event.type == "text_delta"
    assert event.data["delta"] == "Hello"


def test_hermes_map_update_thinking():
    engine = HermesEngine()
    event = engine._map_update({
        "type": "agent_thought_chunk",
        "content": {"type": "text", "text": "thinking..."},
    })
    assert event is not None
    assert event.type == "thinking_delta"


def test_hermes_map_update_tool_call():
    engine = HermesEngine()
    event = engine._map_update({
        "type": "tool_call",
        "id": "tc1",
        "name": "Edit",
        "input": {"file_path": "/a.py"},
    })
    assert event is not None
    assert event.type == "tool_use"
    assert event.data["name"] == "Edit"


def test_hermes_map_update_tool_result():
    engine = HermesEngine()
    event = engine._map_update({
        "type": "tool_call_update",
        "id": "tc1",
        "output": "done",
        "status": "completed",
    })
    assert event is not None
    assert event.type == "tool_result"
    assert not event.data["is_error"]


def test_hermes_map_usage_update_with_cache():
    """Hermes usage_update includes cache hit tokens (creation + read)."""
    engine = HermesEngine()
    event = engine._map_update({
        "type": "usage_update",
        "input_tokens": 300,
        "output_tokens": 100,
        "cache_creation_input_tokens": 150,
        "cache_read_input_tokens": 120,
    })
    assert event is not None
    assert event.type == "usage"
    assert event.data["input_tokens"] == 300
    assert event.data["output_tokens"] == 100
    assert event.data["cache_creation_input_tokens"] == 150
    assert event.data["cache_read_input_tokens"] == 120


# --- ACP Engines ---


@pytest.mark.anyio
async def test_claude_acp_permission_policy_respects_confirmed_mode():
    from types import SimpleNamespace
    from engines.acp_base import _StreamingClient

    options = [
        SimpleNamespace(kind="allow_once", option_id="allow-once"),
        SimpleNamespace(kind="allow_always", option_id="allow-always"),
        SimpleNamespace(kind="reject_once", option_id="reject-once"),
    ]

    edit_response = await _StreamingClient("acceptEdits").request_permission(
        "session", SimpleNamespace(kind="edit"), options
    )
    execute_response = await _StreamingClient("acceptEdits").request_permission(
        "session", SimpleNamespace(kind="execute"), options
    )
    bypass_response = await _StreamingClient("bypassPermissions").request_permission(
        "session", SimpleNamespace(kind="execute"), options
    )

    assert edit_response.outcome.option_id == "allow-once"
    assert execute_response.outcome.outcome == "cancelled"
    assert bypass_response.outcome.option_id == "allow-always"

def test_claude_acp_engine_id():
    assert ClaudeCodeAcpEngine.ENGINE_ID == "claude_acp"


def test_codex_acp_engine_id():
    assert CodexAcpEngine.ENGINE_ID == "codex_acp"


def test_qoder_acp_engine_id():
    assert QoderAcpEngine.ENGINE_ID == "qoder_acp"


def test_qoder_resolve_binary():
    binary = QoderAcpEngine.resolve_binary()
    assert binary is None or isinstance(binary, str)


def test_acp_supports_resume():
    engine = ClaudeCodeAcpEngine()
    assert engine.supports_resume is True
    assert engine.supports_interactive is True


def test_acp_maps_prompt_response_token_usage():
    response = schema.PromptResponse(
        stopReason="end_turn",
        usage=schema.Usage(
            totalTokens=42,
            inputTokens=30,
            outputTokens=12,
            thoughtTokens=3,
            cachedReadTokens=8,
            cachedWriteTokens=4,
        ),
    )

    event = ClaudeCodeAcpEngine._map_prompt_response_usage(response)

    assert event is not None
    assert event.data == {
        "input_tokens": 30,
        "output_tokens": 12,
        "cache_creation_input_tokens": 4,
        "cache_read_input_tokens": 8,
        "total_tokens": 42,
        "thought_tokens": 3,
    }


def test_acp_usage_update_keeps_context_window_semantics():
    update = schema.UsageUpdate(
        sessionUpdate="usage_update",
        used=53_000,
        size=200_000,
        cost=schema.Cost(amount=0.045, currency="USD"),
    )

    event = ClaudeCodeAcpEngine()._map_notification(update)

    assert event is not None
    assert event.data == {
        "usage_kind": "context_window",
        "used": 53_000,
        "size": 200_000,
        "cost": {"amount": 0.045, "currency": "USD"},
    }


def test_acp_engines_require_the_bridge_binary(monkeypatch):
    """An unrelated CLI plus npx must not make an unavailable ACP bridge active."""
    def fake_which(name):
        return f"/fake/{name}" if name in {"node", "npx", "claude", "codex"} else None

    monkeypatch.setattr("shutil.which", fake_which)

    assert ClaudeCodeAcpEngine.is_installed() is False
    assert CodexAcpEngine.is_installed() is False
    assert ClaudeCodeAcpEngine().get_command() == []
    assert CodexAcpEngine().get_command() == []


def test_api_engine_tracks_configuration(monkeypatch):
    """The direct API adapter tracks configuration readiness."""
    monkeypatch.setattr(
        "engines.api.config_store.get_api_engine_config",
        lambda: {
            "provider": "openai",
            "base_url": "https://api.openai.com/v1",
            "api_key": "",
            "model": "",
        },
    )
    assert APIEngine.is_installed() is True
    assert APIEngine.is_configured() is False


# --- Registry ---

def test_all_engines_registered():
    """All engines are in the full list."""
    assert len(_ALL_ENGINES) == 10
    assert "claude" in _ALL_ENGINES
    assert "codex" in _ALL_ENGINES
    assert "hermes" in _ALL_ENGINES
    assert "claude_acp" in _ALL_ENGINES
    assert "codex_acp" in _ALL_ENGINES
    assert "qoder_acp" in _ALL_ENGINES
    assert "qcode" in _ALL_ENGINES
    assert "openclaw" in _ALL_ENGINES
    assert "api" in _ALL_ENGINES
    assert "pydantic_ai" in _ALL_ENGINES


def test_registry_resolves_installed():
    """ENGINE_REGISTRY contains only installed engines."""
    for backend, cls in ENGINE_REGISTRY.items():
        assert cls.is_installed(), f"{backend} is in registry but not installed"


def test_get_available_engines_lists_all_backends():
    """get_available_engines returns entries for all backends."""
    engines = get_available_engines()
    ids = {e["id"] for e in engines}
    assert "claude" in ids
    assert "codex" in ids
    assert "hermes" in ids
    assert "qoder" in ids


def test_create_engine_returns_instance():
    """create_engine returns an instance or None."""
    from engines.base import BaseLLMEngine
    for backend in ENGINE_REGISTRY:
        engine = create_engine(backend)
        assert engine is not None
        assert isinstance(engine, BaseLLMEngine)

    assert create_engine("nonexistent") is None


def test_refresh_registry():
    """refresh_registry rebuilds the registry."""
    refresh_registry()
    # Should still work after refresh
    engines = get_available_engines()
    assert len(engines) >= 4  # at least the 4 backends
