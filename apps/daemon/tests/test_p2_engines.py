"""Tests for P2 engines: Codex, Hermes, SDK engines, registry strategy."""

import asyncio
import os
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from engines.codex import CodexEngine
from engines.hermes import HermesEngine
from engines.claude_agent_sdk import ClaudeAgentSDKEngine
from engines.qoder_sdk import QoderSDKEngine
from engines.codex_sdk import CodexSDKEngine
from engines.claude_code import ClaudeCodeEngine
from engines.pydantic_ai import PydanticAIEngine
from engines.core.registry import (
    ENGINE_REGISTRY,
    get_available_engines,
    create_engine,
    refresh_registry,
    _ALL_ENGINES,
)
from engines.core.events import InternalEvent


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("engine_class", "expected_mode"),
    [
        (ClaudeAgentSDKEngine, "acceptEdits"),
        (QoderSDKEngine, "acceptEdits"),
    ],
)
async def test_sdk_permission_mode_changes_active_client_immediately(
    engine_class,
    expected_mode,
):
    engine = engine_class()
    applied: list[str] = []

    class ActiveClient:
        async def set_permission_mode(self, mode: str) -> None:
            applied.append(mode)

    engine._client = ActiveClient()
    await engine.set_permission_mode("workspace-write")

    assert applied == [expected_mode]
    assert engine.runtime_permission_mode() == "workspace-write"


# --- CodexEngine ---

def test_codex_resolve_binary():
    binary = CodexEngine.resolve_binary()
    assert binary is None or isinstance(binary, str)


@pytest.mark.anyio
async def test_codex_list_models_uses_cli_catalog(monkeypatch, tmp_path):
    calls = []

    class FakeProcess:
        returncode = 0

        async def communicate(self):
            return (
                b'{"models":['
                b'{"slug":"gpt-visible","display_name":"GPT Visible",'
                b'"description":"Selectable","visibility":"list"},'
                b'{"slug":"gpt-hidden","display_name":"GPT Hidden",'
                b'"description":"Internal","visibility":"hide"}'
                b']}',
                b"",
            )

    async def fake_create_subprocess_exec(*args, **kwargs):
        calls.append((args, kwargs))
        return FakeProcess()

    monkeypatch.setattr(
        CodexEngine,
        "resolve_binary",
        staticmethod(lambda: "/fake/codex"),
    )
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)

    models = await CodexEngine().list_models(str(tmp_path))

    assert calls == [
        (("/fake/codex", "debug", "models"), {
            "stdout": asyncio.subprocess.PIPE,
            "stderr": asyncio.subprocess.PIPE,
            "cwd": str(tmp_path),
            "limit": 1024 * 256,
        })
    ]
    assert [(model.id, model.label, model.description) for model in models] == [
        ("gpt-visible", "GPT Visible", "Selectable"),
    ]


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


def test_engine_install_commands():
    """CLI/SDK 引擎暴露可自动安装命令，内置与占位引擎不支持。"""
    assert CodexEngine.install_command() == "npm install -g @openai/codex"
    assert (
        ClaudeCodeEngine.install_command()
        == "npm install -g @anthropic-ai/claude-code"
    )
    assert (
        ClaudeAgentSDKEngine.install_command()
        == "pip install claude-agent-sdk"
    )
    assert CodexSDKEngine.install_command() == "pip install openai-codex"
    assert QoderSDKEngine.install_command() == "pip install qoder-agent-sdk"
    assert HermesEngine.install_command() is None
    assert PydanticAIEngine.install_command() is None


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
    assert event.type == "agent_message_chunk"
    assert event.data["content"]["text"] == "Hello from Codex"


def test_codex_map_agent_message_text_field():
    """Real codex JSONL carries agent text in the item's text field."""
    engine = CodexEngine()
    event = engine._map_event({
        "type": "item.completed",
        "item": {"type": "agent_message", "text": "你好！我是 Codex"},
    })
    assert event is not None
    assert event.type == "agent_message_chunk"
    assert event.data["content"]["text"] == "你好！我是 Codex"


def test_codex_maps_structured_reasoning_summary_to_thought_content():
    engine = CodexEngine()
    event = engine._map_event({
        "type": "item.completed",
        "item": {
            "type": "reasoning",
            "summary": [
                {"type": "summary_text", "text": "先检查现有实现"},
                {"type": "summary_text", "text": "再修改并验证"},
            ],
        },
    })

    assert event is not None
    assert event.type == "agent_thought_chunk"
    assert event.data["content"]["text"] == "先检查现有实现\n再修改并验证"


def test_codex_map_command_execution():
    engine = CodexEngine()
    # tool_use (started)
    event = engine._map_event({
        "type": "item.started",
        "item": {"type": "command_execution", "id": "cmd1", "command": "ls -la"},
    })
    assert event is not None
    assert event.type == "tool_call"
    assert event.data["title"] == "Bash"

    # tool_result (completed)
    event = engine._map_event({
        "type": "item.completed",
        "item": {"type": "command_execution", "id": "cmd1", "output": "file1\nfile2", "exit_code": 0},
    })
    assert event is not None
    assert event.type == "tool_call_update"
    assert event.data["status"] == "completed"


def test_codex_map_sandbox_denial_to_interaction_request():
    """沙箱拒绝的 command_execution 必须转成 ACP 形 interaction_request。"""
    engine = CodexEngine()
    event = engine._map_event({
        "type": "item.completed",
        "item": {
            "type": "command_execution",
            "id": "cmd1",
            "command": "touch x",
            "output": "touch: cannot touch 'x': Operation not permitted",
            "exit_code": 1,
        },
    })
    assert event is not None
    assert event.type == "interaction_request"
    assert event.data["method"] == "session/request_permission"
    assert event.data["tool_call"]["tool_call_id"] == "cmd1"
    assert event.data["tool_call"]["name"] == "Bash"
    assert [o["option_id"] for o in event.data["options"]] == [
        "allow_once", "reject_once", "reject_for_session",
    ]

    # 普通命令失败（非权限拒绝）仍透传为 tool_result
    event = engine._map_event({
        "type": "item.completed",
        "item": {
            "type": "command_execution",
            "id": "cmd2",
            "command": "ls /nonexistent",
            "output": "ls: /nonexistent: No such file or directory",
            "exit_code": 2,
        },
    })
    assert event is not None
    assert event.type == "tool_call_update"
    assert event.data["status"] == "failed"

    # 成功命令照常透传
    event = engine._map_event({
        "type": "item.completed",
        "item": {
            "type": "command_execution",
            "id": "cmd3",
            "command": "ls",
            "output": "file1",
            "exit_code": 0,
        },
    })
    assert event.type == "tool_call_update"
    assert event.data["status"] == "completed"


@pytest.mark.anyio
async def test_codex_denial_round_trip_escalates_sandbox(monkeypatch):
    """被拒命令 → 弹窗 → 批准 → 提升沙箱并以 resume 重启会话重试。"""
    spawned: list[list[str]] = []

    class _FakeStdin:
        def __init__(self):
            self.written = b""

        def write(self, data):
            self.written += data

        async def drain(self):
            return None

        def close(self):
            return None

    class _FakeProc:
        def __init__(self, stdout: bytes):
            self.stdin = _FakeStdin()
            self.stdout = asyncio.StreamReader()
            self.stdout.feed_data(stdout)
            self.stdout.feed_eof()
            self.stderr = asyncio.StreamReader()
            self.stderr.feed_eof()
            self.returncode = 0
            self.terminated = False

        async def wait(self) -> int:
            return self.returncode

        def terminate(self):
            self.terminated = True

        def kill(self):
            self.terminated = True

    first = _FakeProc(stdout=(
        b'{"type":"thread.started","thread_id":"thread-1"}\n'
        b'{"type":"item.started","item":{"type":"command_execution",'
        b'"id":"cmd1","command":"touch x"}}\n'
        b'{"type":"item.completed","item":{"type":"command_execution",'
        b'"id":"cmd1","command":"touch x",'
        b'"output":"touch: cannot touch x: Operation not permitted",'
        b'"exit_code":1}}\n'
    ))
    second = _FakeProc(stdout=(
        '{"type":"thread.started","thread_id":"thread-1"}\n'
        '{"type":"item.completed","item":{"type":"agent_message",'
        '"text":"已重试成功"}}\n'
    ).encode())
    processes = [first, second]

    async def fake_create_subprocess_exec(program, *args, **kwargs):
        spawned.append([program, *args])
        return processes.pop(0)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(CodexEngine, "resolve_binary", staticmethod(lambda: "/fake/codex"))
    monkeypatch.setattr(
        "engines.codex.config_store.get_codex_config",
        lambda: {
            "sandbox_mode": "read-only",
            "model_reasoning_effort": "",
            "approval_policy": "",
        },
    )

    engine = CodexEngine()
    request_seen = asyncio.Event()
    request_data = {}

    async def consume():
        async for event in engine.spawn(
            prompt="hello",
            cwd="/tmp",
            live_message_queue=asyncio.Queue(),
        ):
            if event.type == "interaction_request":
                request_data.update(event.data)
                request_seen.set()

    consumer = asyncio.create_task(consume())
    await asyncio.wait_for(request_seen.wait(), timeout=5)

    assert request_data["method"] == "session/request_permission"
    assert request_data["session_id"] == "thread-1"
    assert "touch x" in request_data["tool_call"]["title"]

    delivered = await engine.respond_interaction(request_data, {
        "outcome": {"outcome": "selected", "option_id": "allow_once"},
    })
    assert delivered is True
    await asyncio.wait_for(consumer, timeout=5)

    # 第二次启动：resume 会话 + 显式提升 sandbox 到 workspace-write
    assert len(spawned) == 2
    resume_cmd = spawned[1]
    assert "resume" in resume_cmd
    assert "thread-1" in resume_cmd
    assert "-c" in resume_cmd
    assert "sandbox_mode=workspace-write" in resume_cmd


@pytest.mark.anyio
async def test_codex_denial_reject_injects_decision_without_escalation(monkeypatch):
    """拒绝时不提升沙箱，仅以 resume 把用户决定带给模型。"""
    spawned: list[list[str]] = []

    class _FakeStdin:
        def __init__(self):
            self.written = b""

        def write(self, data):
            self.written += data

        async def drain(self):
            return None

        def close(self):
            return None

    class _FakeProc:
        def __init__(self, stdout: bytes):
            self.stdin = _FakeStdin()
            self.stdout = asyncio.StreamReader()
            self.stdout.feed_data(stdout)
            self.stdout.feed_eof()
            self.stderr = asyncio.StreamReader()
            self.stderr.feed_eof()
            self.returncode = 0
            self.terminated = False

        async def wait(self) -> int:
            return self.returncode

        def terminate(self):
            self.terminated = True

        def kill(self):
            self.terminated = True

    first = _FakeProc(stdout=(
        b'{"type":"thread.started","thread_id":"thread-1"}\n'
        b'{"type":"item.completed","item":{"type":"command_execution",'
        b'"id":"cmd1","command":"touch x",'
        b'"output":"touch: cannot touch x: Operation not permitted",'
        b'"exit_code":1}}\n'
    ))
    second = _FakeProc(stdout=(
        '{"type":"thread.started","thread_id":"thread-1"}\n'
        '{"type":"item.completed","item":{"type":"agent_message",'
        '"text":"已改用其他方式"}}\n'
    ).encode())
    processes = [first, second]

    async def fake_create_subprocess_exec(program, *args, **kwargs):
        spawned.append([program, *args])
        return processes.pop(0)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(CodexEngine, "resolve_binary", staticmethod(lambda: "/fake/codex"))
    monkeypatch.setattr(
        "engines.codex.config_store.get_codex_config",
        lambda: {
            "sandbox_mode": "read-only",
            "model_reasoning_effort": "",
            "approval_policy": "",
        },
    )

    engine = CodexEngine()
    request_seen = asyncio.Event()
    request_data = {}
    decisions: list[str] = []

    async def consume():
        async for event in engine.spawn(
            prompt="hello",
            cwd="/tmp",
            live_message_queue=asyncio.Queue(),
        ):
            if event.type == "interaction_request":
                request_data.update(event.data)
                request_seen.set()
            elif event.type == "live_message":
                decisions.append(event.data.get("content", ""))

    consumer = asyncio.create_task(consume())
    await asyncio.wait_for(request_seen.wait(), timeout=5)
    await engine.respond_interaction(request_data, {
        "outcome": {"outcome": "selected", "option_id": "reject_once"},
    })
    await asyncio.wait_for(consumer, timeout=5)

    assert any("user rejected" in content for content in decisions)
    resume_cmd = spawned[1]
    assert "sandbox_mode=" not in " ".join(resume_cmd)


async def test_codex_denial_reject_for_session_auto_denies(monkeypatch):
    """选择「拒绝本次运行」后，本次运行内相同命令不再弹窗，自动注入拒绝决定。"""
    spawned: list[list[str]] = []

    class _FakeStdin:
        def __init__(self):
            self.written = b""

        def write(self, data):
            self.written += data

        async def drain(self):
            return None

        def close(self):
            return None

    class _FakeProc:
        def __init__(self, stdout: bytes):
            self.stdin = _FakeStdin()
            self.stdout = asyncio.StreamReader()
            self.stdout.feed_data(stdout)
            self.stdout.feed_eof()
            self.stderr = asyncio.StreamReader()
            self.stderr.feed_eof()
            self.returncode = 0
            self.terminated = False

        async def wait(self) -> int:
            return self.returncode

        def terminate(self):
            self.terminated = True

        def kill(self):
            self.terminated = True

    denial = (
        b'{"type":"thread.started","thread_id":"thread-1"}\n'
        b'{"type":"item.completed","item":{"type":"command_execution",'
        b'"id":"cmd1","command":"touch x",'
        b'"output":"touch: cannot touch x: Operation not permitted",'
        b'"exit_code":1}}\n'
    )
    processes = [
        _FakeProc(stdout=denial),
        _FakeProc(stdout=denial),
        _FakeProc(stdout=(
            '{"type":"thread.started","thread_id":"thread-1"}\n'
            '{"type":"item.completed","item":{"type":"agent_message",'
            '"text":"已改用其他方式"}}\n'
        ).encode()),
    ]

    async def fake_create_subprocess_exec(program, *args, **kwargs):
        spawned.append([program, *args])
        return processes.pop(0)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(CodexEngine, "resolve_binary", staticmethod(lambda: "/fake/codex"))
    monkeypatch.setattr(
        "engines.codex.config_store.get_codex_config",
        lambda: {
            "sandbox_mode": "read-only",
            "model_reasoning_effort": "",
            "approval_policy": "",
        },
    )

    engine = CodexEngine()
    request_seen = asyncio.Event()
    request_data = {}
    interaction_count = 0
    decisions: list[str] = []

    async def consume():
        nonlocal interaction_count
        async for event in engine.spawn(
            prompt="hello",
            cwd="/tmp",
            live_message_queue=asyncio.Queue(),
        ):
            if event.type == "interaction_request":
                interaction_count += 1
                request_data.update(event.data)
                request_seen.set()
            elif event.type == "live_message":
                decisions.append(event.data.get("content", ""))

    consumer = asyncio.create_task(consume())
    await asyncio.wait_for(request_seen.wait(), timeout=5)
    await engine.respond_interaction(request_data, {
        "outcome": {"outcome": "selected", "option_id": "reject_for_session"},
    })
    await asyncio.wait_for(consumer, timeout=5)

    assert interaction_count == 1
    assert len(spawned) == 3
    assert "resume" in " ".join(spawned[1])
    assert "resume" in " ".join(spawned[2])
    assert len(decisions) == 2
    assert all("user rejected" in content for content in decisions)
    assert all("rejected" in content for content in decisions)


