"""Tests for P2 engines: Codex, Hermes, ACP engines, registry strategy."""

import pytest
from engines.codex import CodexEngine
from engines.hermes import HermesEngine
from engines.claude_code_acp import ClaudeCodeAcpEngine
from engines.codex_acp import CodexAcpEngine
from engines.qoder_acp import QoderAcpEngine
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


# --- ACP Engines ---

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


# --- Registry ---

def test_all_engines_registered():
    """All 6 engines are in the full list."""
    assert len(_ALL_ENGINES) == 6
    assert "claude" in _ALL_ENGINES
    assert "codex" in _ALL_ENGINES
    assert "hermes" in _ALL_ENGINES
    assert "claude_acp" in _ALL_ENGINES
    assert "codex_acp" in _ALL_ENGINES
    assert "qoder_acp" in _ALL_ENGINES


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
