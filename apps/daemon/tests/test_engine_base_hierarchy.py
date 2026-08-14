"""引擎基类层次：AcpEngineBase 是协议基类，BaseLLMEngine 承载自定义函数。

- 所有引擎（含新接入的）继承 ``AcpEngineBase``，实现 ACP 协议事件；
- ``BaseLLMEngine`` 实现自定义函数（安装、版本、配置、能力声明等）；
- 上层调用只使用 ACP 风格接口（spawn / session / interaction / approval）。
"""

import asyncio

import pytest

from engines.core.base import BaseLLMEngine
from engines.core.acp_base import AcpEngineBase
from engines.core.registry import ENGINE_REGISTRY


class CustomFunctionsOnly(BaseLLMEngine):
    """只实现 BaseLLMEngine 自定义函数的引擎（协议由 AcpEngineBase 提供）。"""

    @staticmethod
    def is_installed() -> bool:
        return True

    @staticmethod
    def get_version() -> str | None:
        return "test"

    @staticmethod
    def resolve_binary() -> str | None:
        return "test"


def test_acp_base_inherits_base_llm_engine():
    assert issubclass(AcpEngineBase, BaseLLMEngine)


def test_every_registered_engine_inherits_acp_base():
    for engine_id, engine_cls in ENGINE_REGISTRY.items():
        assert issubclass(engine_cls, AcpEngineBase), engine_id


def test_base_llm_engine_exposes_custom_functions():
    """安装 / 版本 / 配置等自定义函数由 BaseLLMEngine 提供。"""
    engine = CustomFunctionsOnly()
    assert engine.is_installed() is True
    assert engine.get_version() == "test"
    assert engine.install_command() is None
    assert BaseLLMEngine.config_schema() == []
    assert asyncio.run(engine.install()).success is True


def test_acp_base_exposes_protocol_interface():
    """协议接口（spawn / session / interaction / approval）由 AcpEngineBase 提供。"""
    for name in (
        "spawn",
        "stop",
        "create_session",
        "load_session",
        "list_sessions",
        "resume_session",
        "close_session",
        "cancel_session",
        "set_config_option",
        "reset_options",
        "approve_tool",
        "approve_tool_option",
        "respond_interaction",
        "inject_response",
        "normalize_event",
        "request_interaction",
        "handle_tool_permission",
        "spawn_coordinator",
        "test_connection",
        "send_live_stage_message",
    ):
        assert hasattr(AcpEngineBase, name), name
        assert name not in vars(BaseLLMEngine), name


def test_base_llm_engine_has_no_protocol_methods():
    """BaseLLMEngine 不声明协议执行方法，全部上移到 AcpEngineBase。"""
    for name in (
        "spawn",
        "stop",
        "create_session",
        "approve_tool",
        "respond_interaction",
        "normalize_event",
        "spawn_coordinator",
        "test_connection",
        "send_live_stage_message",
    ):
        assert name not in vars(BaseLLMEngine), name


def test_non_acp_engine_keeps_safe_protocol_defaults():
    """没有 ACP 命令的引擎（继承 AcpEngineBase 但不提供 get_command）保持安全默认。"""
    engine = _NonAcpEngine()
    assert engine.supports_sessions is False
    assert engine.supports_tool_approval is False
    assert engine.supports_live_stage_message is False
    assert asyncio.run(engine.create_session("/tmp")) is None
    assert asyncio.run(engine.load_session("s1", "/tmp")) is False
    assert asyncio.run(engine.list_sessions()) == []
    assert asyncio.run(engine.resume_session("s1", "/tmp")) is False


class _NonAcpEngine(AcpEngineBase):
    ENGINE_ID = "non-acp"

    @staticmethod
    def is_installed() -> bool:
        return True

    @staticmethod
    def get_version() -> str | None:
        return "test"

    @staticmethod
    def resolve_binary() -> str | None:
        return "test"




