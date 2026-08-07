"""Tests for P2 engines: Codex, Hermes, SDK engines, registry strategy."""

import asyncio

import pytest
from engines.codex import CodexEngine
from engines.hermes import HermesEngine
from engines.claude_agent_sdk import ClaudeAgentSDKEngine
from engines.qoder_sdk import QoderSDKEngine
from engines.codex_sdk import CodexSDKEngine
from engines.claude_code import ClaudeCodeEngine
from engines.api import APIEngine
from engines.pydantic_ai import PydanticAIEngine
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


def test_codex_resume_and_capabilities():
    engine = CodexEngine()
    assert engine.supports_resume is True
    assert engine.supports_interactive is False
    # codex exec 无注入协议，但插入消息以「终止进程 + 新消息 resume」方式支持
    assert engine.supports_live_stage_message is True
    assert engine.build_resume_params("019f-abc") == {"session_id": "019f-abc"}


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


def test_codex_map_agent_message_text_field():
    """Real codex JSONL carries agent text in the item's text field."""
    engine = CodexEngine()
    event = engine._map_event({
        "type": "item.completed",
        "item": {"type": "agent_message", "text": "你好！我是 Codex"},
    })
    assert event is not None
    assert event.type == "text_delta"
    assert event.data["delta"] == "你好！我是 Codex"


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
    """Real codex usage uses cached_input_tokens / cache_write_input_tokens."""
    engine = CodexEngine()
    event = engine._map_event({
        "type": "turn.completed",
        "usage": {
            "input_tokens": 300,
            "output_tokens": 100,
            "cached_input_tokens": 120,
            "cache_write_input_tokens": 150,
            "reasoning_output_tokens": 41,
        },
    })
    assert event is not None
    assert event.type == "usage"
    assert event.data["input_tokens"] == 300
    assert event.data["output_tokens"] == 100
    assert event.data["cache_creation_input_tokens"] == 150
    assert event.data["cache_read_input_tokens"] == 120
    assert event.data["thought_tokens"] == 41


def test_codex_map_turn_completed_with_cost():
    """Codex turn usage carries billing info (订单金额) when provided."""
    engine = CodexEngine()
    event = engine._map_event({
        "type": "turn.completed",
        "usage": {
            "input_tokens": 200,
            "output_tokens": 100,
            "cost_usd": 0.0123,
        },
    })
    assert event is not None
    assert event.type == "usage"
    assert event.data["cost"] == {"amount": 0.0123, "currency": "USD"}


def test_codex_map_error():
    engine = CodexEngine()
    event = engine._map_event({"type": "error", "message": "something broke"})
    assert event is not None
    assert event.type == "error"


def test_codex_sandbox_default():
    sandbox = CodexEngine._default_sandbox()
    assert sandbox in ("workspace-write", "danger-full-access")


class _FakeStdin:
    def __init__(self):
        self.written = b""

    def write(self, data):
        self.written += data

    async def drain(self):
        return None

    def close(self):
        return None


class _FakeCodexProcess:
    def __init__(self, stdout: bytes, stderr: bytes, returncode: int = 0):
        self.stdin = _FakeStdin()
        self.stdout = asyncio.StreamReader()
        self.stdout.feed_data(stdout)
        self.stdout.feed_eof()
        self.stderr = asyncio.StreamReader()
        self.stderr.feed_data(stderr)
        self.stderr.feed_eof()
        self.returncode = returncode

    async def wait(self) -> int:
        return self.returncode


@pytest.mark.anyio
async def test_codex_spawn_emits_session_started_with_thread_id(monkeypatch):
    """codex JSONL 的 thread.started 携带 thread_id，须产出 session_started。"""
    stdout = (
        b'{"type":"thread.started","thread_id":"019f-codex-test-1"}\n'
        b'{"type":"turn.started"}\n'
        b'{"type":"item.completed","item":{"type":"agent_message",'
        b'"message":"WORKSTEP_ENGINE_OK"}}\n'
    )
    process = _FakeCodexProcess(stdout=stdout, stderr=b"")

    async def fake_create_subprocess_exec(*args, **kwargs):
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(CodexEngine, "resolve_binary", staticmethod(lambda: "/fake/codex"))

    events = [
        event
        async for event in CodexEngine().spawn(prompt="hello", cwd="/tmp")
    ]

    sessions = [event for event in events if event.type == "session_started"]
    assert len(sessions) == 1
    assert sessions[0].data["session_id"] == "019f-codex-test-1"


@pytest.mark.anyio
async def test_codex_spawn_resume_builds_resume_command(monkeypatch):
    """带 session_id 时走 `codex exec resume <id> <prompt>`，不再带沙箱/工作目录参数。"""
    captured = {}

    async def fake_create_subprocess_exec(program, *args, **kwargs):
        captured["cmd"] = [program, *args]
        return _FakeCodexProcess(stdout=b"", stderr=b"")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(CodexEngine, "resolve_binary", staticmethod(lambda: "/fake/codex"))

    events = [
        event
        async for event in CodexEngine().spawn(
            prompt="继续上次的任务", cwd="/tmp", session_id="019f-resume-1"
        )
    ]

    cmd = captured["cmd"]
    assert cmd[:4] == ["/fake/codex", "exec", "--json", "--skip-git-repo-check"]
    i = cmd.index("resume")
    assert cmd[i + 1] == "019f-resume-1"
    assert cmd[i + 2] == "继续上次的任务"
    assert "--sandbox" not in cmd
    assert "-C" not in cmd


