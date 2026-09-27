"""Tests for engine layer: events, registry, ClaudeCodeEngine mapping."""

import asyncio
import sys
import threading
from typing import get_args, get_type_hints

import pytest

from engines.core.acp_base import AcpEngineBase
from engines.core.events import (
    InternalEvent,
    normalize_cost,
    normalize_token_usage,
    usage_update_event,
)
from engines.core.registry import ENGINE_REGISTRY, get_available_engines, create_engine
import engines.core.registry as engine_registry
from engines.claude_code import ClaudeCodeEngine
import engines.core.base as engine_base


class StubEngine(AcpEngineBase):
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
    event = InternalEvent(
        type="agent_message_chunk",
        data={"content": {"text": "hello"}},
    )
    assert event.type == "agent_message_chunk"
    assert event.data["content"]["text"] == "hello"
    assert event.timestamp > 0


def test_internal_event_to_dict():
    """InternalEvent serializes to dict."""
    event = InternalEvent(type="status", data={"status": "running"}, timestamp=1000)
    d = event.to_dict()
    assert d == {"type": "status", "data": {"status": "running"}, "timestamp": 1000}


@pytest.mark.parametrize("event_type", ["live_message", "engine_state"])
def test_internal_event_declares_runtime_event_types(event_type):
    event = InternalEvent(type=event_type, data={})
    assert event.type == event_type
    assert event_type in get_args(get_type_hints(InternalEvent)["type"])


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


def test_normalize_token_usage_marks_cached_input_when_provider_includes_it():
    result = normalize_token_usage({
        "input_tokens": 161_509,
        "output_tokens": 299,
        "cache_read_input_tokens": 161_152,
    })

    assert result["cache_input_included"] is True


def test_normalize_token_usage_marks_separate_cached_input_explicitly():
    result = normalize_token_usage({
        "input_tokens": 300,
        "output_tokens": 50,
        "cache_creation_input_tokens": 150,
        "cache_read_input_tokens": 120,
        "cache_input_included": False,
    })

    assert result["cache_input_included"] is False


def test_usage_update_exposes_canonical_context_snapshot():
    event = usage_update_event({
        "input_tokens": 100,
        "output_tokens": 30,
        "total_tokens": 150,
        "model_context_window": 400,
    })

    assert event.data["used"] == 150
    assert event.data["size"] == 400


def test_usage_update_keeps_context_size_optional_when_provider_omits_it():
    event = usage_update_event({"input_tokens": 10, "output_tokens": 5})

    assert event.data["used"] == 15
    assert "size" not in event.data


@pytest.mark.anyio
async def test_base_engine_connection_test_uses_the_execution_interface(tmp_path):
    engine = StubEngine([
        InternalEvent("agent_message_chunk", {"content": {"text": "WORKSTEP_ENGINE_OK"}}),
    ])

    result = await engine.test_connection(str(tmp_path))

    assert result.success is True
    assert result.message == "连接和对话测试通过"
    assert "Do not use tools" in engine.last_prompt


@pytest.mark.anyio
async def test_base_engine_connection_test_accepts_successful_completion_without_text(
    tmp_path,
):
    """Provider connectivity is proven by a successful run, not text output."""
    engine = StubEngine([
        InternalEvent("status", {"status": "done"}),
    ])

    result = await engine.test_connection(str(tmp_path))

    assert result.success is True
    assert result.message == "连接和对话测试通过"