def test_claude_code_maps_subagent_task_frames():
    """Claude CLI stream-json 的 task_* system 帧映射为 subagent 事件。"""
    engine = ClaudeCodeEngine()

    started = engine._map_events({
        "type": "system", "subtype": "task_started",
        "task_id": "task-7", "description": "实现后端",
        "uuid": "u1", "session_id": "s1",
        "tool_use_id": "task-call-1", "task_type": "chain",
    })
    progress = engine._map_events({
        "type": "system", "subtype": "task_progress",
        "task_id": "task-7", "description": "实现后端",
        "usage": {"input_tokens": 10}, "uuid": "u2", "session_id": "s1",
        "last_tool_name": "Edit",
    })
    updated = engine._map_events({
        "type": "system", "subtype": "task_updated",
        "task_id": "task-7", "patch": {"status": "running"},
    })
    failed = engine._map_events({
        "type": "system", "subtype": "task_notification",
        "task_id": "task-7", "status": "failed",
        "output_file": "logs/task-7.json", "summary": "工具执行错误",
        "uuid": "u3", "session_id": "s1",
    })

    assert [event.type for event in started] == ["subagent"]
    assert started[0].data["task_id"] == "task-7"
    assert started[0].data["status"] == "running"
    assert started[0].data["stage"] == "started"
    assert started[0].data["description"] == "实现后端"
    assert started[0].data["tool_use_id"] == "task-call-1"
    assert progress[0].data["stage"] == "progress"
    assert progress[0].data["last_tool_name"] == "Edit"
    assert progress[0].data["usage"] == {"input_tokens": 10}
    assert updated[0].data["status"] == "running"
    assert updated[0].data["stage"] == "updated"
    assert failed[0].data["status"] == "failed"
    assert failed[0].data["summary"] == "工具执行错误"


def test_claude_code_uses_structured_task_create_result_for_plan_updates():
    engine = ClaudeCodeEngine()

    created = engine.normalize_event(engine._map_events({
        "type": "assistant",
        "message": {"content": [{
            "type": "tool_use",
            "id": "create-call-1",
            "name": "TaskCreate",
            "input": {"subject": "排查网页易崩溃"},
        }]},
    })[0])
    assignment_events = engine._map_events({
        "type": "user",
        "message": {"content": [{
            "type": "tool_result",
            "tool_use_id": "create-call-1",
            "content": "Task #15 created successfully: 排查网页易崩溃",
        }]},
        "toolUseResult": {
            "task": {"id": "15", "subject": "排查网页易崩溃"},
        },
    })
    assert assignment_events[0].data["raw_output"] == (
        "Task #15 created successfully: 排查网页易崩溃"
    )
    assigned = engine.normalize_event(assignment_events[0])
    updated = engine.normalize_event(engine._map_events({
        "type": "assistant",
        "message": {"content": [{
            "type": "tool_use",
            "id": "update-call-1",
            "name": "TaskUpdate",
            "input": {"taskId": "15", "status": "in_progress"},
        }]},
    })[0])

    assert created is not None and created.type == "plan"
    assert assigned is not None and assigned.type == "plan"
    assert updated is not None and updated.type == "plan"
    assert updated.data["entries"] == [{
        "content": "排查网页易崩溃",
        "priority": "medium",
        "status": "in_progress",
    }]


def test_claude_code_result_usage_is_not_a_context_snapshot():
    events = ClaudeCodeEngine()._map_events({
        "type": "result",
        "usage": {
            "input_tokens": 100,
            "cache_creation_input_tokens": 40,
            "cache_read_input_tokens": 20,
            "output_tokens": 30,
        },
    })

    usage = events[0].data
    assert usage["used"] == 130
    assert "size" not in usage


def test_claude_code_assistant_usage_defaults_context_window_to_256k():
    events = ClaudeCodeEngine()._map_events({
        "type": "assistant",
        "message": {
            "content": [],
            "usage": {
                "input_tokens": 100,
                "cache_creation_input_tokens": 40,
                "cache_read_input_tokens": 20,
                "output_tokens": 30,
            },
        },
    })

    usage = events[0].data
    assert usage["used"] == 190
    assert usage["size"] == 256_000


def test_claude_code_maps_compact_boundary_and_declares_event():
    engine = ClaudeCodeEngine()

    event = engine._map_events({
        "type": "system",
        "subtype": "compact_boundary",
        "compact_metadata": {"pre_tokens": 1200, "post_tokens": 300},
    })

    assert [item.type for item in event] == ["compacted"]
    assert event[0].data == {
        "metadata": {"pre_tokens": 1200, "post_tokens": 300},
    }
    assert "compacted" in engine.acp_events


def test_codex_maps_collab_agent_tool_call_items():
    """Codex CLI 的 collab_agent_tool_call item 映射为子代理工具调用。"""
    engine = CodexEngine()

    started = engine._map_event({
        "type": "item.started",
        "item": {
            "type": "collab_agent_tool_call",
            "id": "agent-1",
            "tool": "spawnAgent",
            "prompt": "分析 provider 代码",
        },
    })
    completed = engine._map_event({
        "type": "item.completed",
        "item": {
            "type": "collab_agent_tool_call",
            "id": "agent-1",
            "tool": "spawnAgent",
            "agents_states": [{"message": "已完成", "status": "completed"}],
        },
    })

    assert started is not None and started.type == "tool_call"
    assert started.data["title"] == "spawnAgent"
    assert started.data["raw_input"]["prompt"] == "分析 provider 代码"
    assert completed is not None and completed.type == "tool_call_update"
    assert completed.data["tool_call_id"] == "agent-1"
    assert "已完成" in completed.data["raw_output"]
    assert completed.data["status"] == "completed"

def test_claude_code_denial_maps_to_interaction_request():
    """live 模式下「requires approval」tool_result 转成 interaction_request。"""
    engine = ClaudeCodeEngine()

    # 非 live 模式：拒绝照常透传为 tool_result
    events = engine._map_events({
        "type": "user",
        "message": {"role": "user", "content": [{
            "type": "tool_result",
            "tool_use_id": "toolu-1",
            "content": "This command requires approval",
            "is_error": True,
        }]},
    })
    assert [e.type for e in events] == ["tool_call_update"]

    engine._live_mode = True
    # 需先记录 tool_use 名称
    engine._map_events({
        "type": "assistant",
        "message": {"content": [{
            "type": "tool_use",
            "id": "toolu-1",
            "name": "Bash",
            "input": {"command": "cat file.txt"},
        }]},
    })
    events = engine._map_events({
        "type": "user",
        "message": {"role": "user", "content": [{
            "type": "tool_result",
            "tool_use_id": "toolu-1",
            "content": (
                "This Bash command contains multiple operations. "
                "The following part requires approval: cat file.txt"
            ),
            "is_error": True,
        }]},
    })
    assert [e.type for e in events] == ["interaction_request"]
    assert events[0].data["method"] == "session/request_permission"
    assert events[0].data["tool_call"]["tool_call_id"] == "toolu-1"
    assert events[0].data["tool_call"]["name"] == "Bash"
    assert [o["option_id"] for o in events[0].data["options"]] == [
        "allow_once", "allow_always", "allow_for_session",
        "reject_once", "reject_for_session",
    ]

    # 非权限的普通命令失败仍透传为 tool_result
    events = engine._map_events({
        "type": "user",
        "message": {"role": "user", "content": [{
            "type": "tool_result",
            "tool_use_id": "toolu-2",
            "content": "bash: command not found: foobar",
            "is_error": True,
        }]},
    })
    assert [e.type for e in events] == ["tool_call_update"]
    assert events[0].data["status"] == "failed"


def test_claude_code_permission_signature():
    """会话记忆的签名：Bash 按命令、其它按输入 JSON，无输入不记忆。"""
    from engines.core.interactions import permission_signature

    assert permission_signature("Bash", {"command": "cat file.txt"}) == "Bash:cat file.txt"
    assert permission_signature("Bash", {"command": "  cat file.txt  "}) == "Bash:cat file.txt"
    assert permission_signature("Bash", {}) == ""
    assert permission_signature("Bash", None) == ""
    assert permission_signature("Write", {"file_path": "a.txt", "content": "x"}) == (
        'Write:{"content": "x", "file_path": "a.txt"}'
    )


@pytest.mark.anyio
async def test_claude_code_denial_round_trip(monkeypatch):
    """live 模式权限拒绝 → interaction_request 弹窗 → 批准 → 注入 tool_result。"""
    import json as _json

    class _FakeStdin:
        def __init__(self):
            self.written = b""
            self.closed = False

        def write(self, data):
            self.written += data

        async def drain(self):
            return None

        def is_closing(self):
            return self.closed

        def close(self):
            self.closed = True

    class _FakeProc:
        def __init__(self):
            self.stdin = _FakeStdin()
            self.stdout = asyncio.StreamReader()
            self.stderr = asyncio.StreamReader()
            self.stderr.feed_eof()
            self.returncode = 0
            self.terminated = False

        async def wait(self) -> int:
            return self.returncode

        def terminate(self):
            self.terminated = True

        def kill(self):
            self.terminated = True

    process = _FakeProc()
    process.stdout.feed_data((
        '{"type":"system","subtype":"init","session_id":"sess-1"}\n'
        '{"type":"assistant","message":{"content":[{"type":"tool_use",'
        '"id":"toolu-1","name":"Bash","input":{"command":"cat file.txt"}}]}}\n'
        '{"type":"user","message":{"content":[{"type":"tool_result",'
        '"tool_use_id":"toolu-1","content":"This command requires approval",'
        '"is_error":true}]}}\n'
    ).encode())
    process.stdout.feed_eof()

    async def fake_create_subprocess_exec(*args, **kwargs):
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(
        ClaudeCodeEngine, "resolve_binary", staticmethod(lambda: "/fake/claude")
    )
    monkeypatch.setattr(
        "engines.claude_code.config_store.get_claude_permission_mode",
        lambda: "default",
    )

    engine = ClaudeCodeEngine()
    request_seen = asyncio.Event()
    request_data = {}

    async def consume():
        async for event in engine.spawn(
            prompt="hi",
            cwd="/tmp",
            live_message_queue=asyncio.Queue(),
        ):
            if event.type == "interaction_request":
                request_data.update(event.data)
                request_seen.set()

    consumer = asyncio.create_task(consume())
    await asyncio.wait_for(request_seen.wait(), timeout=5)

    assert request_data["method"] == "session/request_permission"
    assert request_data["tool_call"]["tool_call_id"] == "toolu-1"
    assert request_data["session_id"] == "sess-1"
    assert "requires approval" in request_data["tool_call"]["title"]

    delivered = await engine.respond_interaction(request_data, {
        "outcome": {"outcome": "selected", "option_id": "allow_once"},
    })
    assert delivered is True
    await asyncio.wait_for(consumer, timeout=5)

    written = process.stdin.written.decode()
    tool_result_lines = [
        line for line in written.splitlines()
        if '"tool_result"' in line
    ]
    assert tool_result_lines, written
    injected = _json.loads(tool_result_lines[-1])
    content = injected["message"]["content"][0]
    assert content["type"] == "tool_result"
    assert content["tool_use_id"] == "toolu-1"
    assert "approved" in content["content"]


@pytest.mark.anyio
async def test_claude_code_allow_always_auto_approves_same_command(monkeypatch):
    """「允许所有」记住命令签名，后续相同命令不再弹窗、自动注入批准。"""
    import json as _json

    class _FakeStdin:
        def __init__(self):
            self.written = b""
            self.closed = False

        def write(self, data):
            self.written += data

        async def drain(self):
            return None

        def is_closing(self):
            return self.closed

        def close(self):
            self.closed = True

    class _FakeProc:
        def __init__(self):
            self.stdin = _FakeStdin()
            self.stdout = asyncio.StreamReader()
            self.stderr = asyncio.StreamReader()
            self.stderr.feed_eof()
            self.returncode = 0
            self.terminated = False

        async def wait(self) -> int:
            return self.returncode

        def terminate(self):
            self.terminated = True

        def kill(self):
            self.terminated = True

    process = _FakeProc()
    process.stdout.feed_data((
        '{"type":"system","subtype":"init","session_id":"sess-1"}\n'
        # 第一次：cat file.txt 被权限拒绝
        '{"type":"assistant","message":{"content":[{"type":"tool_use",'
        '"id":"toolu-1","name":"Bash","input":{"command":"cat file.txt"}}]}}\n'
        '{"type":"user","message":{"content":[{"type":"tool_result",'
        '"tool_use_id":"toolu-1","content":"This command requires approval",'
        '"is_error":true}]}}\n'
        # 第二次：相同命令再次被权限拒绝
        '{"type":"assistant","message":{"content":[{"type":"tool_use",'
        '"id":"toolu-2","name":"Bash","input":{"command":"cat file.txt"}}]}}\n'
        '{"type":"user","message":{"content":[{"type":"tool_result",'
        '"tool_use_id":"toolu-2","content":"This command requires approval",'
        '"is_error":true}]}}\n'
    ).encode())
    process.stdout.feed_eof()

    async def fake_create_subprocess_exec(*args, **kwargs):
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(
        ClaudeCodeEngine, "resolve_binary", staticmethod(lambda: "/fake/claude")
    )
    monkeypatch.setattr(
        "engines.claude_code.config_store.get_claude_permission_mode",
        lambda: "default",
    )

    persisted_rules = []
    import engines.claude_code as claude_code_module

    monkeypatch.setattr(
        claude_code_module,
        "_append_claude_permission_rule",
        lambda path, rule: (persisted_rules.append(rule), True)[1],
    )

    engine = ClaudeCodeEngine()
    request_seen = asyncio.Event()
    requests = []

    async def consume():
        async for event in engine.spawn(
            prompt="hi",
            cwd="/tmp",
            live_message_queue=asyncio.Queue(),
        ):
            if event.type == "interaction_request":
                requests.append(event.data)
                request_seen.set()

    consumer = asyncio.create_task(consume())
    await asyncio.wait_for(request_seen.wait(), timeout=5)
    assert len(requests) == 1

    delivered = await engine.respond_interaction(requests[0], {
        "outcome": {"outcome": "selected", "option_id": "allow_always"},
    })
    assert delivered is True
    await asyncio.wait_for(consumer, timeout=5)

    # 「允许所有」按 Claude Code 原生机制写入项目权限设置。
    assert persisted_rules == ["Bash(cat file.txt *)"]

    # 第二次相同命令被自动放行：不再弹窗，且注入到 toolu-2。
    assert len(requests) == 1
    written = process.stdin.written.decode()
    tool_result_lines = [
        line for line in written.splitlines()
        if '"tool_result"' in line
    ]
    assert len(tool_result_lines) == 2, written
    injected = _json.loads(tool_result_lines[-1])
    content = injected["message"]["content"][0]
    assert content["tool_use_id"] == "toolu-2"
    assert "will be allowed" in content["content"]