@pytest.mark.anyio
async def test_codex_spawn_reports_stderr_when_silent_exit_zero(monkeypatch):
    """codex exits 0 with empty stdout: stderr diagnostics must surface."""
    process = _FakeCodexProcess(
        stdout=b"",
        stderr=b"Error: failed to initialize app-server client\n",
    )

    async def fake_create_subprocess_exec(*args, **kwargs):
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(CodexEngine, "resolve_binary", staticmethod(lambda: "/fake/codex"))

    events = [
        event
        async for event in CodexEngine().spawn(prompt="hello", cwd="/tmp")
    ]

    errors = [event for event in events if event.type == "error"]
    assert len(errors) == 1
    assert errors[0].data["message"] == "codex 未产生任何输出"
    assert "failed to initialize" in errors[0].data["stderr"]


@pytest.mark.anyio
async def test_codex_spawn_ignores_stderr_when_output_present(monkeypatch):
    """Benign stderr warnings must not shadow real text output."""
    stdout = (
        b'{"type":"item.completed","item":{"type":"agent_message",'
        b'"message":"WORKSTEP_ENGINE_OK"}}\n'
    )
    process = _FakeCodexProcess(stdout=stdout, stderr=b"WARN benign\n")

    async def fake_create_subprocess_exec(*args, **kwargs):
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(CodexEngine, "resolve_binary", staticmethod(lambda: "/fake/codex"))

    events = [
        event
        async for event in CodexEngine().spawn(prompt="hello", cwd="/tmp")
    ]

    assert [event.type for event in events] == ["status", "text_delta", "status"]
    assert events[1].data["delta"] == "WORKSTEP_ENGINE_OK"


@pytest.mark.anyio
async def test_codex_spawn_applies_configured_sandbox_effort_policy(monkeypatch):
    captured = {}

    async def fake_create_subprocess_exec(program, *args, **kwargs):
        captured["cmd"] = [program, *args]
        return _FakeCodexProcess(stdout=b"", stderr=b"")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(CodexEngine, "resolve_binary", staticmethod(lambda: "/fake/codex"))
    monkeypatch.setattr(
        "engines.codex.config_store.get_codex_config",
        lambda: {
            "sandbox_mode": "danger-full-access",
            "model_reasoning_effort": "high",
            "approval_policy": "never",
        },
    )

    events = [
        event
        async for event in CodexEngine().spawn(prompt="hello", cwd="/tmp")
    ]

    cmd = captured["cmd"]
    assert cmd[cmd.index("--sandbox") + 1] == "danger-full-access"
    assert "-c" in cmd
    assert "model_reasoning_effort=high" in cmd
    assert "approval_policy=never" in cmd


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


def test_hermes_map_usage_update_with_cost():
    """Hermes usage_update carries ACP-style cost when provided."""
    engine = HermesEngine()
    event = engine._map_update({
        "type": "usage_update",
        "input_tokens": 300,
        "output_tokens": 100,
        "cost": {"amount": 1.5, "currency": "CNY"},
    })
    assert event is not None
    assert event.type == "usage"
    assert event.data["cost"] == {"amount": 1.5, "currency": "CNY"}


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


@pytest.mark.anyio
async def test_acp_client_ask_mode_parks_permission_until_approved():
    from types import SimpleNamespace
    from engines.acp_base import _StreamingClient

    client = _StreamingClient(permission_mode="ask")
    options = [
        SimpleNamespace(kind="allow_once", option_id="allow-once"),
        SimpleNamespace(kind="reject_once", option_id="reject-once"),
    ]
    tool_call = SimpleNamespace(
        tool_call_id="tool-1",
        title="Bash",
        kind="execute",
        raw_input={"command": "ls"},
    )

    request_task = asyncio.create_task(
        client.request_permission("session-1", tool_call, options)
    )
    await asyncio.sleep(0)

    assert client.pending_permissions == [
        {
            "tool_call_id": "tool-1",
            "name": "Bash",
            "kind": "execute",
            "input": {"command": "ls"},
        }
    ]
    assert client.resolve_approval("tool-1", True) is True

    response = await request_task
    assert response.outcome.outcome == "selected"
    assert response.outcome.option_id == "allow-once"
    assert client.pending_permissions == []


@pytest.mark.anyio
async def test_acp_client_ask_mode_rejects_when_denied():
    from types import SimpleNamespace
    from engines.acp_base import _StreamingClient

    client = _StreamingClient(permission_mode="ask")
    options = [SimpleNamespace(kind="allow_once", option_id="allow-once")]
    tool_call = SimpleNamespace(
        tool_call_id="tool-2",
        title="Bash",
        kind="execute",
        raw_input={},
    )

    request_task = asyncio.create_task(
        client.request_permission("session-1", tool_call, options)
    )
    await asyncio.sleep(0)

    assert client.resolve_approval("tool-2", False) is True
    response = await request_task
    assert response.outcome.outcome == "cancelled"
    assert client.pending_permissions == []


def test_acp_client_resolve_approval_unknown_id_returns_false():
    from engines.acp_base import _StreamingClient

    client = _StreamingClient(permission_mode="ask")
    assert client.resolve_approval("missing-tool", True) is False


# --- ClaudeAgentSDKEngine ---

class _SdkFake:
    """Duck-typed stand-in for claude-agent-sdk message/block objects."""

    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


def test_claude_agent_sdk_engine_id():
    assert ClaudeAgentSDKEngine.ENGINE_ID == "claude_agent_sdk"


def test_claude_agent_sdk_resolve_binary():
    binary = ClaudeAgentSDKEngine.resolve_binary()
    assert binary is None or isinstance(binary, str)