# --- ACP 事件契约：声明 = 实际（非 ACP 引擎用自己的传输产出 ACP 词汇事件） ---

from engines.core.acp_base import ACP_EVENTS
from engines.core.interactions import permission_request
from engines.core.registry import _ALL_ENGINES

#: 非 ACP 引擎：不驱动 ACP 进程（get_command 为空），用自己的传输实现协议。
_NON_ACP_ENGINE_IDS = {
    "codex",
    "codex_sdk",
    "deepseek_harness",
    "claude",
    "claude_agent_sdk",
    "qoder_sdk",
    "openclaw",
    "pydantic_ai",
}

#: ACP 原生引擎：声明 COMMAND，直接使用 ACP 客户端。
_ACP_NATIVE_ENGINE_IDS = {"hermes"}


def _non_acp_engines() -> dict[str, type]:
    return {
        engine_id: cls
        for engine_id, cls in _ALL_ENGINES.items()
        if engine_id in _NON_ACP_ENGINE_IDS
    }


def test_every_engine_acp_events_within_vocabulary():
    """所有引擎的 acp_events 都是 ACP 词汇子集且非空。"""
    assert _ALL_ENGINES
    for engine_id, cls in _ALL_ENGINES.items():
        engine = cls()
        declared = set(engine.acp_events)
        assert declared, engine_id
        assert declared <= set(ACP_EVENTS), engine_id


def test_acp_native_engine_declares_full_vocabulary():
    """ACP 原生引擎（Hermes）继承即声明全集：协议侧可产出任何 ACP 事件。"""
    for engine_id in _ACP_NATIVE_ENGINE_IDS:
        cls = _ALL_ENGINES.get(engine_id)
        assert cls is not None, engine_id
        engine = cls()
        assert engine._is_acp_native is True
        assert set(engine.acp_events) == set(ACP_EVENTS)


def test_non_acp_engines_declare_narrowed_event_sets():
    """非 ACP 引擎声明实际子集（不冒充全集），且含核心文本 / 状态事件。"""
    for engine_id, cls in _non_acp_engines().items():
        engine = cls()
        assert engine._is_acp_native is False
        declared = set(engine.acp_events)
        assert declared < set(ACP_EVENTS), engine_id
        assert {"agent_message_chunk", "status", "error"} <= declared, engine_id


def test_non_acp_engines_declare_capabilities_honestly():
    """审批能力声明与实际事件集合一致（有审批必有 interaction_request）。"""
    for engine_id, cls in _non_acp_engines().items():
        engine = cls()
        if engine.supports_tool_approval:
            assert "interaction_request" in set(engine.acp_events), engine_id


def test_non_acp_engine_mapping_events_are_declared():
    """映射路径实际产出的事件类型 ⊆ 声明集合（声明覆盖实际）。"""
    probes = _mapping_probes()
    for engine_id, probe in probes.items():
        engine = _ALL_ENGINES[engine_id]()
        produced = probe(engine)
        declared = set(engine.acp_events)
        undeclared = produced - declared
        assert not undeclared, f"{engine_id}: 未声明 {sorted(undeclared)}"


# --- 各引擎映射探针（代表性负载，不启动进程） ---