def test_claude_code_append_permission_rule_merges_settings(tmp_path):
    """「允许所有」写入项目 .claude/settings.local.json，保留既有配置并去重。"""
    import json as _json

    from engines.claude_code import _append_claude_permission_rule

    settings = tmp_path / ".claude" / "settings.local.json"
    settings.parent.mkdir()
    settings.write_text(
        '{"permissions": {"allow": ["Bash(ls *)"], "deny": ["Bash(rm *)"]}}',
        encoding="utf-8",
    )

    assert _append_claude_permission_rule(settings, "Bash(cat file.txt *)") is True
    assert _append_claude_permission_rule(settings, "Bash(cat file.txt *)") is True
    data = _json.loads(settings.read_text(encoding="utf-8"))
    assert data["permissions"]["allow"] == ["Bash(ls *)", "Bash(cat file.txt *)"]
    assert data["permissions"]["deny"] == ["Bash(rm *)"]

    # 新文件（无 .claude 目录）也能创建
    fresh = tmp_path / "other" / ".claude" / "settings.local.json"
    assert _append_claude_permission_rule(fresh, "Bash(git status *)") is True
    data = _json.loads(fresh.read_text(encoding="utf-8"))
    assert data["permissions"]["allow"] == ["Bash(git status *)"]

    # 空规则不写入
    assert _append_claude_permission_rule(fresh, "") is False


@pytest.mark.anyio
async def test_claude_code_reject_for_session_auto_denies_same_command(monkeypatch):
    """「拒绝本次会话」记住命令签名，后续相同命令不再弹窗、自动注入拒绝。"""
    import json as _json

    class _FakeStdin:
        def __init__(self):
            self.written = b""
            self.closed = False

        def write(self, data):
            self.written += data

        async def drain(self):
            return None

        def is_closing(self):
            return self.closed

        def close(self):
            self.closed = True

    class _FakeProc:
        def __init__(self):
            self.stdin = _FakeStdin()
            self.stdout = asyncio.StreamReader()
            self.stderr = asyncio.StreamReader()
            self.stderr.feed_eof()
            self.returncode = 0
            self.terminated = False

        async def wait(self) -> int:
            return self.returncode

        def terminate(self):
            self.terminated = True

        def kill(self):
            self.terminated = True

    process = _FakeProc()
    process.stdout.feed_data((
        '{"type":"system","subtype":"init","session_id":"sess-1"}\n'
        '{"type":"assistant","message":{"content":[{"type":"tool_use",'
        '"id":"toolu-1","name":"Bash","input":{"command":"rm tmp.txt"}}]}}\n'
        '{"type":"user","message":{"content":[{"type":"tool_result",'
        '"tool_use_id":"toolu-1","content":"This command requires approval",'
        '"is_error":true}]}}\n'
        '{"type":"assistant","message":{"content":[{"type":"tool_use",'
        '"id":"toolu-2","name":"Bash","input":{"command":"rm tmp.txt"}}]}}\n'
        '{"type":"user","message":{"content":[{"type":"tool_result",'
        '"tool_use_id":"toolu-2","content":"This command requires approval",'
        '"is_error":true}]}}\n'
    ).encode())
    process.stdout.feed_eof()

    async def fake_create_subprocess_exec(*args, **kwargs):
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(
        ClaudeCodeEngine, "resolve_binary", staticmethod(lambda: "/fake/claude")
    )
    monkeypatch.setattr(
        "engines.claude_code.config_store.get_claude_permission_mode",
        lambda: "default",
    )

    engine = ClaudeCodeEngine()
    request_seen = asyncio.Event()
    requests = []

    async def consume():
        async for event in engine.spawn(
            prompt="hi",
            cwd="/tmp",
            live_message_queue=asyncio.Queue(),
        ):
            if event.type == "interaction_request":
                requests.append(event.data)
                request_seen.set()

    consumer = asyncio.create_task(consume())
    await asyncio.wait_for(request_seen.wait(), timeout=5)
    assert len(requests) == 1

    delivered = await engine.respond_interaction(requests[0], {
        "outcome": {"outcome": "selected", "option_id": "reject_for_session"},
    })
    assert delivered is True
    await asyncio.wait_for(consumer, timeout=5)

    # 第二次相同命令被自动拒绝：不再弹窗，且注入到 toolu-2。
    assert len(requests) == 1
    written = process.stdin.written.decode()
    tool_result_lines = [
        line for line in written.splitlines()
        if '"tool_result"' in line
    ]
    assert len(tool_result_lines) == 2, written
    injected = _json.loads(tool_result_lines[-1])
    content = injected["message"]["content"][0]
    assert content["tool_use_id"] == "toolu-2"
    assert "will be rejected" in content["content"]


def test_codex_map_turn_completed():
    engine = CodexEngine()
    event = engine._map_event({
        "type": "turn.completed",
        "usage": {"input_tokens": 200, "output_tokens": 100},
    })
    assert event is not None
    assert event.type == "usage_update"
    assert event.data["input_tokens"] == 200
    assert event.data["used"] == 300


def test_codex_cli_maps_context_compacted_and_declares_event():
    engine = CodexEngine()

    event = engine._map_event({
        "type": "context_compacted",
        "summary": "保留任务目标与已完成步骤",
    })

    assert event is not None
    assert event.type == "compacted"
    assert event.data == {"summary": "保留任务目标与已完成步骤"}
    assert "compacted" in engine.acp_events


def test_codex_cli_maps_plan_snapshot_when_transport_emits_it():
    event = CodexEngine()._map_event({
        "type": "turn.plan.updated",
        "explanation": "按步骤执行",
        "plan": [
            {"step": "修改代码", "status": "inProgress"},
            {"step": "运行测试", "status": "pending"},
        ],
    })

    assert event is not None
    assert event.type == "plan"
    assert event.data["entries"][0] == {
        "content": "修改代码", "priority": "medium", "status": "in_progress",
    }


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
    assert event.type == "usage_update"
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
    assert event.type == "usage_update"
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
    assert 'model_reasoning_summary="detailed"' in cmd
    assert "model_supports_reasoning_summaries=true" in cmd


@pytest.mark.anyio
async def test_codex_spawn_passes_compaction_overrides_for_new_and_resume(monkeypatch):
    captured = []

    async def fake_create_subprocess_exec(program, *args, **kwargs):
        captured.append([program, *args])
        return _FakeCodexProcess(stdout=b"", stderr=b"")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(CodexEngine, "resolve_binary", staticmethod(lambda: "/fake/codex"))

    async for _event in CodexEngine().spawn(
        prompt="hello",
        cwd="/tmp",
        session_id="resume-1",
        config_overrides={
            "model_auto_compact_token_limit": 8000,
            "model_auto_compact_token_limit_scope": "total",
        },
    ):
        pass

    cmd = captured[0]
    assert "-c" in cmd
    assert "model_auto_compact_token_limit=8000" in cmd
    assert "model_auto_compact_token_limit_scope=\"total\"" in cmd


@pytest.mark.anyio
async def test_claude_spawn_passes_compaction_override_only_to_child(monkeypatch):
    captured = {}

    async def fake_create_subprocess_exec(program, *args, **kwargs):
        captured["env"] = kwargs.get("env")
        return _FakeCodexProcess(stdout=b"", stderr=b"")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(ClaudeCodeEngine, "resolve_binary", staticmethod(lambda: "/fake/claude"))
    monkeypatch.setattr(
        "engines.claude_code.config_store.get_claude_permission_mode",
        lambda: "default",
    )

    async for _event in ClaudeCodeEngine().spawn(
        prompt="hello",
        cwd="/tmp",
        config_overrides={"autocompact_pct_override": 5},
    ):
        pass

    assert captured["env"]["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"] == "5"
    assert os.environ.get("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE") is None


@pytest.mark.anyio
async def test_claude_spawn_injects_custom_settings_env_and_flags(monkeypatch):
    """custom_settings: env 注入子进程环境，其余键合并进 --settings 传给 CLI。"""
    import json as _json

    captured = {}

    async def fake_create_subprocess_exec(program, *args, **kwargs):
        captured["cmd"] = [program, *args]
        captured["env"] = kwargs.get("env")
        return _FakeCodexProcess(stdout=b"", stderr=b"")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(
        ClaudeCodeEngine, "resolve_binary", staticmethod(lambda: "/fake/claude")
    )
    monkeypatch.setattr(
        "engines.claude_code.config_store.get_claude_permission_mode",
        lambda: "default",
    )
    custom = _json.dumps({
        "env": {
            "ANTHROPIC_BASE_URL": "http://192.168.50.21:3000",
            "CLAUDE_CODE_EFFORT_LEVEL": "max",
        },
        "permissions": {"ask": ["Bash(rm\\s)"]},
        "model": "sonnet",
    })
    monkeypatch.setattr(
        "engines.claude_code.config_store.get_claude_code_config",
        lambda: {"model_map": "", "custom_settings": custom},
    )

    async for _event in ClaudeCodeEngine().spawn(prompt="hello", cwd="/tmp"):
        pass

    cmd = captured["cmd"]
    assert captured["env"]["ANTHROPIC_BASE_URL"] == "http://192.168.50.21:3000"
    assert captured["env"]["CLAUDE_CODE_EFFORT_LEVEL"] == "max"
    assert os.environ.get("CLAUDE_CODE_EFFORT_LEVEL") is None
    settings_index = cmd.index("--settings")
    merged = _json.loads(cmd[settings_index + 1])
    # 其余键（不含 env）合并进 settings；skillOverrides 保留。
    assert merged["permissions"] == {"ask": ["Bash(rm\\s)"]}
    assert merged["model"] == "sonnet"
    assert "env" not in merged
    assert merged["skillOverrides"] == {}


@pytest.mark.anyio
async def test_codex_spawn_injects_custom_config_and_skips_managed_keys(monkeypatch):
    """自定义 config 覆盖按 key=value 透传 -c；已托管的键不重复注入。"""
    captured = {}

    async def fake_create_subprocess_exec(program, *args, **kwargs):
        captured["cmd"] = [program, *args]
        return _FakeCodexProcess(stdout=b"", stderr=b"")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(CodexEngine, "resolve_binary", staticmethod(lambda: "/fake/codex"))
    monkeypatch.setattr(
        "engines.codex.config_store.get_codex_config",
        lambda: {
            "sandbox_mode": "workspace-write",
            "model_reasoning_effort": "high",
            "approval_policy": "never",
            "custom_config": (
                "model_context_window = 128000\n"
                "# comment line\n"
                "model_reasoning_effort = low\n"
                "model_max_output_tokens = 8192\n"
            ),
        },
    )

    async for _event in CodexEngine().spawn(prompt="hello", cwd="/tmp"):
        pass

    cmd = captured["cmd"]
    joined = list(zip(cmd, cmd[1:]))
    configs = [value for flag, value in joined if flag == "-c"]
    assert "model_context_window=128000" in configs
    assert "model_max_output_tokens=8192" in configs
    # 已由 WorkStep 的推理强度设置的键，自定义覆盖不得重复注入。
    assert not any(item.startswith("model_reasoning_effort=") and item.endswith("=low") for item in configs)
    assert "model_reasoning_effort=high" in configs


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

    assert [event.type for event in events] == ["status", "agent_message_chunk", "status"]
    assert events[1].data["content"]["text"] == "WORKSTEP_ENGINE_OK"


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
    assert engine.get_permission_mode() == "ask"
    assert engine.supports_resume is True
    assert engine.build_resume_params("session-1") == {
        "session_id": "session-1"
    }


def test_hermes_map_update_text():
    engine = HermesEngine()
    event = engine._map_update({
        "type": "agent_message_chunk",
        "content": {"type": "text", "text": "Hello"},
    })
    assert event is not None
    assert event.type == "agent_message_chunk"
    assert event.data["content"]["text"] == "Hello"

def test_hermes_map_update_thinking():
    engine = HermesEngine()
    event = engine._map_update({
        "type": "agent_thought_chunk",
        "content": {"type": "text", "text": "thinking..."},
    })
    assert event is not None
    assert event.type == "agent_thought_chunk"


def test_hermes_map_update_tool_call():
    engine = HermesEngine()
    event = engine._map_update({
        "type": "tool_call",
        "id": "tc1",
        "name": "Edit",
        "input": {"file_path": "/a.py"},
    })
    assert event is not None
    assert event.type == "tool_call"
    assert event.data["title"] == "Edit"


def test_hermes_map_update_tool_result():
    engine = HermesEngine()
    event = engine._map_update({
        "type": "tool_call_update",
        "id": "tc1",
        "output": "done",
        "status": "completed",
    })
    assert event is not None
    assert event.type == "tool_call_update"
    assert event.data["status"] == "completed"


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
    assert event.type == "usage_update"
    assert event.data["input_tokens"] == 300
    assert event.data["output_tokens"] == 100
    assert event.data["cache_creation_input_tokens"] == 150
    assert event.data["cache_read_input_tokens"] == 120
    assert event.data["used"] == 400


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
    assert event.type == "usage_update"
    assert event.data["cost"] == {"amount": 1.5, "currency": "CNY"}


# --- ACP Engines ---


def test_acp_plan_update_maps_to_unified_snapshot():
    from acp import schema

    event = HermesEngine()._map_notification(schema.Plan(entries=[
        schema.PlanEntry(
            content="实现协议映射",
            priority="high",
            status="in_progress",
        ),
        schema.PlanEntry(
            content="运行回归测试",
            priority="medium",
            status="pending",
        ),
    ]))

    assert event is not None
    assert event.type == "plan"
    assert event.data["entries"] == [
        {"content": "实现协议映射", "priority": "high", "status": "in_progress"},
        {"content": "运行回归测试", "priority": "medium", "status": "pending"},
    ]


def test_acp_usage_update_includes_canonical_token_fields():
    from acp import schema

    event = HermesEngine()._map_notification(schema.UsageUpdate(
        used=320,
        size=200000,
        sessionUpdate="usage_update",
    ))

    assert event is not None
    assert event.type == "usage_update"
    assert event.data["total_tokens"] == 320
    assert event.data["context_window"] == 200000
    assert event.data["used"] == 320
    assert event.data["size"] == 200000