def test_claude_agent_sdk_resolve_bundled_cli(monkeypatch, tmp_path):
    """The SDK wheel bundles claude, so no separate CLI install is needed."""
    bundled = tmp_path / "_bundled"
    bundled.mkdir()
    (bundled / "claude").write_bytes(b"")
    import claude_agent_sdk as sdk_module

    monkeypatch.setattr(sdk_module, "__file__", str(tmp_path / "claude_agent_sdk.py"))
    resolved = ClaudeAgentSDKEngine.resolve_binary()
    assert resolved == str(bundled / "claude")
    assert ClaudeAgentSDKEngine.is_installed() is True


def test_claude_agent_sdk_not_installed_without_sdk(monkeypatch):
    monkeypatch.setattr(
        ClaudeAgentSDKEngine, "_sdk_available", staticmethod(lambda: False)
    )
    assert ClaudeAgentSDKEngine.is_installed() is False


def test_claude_agent_sdk_is_reported_as_sdk_mode(monkeypatch):
    """The SDK-backed engine is not a plain CLI mode."""
    from engines.registry import get_available_engines, refresh_registry

    monkeypatch.setattr(
        ClaudeAgentSDKEngine, "is_installed", staticmethod(lambda: True)
    )
    refresh_registry()
    try:
        engines = {item["id"]: item for item in get_available_engines()}
    finally:
        refresh_registry()
    assert engines["claude_agent_sdk"]["installed"] is True
    assert engines["claude_agent_sdk"]["mode"] == "sdk"


def test_claude_agent_sdk_not_resume():
    engine = ClaudeAgentSDKEngine()
    assert engine.supports_resume is False
    assert engine.supports_interactive is True
    assert engine.supports_live_stage_message is True


def test_claude_agent_sdk_maps_system_init():
    engine = ClaudeAgentSDKEngine()
    msg = _SdkFake(type="system", subtype="init")
    events = engine._map_message(msg)
    assert [event.type for event in events] == ["status"]
    assert events[0].data["status"] == "initializing"


def test_claude_agent_sdk_maps_assistant_text():
    engine = ClaudeAgentSDKEngine()
    block = _SdkFake(type="text", text="你好，Claude！")
    message = _SdkFake(content=[block])
    msg = _SdkFake(type="assistant", message=message)
    events = engine._map_message(msg)
    assert [event.type for event in events] == ["text_delta"]
    assert events[0].data["delta"] == "你好，Claude！"


def test_claude_agent_sdk_maps_thinking_and_tool_use():
    engine = ClaudeAgentSDKEngine()
    message = _SdkFake(content=[
        _SdkFake(type="thinking", thinking="让我想想"),
        _SdkFake(type="tool_use", id="tool-1", name="Read", input={"path": "a.py"}),
    ])
    msg = _SdkFake(type="assistant", message=message)
    events = engine._map_message(msg)
    assert [event.type for event in events] == ["thinking_delta", "tool_use"]
    assert events[0].data["delta"] == "让我想想"
    assert events[1].data["id"] == "tool-1"
    assert events[1].data["name"] == "Read"
    assert events[1].data["input"] == {"path": "a.py"}


def test_claude_agent_sdk_maps_tool_result():
    engine = ClaudeAgentSDKEngine()
    message = _SdkFake(content=[
        _SdkFake(type="tool_result", tool_use_id="tool-1", content="file content", is_error=False),
    ])
    msg = _SdkFake(type="user", message=message)
    events = engine._map_message(msg)
    assert [event.type for event in events] == ["tool_result"]
    assert events[0].data["tool_use_id"] == "tool-1"
    assert events[0].data["content"] == "file content"
    assert events[0].data["is_error"] is False


def test_claude_agent_sdk_maps_result_usage_with_cache_and_cost():
    engine = ClaudeAgentSDKEngine()
    result = _SdkFake(
        is_error=False,
        output="",
        subtype="success",
        usage={
            "input_tokens": 100,
            "cache_creation_input_tokens": 40,
            "cache_read_input_tokens": 20,
            "output_tokens": 30,
        },
        total_cost_usd=0.12,
    )
    msg = _SdkFake(type="result", result=result)
    events = engine._map_message(msg, state={"emitted_text": False})
    assert [event.type for event in events] == ["usage", "status"]
    usage = events[0].data
    assert usage["input_tokens"] == 100
    assert usage["output_tokens"] == 30
    assert usage["cache_creation_input_tokens"] == 40
    assert usage["cache_read_input_tokens"] == 20
    assert usage["cost"] == {"amount": 0.12, "currency": "USD"}
    assert events[1].data["status"] == "done"


def test_claude_agent_sdk_result_falls_back_to_output():
    """Result output is emitted as text when no text blocks were streamed."""
    engine = ClaudeAgentSDKEngine()
    result = _SdkFake(is_error=False, output="最终答案", subtype="success", usage=None)
    msg = _SdkFake(type="result", result=result)
    events = engine._map_message(msg, state={"emitted_text": False})
    assert [event.type for event in events] == ["text_delta", "status"]
    assert events[0].data["delta"] == "最终答案"


def test_claude_agent_sdk_result_error():
    engine = ClaudeAgentSDKEngine()
    result = _SdkFake(is_error=True, output="", subtype="error_during_execution", usage=None)
    msg = _SdkFake(type="result", result=result)
    events = engine._map_message(msg, state={"emitted_text": False})
    assert [event.type for event in events] == ["error"]
    assert "error_during_execution" in events[0].data["message"]


def test_claude_agent_sdk_maps_compact():
    engine = ClaudeAgentSDKEngine()
    msg = _SdkFake(type="system", subtype="compacted", data={"summary": "旧对话已摘要"})
    events = engine._map_message(msg)
    assert [event.type for event in events] == ["compacted"]
    assert events[0].data == {"summary": "旧对话已摘要"}