def _probe_codex(engine) -> set[str]:
    produced: set[str] = set()
    cases = [
        {"type": "thread.started", "thread_id": "t1"},
        {"type": "turn.started"},
        {
            "type": "turn.plan.updated",
            "plan": [{"step": "a", "status": "pending"}],
            "explanation": "",
        },
        {"type": "item.completed", "item": {"type": "agent_message", "text": "hi"}},
        {"type": "item.completed", "item": {"type": "reasoning", "text": "think"}},
        {
            "type": "item.completed",
            "item": {"type": "command_execution", "id": "c1", "command": "ls", "exit_code": 0},
        },
        {"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}},
        {"type": "error", "message": "boom"},
    ]
    for obj in cases:
        event = engine._map_event(obj)
        if event:
            produced.add(event.type)
    return produced


class _EnumValue:
    def __init__(self, value: str):
        self.value = value


class _FakeNotification:
    def __init__(self, method: str, payload):
        self.method = method
        self.payload = payload


class _FakeTurn:
    def __init__(self, status: str):
        self.status = _EnumValue(status)
        self.error = None


class _FakeStep:
    def __init__(self, step: str, status: str):
        self.step = step
        self.status = _EnumValue(status)


class _FakeUsage:
    def __init__(self, **values):
        self.input_tokens = values.get("input_tokens", 0)
        self.output_tokens = values.get("output_tokens", 0)
        self.cached_input_tokens = values.get("cached_input_tokens", 0)
        self.total_tokens = values.get("total_tokens", 1)


class _FakeTokenUsage:
    def __init__(self):
        self.last = _FakeUsage()
        self.total = None


def _probe_codex_sdk(engine) -> set[str]:
    produced: set[str] = set()
    state = {"emitted_text": False, "emitted_thinking": False, "tool_emitted": set()}
    notifications = [
        _FakeNotification("turn/started", {}),
        _FakeNotification("item/agentMessage/delta", {"delta": "hi"}),
        _FakeNotification("item/reasoning/textDelta", {"delta": "think"}),
        _FakeNotification("turn/plan/updated", {
            "plan": [_FakeStep("a", "pending")],
            "explanation": "",
        }),
        _FakeNotification("thread/tokenUsage/updated", {
            "token_usage": _FakeTokenUsage(),
        }),
        _FakeNotification("thread/compacted", {}),
        _FakeNotification("turn/completed", {"turn": _FakeTurn("success")}),
    ]
    for notification in notifications:
        for event in engine._map_notification(notification, state):
            produced.add(event.type)
    return produced


def _probe_claude_code(engine) -> set[str]:
    produced: set[str] = set()
    cases = [
        {"type": "system", "subtype": "init", "session_id": "s1"},
        {"type": "system", "subtype": "task_started", "task_id": "task-1",
         "description": "subagent", "message": {"role": "assistant", "content": "x"}},
        {
            "type": "stream_event",
            "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "hi"}},
        },
        {
            "type": "stream_event",
            "event": {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "think"}},
        },
        {
            "type": "assistant",
            "message": {"role": "assistant", "content": [
                {"type": "text", "text": "hi"},
                {"type": "thinking", "thinking": "think"},
                {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}},
            ]},
        },
        {
            "type": "user",
            "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": "ok"},
            ]},
        },
        {"type": "result", "is_error": False, "subtype": "success"},
        {"type": "result", "is_error": True, "subtype": "error_max_turns"},
    ]
    for obj in cases:
        for event in engine._map_events(obj):
            produced.add(event.type)
    return produced


class _FakeBlock:
    def __init__(self, block_type: str, **values):
        self.type = block_type
        for key, value in values.items():
            setattr(self, key, value)


class _FakeMessage:
    def __init__(self, mtype: str, **values):
        self.type = mtype
        self.subtype = values.pop("subtype", "")
        self.content = values.pop("content", None)
        self.message = values.pop("message", None)
        self.data = values.pop("data", None)
        self.session_id = values.pop("session_id", None)
        self.result = values.pop("result", None)
        self.usage = values.pop("usage", None)
        self.is_error = values.pop("is_error", False)
        self.error = values.pop("error", None)
        self.total_cost_usd = values.pop("total_cost_usd", None)
        for key, value in values.items():
            setattr(self, key, value)