@pytest.mark.anyio
async def test_acp_resume_failure_is_explicit_and_does_not_start_new_session(
    monkeypatch,
):
    from engines.core.acp_base import AcpEngineBase

    class TestEngine(AcpEngineBase):
        COMMAND = ["fake-acp"]
        ENGINE_ID = "test-acp"

        @staticmethod
        def is_installed():
            return True

        @staticmethod
        def get_version():
            return "test"

        @staticmethod
        def resolve_binary():
            return "fake-acp"

    class Client:
        new_session_calls = 0

        async def initialize(self, **kwargs):
            return None

        async def load_session(self, **kwargs):
            raise RuntimeError("session missing")

        async def new_session(self, **kwargs):
            self.new_session_calls += 1
            return _SdkFake(session_id="new-session")

    client = Client()

    @asynccontextmanager
    async def fake_spawn(*args, **kwargs):
        yield client, _SdkFake()

    monkeypatch.setattr("engines.core.acp_base.acp.spawn_agent_process", fake_spawn)

    events = [event async for event in TestEngine().spawn(
        prompt="继续", cwd="/tmp", session_id="missing-session"
    )]

    assert [event.type for event in events] == ["status", "error"]
    assert "missing-session" in events[1].data["message"]
    assert client.new_session_calls == 0


@pytest.mark.anyio
async def test_acp_finished_turn_does_not_wait_for_late_live_message(monkeypatch):
    """A live message must already be queued when a turn finishes to continue."""
    from engines.core.acp_base import AcpEngineBase

    class TestEngine(AcpEngineBase):
        COMMAND = ["fake-acp"]
        ENGINE_ID = "test-acp"

        @staticmethod
        def is_installed():
            return True

        @staticmethod
        def get_version():
            return "test"

        @staticmethod
        def resolve_binary():
            return "fake-acp"

    class Client:
        def __init__(self):
            self.prompts: list[str] = []

        async def initialize(self, **kwargs):
            return None

        async def new_session(self, **kwargs):
            return _SdkFake(session_id="session-1")

        async def prompt(self, *, prompt, **kwargs):
            self.prompts.append(prompt[0].text)
            return _SdkFake(usage=None)

    client = Client()

    @asynccontextmanager
    async def fake_spawn(*args, **kwargs):
        yield client, _SdkFake()

    monkeypatch.setattr("engines.core.acp_base.acp.spawn_agent_process", fake_spawn)
    queue: asyncio.Queue = asyncio.Queue()

    async def enqueue_after_completion():
        # The ACP notification pump polls at 0.1s. Arrive after it observes the
        # completed prompt, but inside the former 0.05s insertion grace.
        await asyncio.sleep(0.12)
        await queue.put(("late-1", "迟到的插入消息"))

    producer = asyncio.create_task(enqueue_after_completion())
    events: list[InternalEvent] = []

    async def consume():
        async for event in TestEngine().spawn(
            prompt="开始任务",
            cwd="/tmp",
            live_message_queue=queue,
        ):
            events.append(event)

    await asyncio.wait_for(consume(), timeout=0.3)
    await producer

    assert client.prompts == ["开始任务"]
    assert queue.qsize() == 1
    assert not any(event.type == "live_message" for event in events)


@pytest.mark.anyio
async def test_claude_acp_permission_policy_respects_confirmed_mode():
    from types import SimpleNamespace
    from engines.core.acp_base import _StreamingClient

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
    from engines.core.acp_base import _StreamingClient

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

    interaction = await client.updates.get()
    assert interaction.type == "interaction_request"
    assert interaction.data["method"] == "session/request_permission"
    assert interaction.data["options"][0]["option_id"] == "allow-once"

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
async def test_acp_client_returns_the_exact_permission_option_selected_by_user():
    from types import SimpleNamespace
    from engines.core.acp_base import _StreamingClient

    client = _StreamingClient(permission_mode="ask")
    options = [
        SimpleNamespace(kind="allow_once", option_id="allow-once", name="允许一次"),
        SimpleNamespace(kind="allow_always", option_id="allow-always", name="始终允许"),
    ]
    request_task = asyncio.create_task(client.request_permission(
        "session-1",
        SimpleNamespace(
            tool_call_id="tool-1",
            title="Bash",
            kind="execute",
            raw_input={"command": "pytest"},
        ),
        options,
    ))
    await asyncio.sleep(0)
    await client.updates.get()

    assert client.resolve_permission("tool-1", "allow-always") is True
    response = await request_task
    assert response.outcome.option_id == "allow-always"


@pytest.mark.anyio
async def test_acp_client_form_elicitation_waits_for_structured_user_input():
    from types import SimpleNamespace
    from engines.core.acp_base import _StreamingClient

    client = _StreamingClient(permission_mode="ask")
    mode = SimpleNamespace(
        session_id="session-1",
        tool_call_id="ask-1",
        requested_schema=SimpleNamespace(model_dump=lambda **kwargs: {
            "type": "object",
            "properties": {"answer": {"type": "string"}},
            "required": ["answer"],
        }),
    )
    request_task = asyncio.create_task(client.create_elicitation(
        "请输入答案",
        mode,
    ))
    await asyncio.sleep(0)

    interaction = await client.updates.get()
    assert interaction.type == "interaction_request"
    assert interaction.data["method"] == "elicitation/create"
    assert interaction.data["session_id"] == "session-1"
    assert interaction.data["tool_call_id"] == "ask-1"
    interaction_id = interaction.data["interaction_id"]
    assert client.resolve_elicitation(interaction_id, {
        "action": "accept",
        "content": {"answer": "继续"},
    }) is True

    response = await request_task
    assert response.action == "accept"
    assert response.content == {"answer": "继续"}


@pytest.mark.anyio
async def test_acp_client_ask_mode_rejects_when_denied():
    from types import SimpleNamespace
    from engines.core.acp_base import _StreamingClient

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
    from engines.core.acp_base import _StreamingClient

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


@pytest.mark.anyio
async def test_claude_agent_sdk_ask_user_callback_round_trips_answers():
    engine = ClaudeAgentSDKEngine()
    events = []
    tool_input = {
        "questions": [{
            "header": "方案",
            "question": "选择方案",
            "multiSelect": False,
            "options": [{"label": "A", "description": "方案 A"}],
        }],
    }
    waiting = asyncio.create_task(engine.handle_tool_permission(
        events.append,
        tool_name="AskUserQuestion",
        tool_input=tool_input,
        tool_use_id="ask-1",
        title="选择方案",
    ))
    await asyncio.sleep(0)

    request = events[0]
    assert request.type == "interaction_request"
    assert await engine.respond_interaction(request.data, {
        "action": "accept",
        "content": {"question_0": "A"},
    }) is True
    allowed, updated_input = await waiting
    assert allowed is True
    assert updated_input == {
        "questions": tool_input["questions"],
        "answers": {"选择方案": "A"},
    }


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
    from engines.core.registry import get_available_engines, refresh_registry

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


def test_claude_agent_sdk_resume():
    engine = ClaudeAgentSDKEngine()
    assert engine.supports_resume is True
    assert engine.build_resume_params("session-1") == {
        "session_id": "session-1"
    }
    assert engine.supports_interactive is True
    assert engine.supports_live_stage_message is True


def test_claude_agent_sdk_maps_system_init():
    engine = ClaudeAgentSDKEngine()
    msg = _SdkFake(type="system", subtype="init", data={"session_id": "session-1"})
    events = engine._map_message(msg)
    assert [event.type for event in events] == ["status", "session_started"]
    assert events[0].data["status"] == "initializing"
    assert events[1].data["session_id"] == "session-1"


def test_claude_agent_sdk_maps_partial_stream_without_final_text_duplicate():
    from claude_agent_sdk.types import AssistantMessage, StreamEvent, TextBlock

    engine = ClaudeAgentSDKEngine()
    state = {
        "emitted_text": False,
        "streamed_text": False,
        "streamed_thinking": False,
        "session_started": False,
    }
    partial = engine._map_message(StreamEvent(
        uuid="u1",
        session_id="session-1",
        event={
            "type": "content_block_delta",
            "delta": {"type": "text_delta", "text": "增量"},
        },
    ), state)
    completed = engine._map_message(AssistantMessage(
        content=[TextBlock(text="增量")], model="sonnet"
    ), state)

    assert [event.type for event in partial] == ["session_started", "agent_message_chunk"]
    assert partial[1].data["content"]["text"] == "增量"
    assert completed == []


def test_claude_agent_sdk_maps_assistant_text():
    engine = ClaudeAgentSDKEngine()
    block = _SdkFake(type="text", text="你好，Claude！")
    message = _SdkFake(content=[block])
    msg = _SdkFake(type="assistant", message=message)
    events = engine._map_message(msg)
    assert [event.type for event in events] == ["agent_message_chunk"]
    assert events[0].data["content"]["text"] == "你好，Claude！"


def test_claude_agent_sdk_maps_thinking_and_tool_use():
    engine = ClaudeAgentSDKEngine()
    message = _SdkFake(content=[
        _SdkFake(type="thinking", thinking="让我想想"),
        _SdkFake(type="tool_use", id="tool-1", name="Read", input={"path": "a.py"}),
    ])
    msg = _SdkFake(type="assistant", message=message)
    events = engine._map_message(msg)
    assert [event.type for event in events] == ["agent_thought_chunk", "tool_call"]
    assert events[0].data["content"]["text"] == "让我想想"
    assert events[1].data["tool_call_id"] == "tool-1"
    assert events[1].data["title"] == "Read"
    assert events[1].data["raw_input"] == {"path": "a.py"}


def test_claude_agent_sdk_maps_tool_result():
    engine = ClaudeAgentSDKEngine()
    message = _SdkFake(content=[
        _SdkFake(type="tool_result", tool_use_id="tool-1", content="file content", is_error=False),
    ])
    msg = _SdkFake(type="user", message=message)
    events = engine._map_message(msg)
    assert [event.type for event in events] == ["tool_call_update"]
    assert events[0].data["tool_call_id"] == "tool-1"
    assert events[0].data["raw_output"] == "file content"
    assert events[0].data["status"] == "completed"


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
    assert [event.type for event in events] == ["usage_update", "status"]
    usage = events[0].data
    assert usage["input_tokens"] == 100
    assert usage["output_tokens"] == 30
    assert usage["cache_creation_input_tokens"] == 40
    assert usage["cache_read_input_tokens"] == 20
    assert usage["used"] == 130
    assert "size" not in usage
    assert usage["cost"] == {"amount": 0.12, "currency": "USD"}
    assert events[1].data["status"] == "done"


def test_claude_agent_sdk_assistant_usage_is_a_context_snapshot():
    engine = ClaudeAgentSDKEngine()
    msg = _SdkFake(
        type="assistant",
        content=[],
        usage={
            "input_tokens": 100,
            "cache_creation_input_tokens": 40,
            "cache_read_input_tokens": 20,
            "output_tokens": 30,
        },
    )

    events = engine._map_message(msg)

    assert [event.type for event in events] == ["usage_update"]
    assert events[0].data["used"] == 190
    assert events[0].data["size"] == 256_000


@pytest.mark.anyio
async def test_claude_agent_sdk_spawn_prefers_live_context_usage(monkeypatch):
    import claude_agent_sdk as sdk_module

    class _ClaudeClientContextUsage:
        def __init__(self, options=None, transport=None):
            self.options = options

        async def connect(self, prompt=None):
            pass

        async def query(self, prompt, session_id="default", **kwargs):
            if hasattr(prompt, "__aiter__"):
                async for _ in prompt:
                    pass

        async def receive_messages(self):
            yield _SdkFake(
                type="result",
                result="",
                is_error=False,
                usage={"input_tokens": 900_000, "output_tokens": 100_000},
                session_id="s1",
            )

        async def get_context_usage(self):
            return {
                "totalTokens": 42_000,
                "rawMaxTokens": 256_000,
                "maxTokens": 243_200,
                "percentage": 16.4,
            }

        async def disconnect(self):
            pass

    monkeypatch.setattr(sdk_module, "ClaudeSDKClient", _ClaudeClientContextUsage)
    monkeypatch.setattr(
        ClaudeAgentSDKEngine, "resolve_binary", staticmethod(lambda: "/fake/claude")
    )
    monkeypatch.setattr(
        "engines.claude_agent_sdk.config_store.get_claude_agent_sdk_config",
        lambda: {
            "permission_mode": "acceptEdits",
            "max_turns": "",
            "fallback_model": "",
        },
    )

    events = [
        event
        async for event in ClaudeAgentSDKEngine().spawn(prompt="hi", cwd="/tmp")
    ]
    usage_events = [event.data for event in events if event.type == "usage_update"]

    assert usage_events[0]["used"] == 42_000
    assert usage_events[0]["size"] == 256_000
    assert usage_events[1]["used"] == 1_000_000
    assert "size" not in usage_events[1]


def test_claude_agent_sdk_result_falls_back_to_output():
    """Result output is emitted as text when no text blocks were streamed."""
    engine = ClaudeAgentSDKEngine()
    result = _SdkFake(is_error=False, output="最终答案", subtype="success", usage=None)
    msg = _SdkFake(type="result", result=result)
    events = engine._map_message(msg, state={"emitted_text": False})
    assert [event.type for event in events] == ["agent_message_chunk", "status"]
    assert events[0].data["content"]["text"] == "最终答案"


def test_claude_agent_sdk_result_error():
    engine = ClaudeAgentSDKEngine()
    result = _SdkFake(is_error=True, output="", subtype="error_during_execution", usage=None)
    msg = _SdkFake(type="result", result=result)
    events = engine._map_message(msg, state={"emitted_text": False})
    assert [event.type for event in events] == ["error"]
    assert "error_during_execution" in events[0].data["message"]


def test_claude_agent_sdk_result_error_surfaces_cli_error_text():
    """SDK ≥0.2.130 认证失败时 subtype 仍为 success，真实原因在 result 文本里。

    复现：捆绑 claude CLI 未登录时，ResultMessage 回写
    ``result="Not logged in · Please run /login"``（terminal_reason=api_error、
    errors=None），旧映射只能给出无提示的兜底文案。
    """
    engine = ClaudeAgentSDKEngine()
    msg = _SdkFake(
        type="result",
        subtype="success",
        is_error=True,
        result="Not logged in · Please run /login",
        terminal_reason="api_error",
        errors=None,
        api_error_status=None,
        usage=None,
    )
    events = engine._map_message(msg, state={"emitted_text": True})
    assert [event.type for event in events] == ["error"]
    assert events[0].data["message"] == "Not logged in · Please run /login"