def test_claude_agent_sdk_maps_compact_without_summary():
    engine = ClaudeAgentSDKEngine()
    msg = _SdkFake(type="system", subtype="compact_boundary", data={})
    events = engine._map_message(msg)
    assert [event.type for event in events] == ["compacted"]
    assert events[0].data == {}


def test_claude_agent_sdk_maps_modern_typed_messages():
    """Current SDK versions drop the ``type`` field; mapping falls back to class names."""
    from claude_agent_sdk.types import (
        AssistantMessage,
        ResultMessage,
        SystemMessage,
        TextBlock,
        ThinkingBlock,
        ToolResultBlock,
        ToolUseBlock,
        UserMessage,
    )

    engine = ClaudeAgentSDKEngine()

    events = engine._map_message(SystemMessage(subtype="init", data={}))
    assert [event.type for event in events] == ["status"]
    assert events[0].data["status"] == "initializing"

    assistant = AssistantMessage(
        content=[
            ThinkingBlock(thinking="让我想想", signature="s"),
            TextBlock(text="你好"),
            ToolUseBlock(id="tool-1", name="Read", input={"path": "a.py"}),
        ],
        model="sonnet",
    )
    events = engine._map_message(assistant)
    assert [event.type for event in events] == [
        "thinking_delta",
        "text_delta",
        "tool_use",
    ]
    assert events[2].data == {
        "id": "tool-1",
        "name": "Read",
        "input": {"path": "a.py"},
    }

    user = UserMessage(
        content=[
            ToolResultBlock(
                tool_use_id="tool-1", content="file content", is_error=False
            )
        ],
        uuid="u",
        parent_tool_use_id=None,
        tool_use_result=None,
    )
    events = engine._map_message(user)
    assert [event.type for event in events] == ["tool_result"]
    assert events[0].data == {
        "tool_use_id": "tool-1",
        "content": "file content",
        "is_error": False,
    }

    result = ResultMessage(
        subtype="success",
        duration_ms=100,
        duration_api_ms=120,
        is_error=False,
        num_turns=1,
        session_id="s1",
        total_cost_usd=0.12,
        usage={
            "input_tokens": 100,
            "cache_creation_input_tokens": 40,
            "cache_read_input_tokens": 20,
            "output_tokens": 30,
        },
        result="最终答案",
    )
    events = engine._map_message(result, state={"emitted_text": False})
    assert [event.type for event in events] == ["text_delta", "usage", "status"]
    assert events[0].data["delta"] == "最终答案"
    usage = events[1].data
    assert usage["input_tokens"] == 100
    assert usage["output_tokens"] == 30
    assert usage["cache_creation_input_tokens"] == 40
    assert usage["cache_read_input_tokens"] == 20
    assert usage["cost"] == {"amount": 0.12, "currency": "USD"}
    assert usage["session_id"] == "s1"


@pytest.mark.anyio
async def test_claude_agent_sdk_spawn_uses_modern_query_api(monkeypatch):
    """The adapter drives the current SDK query() API with ClaudeAgentOptions."""
    import claude_agent_sdk as sdk_module

    captured = {}

    async def fake_query(*, prompt, options=None, transport=None):
        captured["prompt"] = prompt
        captured["options"] = options
        if False:
            yield None

    monkeypatch.setattr(sdk_module, "query", fake_query)
    monkeypatch.setattr(
        ClaudeAgentSDKEngine, "resolve_binary", staticmethod(lambda: "/fake/claude")
    )
    monkeypatch.setattr(
        "engines.claude_agent_sdk.config_store.get_claude_agent_sdk_config",
        lambda: {
            "permission_mode": "acceptEdits",
            "max_turns": "25",
            "fallback_model": "claude-haiku-latest",
            "max_budget_usd": "0.75",
        },
    )

    engine = ClaudeAgentSDKEngine()
    events = [
        event
        async for event in engine.spawn(
            prompt="hi", cwd="/tmp", model="sonnet", add_dirs=["/repo/src"]
        )
    ]
    assert [event.type for event in events] == ["status"]
    options = captured["options"]
    assert options.cli_path == "/fake/claude"
    assert options.cwd == "/tmp"
    assert options.model == "sonnet"
    assert options.permission_mode == "acceptEdits"
    assert options.max_turns == 25
    assert options.fallback_model == "claude-haiku-latest"
    assert options.max_budget_usd == 0.75
    assert options.add_dirs == ["/repo/src"]


def test_codex_sdk_engine_id():
    assert CodexSDKEngine.ENGINE_ID == "codex_sdk"


def test_codex_sdk_version_or_none():
    version = CodexSDKEngine.get_version()
    assert version is None or isinstance(version, str)


def test_codex_sdk_not_installed_without_sdk(monkeypatch):
    monkeypatch.setattr(
        CodexSDKEngine, "_sdk_available", staticmethod(lambda: False)
    )
    assert CodexSDKEngine.is_installed() is False


def test_codex_sdk_is_reported_as_sdk_mode(monkeypatch):
    """The SDK-backed engine is not a plain CLI mode."""
    from engines.registry import get_available_engines, refresh_registry

    monkeypatch.setattr(
        CodexSDKEngine, "is_installed", staticmethod(lambda: True)
    )
    refresh_registry()
    try:
        engines = {item["id"]: item for item in get_available_engines()}
    finally:
        refresh_registry()
    assert engines["codex_sdk"]["installed"] is True
    assert engines["codex_sdk"]["mode"] == "sdk"


def test_codex_sdk_resume_capability():
    engine = CodexSDKEngine()
    assert engine.supports_resume is True
    assert engine.supports_interactive is True
    assert engine.supports_live_stage_message is True
    assert engine.build_resume_params("thread-1") == {"session_id": "thread-1"}