@pytest.mark.anyio
async def test_base_engine_connection_test_reports_timeout_when_engine_swallows_cancel(
    tmp_path,
):
    """A cancelled engine must not turn the test timeout into 'no text'."""

    class SwallowingEngine(StubEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            try:
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                yield InternalEvent("status", {"status": "cancelled"})

    engine = SwallowingEngine([])

    result = await engine.test_connection(str(tmp_path), timeout_seconds=0.05)

    assert result.success is False
    assert result.message == "测试超时（0.05 秒）"


@pytest.mark.anyio
async def test_base_engine_connection_test_reports_engine_errors(tmp_path):
    engine = StubEngine([
        InternalEvent("error", {"message": "authentication failed"}),
    ])

    result = await engine.test_connection(str(tmp_path))

    assert result.success is False
    assert result.message == "authentication failed"


@pytest.mark.anyio
async def test_engine_retry_reuses_session_from_failed_attempt():
    class RetryEngine(StubEngine):
        def __init__(self):
            super().__init__([])
            self.session_ids = []

        @property
        def supports_resume(self):
            return True

        async def spawn(self, prompt, cwd, session_id=None, **kwargs):
            self.session_ids.append(session_id)
            if len(self.session_ids) == 1:
                yield InternalEvent("session_started", {"session_id": "session-1"})
                yield InternalEvent("error", {"message": "network unavailable"})
                return
            yield InternalEvent(
                "agent_message_chunk",
                {"content": {"text": "recovered"}},
            )
            yield InternalEvent("status", {"status": "done"})

    engine = RetryEngine()

    events = [
        event
        async for event in engine.spawn_with_retry(prompt="hello", cwd="/tmp")
    ]

    assert engine.session_ids == [None, "session-1"]
    assert [event.type for event in events] == [
        "session_started",
        "status",
        "agent_message_chunk",
        "status",
    ]
    assert events[1].data == {
        "status": "retrying",
        "attempt": 2,
        "max_attempts": 2,
        "message": "network unavailable",
    }


@pytest.mark.anyio
async def test_engine_retry_reports_only_second_error():
    class FailingEngine(StubEngine):
        def __init__(self):
            super().__init__([])
            self.calls = 0

        @property
        def supports_resume(self):
            return True

        async def spawn(self, prompt, cwd, session_id=None, **kwargs):
            self.calls += 1
            yield InternalEvent("session_started", {"session_id": "session-1"})
            yield InternalEvent("error", {"message": f"failure-{self.calls}"})

    engine = FailingEngine()

    events = [
        event
        async for event in engine.spawn_with_retry(prompt="hello", cwd="/tmp")
    ]

    assert engine.calls == 2
    assert [event.data.get("message") for event in events if event.type == "error"] == [
        "failure-2"
    ]


@pytest.mark.anyio
async def test_engine_retry_retries_raised_exception_once():
    class RaisingEngine(StubEngine):
        def __init__(self):
            super().__init__([])
            self.calls = 0

        async def spawn(self, prompt, cwd, session_id=None, **kwargs):
            self.calls += 1
            if self.calls == 1:
                raise ConnectionError("connection reset")
            yield InternalEvent("status", {"status": "done"})

    engine = RaisingEngine()

    events = [
        event
        async for event in engine.spawn_with_retry(prompt="hello", cwd="/tmp")
    ]

    assert engine.calls == 2
    assert [event.data.get("status") for event in events] == ["retrying", "done"]


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
    from engines.core.base import BaseLLMEngine
    engine = create_engine("claude")
    assert isinstance(engine, BaseLLMEngine)


def test_create_engine_unknown():
    """create_engine returns None for unknown backend."""
    assert create_engine("unknown") is None


def test_create_engine_waits_for_registry_refresh(monkeypatch):
    """聊天提交不得观察到刷新过程中被暂时清空的引擎注册表。"""
    original_registry = ENGINE_REGISTRY.copy()
    refresh_entered = threading.Event()
    allow_refresh = threading.Event()

    class RefreshProbeEngine(StubEngine):
        def __init__(self):
            super().__init__([])

        @staticmethod
        def is_installed():
            refresh_entered.set()
            assert allow_refresh.wait(timeout=2)
            return True

    monkeypatch.setattr(
        engine_registry,
        "_ALL_ENGINES",
        {"refresh_probe": RefreshProbeEngine},
    )
    monkeypatch.setattr(engine_registry, "_apply_binary_overrides", lambda: None)
    monkeypatch.setitem(ENGINE_REGISTRY, "refresh_probe", RefreshProbeEngine)

    refresh_thread = threading.Thread(target=engine_registry.refresh_registry)
    create_thread = None
    try:
        refresh_thread.start()
        assert refresh_entered.wait(timeout=2)

        result = []
        create_thread = threading.Thread(
            target=lambda: result.append(create_engine("refresh_probe"))
        )
        create_thread.start()
        create_thread.join(timeout=0.05)

        assert create_thread.is_alive()
        allow_refresh.set()
        refresh_thread.join(timeout=2)
        create_thread.join(timeout=2)

        assert isinstance(result[0], RefreshProbeEngine)
    finally:
        allow_refresh.set()
        refresh_thread.join(timeout=2)
        if create_thread is not None:
            create_thread.join(timeout=2)
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original_registry)


def test_engine_install_base_defaults():
    """Base install reports nothing to install; no install command by default."""
    engine = StubEngine([])
    assert engine.install_command() is None
    result = asyncio.run(engine.install())
    assert result.success is True
    assert result.already_installed is True