def _probe_claude_agent_sdk(engine) -> set[str]:
    produced: set[str] = set()
    state = {
        "emitted_text": False,
        "streamed_text": False,
        "streamed_thinking": False,
        "session_started": False,
    }
    messages = [
        _FakeMessage("system", subtype="init", data={"session_id": "s1"}),
        _FakeMessage("system", subtype="error", message="boom"),
        _FakeMessage("system", subtype="context_compaction", data={"summary": "compacted"}),
        _FakeMessage("assistant", content=[
            _FakeBlock("text", text="hi"),
            _FakeBlock("thinking", thinking="think"),
            _FakeBlock("tool_use", id="t1", name="Bash", input={"command": "ls"}),
        ]),
        _FakeMessage("user", content=[
            _FakeBlock("tool_result", tool_use_id="t1", content="ok"),
        ]),
        _FakeMessage("result", result="done", usage={"input_tokens": 1, "output_tokens": 1}),
        _FakeMessage("result", result="boom", is_error=True, subtype="error"),
    ]
    for msg in messages:
        for event in engine._map_message(msg, state):
            produced.add(event.type)
    return produced


def _probe_qoder_sdk(engine) -> set[str]:
    produced: set[str] = set()
    state = {
        "emitted_text": False,
        "emitted_thinking": False,
        "streamed_text": False,
        "streamed_thinking": False,
        "session_started": False,
    }
    messages = [
        _FakeMessage("system", subtype="init", data={"session_id": "s1"}),
        _FakeMessage("system", subtype="error", data={"error": "boom"}),
        _FakeMessage("system", subtype="context_compaction", data={"summary": "compacted"}),
        _FakeMessage("stream", session_id="s1", event={
            "type": "content_block_delta",
            "delta": {"type": "text_delta", "text": "hi"},
        }),
        _FakeMessage("stream", session_id="s1", event={
            "type": "content_block_delta",
            "delta": {"type": "thinking_delta", "thinking": "think"},
        }),
        _FakeMessage("assistant", content=[
            _FakeBlock("text", text="hi"),
            _FakeBlock("thinking", thinking="think"),
            _FakeBlock("tool_use", id="t1", name="Bash", input={"command": "ls"}),
        ]),
        _FakeMessage("user", content=[
            _FakeBlock("tool_result", tool_use_id="t1", content="ok"),
        ]),
        _FakeMessage("result", result="done", usage={"input_tokens": 1, "output_tokens": 1}),
    ]
    for msg in messages:
        for event in engine._map_message(msg, state):
            produced.add(event.type)
    return produced


def _probe_openclaw(engine) -> set[str]:
    produced: set[str] = set()
    envelopes = [
        {"ok": True, "status": "success", "sessionId": "s1", "final": "done",
         "usage": {"input": 1, "output": 1, "total": 2}},
        {"ok": False, "error": {"message": "boom", "kind": "runtime"}},
    ]
    for envelope in envelopes:
        for event in engine._map_envelope(envelope):
            produced.add(event.type)
    return produced


class _FakeStreamEvent:
    def __init__(self, event_kind: str, part=None, delta=None, content=None):
        self.event_kind = event_kind
        self.part = part
        self.delta = delta
        self.content = content


class _FakePart:
    def __init__(self, part_kind: str, **values):
        self.part_kind = part_kind
        for key, value in values.items():
            setattr(self, key, value)


def _probe_pydantic_ai(engine) -> set[str]:
    produced: set[str] = set()
    cases = [
        _FakeStreamEvent("part_start", part=_FakePart("text", content="hi")),
        _FakeStreamEvent("part_start", part=_FakePart("thinking", content="think")),
        _FakeStreamEvent("part_delta", delta=_FakePart("text", content_delta="hi")),
        _FakeStreamEvent("part_delta", delta=_FakePart("thinking", content_delta="think")),
        _FakeStreamEvent(
            "function_tool_call",
            part=_FakePart("tool_call", tool_call_id="t1", tool_name="Bash", args='{"command":"ls"}'),
        ),
        _FakeStreamEvent(
            "function_tool_result",
            part=_FakePart("tool_call", tool_call_id="t1", content="ok"),
            content="ok",
        ),
    ]
    for case in cases:
        event = engine._map_stream_event(case)
        if event:
            produced.add(event.type)
    return produced