def test_codex_sdk_maps_compacted_notification():
    engine = CodexSDKEngine()
    notification = _SdkFake(method="thread/compacted", payload=_SdkFake())
    events = engine._map_notification(
        notification, {"emitted_text": False, "tool_emitted": set()}
    )
    assert [event.type for event in events] == ["compacted"]
    assert events[0].data == {}


def test_codex_sdk_maps_started_and_text_delta():
    engine = CodexSDKEngine()
    notification = _SdkFake(
        method="item/agentMessage/delta",
        payload=_SdkFake(delta="你好，Codex！"),
    )
    state = {"emitted_text": False, "tool_emitted": set()}
    events = engine._map_notification(notification, state)
    assert [event.type for event in events] == ["text_delta"]
    assert events[0].data["delta"] == "你好，Codex！"
    assert state["emitted_text"] is True


def test_codex_sdk_maps_reasoning_deltas():
    engine = CodexSDKEngine()
    state = {"emitted_text": False, "tool_emitted": set()}
    events = engine._map_notification(
        _SdkFake(
            method="item/reasoning/textDelta",
            payload=_SdkFake(delta="正在推理"),
        ),
        state,
    )
    assert [event.type for event in events] == ["thinking_delta"]
    assert events[0].data["delta"] == "正在推理"


def test_codex_sdk_maps_tool_use_and_result():
    engine = CodexSDKEngine()
    state = {"emitted_text": False, "tool_emitted": set()}
    started = engine._map_notification(
        _SdkFake(
            method="item/started",
            payload=_SdkFake(item=_SdkFake(root=_SdkFake(
                type="dynamicToolCall",
                id="tool-1",
                tool="Read",
                arguments={"path": "a.py"},
            ))),
        ),
        state,
    )
    assert [event.type for event in started] == ["tool_use"]
    assert started[0].data["id"] == "tool-1"
    assert started[0].data["name"] == "Read"
    assert started[0].data["input"] == {"path": "a.py"}
    assert "tool-1" in state["tool_emitted"]

    completed = engine._map_notification(
        _SdkFake(
            method="item/completed",
            payload=_SdkFake(item=_SdkFake(root=_SdkFake(
                type="dynamicToolCall",
                id="tool-1",
                tool="Read",
                status=_SdkFake(value="completed"),
                success=True,
                content_items=[_SdkFake(root=_SdkFake(text="file content"))],
            ))),
        ),
        state,
    )
    assert [event.type for event in completed] == ["tool_result"]
    assert completed[0].data["tool_use_id"] == "tool-1"
    assert completed[0].data["content"] == "file content"
    assert completed[0].data["is_error"] is False


def test_codex_sdk_completed_text_falls_back_only_when_no_delta():
    engine = CodexSDKEngine()
    state = {"emitted_text": False, "tool_emitted": set()}
    events = engine._map_notification(
        _SdkFake(
            method="item/completed",
            payload=_SdkFake(item=_SdkFake(root=_SdkFake(
                type="agentMessage",
                text="最终答案",
            ))),
        ),
        state,
    )
    assert [event.type for event in events] == ["text_delta"]
    assert events[0].data["delta"] == "最终答案"

    # Deltas already emitted → completed text must not duplicate.
    state["emitted_text"] = True
    events = engine._map_notification(
        _SdkFake(
            method="item/completed",
            payload=_SdkFake(item=_SdkFake(root=_SdkFake(
                type="agentMessage",
                text="最终答案",
            ))),
        ),
        state,
    )
    assert events == []


def test_codex_sdk_maps_usage_with_cache():
    engine = CodexSDKEngine()
    notification = _SdkFake(
        method="thread/tokenUsage/updated",
        payload=_SdkFake(token_usage=_SdkFake(
            last=_SdkFake(
                input_tokens=100,
                output_tokens=30,
                cached_input_tokens=20,
                reasoning_output_tokens=5,
                total_tokens=150,
            ),
            total=None,
        )),
    )
    events = engine._map_notification(
        notification, {"emitted_text": False, "tool_emitted": set()}
    )
    assert [event.type for event in events] == ["usage"]
    usage = events[0].data
    assert usage["input_tokens"] == 100
    assert usage["output_tokens"] == 30
    assert usage["cache_read_input_tokens"] == 20
    assert usage["reasoning_output_tokens"] == 5
    assert usage["total_tokens"] == 150


def test_codex_sdk_turn_completed_error():
    engine = CodexSDKEngine()
    events = engine._map_notification(
        _SdkFake(
            method="turn/completed",
            payload=_SdkFake(turn=_SdkFake(
                status=_SdkFake(value="failed"),
                error=_SdkFake(message="boom"),
            )),
        ),
        {"emitted_text": False, "tool_emitted": set()},
    )
    assert [event.type for event in events] == ["error"]
    assert events[0].data["message"] == "boom"


def test_codex_sdk_turn_completed_done():
    engine = CodexSDKEngine()
    events = engine._map_notification(
        _SdkFake(
            method="turn/completed",
            payload=_SdkFake(turn=_SdkFake(
                status=_SdkFake(value="completed"),
                error=None,
            )),
        ),
        {"emitted_text": False, "tool_emitted": set()},
    )
    assert [event.type for event in events] == ["status"]
    assert events[0].data["status"] == "done"


def test_codex_sdk_spawn_error_without_sdk(monkeypatch):
    monkeypatch.setattr(
        CodexSDKEngine, "_sdk_available", staticmethod(lambda: False)
    )
    engine = CodexSDKEngine()

    async def run():
        return [event async for event in engine.spawn(prompt="hi", cwd=".")]

    events = asyncio.run(run())
    assert [event.type for event in events] == ["error"]