def test_claude_agent_sdk_result_error_prefers_errors_list_and_marker():
    """errors 列表最具体；无描述文本时回退到助手消息的 error 标记。"""
    engine = ClaudeAgentSDKEngine()

    listed = _SdkFake(
        type="result",
        subtype="success",
        is_error=True,
        result=None,
        errors=["API Error: 401 authentication failed"],
        api_error_status=401,
        terminal_reason="api_error",
        usage=None,
    )
    events = engine._map_message(listed, state={"emitted_text": True})
    assert events[0].data["message"] == "API Error: 401 authentication failed"

    state: dict = {"emitted_text": True}
    assistant = _SdkFake(
        type="assistant",
        message=_SdkFake(content=[_SdkFake(type="text", text="Not logged in")]),
        error="authentication_failed",
    )
    engine._map_message(assistant, state)
    bare = _SdkFake(
        type="result",
        subtype="success",
        is_error=True,
        result=None,
        errors=None,
        api_error_status=None,
        terminal_reason="api_error",
        usage=None,
    )
    events = engine._map_message(bare, state)
    assert events[0].data["message"] == "authentication_failed"


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




def test_claude_agent_sdk_maps_subagent_task_lifecycle():
    """SDK subagent system messages map to subagent InternalEvents."""
    from claude_agent_sdk.types import (
        SystemMessage,
        TaskNotificationMessage,
        TaskProgressMessage,
        TaskStartedMessage,
        TaskUpdatedMessage,
    )

    engine = ClaudeAgentSDKEngine()

    started = engine._map_message(TaskStartedMessage(
        subtype="task_started",
        data={"task_id": "task-7"},
        task_id="task-7",
        description="实现后端",
        uuid="u1",
        session_id="s1",
        tool_use_id="task-call-1",
        task_type="chain",
    ))
    progress = engine._map_message(TaskProgressMessage(
        subtype="task_progress",
        data={"task_id": "task-7"},
        task_id="task-7",
        description="实现后端",
        usage={"input_tokens": 10},
        uuid="u2",
        session_id="s1",
        last_tool_name="Edit",
    ))
    updated = engine._map_message(TaskUpdatedMessage(
        subtype="task_updated",
        data={"task_id": "task-7"},
        task_id="task-7",
        patch={"status": "completed"},
    ))
    failed = engine._map_message(TaskNotificationMessage(
        subtype="task_notification",
        data={"task_id": "task-8"},
        task_id="task-8",
        status="failed",
        output_file="logs/task-8.json",
        summary="工具执行错误",
        uuid="u3",
        session_id="s1",
    ))

    assert [event.type for event in started] == ["subagent"]
    assert started[0].data == {
        "task_id": "task-7",
        "status": "running",
        "stage": "started",
        "description": "实现后端",
        "tool_use_id": "task-call-1",
        "task_type": "chain",
    }
    assert progress[0].data["status"] == "running"
    assert progress[0].data["stage"] == "progress"
    assert progress[0].data["last_tool_name"] == "Edit"
    assert progress[0].data["usage"] == {"input_tokens": 10}
    assert updated[0].data["status"] == "completed"
    assert updated[0].data["stage"] == "updated"
    assert failed[0].data["status"] == "failed"
    assert failed[0].data["summary"] == "工具执行错误"
    assert failed[0].data["output_file"] == "logs/task-8.json"


def test_claude_agent_sdk_maps_generic_system_task_frames():
    """Raw ``SystemMessage`` task frames (e.g. ``task_updated``) also map."""
    from claude_agent_sdk.types import SystemMessage

    engine = ClaudeAgentSDKEngine()
    msg = SystemMessage(
        subtype="task_updated",
        data={"task_id": "task-7", "patch": {"status": "killed"}},
    )
    events = engine._map_message(msg)

    assert [event.type for event in events] == ["subagent"]
    assert events[0].data["status"] == "killed"


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
        "agent_thought_chunk",
        "agent_message_chunk",
        "tool_call",
    ]
    assert events[2].data == {
        "tool_call_id": "tool-1",
        "title": "Read",
        "raw_input": {"path": "a.py"},
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
    assert [event.type for event in events] == ["tool_call_update"]
    assert events[0].data == {
        "tool_call_id": "tool-1",
        "status": "completed",
        "raw_output": "file content",
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
    assert [event.type for event in events] == ["agent_message_chunk", "usage_update", "status"]
    assert events[0].data["content"]["text"] == "最终答案"
    usage = events[1].data
    assert usage["input_tokens"] == 100
    assert usage["output_tokens"] == 30
    assert usage["cache_creation_input_tokens"] == 40
    assert usage["cache_read_input_tokens"] == 20
    assert usage["cost"] == {"amount": 0.12, "currency": "USD"}
    assert usage["session_id"] == "s1"


@pytest.mark.anyio
async def test_claude_agent_sdk_spawn_uses_modern_query_api(monkeypatch):
    """The adapter drives ClaudeSDKClient with ClaudeAgentOptions and streams the
    initial prompt via query() (interactive mode, not batch query())."""
    import claude_agent_sdk as sdk_module

    captured = {}

    class _ClaudeClientCapture:
        def __init__(self, options=None, transport=None):
            self.options = options
            self.queries: list[str] = []
            captured["client"] = self

        async def connect(self, prompt=None):
            pass

        async def query(self, prompt, session_id="default", **kwargs):
            # 真实 SDK 消费流式输入源（初始 prompt + 注入消息）。
            if hasattr(prompt, "__aiter__"):
                async for message in prompt:
                    self.queries.append(message["message"]["content"])
            else:
                self.queries.append(prompt)

        async def receive_messages(self):
            if False:  # pragma: no cover
                yield None

        async def disconnect(self):
            pass

    monkeypatch.setattr(sdk_module, "ClaudeSDKClient", _ClaudeClientCapture)
    monkeypatch.setattr(
        ClaudeAgentSDKEngine, "resolve_binary", staticmethod(lambda: "/fake/claude")
    )
    monkeypatch.setattr(
        "engines.claude_agent_sdk.config_store.get_claude_agent_sdk_config",
        lambda: {
            "permission_mode": "acceptEdits",
            "max_turns": "25",
            "fallback_model": "claude-haiku-latest",
        },
    )

    engine = ClaudeAgentSDKEngine()
    live_queue: asyncio.Queue = asyncio.Queue()
    events = [
        event
        async for event in engine.spawn(
            prompt="hi",
            cwd="/tmp",
            model="sonnet",
            add_dirs=["/repo/src"],
            session_id="session-1",
            live_message_queue=live_queue,
        )
    ]
    assert [event.type for event in events] == ["status"]
    client = captured["client"]
    assert client.queries == ["hi"]
    options = client.options
    assert options.cli_path == "/fake/claude"
    assert options.cwd == "/tmp"
    assert options.model == "sonnet"
    assert options.permission_mode == "acceptEdits"
    assert options.max_turns == 25
    assert options.fallback_model == "claude-haiku-latest"
    assert options.add_dirs == ["/repo/src"]
    assert options.resume == "session-1"
    assert options.include_partial_messages is True
    # resume 有明确会话目标时不得再设置 --continue，否则会覆盖 --resume
    # 并串到目录最近会话（阶段/审核会话互相污染）。
    assert options.continue_conversation is False
    assert engine.supports_resume is True


@pytest.mark.anyio
async def test_claude_agent_sdk_spawn_injects_custom_settings_env_and_options(monkeypatch):
    """custom_settings: env 进子进程环境，其余键合并进 SDK settings。"""
    import claude_agent_sdk as sdk_module
    import json as _json

    captured = {}

    class _ClaudeClientCapture:
        def __init__(self, options=None, transport=None):
            self.options = options
            captured["client"] = self

        async def connect(self, prompt=None):
            pass

        async def query(self, prompt, session_id="default", **kwargs):
            if hasattr(prompt, "__aiter__"):
                async for _message in prompt:
                    pass

        async def receive_messages(self):
            if False:  # pragma: no cover
                yield None

        async def disconnect(self):
            pass

    monkeypatch.setattr(sdk_module, "ClaudeSDKClient", _ClaudeClientCapture)
    monkeypatch.setattr(
        ClaudeAgentSDKEngine, "resolve_binary", staticmethod(lambda: "/fake/claude")
    )
    custom = _json.dumps({
        "env": {"ANTHROPIC_AUTH_TOKEN": "sk-test", "CLAUDE_CODE_EFFORT_LEVEL": "max"},
        "permissions": {"ask": ["Bash(rm\\s)"]},
        "model": "sonnet",
    })
    monkeypatch.setattr(
        "engines.claude_agent_sdk.config_store.get_claude_agent_sdk_config",
        lambda: {
            "permission_mode": "acceptEdits",
            "max_turns": "",
            "fallback_model": "",
            "model_map": "",
            "custom_settings": custom,
        },
    )

    events = [
        event
        async for event in ClaudeAgentSDKEngine().spawn(prompt="hi", cwd="/tmp")
    ]
    assert [event.type for event in events] == ["status"]
    options = captured["client"].options
    assert options.env["ANTHROPIC_AUTH_TOKEN"] == "sk-test"
    assert options.env["CLAUDE_CODE_EFFORT_LEVEL"] == "max"
    assert os.environ.get("ANTHROPIC_AUTH_TOKEN") is None
    merged = _json.loads(options.settings)
    assert merged["permissions"] == {"ask": ["Bash(rm\\s)"]}
    assert merged["model"] == "sonnet"
    assert "env" not in merged
    assert merged["skillOverrides"] == {}


@pytest.mark.anyio
async def test_claude_agent_sdk_can_use_tool_permission_round_trip(monkeypatch):
    """can_use_tool 权限回调 → interaction_request 弹窗 → 用户允许 → PermissionResultAllow。

    Covers the full spawn-level permission flow: the SDK callback blocks until
    respond_interaction delivers the user's choice, then the run continues.
    """
    import claude_agent_sdk as sdk_module
    from types import SimpleNamespace

    permission_result = {}

    class _ClaudeClientPermission:
        def __init__(self, options=None, transport=None):
            self.options = options

        async def connect(self, prompt=None):
            pass

        async def query(self, prompt, session_id="default", **kwargs):
            pass

        async def receive_messages(self):
            result = await self.options.can_use_tool(
                "Bash",
                {"command": "ls"},
                SimpleNamespace(tool_use_id="tool-1", title="Bash"),
            )
            permission_result["allowed"] = isinstance(
                result, sdk_module.PermissionResultAllow
            )
            yield _SdkFake(
                type="result",
                result="done",
                is_error=False,
                usage={"input_tokens": 5, "output_tokens": 5},
                session_id="s1",
            )

        async def disconnect(self):
            pass

    monkeypatch.setattr(sdk_module, "ClaudeSDKClient", _ClaudeClientPermission)
    monkeypatch.setattr(
        ClaudeAgentSDKEngine, "resolve_binary", staticmethod(lambda: "/fake/claude")
    )
    monkeypatch.setattr(
        "engines.claude_agent_sdk.config_store.get_claude_agent_sdk_config",
        lambda: {
            "permission_mode": "acceptEdits",
            "max_turns": "",
            "fallback_model": "",
        },
    )

    engine = ClaudeAgentSDKEngine()
    collected = []
    request_seen = asyncio.Event()
    request_data = {}

    async def consume():
        async for event in engine.spawn(prompt="hi", cwd="/tmp"):
            if event.type == "interaction_request":
                request_data.update(event.data)
                request_seen.set()
            collected.append(event)

    consumer = asyncio.create_task(consume())
    await asyncio.wait_for(request_seen.wait(), timeout=5)

    assert request_data["method"] == "session/request_permission"
    assert request_data["tool_call"]["name"] == "Bash"
    assert request_data["session_id"] == "claude-agent-sdk"
    assert [o["option_id"] for o in request_data["options"]] == [
        "allow_once",
        "allow_for_session",
        "reject_once",
        "reject_for_session",
    ]

    delivered = await engine.respond_interaction(request_data, {
        "outcome": {"outcome": "selected", "option_id": "allow_once"},
    })
    assert delivered is True
    await asyncio.wait_for(consumer, timeout=5)

    assert permission_result.get("allowed") is True
    assert [event.type for event in collected][-1] == "status"


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
    from engines.core.registry import get_available_engines, refresh_registry

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


@pytest.mark.anyio
async def test_codex_sdk_list_models_uses_codex_config(monkeypatch):
    """模型发现必须遵守真实 SDK 的 ``AsyncCodex(config=...)`` 契约。"""
    import openai_codex as codex_module

    captured = {}

    class Model:
        id = "gpt-test"
        display_name = "GPT Test"
        description = "test model"
        hidden = False

    class Response:
        data = [Model()]

    class StrictClient:
        def __init__(self, config=None):
            captured["config"] = config

        async def models(self):
            return Response()

        async def close(self):
            return None

    monkeypatch.setattr(codex_module, "AsyncCodex", StrictClient)

    models = await CodexSDKEngine().list_models("/tmp/project")

    assert [model.id for model in models] == ["gpt-test"]
    assert captured["config"].cwd == "/tmp/project"


@pytest.mark.anyio
async def test_codex_sdk_list_models_propagates_sdk_errors(monkeypatch):
    """模型发现失败必须交给 API 呈现，不能伪装成成功的空列表。"""
    import openai_codex as codex_module

    class FailingClient:
        def __init__(self, config=None):
            pass

        async def models(self):
            raise RuntimeError("model discovery failed")

        async def close(self):
            return None

    monkeypatch.setattr(codex_module, "AsyncCodex", FailingClient)

    with pytest.raises(RuntimeError, match="model discovery failed"):
        await CodexSDKEngine().list_models("/tmp/project")


def test_codex_sdk_maps_compacted_notification():
    engine = CodexSDKEngine()
    notification = _SdkFake(method="thread/compacted", payload=_SdkFake())
    events = engine._map_notification(
        notification, {"emitted_text": False, "tool_emitted": set()}
    )
    assert [event.type for event in events] == ["compacted"]
    assert events[0].data == {}


def test_codex_sdk_maps_turn_plan_updated_to_acp_snapshot():
    engine = CodexSDKEngine()
    events = engine._map_notification(
        _SdkFake(
            method="turn/plan/updated",
            payload=_SdkFake(
                explanation="先实现后测试",
                plan=[
                    _SdkFake(step="实现功能", status=_SdkFake(value="inProgress")),
                    _SdkFake(step="运行测试", status=_SdkFake(value="pending")),
                ],
            ),
        ),
        {"emitted_text": False, "tool_emitted": set()},
    )

    assert [event.type for event in events] == ["plan"]
    assert events[0].data == {
        "entries": [
            {"content": "实现功能", "priority": "medium", "status": "in_progress"},
            {"content": "运行测试", "priority": "medium", "status": "pending"},
        ],
        "explanation": "先实现后测试",
    }


def test_codex_sdk_maps_started_and_text_delta():
    engine = CodexSDKEngine()
    notification = _SdkFake(
        method="item/agentMessage/delta",
        payload=_SdkFake(delta="你好，Codex！"),
    )
    state = {"emitted_text": False, "tool_emitted": set()}
    events = engine._map_notification(notification, state)
    assert [event.type for event in events] == ["agent_message_chunk"]
    assert events[0].data["content"]["text"] == "你好，Codex！"
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
    assert [event.type for event in events] == ["agent_thought_chunk"]
    assert events[0].data["content"]["text"] == "正在推理"

    completed = engine._map_notification(
        _SdkFake(
            method="item/completed",
            payload=_SdkFake(item=_SdkFake(root=_SdkFake(
                type="reasoning", content=["正在推理"], summary=[], id="r1",
            ))),
        ),
        state,
    )
    assert completed == []


def test_codex_sdk_maps_completed_reasoning_summary_to_thought_content():
    engine = CodexSDKEngine()
    state = {
        "emitted_text": False,
        "emitted_thinking": False,
        "tool_emitted": set(),
    }
    events = engine._map_notification(
        _SdkFake(
            method="item/completed",
            payload=_SdkFake(item=_SdkFake(root=_SdkFake(
                type="reasoning",
                content=[],
                summary=[
                    _SdkFake(type="summary_text", text="检查代码"),
                    _SdkFake(type="summary_text", text="验证修改"),
                ],
                id="r-summary",
            ))),
        ),
        state,
    )

    assert [event.type for event in events] == ["agent_thought_chunk"]
    assert events[0].data["content"]["text"] == "检查代码\n验证修改"


@pytest.mark.parametrize(
    ("root", "expected_name", "expected_input", "expected_result"),
    [
        (
            _SdkFake(type="commandExecution", id="cmd-1", command="ls", status="inProgress"),
            "Bash",
            {"command": "ls"},
            _SdkFake(
                type="commandExecution", id="cmd-1", command="ls",
                status="completed", aggregated_output="ok", exit_code=0,
            ),
        ),
        (
            _SdkFake(type="mcpToolCall", id="mcp-1", server="fs", tool="read", arguments={"path": "a"}, status="inProgress"),
            "fs/read",
            {"path": "a"},
            _SdkFake(
                type="mcpToolCall", id="mcp-1", server="fs", tool="read",
                arguments={"path": "a"}, status="completed", result="content", error=None,
            ),
        ),
        (
            _SdkFake(type="fileChange", id="patch-1", changes=["a.py"], status="inProgress"),
            "FileChange",
            {"changes": ["a.py"]},
            _SdkFake(type="fileChange", id="patch-1", changes=["a.py"], status="completed"),
        ),
        (
            _SdkFake(type="webSearch", id="web-1", query="WorkStep"),
            "WebSearch",
            {"query": "WorkStep"},
            _SdkFake(type="webSearch", id="web-1", query="WorkStep"),
        ),
    ],
)
def test_codex_sdk_maps_supported_tool_item_families(
    root, expected_name, expected_input, expected_result
):
    engine = CodexSDKEngine()
    state = {
        "emitted_text": False,
        "emitted_thinking": False,
        "tool_emitted": set(),
    }
    started = engine._map_notification(
        _SdkFake(method="item/started", payload=_SdkFake(item=_SdkFake(root=root))),
        state,
    )
    completed = engine._map_notification(
        _SdkFake(
            method="item/completed",
            payload=_SdkFake(item=_SdkFake(root=expected_result)),
        ),
        state,
    )

    assert [event.type for event in started] == ["tool_call"]
    assert started[0].data["title"] == expected_name
    assert started[0].data["raw_input"] == expected_input
    assert [event.type for event in completed] == ["tool_call_update"]


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
    assert [event.type for event in started] == ["tool_call"]
    assert started[0].data["tool_call_id"] == "tool-1"
    assert started[0].data["title"] == "Read"
    assert started[0].data["raw_input"] == {"path": "a.py"}
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
    assert [event.type for event in completed] == ["tool_call_update"]
    assert completed[0].data["tool_call_id"] == "tool-1"
    assert completed[0].data["raw_output"] == "file content"
    assert completed[0].data["status"] == "completed"


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
    assert [event.type for event in events] == ["agent_message_chunk"]
    assert events[0].data["content"]["text"] == "最终答案"

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


def test_codex_sdk_marks_intermediate_unphased_messages_as_commentary():
    engine = CodexSDKEngine()
    state = {"emitted_text": False, "tool_emitted": set()}

    first = engine._map_notification(
        _SdkFake(
            method="item/completed",
            payload=_SdkFake(item=_SdkFake(root=_SdkFake(
                type="agentMessage",
                id="progress",
                text="我先定位实现。",
            ))),
        ),
        state,
    )
    assert first == []

    tool = engine._map_notification(
        _SdkFake(
            method="item/started",
            payload=_SdkFake(item=_SdkFake(root=_SdkFake(
                type="commandExecution",
                id="tool-1",
                command="rg phase",
            ))),
        ),
        state,
    )
    assert [event.type for event in tool] == [
        "agent_message_chunk", "tool_call",
    ]
    assert tool[0].data["phase"] == "commentary"
    assert tool[0].data["source_item_id"] == "progress"

    final = engine._map_notification(
        _SdkFake(
            method="item/completed",
            payload=_SdkFake(item=_SdkFake(root=_SdkFake(
                type="agentMessage",
                id="answer",
                text="已完成。",
            ))),
        ),
        state,
    )
    assert final == []

    completed = engine._map_notification(
        _SdkFake(
            method="turn/completed",
            payload=_SdkFake(turn=_SdkFake(
                status=_SdkFake(value="completed"),
                error=None,
            )),
        ),
        state,
    )
    assert [event.type for event in completed] == [
        "agent_message_chunk", "status",
    ]
    assert completed[0].data["content"]["text"] == "已完成。"
    assert completed[0].data.get("phase") is None
    assert completed[0].data["source_item_id"] == "answer"


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
            model_context_window=400,
        )),
    )
    events = engine._map_notification(
        notification, {"emitted_text": False, "tool_emitted": set()}
    )
    assert [event.type for event in events] == ["usage_update"]
    usage = events[0].data
    assert usage["input_tokens"] == 100
    assert usage["output_tokens"] == 30
    assert usage["cache_read_input_tokens"] == 20
    assert usage["reasoning_output_tokens"] == 5
    assert usage["total_tokens"] == 150
    assert usage["used"] == 150
    assert usage["size"] == 400


