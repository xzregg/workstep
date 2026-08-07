"""Tests for engine layer: events, registry, ClaudeCodeEngine mapping."""

import pytest

from engines.base import BaseLLMEngine
from engines.events import InternalEvent, normalize_cost, normalize_token_usage
from engines.registry import ENGINE_REGISTRY, get_available_engines, create_engine
from engines.claude_code import ClaudeCodeEngine


class StubEngine(BaseLLMEngine):
    def __init__(self, events):
        self.events = events
        self.last_prompt = ""

    @staticmethod
    def is_installed():
        return True

    @staticmethod
    def get_version():
        return "test"

    @staticmethod
    def resolve_binary():
        return "test"

    async def spawn(self, prompt, cwd, **kwargs):
        self.last_prompt = prompt
        for event in self.events:
            yield event

    async def stop(self):
        pass

    async def inject_response(self, tool_use_id, content):
        pass

    @property
    def supports_resume(self):
        return False

    @property
    def supports_interactive(self):
        return False

    def build_resume_params(self, session_id):
        return {}


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


def test_normalize_cost_accepts_acp_style_dict():
    assert normalize_cost({"cost": {"amount": 0.045, "currency": "USD"}}) == {
        "amount": 0.045,
        "currency": "USD",
    }


def test_normalize_cost_accepts_bare_number_as_usd():
    assert normalize_cost({"cost": 1.2}) == {"amount": 1.2, "currency": "USD"}


def test_normalize_cost_accepts_openai_style_fields():
    assert normalize_cost({"cost_usd": 0.123456789}) == {
        "amount": 0.123457,
        "currency": "USD",
    }
    assert normalize_cost({"total_cost": 0.5, "currency_code": "CNY"}) == {
        "amount": 0.5,
        "currency": "USD",
    }


def test_normalize_cost_returns_none_without_cost_info():
    assert normalize_cost({"input_tokens": 10, "output_tokens": 5}) is None


def test_normalize_token_usage_appends_cost():
    result = normalize_token_usage(
        {"input_tokens": 10, "output_tokens": 5, "cost_usd": 0.01}
    )
    assert result["input_tokens"] == 10
    assert result["total_tokens"] == 15
    assert result["cost"] == {"amount": 0.01, "currency": "USD"}


@pytest.mark.anyio
async def test_base_engine_connection_test_uses_the_execution_interface(tmp_path):
    engine = StubEngine([
        InternalEvent("text_delta", {"delta": "WORKSTEP_ENGINE_OK"}),
    ])

    result = await engine.test_connection(str(tmp_path))

    assert result.success is True
    assert result.message == "连接和对话测试通过"
    assert "Do not use tools" in engine.last_prompt


@pytest.mark.anyio
async def test_base_engine_connection_test_reports_engine_errors(tmp_path):
    engine = StubEngine([
        InternalEvent("error", {"message": "authentication failed"}),
    ])

    result = await engine.test_connection(str(tmp_path))

    assert result.success is False
    assert result.message == "authentication failed"


@pytest.mark.anyio
async def test_base_engine_model_list_defaults_to_engine_configuration(tmp_path):
    engine = StubEngine([])

    assert await engine.list_models(str(tmp_path)) == []


@pytest.mark.anyio
async def test_base_engine_acp_session_defaults_are_safe_noops(tmp_path):
    """Non-ACP engines expose ACP session/tool methods as safe defaults."""
    engine = StubEngine([])

    assert engine.supports_sessions is False
    assert engine.supports_tool_approval is False
    assert await engine.create_session(str(tmp_path)) is None
    assert await engine.load_session("s1", str(tmp_path)) is False
    assert await engine.list_sessions() == []
    assert await engine.resume_session("s1", str(tmp_path)) is False
    await engine.close_session("s1")
    await engine.cancel_session("s1")
    await engine.set_config_option("model", "gpt-5")
    await engine.reset_options()
    await engine.approve_tool("tool-1")


def test_registry_has_claude():
    """Registry includes the claude engine."""
    assert "claude" in ENGINE_REGISTRY


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


def test_claude_supports_live_stage_messages():
    """Direct CLI mode supports mid-execution live stage messages."""
    engine = ClaudeCodeEngine()
    assert engine.supports_interactive is True
    assert engine.supports_live_stage_message is True
    assert engine.capabilities.supports_live_stage_message is True