@pytest.mark.anyio
async def test_codex_sdk_spawn_omits_approval_mode_when_unset(monkeypatch):
    """thread_start 不接受 approval_mode=None；未配置时不传该参数（用 SDK 默认）。"""
    import openai_codex as codex_module

    captured = {}

    class FakeTurn:
        async def stream(self):
            if False:
                yield None

    class FakeThread:
        id = "thread-1"

        async def turn(self, prompt, model=None):
            captured["prompt"] = prompt
            return FakeTurn()

    class FakeClient:
        def __init__(self, **kwargs):
            captured["client_kwargs"] = kwargs

        async def thread_start(self, **kwargs):
            captured["start_kwargs"] = kwargs
            return FakeThread()

        async def close(self):
            return None

    monkeypatch.setattr(codex_module, "AsyncCodex", FakeClient)
    monkeypatch.setattr(
        "engines.codex_sdk.config_store.get_codex_sdk_config",
        lambda: {
            "model_reasoning_effort": "",
            "approval_mode": "",
            "sandbox": "workspace-write",
        },
    )

    engine = CodexSDKEngine()
    events = [
        event async for event in engine.spawn(prompt="hi", cwd="/tmp")
    ]

    assert "approval_mode" not in captured["start_kwargs"]
    assert captured["start_kwargs"]["sandbox"].value == "workspace-write"
    assert captured["start_kwargs"]["config"] is None
    assert [event.type for event in events] == [
        "status",
        "session_started",
        "status",
    ]


@pytest.mark.anyio
async def test_codex_sdk_spawn_passes_configured_approval_mode(monkeypatch):
    """配置了 approval_mode 时以 SDK 枚举传入 thread_start。"""
    import openai_codex as codex_module
    from openai_codex import ApprovalMode

    captured = {}

    class FakeTurn:
        async def stream(self):
            if False:
                yield None

    class FakeThread:
        id = "thread-1"

        async def turn(self, prompt, model=None):
            return FakeTurn()

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def thread_start(self, **kwargs):
            captured["start_kwargs"] = kwargs
            return FakeThread()

        async def close(self):
            return None

    monkeypatch.setattr(codex_module, "AsyncCodex", FakeClient)
    monkeypatch.setattr(
        "engines.codex_sdk.config_store.get_codex_sdk_config",
        lambda: {
            "model_reasoning_effort": "high",
            "approval_mode": "deny_all",
            "sandbox": "read-only",
        },
    )

    engine = CodexSDKEngine()
    events = [
        event async for event in engine.spawn(prompt="hi", cwd="/tmp")
    ]

    assert captured["start_kwargs"]["approval_mode"] is ApprovalMode.deny_all
    assert captured["start_kwargs"]["sandbox"].value == "read-only"
    assert captured["start_kwargs"]["config"] == {
        "model_reasoning_effort": "high"
    }
    assert [event.type for event in events] == [
        "status",
        "session_started",
        "status",
    ]


def test_codex_sdk_registered_in_registry():
    assert "codex_sdk" in _ALL_ENGINES
    assert CodexSDKEngine in _ALL_ENGINES.values()


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


# --- Engine config schema (backend-driven settings forms) ---

def test_engine_config_schemas_are_declared():
    api_fields = {field.key: field for field in APIEngine.config_schema()}
    assert set(api_fields) == {"provider", "base_url", "api_key"}
    assert api_fields["provider"].type == "select"
    assert [option.value for option in api_fields["provider"].options] == [
        "openai",
        "anthropic",
    ]
    assert api_fields["api_key"].sensitive is True
    assert api_fields["base_url"].required is True

    pydantic_fields = {
        field.key for field in PydanticAIEngine.config_schema()
    }
    assert pydantic_fields == {"provider", "base_url", "api_key"}

    claude_fields = {field.key: field for field in ClaudeCodeEngine.config_schema()}
    assert set(claude_fields) == {"permission_mode"}
    assert "bypassPermissions" in claude_fields["permission_mode"].confirm_values

    codex_fields = {field.key: field for field in CodexEngine.config_schema()}
    assert set(codex_fields) == {
        "sandbox_mode",
        "model_reasoning_effort",
        "approval_policy",
    }
    assert codex_fields["sandbox_mode"].type == "select"
    assert codex_fields["sandbox_mode"].default == "workspace-write"

    claude_sdk_fields = {
        field.key: field for field in ClaudeAgentSDKEngine.config_schema()
    }
    assert set(claude_sdk_fields) == {
        "permission_mode",
        "max_turns",
        "fallback_model",
        "max_budget_usd",
    }
    assert claude_sdk_fields["max_turns"].type == "number"
    assert claude_sdk_fields["max_budget_usd"].type == "number"
    assert "bypassPermissions" in claude_sdk_fields["permission_mode"].confirm_values

    codex_sdk_fields = {field.key: field for field in CodexSDKEngine.config_schema()}
    assert set(codex_sdk_fields) == {
        "model_reasoning_effort",
        "approval_mode",
        "sandbox",
    }
    assert codex_sdk_fields["approval_mode"].type == "select"

    from engines.base import BaseLLMEngine
    assert BaseLLMEngine.config_schema() == []


def test_api_engine_config_values_mask_secrets(monkeypatch):
    store = {
        "provider": "openai",
        "base_url": "https://gateway.example.com/v1",
        "api_key": "stored-secret",
        "model": "model-x",
    }
    monkeypatch.setattr(
        "engines.api.config_store.get_api_engine_config", lambda: dict(store)
    )
    engine = APIEngine()
    assert engine.get_config_values()["api_key"] == ""
    assert engine.get_config_secrets() == {"api_key": True}
    assert engine.reveal_config_value("api_key") == "stored-secret"