def _mapping_probes() -> dict[str, callable]:
    return {
        "codex": _probe_codex,
        "codex_sdk": _probe_codex_sdk,
        "claude": _probe_claude_code,
        "claude_agent_sdk": _probe_claude_agent_sdk,
        "qoder_sdk": _probe_qoder_sdk,
        "openclaw": _probe_openclaw,
        "pydantic_ai": _probe_pydantic_ai,
    }


# --- 非 ACP 引擎会话 / 审批方法：无运行进程时不崩溃、返回合理值 ---


@pytest.mark.anyio
async def test_non_acp_session_and_approval_methods_are_safe():
    for engine_id, cls in _non_acp_engines().items():
        engine = cls()
        created = await engine.create_session("/tmp")
        assert created is None or isinstance(created, str), engine_id
        resumed = await engine.resume_session("s1", "/tmp")
        assert isinstance(resumed, bool), engine_id
        if not engine.supports_resume:
            assert resumed is False, engine_id
        await engine.load_session("s1", "/tmp")
        assert isinstance(await engine.list_sessions(), list), engine_id
        await engine.close_session("s1")
        await engine.cancel_session("s1")
        await engine.set_config_option("model", "gpt-5")
        await engine.reset_options()
        await engine.approve_tool("tool-1")
        await engine.approve_tool_option("tool-1", None)


@pytest.mark.anyio
async def test_approve_tool_resolves_parked_non_acp_permission():
    """approve_tool 把决定写回非 ACP 引擎挂起的 request_permission。"""
    engine = _ApprovalProbeEngine()
    tool_call_id = "tool-42"
    event = permission_request(
        interaction_id="interaction-42",
        session_id="probe",
        tool_call={"tool_call_id": tool_call_id, "name": "Bash", "title": "ls"},
        options=[
            {"option_id": "allow_once", "name": "允许一次", "kind": "allow_once"},
            {"option_id": "reject_once", "name": "拒绝", "kind": "reject_once"},
        ],
    )
    task = asyncio.create_task(engine.request_interaction(event, lambda e: None))
    await asyncio.sleep(0)
    await engine.approve_tool(tool_call_id, True)
    response = await task
    assert response["outcome"]["option_id"] == "allow_once"

    task = asyncio.create_task(engine.request_interaction(event, lambda e: None))
    await asyncio.sleep(0)
    await engine.approve_tool(tool_call_id, False)
    response = await task
    assert response["outcome"]["option_id"] == "reject_once"


class _ApprovalProbeEngine(AcpEngineBase):
    ENGINE_ID = "approval-probe"

    @staticmethod
    def is_installed() -> bool:
        return True

    @staticmethod
    def get_version() -> str | None:
        return "probe"

    @staticmethod
    def resolve_binary() -> str | None:
        return None


def test_resolve_thinking_effort():
    from engines.core.base import (
        THINKING_EFFORT_LEVELS,
        THINKING_EFFORT_VALUES,
        resolve_thinking_effort,
    )
    assert THINKING_EFFORT_VALUES == (
        "auto",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
    )
    assert THINKING_EFFORT_LEVELS == (
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
    )
    # 显式级别原样传递
    for level in THINKING_EFFORT_LEVELS:
        assert resolve_thinking_effort(level) == level
    # 自动：不传任何强度（忽略引擎配置默认）
    assert resolve_thinking_effort("auto") is None
    assert resolve_thinking_effort("auto", "high") is None
    assert resolve_thinking_effort("AUTO") is None
    # 空值回退引擎配置默认；默认不可用时返回 None
    assert resolve_thinking_effort("", "high") == "high"
    assert resolve_thinking_effort(None, "xhigh") == "xhigh"
    assert resolve_thinking_effort("") is None
    assert resolve_thinking_effort("", "auto") is None
    assert resolve_thinking_effort("", "ultra") is None
    # 非法值防御性回退默认
    assert resolve_thinking_effort("ultra", "medium") == "medium"
    assert resolve_thinking_effort("ultra") is None