def test_claude_command_includes_confirmed_permission_mode():
    command = ClaudeCodeEngine.build_command(
        "/usr/local/bin/claude",
        "acceptEdits",
        model="sonnet",
        session_id="session-1",
        add_dirs=["/tmp/shared"],
    )

    assert command == [
        "/usr/local/bin/claude",
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "acceptEdits",
        "--model", "sonnet",
        "--resume", "session-1",
        "--add-dir", "/tmp/shared",
    ]


@pytest.mark.anyio
async def test_claude_refuses_to_start_without_confirmed_permission_mode(monkeypatch):
    from engines import claude_code

    monkeypatch.setattr(
        ClaudeCodeEngine,
        "resolve_binary",
        staticmethod(lambda: "/usr/local/bin/claude"),
    )
    monkeypatch.setattr(
        claude_code.config_store,
        "get_claude_permission_mode",
        lambda: "",
    )

    events = [
        event async for event in ClaudeCodeEngine().spawn("prompt", "/tmp")
    ]

    assert len(events) == 1
    assert events[0].type == "error"
    assert "权限模式尚未确认" in events[0].data["message"]


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


def test_codex_map_reasoning_item():
    from engines.codex import CodexEngine

    event = CodexEngine()._map_event({
        "type": "item.completed",
        "item": {"type": "reasoning", "text": "分析任务"},
    })

    assert event is not None
    assert event.type == "thinking_delta"
    assert event.data["delta"] == "分析任务"


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


def test_claude_map_event_usage_with_cache():
    """Claude result usage includes cache hit tokens (creation + read)."""
    engine = ClaudeCodeEngine()
    obj = {
        "type": "result",
        "input_tokens": 300,
        "output_tokens": 50,
        "cache_creation_input_tokens": 150,
        "cache_read_input_tokens": 120,
    }
    event = engine._map_event(obj)
    assert event is not None
    assert event.type == "usage"
    assert event.data["input_tokens"] == 300
    assert event.data["output_tokens"] == 50
    assert event.data["cache_creation_input_tokens"] == 150
    assert event.data["cache_read_input_tokens"] == 120


def test_claude_map_event_usage_from_nested_result_payload():
    """Claude result maps nested CLI usage instead of reporting zero tokens."""
    engine = ClaudeCodeEngine()
    obj = {
        "type": "result",
        "session_id": "a37b97f3-58ac-4dbe-9b20-b2057b026acc",
        "usage": {
            "input_tokens": 300,
            "output_tokens": 50,
            "cache_creation_input_tokens": 150,
            "cache_read_input_tokens": 120,
        },
    }

    event = engine._map_event(obj)

    assert event is not None
    assert event.type == "usage"
    assert event.data == {
        "input_tokens": 300,
        "output_tokens": 50,
        "cache_creation_input_tokens": 150,
        "cache_read_input_tokens": 120,
        "session_id": "a37b97f3-58ac-4dbe-9b20-b2057b026acc",
    }


def test_claude_map_event_usage_with_cost():
    """Claude result usage carries ACP-style cost (订单金额)."""
    engine = ClaudeCodeEngine()
    event = engine._map_event({
        "type": "result",
        "usage": {
            "input_tokens": 300,
            "output_tokens": 50,
            "cost": {"amount": 0.045, "currency": "USD"},
        },
    })
    assert event is not None
    assert event.type == "usage"
    assert event.data["cost"] == {"amount": 0.045, "currency": "USD"}


def test_claude_map_event_result_top_level_cost():
    """claude CLI 把 total_cost_usd 放在 result 顶层而非 usage 内。"""
    engine = ClaudeCodeEngine()
    event = engine._map_event({
        "type": "result",
        "session_id": "s1",
        "usage": {
            "input_tokens": 100,
            "output_tokens": 30,
            "cache_creation_input_tokens": 10,
            "cache_read_input_tokens": 20,
        },
        "total_cost_usd": 0.456,
    })
    assert event is not None
    assert event.type == "usage"
    assert event.data["cost"] == {"amount": 0.456, "currency": "USD"}


def test_claude_map_event_unknown_returns_none():
    """Unknown event types return None (skipped)."""
    engine = ClaudeCodeEngine()
    assert engine._map_event({"type": "unknown"}) is None
    assert engine._map_event({"type": "ping"}) is None