@pytest.mark.anyio
async def test_api_engine_save_keeps_and_clears_secret(monkeypatch):
    saved = {}

    class Store:
        def get_api_engine_config(self):
            return {
                "provider": "openai",
                "base_url": "https://gateway.example.com/v1",
                "api_key": "stored-secret",
                "model": "model-x",
            }

        def set_api_engine_config(self, **kwargs):
            saved.update(kwargs)

    monkeypatch.setattr("engines.api.config_store", Store())

    engine = APIEngine()
    # Not provided → keep existing key
    await engine.save_config_values({
        "provider": "openai",
        "base_url": "https://gateway.example.com/v1",
    })
    assert saved["api_key"] is None

    # Provided → replace
    await engine.save_config_values({
        "provider": "openai",
        "base_url": "https://gateway.example.com/v1",
        "api_key": "new-secret",
    })
    assert saved["api_key"] == "new-secret"

    # Clear flag → wipe
    await engine.save_config_values(
        {
            "provider": "openai",
            "base_url": "https://gateway.example.com/v1",
        },
        clear={"api_key": True},
    )
    assert saved["api_key"] == ""


@pytest.mark.anyio
async def test_api_engine_save_rejects_remote_plain_http(monkeypatch):
    monkeypatch.setattr(
        "engines.api.config_store.get_api_engine_config",
        lambda: {
            "provider": "openai",
            "base_url": "https://api.openai.com/v1",
            "api_key": "",
            "model": "",
        },
    )
    engine = APIEngine()
    with pytest.raises(ValueError, match="HTTPS"):
        await engine.save_config_values({
            "provider": "openai",
            "base_url": "http://192.168.1.20:11434/v1",
        })


@pytest.mark.anyio
async def test_claude_permission_mode_save_requires_confirmation(monkeypatch):
    saved = []
    monkeypatch.setattr(
        "engines.claude_code.config_store.set_claude_permission_mode",
        lambda mode: saved.append(mode),
    )
    engine = ClaudeCodeEngine()

    with pytest.raises(ValueError, match="明确确认"):
        await engine.save_config_values({"permission_mode": "bypassPermissions"})
    assert saved == []

    await engine.save_config_values(
        {"permission_mode": "bypassPermissions"},
        confirmed={"permission_mode": True},
    )
    assert saved == ["bypassPermissions"]


# --- Registry ---

def test_all_engines_registered():
    """All engines are in the full list."""
    assert len(_ALL_ENGINES) == 9
    assert "claude" in _ALL_ENGINES
    assert "codex" in _ALL_ENGINES
    assert "hermes" in _ALL_ENGINES
    assert "qoder_sdk" in _ALL_ENGINES
    assert "openclaw" in _ALL_ENGINES
    assert "api" in _ALL_ENGINES
    assert "pydantic_ai" in _ALL_ENGINES
    assert "claude_agent_sdk" in _ALL_ENGINES
    assert "codex_sdk" in _ALL_ENGINES


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
    assert "qoder_sdk" in ids
    assert "openclaw" in ids
    assert "claude_agent_sdk" in ids


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


# --- QoderSDKEngine ---

class _QoderFake:
    """Minimal stand-in for qoder_agent_sdk dataclasses (name/attr driven)."""

    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)


class _QoderSystemMessage(_QoderFake):
    pass


class _QoderStreamEvent(_QoderFake):
    pass


class _QoderAssistantMessage(_QoderFake):
    pass


class _QoderUserMessage(_QoderFake):
    pass


class _QoderResultMessage(_QoderFake):
    pass


def test_qoder_sdk_engine_id():
    assert QoderSDKEngine.ENGINE_ID == "qoder_sdk"


def test_qoder_sdk_version_and_binary():
    version = QoderSDKEngine.get_version()
    assert version is None or isinstance(version, str)
    binary = QoderSDKEngine.resolve_binary()
    assert binary is None or isinstance(binary, str)


def test_qoder_sdk_resolve_bundled_cli(monkeypatch, tmp_path):
    """The SDK wheel bundles qodercli, so no separate install is needed."""
    bundled = tmp_path / "_bundled"
    bundled.mkdir()
    (bundled / "qodercli").write_bytes(b"")
    import qoder_agent_sdk as sdk_module

    monkeypatch.setattr(sdk_module, "__file__", str(tmp_path / "qoder_agent_sdk.py"))
    resolved = QoderSDKEngine.resolve_binary()
    assert resolved == str(bundled / "qodercli")
    assert QoderSDKEngine.is_installed() is True


def test_qoder_sdk_not_installed_without_sdk(monkeypatch):
    monkeypatch.setattr(
        QoderSDKEngine, "_sdk_available", staticmethod(lambda: False)
    )
    assert QoderSDKEngine.is_installed() is False


def test_qoder_sdk_is_reported_as_sdk_mode(monkeypatch):
    """The SDK-backed engine is not a plain CLI mode."""
    from engines.registry import get_available_engines, refresh_registry

    monkeypatch.setattr(
        QoderSDKEngine, "is_installed", staticmethod(lambda: True)
    )
    refresh_registry()
    try:
        engines = {item["id"]: item for item in get_available_engines()}
    finally:
        refresh_registry()
    assert engines["qoder_sdk"]["installed"] is True
    assert engines["qoder_sdk"]["mode"] == "sdk"


def test_qoder_sdk_not_resume():
    engine = QoderSDKEngine()
    assert engine.supports_resume is False
    assert engine.supports_interactive is True
    assert engine.supports_live_stage_message is True


def test_qoder_sdk_maps_system_init():
    engine = QoderSDKEngine()
    msg = _QoderSystemMessage(subtype="init", data={"model": "auto"})
    events = engine._map_message(msg)
    assert [event.type for event in events] == ["status"]
    assert events[0].data["status"] == "initializing"