def test_codex_sdk_cumulative_usage_without_last_is_not_a_context_snapshot():
    engine = CodexSDKEngine()
    notification = _SdkFake(
        method="thread/tokenUsage/updated",
        payload=_SdkFake(token_usage=_SdkFake(
            last=None,
            total=_SdkFake(
                input_tokens=900_000,
                output_tokens=100_000,
                cached_input_tokens=600_000,
                total_tokens=1_000_000,
            ),
            model_context_window=400_000,
        )),
    )

    events = engine._map_notification(
        notification, {"emitted_text": False, "tool_emitted": set()}
    )

    assert [event.type for event in events] == ["usage_update"]
    assert events[0].data["used"] == 1_000_000
    assert "size" not in events[0].data


@pytest.mark.anyio
async def test_codex_sdk_reads_account_quota_from_active_client():
    engine = CodexSDKEngine()
    captured = {}

    class Client:
        async def request(self, method, params, *, response_model):
            captured.update(method=method, params=params, response_model=response_model)
            return _SdkFake(
                rate_limits=_SdkFake(
                    primary=_SdkFake(used_percent=19, resets_at=1_800_000_000, window_duration_mins=300),
                    secondary=None,
                    credits=_SdkFake(balance="12.5", has_credits=True, unlimited=False),
                    individual_limit=_SdkFake(limit="100", used="25", remaining_percent=75, resets_at=1_800_000_100),
                    limit_id="codex",
                    limit_name="Codex",
                    plan_type=_SdkFake(value="plus"),
                    rate_limit_reached_type=None,
                ),
                rate_limits_by_limit_id=None,
            )

    quota = await engine._read_account_quota(_SdkFake(_client=Client()))

    assert captured["method"] == "account/rateLimits/read"
    assert captured["params"] is None
    assert quota["engine_id"] == "codex_sdk"
    assert quota["primary"] == {
        "used_percent": 19,
        "remaining_percent": 81,
        "resets_at": 1_800_000_000,
        "window_duration_mins": 300,
    }
    assert quota["credits"]["balance"] == "12.5"
    assert quota["individual_limit"]["remaining_percent"] == 75


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
async def test_codex_sdk_spawn_injects_custom_config_and_skips_managed_keys(monkeypatch):
    """自定义 config 写入 thread config；已托管的键不被覆盖。"""
    import openai_codex as codex_module

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
            self._client = SimpleNamespace(
                _sync=SimpleNamespace(_approval_handler=None)
            )

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
            "approval_mode": "",
            "sandbox": "workspace-write",
            "custom_config": (
                "model_context_window = 128000\n"
                "model_reasoning_effort = low\n"
            ),
        },
    )

    async for _event in CodexSDKEngine().spawn(prompt="hi", cwd="/tmp"):
        pass

    config = captured["start_kwargs"]["config"]
    assert config["model_context_window"] == "128000"
    # WorkStep 的推理强度优先，自定义的 low 不得覆盖。
    assert config["model_reasoning_effort"] == "high"


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
            self._client = SimpleNamespace(
                _sync=SimpleNamespace(_approval_handler=None)
            )

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
    assert captured["start_kwargs"]["config"] == {
        "model_reasoning_summary": "detailed",
        "model_supports_reasoning_summaries": True,
    }
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
            self._client = SimpleNamespace(
                _sync=SimpleNamespace(_approval_handler=None)
            )

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
        "model_reasoning_effort": "high",
        "model_reasoning_summary": "detailed",
        "model_supports_reasoning_summaries": True,
    }
    assert [event.type for event in events] == [
        "status",
        "session_started",
        "status",
    ]


@pytest.mark.anyio
async def test_codex_sdk_spawn_registers_approval_handler(monkeypatch):
    """AsyncCodex 的底层 CodexClient 必须注册审批回调，禁止默认自动放行。"""
    import openai_codex as codex_module

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
        def __init__(self, config=None):
            class SyncClient:
                _approval_handler = None

            class AsyncClient:
                _sync = SyncClient()

            self._client = AsyncClient()
            captured["config"] = config
            captured["sync_client"] = self._client._sync

        async def thread_start(self, **kwargs):
            return FakeThread()

        async def close(self):
            return None

    monkeypatch.setattr(codex_module, "AsyncCodex", FakeClient)
    monkeypatch.setattr(
        "engines.codex_sdk.config_store.get_codex_sdk_config",
        lambda: {
            "model_reasoning_effort": "",
            "approval_mode": "deny_all",
            "sandbox": "workspace-write",
        },
    )

    events = [
        event async for event in CodexSDKEngine().spawn(prompt="hi", cwd="/tmp")
    ]
    handler = captured["sync_client"]._approval_handler
    assert callable(handler)
    assert captured["config"].cwd == "/tmp"
    assert [event.type for event in events] == [
        "status",
        "session_started",
        "status",
    ]


@pytest.mark.anyio
async def test_codex_sdk_approval_handler_round_trip():
    """审批回调 → interaction_request 弹窗 → 用户允许/拒绝 → decision。"""
    import threading

    engine = CodexSDKEngine()
    event_queue: asyncio.Queue = asyncio.Queue()
    handler = engine._build_approval_handler(
        event_queue, asyncio.get_running_loop(), "session-1"
    )

    def invoke(params):
        return handler("item/commandExecution/requestApproval", params)

    result = {}
    thread = threading.Thread(
        target=lambda: result.update(decision=invoke(
            {"approval_id": "approval-1", "command": "ls -la"}
        ))
    )
    thread.start()

    request = await asyncio.wait_for(event_queue.get(), timeout=5)
    assert request.type == "interaction_request"
    assert request.data["method"] == "session/request_permission"
    assert request.data["session_id"] == "session-1"
    assert request.data["tool_call"]["name"] == "Bash"
    assert request.data["tool_call"]["tool_call_id"] == "approval-1"
    assert request.data["tool_call"]["title"].startswith("执行命令:")

    await engine.respond_interaction(request.data, {
        "outcome": {"outcome": "selected", "option_id": "allow_once"},
    })
    # 让事件循环推进 _ask_approval 任务，避免 thread.join 阻塞循环
    for _ in range(200):
        if not thread.is_alive():
            break
        await asyncio.sleep(0.01)
    thread.join(timeout=1)
    assert result["decision"] == {"decision": "accept"}

    # 拒绝路径
    result.clear()
    thread = threading.Thread(
        target=lambda: result.update(decision=invoke(
            {"approval_id": "approval-2", "command": "rm -rf /"}
        ))
    )
    thread.start()
    request = await asyncio.wait_for(event_queue.get(), timeout=5)
    await engine.respond_interaction(request.data, {
        "outcome": {"outcome": "selected", "option_id": "reject_once"},
    })
    for _ in range(200):
        if not thread.is_alive():
            break
        await asyncio.sleep(0.01)
    thread.join(timeout=1)
    assert result["decision"] == {"decision": "deny"}


@pytest.mark.anyio
async def test_codex_sdk_approval_handler_unknown_method_returns_empty():
    engine = CodexSDKEngine()
    handler = engine._build_approval_handler(
        asyncio.Queue(), asyncio.get_running_loop(), ""
    )
    assert handler("item/unknown", {}) == {}


def test_codex_sdk_registered_in_registry():
    assert "codex_sdk" in _ALL_ENGINES
    assert CodexSDKEngine in _ALL_ENGINES.values()


# --- Engine config schema (backend-driven settings forms) ---

def test_engine_config_schemas_are_declared():
    pydantic_fields = {
        field.key for field in PydanticAIEngine.config_schema()
    }
    assert pydantic_fields == {"provider_id", "sandbox"}
    assert PydanticAIEngine.config_schema()[0].type == "select"

    claude_fields = {field.key: field for field in ClaudeCodeEngine.config_schema()}
    assert set(claude_fields) == {"permission_mode", "model_map", "custom_settings"}
    assert "bypassPermissions" in claude_fields["permission_mode"].confirm_values
    assert claude_fields["model_map"].type == "model_map"
    assert claude_fields["model_map"].stage_hidden is True

    codex_fields = {field.key: field for field in CodexEngine.config_schema()}
    assert set(codex_fields) == {
        "sandbox_mode",
        "model_reasoning_effort",
        "approval_policy",
        "custom_config",
    }
    assert codex_fields["sandbox_mode"].type == "select"
    assert codex_fields["sandbox_mode"].default == "workspace-write"
    assert codex_fields["custom_config"].stage_hidden is True

    claude_sdk_fields = {
        field.key: field for field in ClaudeAgentSDKEngine.config_schema()
    }
    assert set(claude_sdk_fields) == {
        "permission_mode",
        "max_turns",
        "fallback_model",
        "model_map",
        "custom_settings",
    }
    assert claude_sdk_fields["max_turns"].type == "number"
    assert claude_sdk_fields["model_map"].type == "model_map"
    assert claude_sdk_fields["model_map"].stage_hidden is True
    assert "bypassPermissions" in claude_sdk_fields["permission_mode"].confirm_values

    codex_sdk_fields = {field.key: field for field in CodexSDKEngine.config_schema()}
    assert set(codex_sdk_fields) == {
        "model_reasoning_effort",
        "approval_mode",
        "sandbox",
        "custom_config",
    }
    assert codex_sdk_fields["approval_mode"].type == "select"
    assert codex_sdk_fields["custom_config"].stage_hidden is True

    from engines.core.base import BaseLLMEngine
    assert BaseLLMEngine.config_schema() == []


