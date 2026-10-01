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
    events = [event async for event in HermesEngine().spawn("hi", "/tmp")]
    errors = [event for event in events if event.type == "error"]
    assert errors
    assert "hermes model" in errors[-1].data["message"]
    assert "Internal error" in errors[-1].data["message"]
