"""HermesEngine 适配器单元测试：能力诚实声明与模型列表降级。"""

from unittest import mock

import pytest
from acp import schema

from engines.core.acp_base import AcpEngineBase
from engines.hermes import HermesEngine


def _initialize_response():
    return schema.InitializeResponse(
        protocolVersion=1,
        agentCapabilities=schema.AgentCapabilities(
            loadSession=True,
            sessionCapabilities=schema.SessionCapabilities(
                resume=schema.SessionResumeCapabilities(),
            ),
        ),
    )


def test_resume_capability_hidden_until_hermes_fixes_it():
    """Hermes 的 session/resume 实测报 Internal error，必须隐藏。

    否则基类可能误入 resume 路径；续轮统一走 session/load
    （实测恢复上下文且不重播历史）。
    """
    resp = _initialize_response()
    assert not HermesEngine._agent_capability(
        resp, "session_capabilities", "resume"
    )
    # 其它能力原样委托基类：load 保持可用。
    assert AcpEngineBase._agent_capability(resp, "load_session")
    assert HermesEngine._agent_capability(resp, "load_session")


@pytest.mark.anyio
async def test_list_models_degrades_to_empty_on_failure():
    """session/new 失败（如 provider 未配置）时返回 [] 而非抛错。

    执行引擎配置页降级为仅默认模型，而不是整页报错。
    """
    engine = HermesEngine()
    with mock.patch.object(
        AcpEngineBase, "list_models", side_effect=RuntimeError("Internal error")
    ):
        assert await engine.list_models("/tmp") == []


@pytest.mark.anyio
async def test_bare_internal_error_gets_actionable_hint(monkeypatch):
    """Hermes 把真实原因吞成裸 Internal error 时，转成可行动的提示。"""
    from contextlib import asynccontextmanager

    from acp import schema

    class Client:
        async def initialize(self, **kwargs):
            return schema.InitializeResponse(
                protocolVersion=1,
                agentCapabilities=schema.AgentCapabilities(),
            )

        async def new_session(self, **kwargs):
            raise RuntimeError("Internal error")

    @asynccontextmanager
    async def fake_spawn(*args, **kwargs):
        yield Client(), object()

    monkeypatch.setattr("engines.core.acp_base.acp.spawn_agent_process", fake_spawn)
    engine = HermesEngine()
    monkeypatch.setattr(engine, "get_command", lambda: ["hermes", "acp"])
    events = [event async for event in engine.spawn("hi", "/tmp")]
    errors = [event for event in events if event.type == "error"]
    assert errors
    assert "hermes model" in errors[-1].data["message"]
    assert "Internal error" in errors[-1].data["message"]


def _replay_chunk(update_cls, session_update, text):
    return update_cls(
        sessionUpdate=session_update,
        content=schema.TextContentBlock(type="text", text=text),
    )


@pytest.mark.anyio
async def test_resumed_turn_drops_replayed_history(monkeypatch):
    """load 内重播的历史 chunk 不能混入新一轮正文（旧文复读回归）。

    Hermes 按 ACP 规范在 load 请求内重播整段历史；引擎在基类 yield
    session_started 的挂起点（load 已返回、prompt 未发出）同步丢弃
    内容型 update，本轮 live 与状态类 update 不受影响。
    """
    from contextlib import asynccontextmanager

    holder = {}

    class Client:
        async def initialize(self, **kwargs):
            return schema.InitializeResponse(
                protocolVersion=1,
                agentCapabilities=schema.AgentCapabilities(loadSession=True),
            )

        async def load_session(self, **kwargs):
            handler = holder["handler"]
            await handler.updates.put(_replay_chunk(
                schema.AgentMessageChunk, "agent_message_chunk", "OLD TURN TEXT"))
            await handler.updates.put(_replay_chunk(
                schema.AgentThoughtChunk, "agent_thought_chunk", "old thinking"))
            await handler.updates.put(schema.UsageUpdate(
                sessionUpdate="usage_update", used=10, size=100,
            ))
            return object()

        async def set_config_option(self, **kwargs):
            return None

        async def prompt(self, **kwargs):
            await holder["handler"].updates.put(_replay_chunk(
                schema.AgentMessageChunk, "agent_message_chunk", "NEW TURN TEXT"))
            return type("Response", (), {"usage": None, "stop_reason": "end_turn"})()

    @asynccontextmanager
    async def fake_spawn(*args, **kwargs):
        holder["handler"] = args[0]
        yield Client(), object()

    monkeypatch.setattr("engines.core.acp_base.acp.spawn_agent_process", fake_spawn)
    engine = HermesEngine()
    monkeypatch.setattr(engine, "get_command", lambda: ["hermes", "acp"])
    events = [event async for event in engine.spawn(
        "go on", "/tmp", session_id="s1"
    )]

    texts = [
        event.data.get("content", {}).get("text", "")
        for event in events
        if event.type in ("agent_message_chunk", "agent_thought_chunk")
    ]
    assert not [event for event in events if event.type == "error"]
    assert "NEW TURN TEXT" in texts
    assert not any("OLD TURN TEXT" in text for text in texts)
    assert not any("old thinking" in text for text in texts)
    assert [event for event in events if event.type == "usage_update"]