@pytest.mark.parametrize("engine_cls", [ClaudeCodeEngine, ClaudeAgentSDKEngine])
def test_stage_config_schema_excludes_stage_hidden_fields(engine_cls):
    """模型映射只在全局引擎配置里编辑，不进阶段配置模板。"""
    stage_keys = {field.key for field in engine_cls.stage_config_schema()}
    full_stage_keys = {field.key for field in engine_cls.full_stage_config_schema()}
    assert "model_map" in {field.key for field in engine_cls.config_schema()}
    assert "model_map" not in stage_keys
    assert "model_map" not in full_stage_keys


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
    assert "pydantic_ai" in _ALL_ENGINES
    assert "claude_agent_sdk" in _ALL_ENGINES
    assert "codex_sdk" in _ALL_ENGINES


def test_registered_engines_declare_resume_capability_accurately():
    unsupported = [
        engine_id
        for engine_id, engine_class in _ALL_ENGINES.items()
        if not engine_class().supports_resume
    ]
    assert unsupported == ["openclaw"]


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
    from engines.core.base import BaseLLMEngine
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


def test_qoder_sdk_configured_with_stored_or_environment_token(monkeypatch):
    monkeypatch.setattr(
        "engines.qoder_sdk.config_store.get_qoder_sdk_config",
        lambda: {"personal_access_token": "stored-token"},
    )
    assert QoderSDKEngine.is_configured() is True

    monkeypatch.setattr(
        "engines.qoder_sdk.config_store.get_qoder_sdk_config",
        lambda: {"personal_access_token": ""},
    )
    monkeypatch.setenv("QODER_PERSONAL_ACCESS_TOKEN", "env-token")
    assert QoderSDKEngine.is_configured() is True


def test_qoder_sdk_requires_local_login_without_token(monkeypatch):
    monkeypatch.setattr(
        "engines.qoder_sdk.config_store.get_qoder_sdk_config",
        lambda: {"personal_access_token": ""},
    )
    monkeypatch.delenv("QODER_PERSONAL_ACCESS_TOKEN", raising=False)
    monkeypatch.setattr(
        QoderSDKEngine, "resolve_binary", staticmethod(lambda: "/fake/qodercli")
    )
    QoderSDKEngine._status_cache = None

    class Status:
        returncode = 0
        stdout = "Version: 1.1.11\nAccount: Not logged in\n"

    monkeypatch.setattr("engines.qoder_sdk.subprocess.run", lambda *a, **k: Status())

    assert QoderSDKEngine.is_configured() is False


def test_qoder_sdk_is_reported_as_sdk_mode(monkeypatch):
    """The SDK-backed engine is not a plain CLI mode."""
    from engines.core.registry import get_available_engines, refresh_registry

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


def test_qoder_sdk_resume():
    engine = QoderSDKEngine()
    assert engine.supports_resume is True
    assert engine.build_resume_params("session-1") == {
        "session_id": "session-1"
    }
    assert engine.supports_interactive is True
    assert engine.supports_live_stage_message is True


def test_qoder_sdk_maps_system_init():
    engine = QoderSDKEngine()
    msg = _QoderSystemMessage(
        subtype="init", data={"model": "auto", "session_id": "session-1"}
    )
    events = engine._map_message(msg)
    assert [event.type for event in events] == ["status", "session_started"]
    assert events[0].data["status"] == "initializing"
    assert events[1].data["session_id"] == "session-1"


def test_qoder_sdk_maps_compact_boundary():
    engine = QoderSDKEngine()
    msg = _QoderSystemMessage(
        subtype="compact_boundary",
        data={"compact_summary": "前文已压缩为摘要"},
    )
    events = engine._map_message(msg)
    assert [event.type for event in events] == ["compacted"]
    assert events[0].data == {"summary": "前文已压缩为摘要"}




def test_qoder_sdk_maps_subagent_task_lifecycle():
    """Qoder subagent system messages map to subagent InternalEvents."""
    from qoder_agent_sdk.types import (
        SystemMessage,
        TaskNotificationMessage,
        TaskProgressMessage,
        TaskStartedMessage,
    )

    engine = QoderSDKEngine()

    started = engine._map_message(TaskStartedMessage(
        subtype="task_started",
        data={"task_id": "task-7"},
        task_id="task-7",
        description="实现后端",
        uuid="u1",
        session_id="s1",
        tool_use_id="task-call-1",
        task_type="chain",
    ))
    progress = engine._map_message(TaskProgressMessage(
        subtype="task_progress",
        data={"task_id": "task-7"},
        task_id="task-7",
        description="实现后端",
        usage={"input_tokens": 10},
        uuid="u2",
        session_id="s1",
        last_tool_name="Edit",
    ))
    updated = engine._map_message(SystemMessage(
        subtype="task_updated",
        data={"task_id": "task-7", "patch": {"status": "running"}},
    ))
    completed = engine._map_message(TaskNotificationMessage(
        subtype="task_notification",
        data={"task_id": "task-7"},
        task_id="task-7",
        status="completed",
        output_file="",
        summary="完成",
        uuid="u3",
        session_id="s1",
    ))

    assert [event.type for event in started] == ["subagent"]
    assert started[0].data["status"] == "running"
    assert started[0].data["stage"] == "started"
    assert started[0].data["description"] == "实现后端"
    assert started[0].data["tool_use_id"] == "task-call-1"
    assert progress[0].data["stage"] == "progress"
    assert progress[0].data["last_tool_name"] == "Edit"
    assert updated[0].data["status"] == "running"
    assert updated[0].data["stage"] == "updated"
    assert completed[0].data["status"] == "completed"
    assert completed[0].data["summary"] == "完成"


def test_qoder_sdk_maps_assistant_blocks():
    engine = QoderSDKEngine()
    text = _QoderFake(type="text", text="你好，Qoder！")
    thinking = _QoderFake(type="thinking", thinking="让我想想")
    tool = _QoderFake(type="tool_use", id="tool-1", name="Read", input={"path": "a.py"})
    msg = _QoderAssistantMessage(content=[text, thinking, tool], session_id="s1")
    events = engine._map_message(msg)
    assert [event.type for event in events] == [
        "agent_message_chunk", "agent_thought_chunk", "tool_call",
    ]
    assert events[0].data["content"]["text"] == "你好，Qoder！"
    assert events[2].data["tool_call_id"] == "tool-1"
    assert events[2].data["title"] == "Read"


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
    assert [e.data["content"]["text"] for e in stream_events] == ["增量"]
    assert final_events == []


def test_qoder_sdk_preserves_multiple_complete_text_blocks_without_partial_stream():
    engine = QoderSDKEngine()
    msg = _QoderAssistantMessage(content=[
        _QoderFake(type="text", text="A"),
        _QoderFake(type="text", text="B"),
    ])

    events = engine._map_message(msg)

    assert [event.data["content"]["text"] for event in events] == ["A", "B"]


@pytest.mark.anyio
async def test_qoder_sdk_spawn_uses_message_dicts_and_resume(monkeypatch):
    import qoder_agent_sdk as sdk_module

    captured = {}

    class _QoderClientCapture:
        def __init__(self, options=None, transport=None):
            self.options = options
            self.queries: list[str] = []
            captured["client"] = self

        async def connect(self, prompt=None):
            pass

        async def query(self, prompt, session_id="default", **kwargs):
            # 真实 SDK 消费流式输入源（初始 prompt + 注入消息）。
            if hasattr(prompt, "__aiter__"):
                async for message in prompt:
                    self.queries.append(message["message"]["content"])
            else:
                self.queries.append(prompt)

        async def receive_messages(self):
            if False:  # pragma: no cover
                yield None

        async def disconnect(self):
            pass

    monkeypatch.setattr(sdk_module, "QoderSDKClient", _QoderClientCapture)
    monkeypatch.setattr(
        QoderSDKEngine, "resolve_binary", staticmethod(lambda: "/fake/qodercli")
    )
    monkeypatch.setattr(
        "engines.qoder_sdk.config_store.get_qoder_sdk_config",
        lambda: {
            "personal_access_token": "test-token",
            "model": "auto",
            "permission_mode": "default",
            "include_partial_messages": True,
            "allowed_tools": "",
            "max_turns": "",
        },
    )

    live_queue: asyncio.Queue = asyncio.Queue()
    events = [event async for event in QoderSDKEngine().spawn(
        prompt="hi", cwd="/tmp", session_id="session-1",
        live_message_queue=live_queue,
    )]

    assert [event.type for event in events] == ["status"]
    client = captured["client"]
    assert client.queries == ["hi"]
    assert client.options.resume == "session-1"
    # resume 有明确会话目标时不得设置 --continue，避免覆盖 --resume 串会话。
    assert client.options.continue_conversation is False


@pytest.mark.anyio
async def test_qoder_sdk_can_use_tool_permission_round_trip(monkeypatch):
    """can_use_tool 权限回调 → interaction_request 弹窗 → 允许 → PermissionResultAllow。

    Mirrors the Claude Agent SDK spawn-level permission flow for Qoder: the
    SDK callback blocks until respond_interaction delivers the user's choice,
    then the run continues.
    """
    import qoder_agent_sdk as sdk_module
    from types import SimpleNamespace

    permission_result = {}

    class _QoderClientPermission:
        def __init__(self, options=None, transport=None):
            self.options = options

        async def connect(self, prompt=None):
            pass

        async def query(self, prompt, session_id="default", **kwargs):
            pass

        async def receive_messages(self):
            result = await self.options.can_use_tool(
                "Bash",
                {"command": "ls"},
                SimpleNamespace(tool_use_id="tool-1", title="Bash"),
            )
            permission_result["allowed"] = isinstance(
                result, sdk_module.PermissionResultAllow
            )
            yield _QoderResultMessage(
                type="result",
                result="done",
                usage={"input_tokens": 5, "output_tokens": 5},
                session_id="s1",
            )

        async def disconnect(self):
            pass

    monkeypatch.setattr(sdk_module, "QoderSDKClient", _QoderClientPermission)
    monkeypatch.setattr(
        QoderSDKEngine, "resolve_binary", staticmethod(lambda: "/fake/qodercli")
    )
    monkeypatch.setattr(
        "engines.qoder_sdk.config_store.get_qoder_sdk_config",
        lambda: {
            "personal_access_token": "test-token",
            "model": "auto",
            "permission_mode": "default",
            "include_partial_messages": True,
            "allowed_tools": "",
            "max_turns": "",
        },
    )

    engine = QoderSDKEngine()
    collected = []
    request_seen = asyncio.Event()
    request_data = {}

    async def consume():
        async for event in engine.spawn(prompt="hi", cwd="/tmp"):
            if event.type == "interaction_request":
                request_data.update(event.data)
                request_seen.set()
            collected.append(event)

    consumer = asyncio.create_task(consume())
    await asyncio.wait_for(request_seen.wait(), timeout=5)

    assert request_data["method"] == "session/request_permission"
    assert request_data["tool_call"]["name"] == "Bash"
    assert request_data["session_id"] == "qoder-agent-sdk"
    assert [o["option_id"] for o in request_data["options"]] == [
        "allow_once",
        "allow_for_session",
        "reject_once",
        "reject_for_session",
    ]

    delivered = await engine.respond_interaction(request_data, {
        "outcome": {"outcome": "selected", "option_id": "allow_once"},
    })
    assert delivered is True
    await asyncio.wait_for(consumer, timeout=5)

    assert permission_result.get("allowed") is True
    assert [event.type for event in collected][-1] == "status"





def test_qoder_sdk_maps_real_sdk_blocks_without_type_field():
    """Real qoder blocks carry no ``type`` attr; class names must map too."""
    from qoder_agent_sdk.types import (
        AssistantMessage,
        TextBlock,
        ToolResultBlock,
        ToolUseBlock,
        UserMessage,
    )

    engine = QoderSDKEngine()

    assistant = AssistantMessage(content=[
        TextBlock(text="开始"),
        ToolUseBlock(id="tool-1", name="Read", input={"path": "a.py"}),
    ], model="auto")
    events = engine._map_message(assistant)
    assert [event.type for event in events] == ["agent_message_chunk", "tool_call"]
    assert events[1].data == {
        "tool_call_id": "tool-1",
        "title": "Read",
        "raw_input": {"path": "a.py"},
    }

    user = UserMessage(content=[
        ToolResultBlock(tool_use_id="tool-1", content="file content", is_error=False),
    ], uuid="u")
    events = engine._map_message(user)
    assert [event.type for event in events] == ["tool_call_update"]
    assert events[0].data == {
        "tool_call_id": "tool-1",
        "status": "completed",
        "raw_output": "file content",
    }


def test_qoder_sdk_real_task_tools_produce_plan_events():
    """Tool_use from real qoder blocks reaches the plan tracker."""
    from qoder_agent_sdk.types import (
        AssistantMessage,
        ToolUseBlock,
        UserMessage,
        ToolResultBlock,
    )

    engine = QoderSDKEngine()

    def push(msg):
        normalized = []
        for event in engine._map_message(msg):
            result = engine.normalize_event(event)
            if result is not None:
                normalized.append(result)
        return normalized

    created = push(AssistantMessage(content=[
        ToolUseBlock(id="task-call-1", name="TaskCreate",
                     input={"description": "实现后端"}),
    ], model="auto"))
    finished = push(UserMessage(content=[
        ToolResultBlock(tool_use_id="task-call-1",
                        content='{"task":{"id":"task-7","description":"实现后端"}}',
                        is_error=False),
    ], uuid="u"))

    assert created[0].type == "plan"
    assert created[0].data["entries"] == [{
        "content": "实现后端",
        "priority": "medium",
        "status": "pending",
    }]
    # TaskCreate 的 tool_result 只确认任务已建（pending）；终态由
    # task_notification / TaskUpdate 帧驱动，此处验证两者衔接。
    assert finished[0].type == "plan"
    assert finished[0].data["entries"] == [{
        "content": "实现后端",
        "priority": "medium",
        "status": "pending",
    }]
    updated = push(AssistantMessage(content=[
        ToolUseBlock(id="update-call-1", name="TaskUpdate",
                     input={"taskId": "task-7", "status": "completed"}),
    ], model="auto"))
    assert updated[0].type == "plan"
    assert updated[0].data["entries"] == [{
        "content": "实现后端",
        "priority": "medium",
        "status": "completed",
    }]

