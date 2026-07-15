"""Tests for engine layer: events, registry, ClaudeCodeEngine mapping."""

import pytest
from engines.events import InternalEvent
from engines.registry import ENGINE_REGISTRY, get_available_engines, create_engine
from engines.claude_code import ClaudeCodeEngine


def test_internal_event_creation():
    """InternalEvent can be created with type and data."""
    event = InternalEvent(type="text_delta", data={"delta": "hello"})
    assert event.type == "text_delta"
    assert event.data["delta"] == "hello"
    assert event.timestamp > 0


def test_internal_event_to_dict():
    """InternalEvent serializes to dict."""
    event = InternalEvent(type="status", data={"status": "running"}, timestamp=1000)
    d = event.to_dict()
    assert d == {"type": "status", "data": {"status": "running"}, "timestamp": 1000}


def test_registry_has_claude():
    """Registry includes claude engine (ACP or CLI)."""
    assert "claude" in ENGINE_REGISTRY
    # Could be ClaudeCodeEngine or ClaudeCodeAcpEngine depending on install


def test_create_engine():
    """create_engine returns a BaseLLMEngine instance."""
    from engines.base import BaseLLMEngine
    engine = create_engine("claude")
    assert isinstance(engine, BaseLLMEngine)


def test_create_engine_unknown():
    """create_engine returns None for unknown backend."""
    assert create_engine("unknown") is None


def test_get_available_engines():
    """get_available_engines returns list with install status."""
    engines = get_available_engines()
    assert len(engines) >= 1
    claude_entry = next(e for e in engines if e["id"] == "claude")
    assert "installed" in claude_entry
    assert isinstance(claude_entry["installed"], bool)


def test_claude_resolve_binary():
    """resolve_binary returns a path or None."""
    binary = ClaudeCodeEngine.resolve_binary()
    # May be None if claude not installed — that's OK
    assert binary is None or isinstance(binary, str)


def test_claude_supports_resume():
    """ClaudeCodeEngine supports resume."""
    engine = ClaudeCodeEngine()
    assert engine.supports_resume is True


def test_claude_not_interactive():
    """Direct CLI mode doesn't support mid-execution interaction."""
    engine = ClaudeCodeEngine()
    assert engine.supports_interactive is False


def test_claude_map_event_text_delta():
    """Claude text content maps to text_delta event."""
    engine = ClaudeCodeEngine()
    obj = {
        "type": "assistant",
        "message": {
            "content": [{"type": "text", "text": "Hello world"}]
        }
    }
    event = engine._map_event(obj)
    assert event is not None
    assert event.type == "text_delta"
    assert event.data["delta"] == "Hello world"


def test_claude_map_event_tool_use():
    """Claude tool_use block maps to tool_use event."""
    engine = ClaudeCodeEngine()
    obj = {
        "type": "assistant",
        "message": {
            "content": [{
                "type": "tool_use",
                "id": "tool_123",
                "name": "Read",
                "input": {"file_path": "/tmp/test.py"}
            }]
        }
    }
    event = engine._map_event(obj)
    assert event is not None
    assert event.type == "tool_use"
    assert event.data["name"] == "Read"
    assert event.data["id"] == "tool_123"


def test_claude_map_event_usage():
    """Claude result maps to usage event."""
    engine = ClaudeCodeEngine()
    obj = {
        "type": "result",
        "input_tokens": 100,
        "output_tokens": 50,
        "session_id": "sess_abc",
    }
    event = engine._map_event(obj)
    assert event is not None
    assert event.type == "usage"
    assert event.data["input_tokens"] == 100
    assert event.data["session_id"] == "sess_abc"


def test_claude_map_event_unknown_returns_none():
    """Unknown event types return None (skipped)."""
    engine = ClaudeCodeEngine()
    assert engine._map_event({"type": "unknown"}) is None
    assert engine._map_event({"type": "ping"}) is None