def test_python_sdk_update_upgrades_in_user_runtime(monkeypatch, tmp_path):
    captured = []

    async def fake_run(cmd, *, timeout=600):
        captured.append(cmd)
        return 0, "updated"

    monkeypatch.setattr(engine_base.shutil, "which", lambda _name: "/usr/bin/uv")
    package_dir = tmp_path / "python-packages"
    monkeypatch.setenv("WORKSTEP_ENGINE_PACKAGE_DIR", str(package_dir))
    monkeypatch.setattr(engine_base, "_has_pip", lambda: False)
    monkeypatch.setattr(engine_base, "run_install_command", fake_run)

    result = asyncio.run(
        engine_base.install_python_package("openai-codex", upgrade=True)
    )

    assert captured == [[
        "uv", "pip", "install", "--upgrade", "--target", str(package_dir),
        "openai-codex",
    ]]
    assert result.success is True
    assert "重启 daemon" in result.message


@pytest.mark.anyio
async def test_python_sdk_install_slow_directory_keeps_event_loop_responsive(monkeypatch, tmp_path):
    import threading
    import time

    package_dir = tmp_path / "python-packages"
    monkeypatch.setenv("WORKSTEP_ENGINE_PACKAGE_DIR", str(package_dir))
    main_thread = threading.get_ident()
    worker_threads = []
    original_makedirs = engine_base.os.makedirs

    def slow_makedirs(*args, **kwargs):
        worker_threads.append(threading.get_ident())
        time.sleep(0.2)
        return original_makedirs(*args, **kwargs)

    async def fake_run(cmd, *, timeout=600):
        return 0, "installed"

    monkeypatch.setattr(engine_base.os, "makedirs", slow_makedirs)
    monkeypatch.setattr(engine_base, "_has_pip", lambda: False)
    monkeypatch.setattr(engine_base.shutil, "which", lambda _name: "/usr/bin/uv")
    monkeypatch.setattr(engine_base, "run_install_command", fake_run)

    started = asyncio.get_running_loop().time()
    task = asyncio.create_task(engine_base.install_python_package("openai-codex"))
    await asyncio.sleep(0.02)
    assert asyncio.get_running_loop().time() - started < 0.1
    assert (await task).success
    assert worker_threads and all(thread != main_thread for thread in worker_threads)


def test_python_sdk_install_targets_desktop_user_runtime(monkeypatch, tmp_path):
    captured = []

    async def fake_run(cmd, *, timeout=600):
        captured.append(cmd)
        return 0, "installed"

    package_dir = tmp_path / "python-packages"
    monkeypatch.setenv("WORKSTEP_ENGINE_PACKAGE_DIR", str(package_dir))
    monkeypatch.setattr(engine_base, "_has_pip", lambda: True)
    monkeypatch.setattr(engine_base, "run_install_command", fake_run)

    result = asyncio.run(engine_base.install_python_package("openai-codex"))

    assert captured == [[
        sys.executable, "-m", "pip", "install", "--target", str(package_dir),
        "openai-codex",
    ]]
    assert result.success is True


def test_python_sdk_install_targets_user_runtime_without_pip(monkeypatch, tmp_path):
    captured = []

    async def fake_run(cmd, *, timeout=600):
        captured.append(cmd)
        return 0, "installed"

    package_dir = tmp_path / "python-packages"
    monkeypatch.setenv("WORKSTEP_ENGINE_PACKAGE_DIR", str(package_dir))
    monkeypatch.setattr(engine_base, "_has_pip", lambda: False)
    monkeypatch.setattr(engine_base.shutil, "which", lambda name: "/usr/bin/uv" if name == "uv" else None)
    monkeypatch.setattr(engine_base, "run_install_command", fake_run)

    result = asyncio.run(engine_base.install_python_package("openai-codex", upgrade=True))

    assert captured == [[
        "uv", "pip", "install", "--upgrade", "--target", str(package_dir),
        "openai-codex",
    ]]
    assert result.success is True


def test_claude_code_install_command():
    assert (
        ClaudeCodeEngine.install_command()
        == "npm install -g @anthropic-ai/claude-code"
    )


def test_get_available_engines():
    """get_available_engines returns list with install status."""
    engines = get_available_engines()
    assert len(engines) >= 1
    claude_entry = next(e for e in engines if e["id"] == "claude")
    assert "installed" in claude_entry
    assert isinstance(claude_entry["installed"], bool)
    assert "installable" in claude_entry
    assert "install_command" in claude_entry


def test_registry_marks_python_sdk_engines_as_updatable():
    engines = {item["id"]: item for item in get_available_engines()}

    for engine_id in (
        "codex_sdk",
        "claude_agent_sdk",
        "qoder_sdk",
        "deepseek_harness",
    ):
        assert engines[engine_id]["updatable"] is True
        assert "pip install --upgrade" in engines[engine_id]["update_command"]
    assert engines["pydantic_ai"]["updatable"] is False


def test_claude_resolve_binary():
    """resolve_binary returns a path or None."""
    binary = ClaudeCodeEngine.resolve_binary()
    # May be None if claude not installed — that's OK
    assert binary is None or isinstance(binary, str)