def test_qoder_sdk_maps_tool_result():
    engine = QoderSDKEngine()
    block = _QoderFake(type="tool_result", tool_use_id="tool-1",
                       content="file content", is_error=False)
    msg = _QoderUserMessage(content=[block])
    events = engine._map_message(msg)
    assert [event.type for event in events] == ["tool_call_update"]
    assert events[0].data["tool_call_id"] == "tool-1"
    assert events[0].data["raw_output"] == "file content"
    assert events[0].data["status"] == "completed"


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
    usage_event = next(event for event in events if event.type == "usage_update")
    assert usage_event.data == {
        "input_tokens": 300,
        "output_tokens": 100,
        "cache_creation_input_tokens": 40,
        "cache_read_input_tokens": 120,
        "total_tokens": 400,
        "used": 400,
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
    assert [event.type for event in events] == ["agent_message_chunk", "status"]


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


def test_pydantic_ai_capabilities_match_session_and_interaction_support():
    engine = PydanticAIEngine()

    assert engine.supports_interactive is True
    assert engine.supports_resume is True
    assert engine.build_resume_params("session-1") == {"session_id": "session-1"}


# --- PydanticAIEngine session id ---

@pytest.mark.anyio
async def test_pydantic_ai_spawn_emits_session_started(monkeypatch):
    """The built-in agent emits a per-run session id like other engines."""
    import engines.pydantic_ai.engine as pydantic_ai_module
    from engines.pydantic_ai import PydanticAIEngine

    class FakeStore:
        def get_pydantic_ai_engine_config(self):
            return {"provider_id": "prov_1", "model": "agent-model"}

        def get_provider(self, provider_id):
            return {
                "id": provider_id,
                "name": "主账号",
                "type": "openai",
                "base_url": "https://agent-gateway.example.com/v1",
                "api_key": "k",
                "enabled": True,
                "verified": True,
                "created_at": "",
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
                             on_event, live_message_queue=None, images=None,
                             session_id=None, sandbox="workspace-write"):
        return FakeResult(), FakeUsage()

    monkeypatch.setattr(pydantic_ai_module, "config_store", FakeStore())
    monkeypatch.setattr(
        PydanticAIEngine, "build_model", staticmethod(lambda *, provider, model_name: object())
    )
    monkeypatch.setattr(PydanticAIEngine, "_run_agent", fake_run_agent)

    events = [
        event async for event in PydanticAIEngine().spawn("hi", cwd="/tmp/project")
    ]
    assert events[0].type == "session_started"
    session_id = events[0].data["session_id"]
    assert isinstance(session_id, str) and session_id
    usage_event = next(event for event in events if event.type == "usage_update")
    assert usage_event.data["used"] == 2
    assert usage_event.data["session_id"] == session_id
    assert usage_event.data["provider_id"] == "prov_1"
    assert events[-1].type == "status"
    assert events[-1].data["status"] == "done"


@pytest.mark.anyio
async def test_pydantic_ai_spawn_separates_context_snapshot_from_cumulative_usage(
    monkeypatch,
):
    """A multi-request run must not report cumulative billing as context occupancy."""
    import engines.pydantic_ai.engine as pydantic_ai_module
    from pydantic_ai.messages import (
        ModelRequest,
        ModelResponse,
        TextPart,
        UserPromptPart,
    )

    class FakeStore:
        def get_pydantic_ai_engine_config(self):
            return {"provider_id": "prov_1", "model": "unknown-custom-model"}

        def get_provider(self, provider_id):
            return {
                "id": provider_id,
                "name": "主账号",
                "type": "openai",
                "base_url": "https://agent-gateway.example.com/v1",
                "api_key": "k",
                "enabled": True,
                "verified": True,
                "created_at": "",
            }

    class FakeModel:
        model_id = "openai:unknown-custom-model"

    class FakeUsage:
        input_tokens = 280_782
        output_tokens = 1_978
        total_tokens = 282_760
        cache_write_tokens = 0
        cache_read_tokens = 235_520
        requests = 12
        cost = None

    class FakeResult:
        output = "short answer"

        def all_messages(self):
            return [
                ModelRequest(parts=[UserPromptPart(content="short prompt")]),
                ModelResponse(parts=[TextPart(content="short answer")]),
            ]

    async def fake_run_agent(self, *, prompt, cwd, add_dirs, model,
                             on_event, live_message_queue=None, images=None,
                             session_id=None, sandbox="workspace-write"):
        return FakeResult(), FakeUsage()

    monkeypatch.setattr(pydantic_ai_module, "config_store", FakeStore())
    monkeypatch.setattr(
        PydanticAIEngine,
        "build_model",
        staticmethod(lambda *, provider, model_name: FakeModel()),
    )
    monkeypatch.setattr(PydanticAIEngine, "_run_agent", fake_run_agent)

    events = [
        event async for event in PydanticAIEngine().spawn("hi", cwd="/tmp/project")
    ]
    usage = next(event.data for event in events if event.type == "usage_update")

    assert usage["total_tokens"] == 282_760
    assert usage["requests"] == 12
    assert 0 < usage["used"] < 2_000
    assert usage["size"] == 200_000


class _FakeSDKClient:
    """Duck-typed ClaudeSDKClient: consumes the streamed prompt source and
    yields one assistant+result per user message; the message stream ends when
    the input source ends (stdin EOF → CLI exits → end frame), like the real
    SDK."""

    last: "_FakeSDKClient | None" = None
    # 模拟 CLI 把 result 前到达的注入合并进当前回合：注入消息不产生独立
    # 的新回合（a47f9b1e 场景：全程只有一个 result）。测试可临时置 True。
    merge_injections = False

    def __init__(self, options):
        type(self).last = self
        self.options = options
        self.disconnected = False
        self.queries: list[str] = []
        self.turn_ready: asyncio.Queue = asyncio.Queue()
        self.input_ended = asyncio.Event()

    async def connect(self):
        return None

    async def query(self, prompt):
        if hasattr(prompt, "__aiter__"):
            async for message in prompt:
                self.queries.append(message["message"]["content"])
                if type(self).merge_injections and len(self.queries) > 1:
                    continue
                await self.turn_ready.put(None)
        else:
            self.queries.append(prompt)
            await self.turn_ready.put(None)
        self.input_ended.set()

    async def receive_messages(self):
        yield _SdkFake(
            type="system",
            subtype="init",
            data={"session_id": "sdk-session-1"},
        )
        turn = 0
        while not self.disconnected:
            get_task = asyncio.create_task(self.turn_ready.get())
            end_task = asyncio.create_task(self.input_ended.wait())
            try:
                done, _ = await asyncio.wait(
                    {get_task, end_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
            except asyncio.CancelledError:
                get_task.cancel()
                end_task.cancel()
                raise
            if end_task in done and get_task not in done:
                # stdin 已关闭：CLI 处理完剩余输入后才退出并结束流。
                get_task.cancel()
                return
            turn += 1
            yield _SdkFake(type="assistant", content=[
                _SdkFake(type="text", text=f"回复 {turn}"),
            ])
            yield _SdkFake(
                type="result",
                result=_SdkFake(
                    is_error=False,
                    output="",
                    subtype="success",
                    usage={"input_tokens": 1, "output_tokens": 1},
                    total_cost_usd=0.0,
                    session_id="sdk-session-1",
                ),
            )

    async def disconnect(self):
        self.disconnected = True
        try:
            self.turn_ready.put_nowait(None)
        except Exception:
            pass


def _patch_claude_sdk(monkeypatch, client_class=_FakeSDKClient):
    import claude_agent_sdk as sdk_module
    from services.config import config_store

    monkeypatch.setattr(sdk_module, "ClaudeSDKClient", client_class)
    monkeypatch.setattr(sdk_module, "ClaudeAgentOptions", _SdkFake)
    monkeypatch.setattr(sdk_module, "PermissionResultAllow", _SdkFake)
    monkeypatch.setattr(sdk_module, "PermissionResultDeny", _SdkFake)
    monkeypatch.setattr(
        ClaudeAgentSDKEngine, "resolve_binary", staticmethod(lambda: "/fake/claude")
    )
    monkeypatch.setattr(config_store, "get_claude_agent_sdk_config", lambda: {
        "permission_mode": "acceptEdits",
        "max_turns": "",
        "fallback_model": "",
    })


@pytest.mark.anyio
async def test_claude_agent_sdk_result_ends_a_persistent_message_stream(monkeypatch):
    """Real receive_messages stays open; an empty queue must still end now."""

    class PersistentSDKClient(_FakeSDKClient):
        async def receive_messages(self):
            yield _SdkFake(
                type="system",
                subtype="init",
                data={"session_id": "sdk-session-1"},
            )
            yield _SdkFake(type="assistant", content=[
                _SdkFake(type="text", text="回复完成"),
            ])
            yield _SdkFake(
                type="result",
                result=_SdkFake(
                    is_error=False,
                    output="",
                    subtype="success",
                    usage={"input_tokens": 1, "output_tokens": 1},
                    total_cost_usd=0.0,
                    session_id="sdk-session-1",
                ),
            )
            while not self.disconnected:
                await asyncio.sleep(0.01)

    _patch_claude_sdk(monkeypatch, PersistentSDKClient)
    events: list[InternalEvent] = []

    async def consume():
        async for event in ClaudeAgentSDKEngine().spawn(
            "开始任务",
            cwd="/tmp",
            live_message_queue=asyncio.Queue(),
        ):
            events.append(event)

    await asyncio.wait_for(consume(), timeout=0.25)

    assert any(
        event.type == "status" and event.data.get("status") == "done"
        for event in events
    )
    assert not any(
        event.type == "status" and event.data.get("status") == "cancelled"
        for event in events
    )


@pytest.mark.anyio
async def test_claude_agent_sdk_turn_without_injection_ends_immediately(monkeypatch):
    """A finished turn without any live injection ends the session right away:
    the reply is the end of the stage, so no insertion grace is applied and no
    idle_timeout marker is needed."""
    _patch_claude_sdk(monkeypatch)
    engine = ClaudeAgentSDKEngine()
    # 带 live 队列才是真实路径：prompt 源在首条消息后保持打开，
    # 由 watchdog 在回合结束后立即关闭（无队列时源立刻结束，watchdog 不参与）。
    live_queue: asyncio.Queue = asyncio.Queue()
    events = []
    async for event in engine.spawn(
        "开始任务", cwd="/tmp", live_message_queue=live_queue
    ):
        events.append(event)

    client = _FakeSDKClient.last
    assert client.disconnected is True
    assert client.queries == ["开始任务"]
    assert any(
        event.type == "agent_message_chunk" and event.data["content"]["text"] == "回复 1"
        for event in events
    )
    assert any(
        event.type == "status" and event.data.get("status") == "done"
        for event in events
    )
    assert not any(
        event.type == "status" and event.data.get("status") == "idle_timeout"
        for event in events
    ), "无插入的回合回复即结尾：应立即收尾，不应出现 idle_timeout"


@pytest.mark.anyio
async def test_claude_agent_sdk_early_injection_ends_when_queue_empty(monkeypatch):
    """注入在回合 result 之前已被消费（CLI 合并处理、全程只有一个 result）时，
    回合结束且插入队列为空必须立即收尾：不论本回合是否插入过消息都不等
    宽限期（a47f9b1e 卡死回归）。"""
    _patch_claude_sdk(monkeypatch)
    engine = ClaudeAgentSDKEngine()
    live_queue: asyncio.Queue = asyncio.Queue()
    live_queue.put_nowait(("pre-1", "提前注入"))
    events: list[InternalEvent] = []

    async def consume():
        async for event in engine.spawn(
            "开始任务", cwd="/tmp", live_message_queue=live_queue
        ):
            events.append(event)

    _FakeSDKClient.merge_injections = True
    try:
        # 3s 超时保护：修复前 watchdog 误判保活、流只能靠外部取消收尾，
        # 会留下 cancelled 事件；修复后空队列立即自然收尾、无 cancelled。
        await asyncio.wait_for(consume(), timeout=3)
    finally:
        _FakeSDKClient.merge_injections = False

    client = _FakeSDKClient.last
    assert client.disconnected is True
    assert client.queries == ["开始任务", "提前注入"]
    delivered = [
        e for e in events
        if e.type == "live_message" and e.data.get("status") == "delivered"
    ]
    assert delivered and delivered[0].data["message_id"] == "pre-1"
    assert any(
        e.type == "status" and e.data.get("status") == "done" for e in events
    ), "回合完成但流未正常收尾（watchdog 误判保活）"
    assert not any(
        e.type == "status" and e.data.get("status") == "idle_timeout" for e in events
    ), "合并注入回合结束时队列已空：应立即收尾，不应出现 idle_timeout"
    assert not any(
        e.type == "status" and e.data.get("status") == "cancelled" for e in events
    ), "流被外部取消才收尾：watchdog 误判保活导致卡死"


@pytest.mark.anyio
async def test_claude_agent_sdk_injection_keeps_session_alive(monkeypatch):
    """A pending message in the insert queue is consumed into a follow-up turn
    (回复 2 runs); once the queue is empty the session closes right away."""
    _patch_claude_sdk(monkeypatch)
    engine = ClaudeAgentSDKEngine()
    live_queue: asyncio.Queue = asyncio.Queue()
    live_queue.put_nowait(("live-1", "继续"))
    events = []
    async for event in engine.spawn(
        "开始任务", cwd="/tmp", live_message_queue=live_queue
    ):
        events.append(event)

    client = _FakeSDKClient.last
    assert client.disconnected is True
    assert client.queries == ["开始任务", "继续"]
    deltas = [
        event.data["content"]["text"]
        for event in events
        if event.type == "agent_message_chunk"
    ]
    assert "回复 2" in deltas
    delivered = [
        event for event in events
        if event.type == "live_message"
        and event.data.get("status") == "delivered"
    ]
    assert len(delivered) == 1
    assert delivered[0].data["message_id"] == "live-1"

def test_config_overrides_can_clear_a_saved_value_for_a_draft_test():
    effective = CodexEngine.merge_config_overrides(
        {"approval_policy": "on-request", "sandbox_mode": "workspace-write"},
        {
            "approval_policy": "",
            "sandbox_mode": "read-only",
            "__workstep_clear_keys__": ["approval_policy"],
        },
    )

    assert effective == {
        "approval_policy": "",
        "sandbox_mode": "read-only",
    }


def test_claude_sandbox_env_only_for_bypass_permissions():
    """只有 bypassPermissions 才注入 IS_SANDBOX（容器 root 下的必需声明）。"""
    from services.config import claude_sandbox_env

    assert claude_sandbox_env("bypassPermissions") == {"IS_SANDBOX": "1"}
    for mode in ("acceptEdits", "default", "plan", "manual", "", None):
        assert claude_sandbox_env(mode) == {}


def test_claude_engines_inject_sandbox_env_for_bypass_permissions():
    """CLI 与 SDK 引擎都必须把 IS_SANDBOX 合并进子进程环境。"""
    from services.config import claude_sandbox_env

    cli_env = {"ANTHROPIC_BASE_URL": "http://x", **claude_sandbox_env("bypassPermissions")}
    assert cli_env["IS_SANDBOX"] == "1"

    sdk_env = {"ANTHROPIC_BASE_URL": "http://x", **claude_sandbox_env("bypassPermissions")}
    assert sdk_env["IS_SANDBOX"] == "1"
    assert claude_sandbox_env("acceptEdits").get("IS_SANDBOX") is None