def test_qoder_sdk_maps_compact_boundary():
    engine = QoderSDKEngine()
    msg = _QoderSystemMessage(
        subtype="compact_boundary",
        data={"compact_summary": "前文已压缩为摘要"},
    )
    events = engine._map_message(msg)
    assert [event.type for event in events] == ["compacted"]
    assert events[0].data == {"summary": "前文已压缩为摘要"}


def test_qoder_sdk_maps_assistant_blocks():
    engine = QoderSDKEngine()
    text = _QoderFake(type="text", text="你好，Qoder！")
    thinking = _QoderFake(type="thinking", thinking="让我想想")
    tool = _QoderFake(type="tool_use", id="tool-1", name="Read", input={"path": "a.py"})
    msg = _QoderAssistantMessage(content=[text, thinking, tool], session_id="s1")
    events = engine._map_message(msg)
    assert [event.type for event in events] == [
        "text_delta", "thinking_delta", "tool_use",
    ]
    assert events[0].data["delta"] == "你好，Qoder！"
    assert events[2].data["id"] == "tool-1"
    assert events[2].data["name"] == "Read"


def test_qoder_sdk_assistant_text_skipped_when_streamed():
    """Streamed text is not duplicated by the final AssistantMessage."""
    engine = QoderSDKEngine()
    stream = _QoderStreamEvent(
        event={"type": "content_block_delta",
               "delta": {"type": "text_delta", "text": "增量"}},
    )
    msg = _QoderAssistantMessage(content=[_QoderFake(type="text", text="增量")])
    state = {"emitted_text": False, "emitted_thinking": False}
    stream_events = engine._map_message(stream, state)
    final_events = engine._map_message(msg, state)
    assert [e.data["delta"] for e in stream_events] == ["增量"]
    assert final_events == []


def test_qoder_sdk_maps_tool_result():
    engine = QoderSDKEngine()
    block = _QoderFake(type="tool_result", tool_use_id="tool-1",
                       content="file content", is_error=False)
    msg = _QoderUserMessage(content=[block])
    events = engine._map_message(msg)
    assert [event.type for event in events] == ["tool_result"]
    assert events[0].data["tool_use_id"] == "tool-1"
    assert events[0].data["content"] == "file content"
    assert events[0].data["is_error"] is False


def test_qoder_sdk_maps_result_usage_with_cost_and_credits():
    engine = QoderSDKEngine()
    msg = _QoderResultMessage(
        subtype="success",
        is_error=False,
        result="",
        session_id="session-1",
        total_cost_usd=0.042,
        total_credits=2.5,
        usage={
            "inputTokens": 300,
            "outputTokens": 100,
            "cacheReadInputTokens": 120,
            "cacheCreationInputTokens": 40,
            "costUSD": 0.042,
        },
    )
    events = engine._map_message(msg)
    usage_event = next(event for event in events if event.type == "usage")
    assert usage_event.data == {
        "input_tokens": 300,
        "output_tokens": 100,
        "cache_creation_input_tokens": 40,
        "cache_read_input_tokens": 120,
        "total_tokens": 400,
        "cost": {"amount": 0.042, "currency": "USD"},
        "credits": 2.5,
        "session_id": "session-1",
    }
    assert events[-1].type == "status"
    assert events[-1].data["status"] == "done"


def test_qoder_sdk_result_falls_back_to_result_text():
    engine = QoderSDKEngine()
    msg = _QoderResultMessage(subtype="success", is_error=False, result="完成")
    events = engine._map_message(msg)
    assert [event.type for event in events] == ["text_delta", "status"]


def test_qoder_sdk_result_error():
    engine = QoderSDKEngine()
    msg = _QoderResultMessage(
        subtype="error_max_turns",
        is_error=True,
        errors=["达到最大轮数"],
        result="",
    )
    events = engine._map_message(msg)
    error_event = next(event for event in events if event.type == "error")
    assert error_event.data["message"] == "达到最大轮数"


# --- PydanticAIEngine session id ---

@pytest.mark.anyio
async def test_pydantic_ai_spawn_emits_session_started(monkeypatch):
    """The built-in agent emits a per-run session id like other engines."""
    import engines.pydantic_ai as pydantic_ai_module
    from engines.pydantic_ai import PydanticAIEngine

    class FakeStore:
        def get_pydantic_ai_engine_config(self):
            return {
                "provider": "openai",
                "base_url": "https://agent-gateway.example.com/v1",
                "api_key": "k",
                "model": "agent-model",
            }

    class FakeUsage:
        input_tokens = 1
        output_tokens = 1
        total_tokens = 2
        cache_write_tokens = 0
        cache_read_tokens = 0
        requests = 1
        cost = None

    class FakeResult:
        output = "done"
        usage = FakeUsage()

    async def fake_run_agent(self, *, prompt, cwd, add_dirs, model,
                             on_event, live_message_queue=None, images=None):
        return FakeResult(), FakeUsage()

    monkeypatch.setattr(pydantic_ai_module, "config_store", FakeStore())
    monkeypatch.setattr(
        PydanticAIEngine, "build_model", staticmethod(lambda **config: object())
    )
    monkeypatch.setattr(PydanticAIEngine, "_run_agent", fake_run_agent)

    events = [
        event async for event in PydanticAIEngine().spawn("hi", cwd="/tmp/project")
    ]
    assert events[0].type == "session_started"
    session_id = events[0].data["session_id"]
    assert isinstance(session_id, str) and session_id
    usage_event = next(event for event in events if event.type == "usage")
    assert usage_event.data["session_id"] == session_id
    assert events[-1].type == "status"
    assert events[-1].data["status"] == "done"