def test_claude_supports_resume():
    """ClaudeCodeEngine supports resume."""
    engine = ClaudeCodeEngine()
    assert engine.supports_resume is True


def test_claude_supports_live_step_messages():
    """Direct CLI mode supports mid-execution live stage messages."""
    engine = ClaudeCodeEngine()
    assert engine.supports_interactive is True
    assert engine.supports_live_step_message is True
    assert engine.capabilities.supports_live_step_message is True


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
        "--include-partial-messages",
        "--verbose",
        "--permission-mode", "acceptEdits",
        "--model", "sonnet",
        "--resume", "session-1",
        "--add-dir", "/tmp/shared",
    ]


def test_claude_maps_partial_stream_and_all_completed_blocks_without_duplicates():
    engine = ClaudeCodeEngine()
    state = {"streamed_text": False, "streamed_thinking": False}

    partial = engine._map_events({
        "type": "stream_event",
        "event": {
            "type": "content_block_delta",
            "delta": {"type": "text_delta", "text": "增量"},
        },
    }, state)
    completed = engine._map_events({
        "type": "assistant",
        "message": {"content": [
            {"type": "text", "text": "增量"},
            {"type": "thinking", "thinking": "完整思考"},
            {"type": "tool_use", "id": "tool-1", "name": "Read", "input": {}},
        ]},
    }, state)

    assert [(event.type, (event.data.get("content") or {}).get("text")) for event in partial] == [
        ("agent_message_chunk", "增量")
    ]
    assert [event.type for event in completed] == ["agent_thought_chunk", "tool_call"]


def test_claude_maps_all_completed_blocks_when_partial_stream_is_absent():
    events = ClaudeCodeEngine()._map_events({
        "type": "assistant",
        "message": {"content": [
            {"type": "text", "text": "A"},
            {"type": "text", "text": "B"},
        ]},
    })

    assert [event.data["content"]["text"] for event in events] == ["A", "B"]


def test_claude_result_error_is_not_reported_as_successful_usage_only():
    events = ClaudeCodeEngine()._map_events({
        "type": "result",
        "subtype": "error_during_execution",
        "is_error": True,
        "result": "权限失败",
        "usage": {"input_tokens": 1, "output_tokens": 0},
    })

    assert events[0].type == "error"
    assert "权限失败" in events[0].data["message"]


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
    assert event.type == "agent_message_chunk"
    assert event.data["content"]["text"] == "Hello world"


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
    assert event.type == "tool_call"
    assert event.data["title"] == "Read"
    assert event.data["tool_call_id"] == "tool_123"


def test_claude_maps_ask_user_question_to_form_elicitation():
    engine = ClaudeCodeEngine()
    event = engine._map_event({
        "type": "assistant",
        "message": {"content": [{
            "type": "tool_use",
            "id": "ask-1",
            "name": "AskUserQuestion",
            "input": {
                "questions": [{
                    "header": "方案",
                    "question": "选择方案",
                    "multiSelect": False,
                    "options": [{"label": "A", "description": "方案 A"}],
                }],
            },
        }]},
    })

    assert event is not None
    assert event.type == "interaction_request"
    assert event.data["method"] == "elicitation/create"
    assert event.data["tool_call_id"] == "ask-1"


def test_codex_map_reasoning_item():
    from engines.codex import CodexEngine

    event = CodexEngine()._map_event({
        "type": "item.completed",
        "item": {"type": "reasoning", "text": "分析任务"},
    })

    assert event is not None
    assert event.type == "agent_thought_chunk"
    assert event.data["content"]["text"] == "分析任务"


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
    assert event.type == "usage_update"
    assert event.data["input_tokens"] == 100
    assert event.data["session_id"] == "sess_abc"
    assert event.data["used"] == 150


def test_claude_map_event_usage_with_cache():
    """Claude result usage normalizes cached input into the input total."""
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
    assert event.type == "usage_update"
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
    assert event.type == "usage_update"
    assert event.data == {
        "input_tokens": 300,
        "output_tokens": 50,
        "cache_creation_input_tokens": 150,
        "cache_read_input_tokens": 120,
        "cache_input_included": False,
        "total_tokens": 620,
        "used": 620,
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
    assert event.type == "usage_update"
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
    assert event.type == "usage_update"
    assert event.data["cost"] == {"amount": 0.456, "currency": "USD"}


def test_claude_map_event_unknown_returns_none():
    """Unknown event types return None (skipped)."""
    engine = ClaudeCodeEngine()
    assert engine._map_event({"type": "unknown"}) is None
    assert engine._map_event({"type": "ping"}) is None
