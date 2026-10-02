"""opencode 运行中插入打断 prompt 的回归测试（引擎本地实现）。

opencode 的 spawn 在等待 prompt 时轮询插入队列，有新消息就
``session/cancel`` 打断本轮；cancelled 且队列非空时不收尾，
直接用新消息重开一轮（Codex CLI 终止重开的 ACP 等价）。
cancel 失败则回退为等整轮结束。其它 ACP 引擎仍走基类实现，
本文件同时断言基类默认行为未被改动。
"""

import asyncio
import os
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

import acp
from engines.core.acp_base import AcpEngineBase
from engines.opencode import OpencodeEngine


class _OpencodeProbe(OpencodeEngine):
    """去副作用的 opencode：不写权限配置文件，不碰 runtime。"""

    def project_skill_env(self, cwd: str):
        return {}

    async def set_permission_mode(self, mode: str) -> None:
        return None

    def runtime_permission_mode(self):
        return None

    def resolve_provider_runtime(self, provider_id="", model=None, protocol=None):
        return SimpleNamespace(
            model=None, provider_id="", env={},
            child_env=lambda: dict(os.environ),
        )

    def _validate_session_inputs(self, init_resp, add_dirs, mcp_servers):
        return None

    def _acp_prompt_blocks(self, prompt, images=None):
        return []


class _FakeClient:
    """首轮 prompt 等 cancel，第二轮正常结束；记录调用与 cancel。"""

    def __init__(self):
        self.prompts: list[list] = []
        self.cancels: list[str] = []
        self.cancel_event = asyncio.Event()
        self.wait_for_cancel = True

    async def initialize(self, **kwargs):
        return SimpleNamespace(protocol_version=acp.PROTOCOL_VERSION)

    async def new_session(self, **kwargs):
        return SimpleNamespace(session_id="sess-1")

    async def cancel(self, session_id: str, **kwargs):
        self.cancels.append(session_id)
        self.cancel_event.set()

    async def prompt(self, session_id: str, prompt: list, **kwargs):
        self.prompts.append(list(prompt))
        if self.wait_for_cancel and len(self.prompts) == 1:
            await asyncio.wait_for(self.cancel_event.wait(), timeout=10)
            return SimpleNamespace(stop_reason="cancelled")
        return SimpleNamespace(stop_reason="end_turn")


def _install_fake(monkeypatch, client):
    @asynccontextmanager
    async def _spawn(handler, *args, **kwargs):
        yield client, SimpleNamespace()

    monkeypatch.setattr(acp, "spawn_agent_process", _spawn)


def _block_text(block) -> str:
    text = getattr(block, "text", None)
    if isinstance(text, str):
        return text
    content = getattr(block, "content", None)
    if isinstance(content, dict):
        return str(content.get("text") or "")
    return str(block)


@pytest.mark.asyncio
async def test_opencode_cancels_and_reprompts_on_live_message(monkeypatch):
    engine = _OpencodeProbe()
    client = _FakeClient()
    _install_fake(monkeypatch, client)
    queue: asyncio.Queue = asyncio.Queue()
    queue.put_nowait(("live-1", "新消息打断上一轮"))

    events = []
    async for event in engine.spawn(
        prompt="第一轮问题", cwd="/tmp", live_message_queue=queue,
    ):
        events.append(event)

    assert client.cancels == ["sess-1"]
    assert len(client.prompts) == 2
    assert any(
        "新消息打断上一轮" in _block_text(block)
        for block in client.prompts[1]
    ), client.prompts
    delivered = [
        event for event in events
        if event.type == "live_message"
        and event.data.get("message_id") == "live-1"
        and event.data.get("status") == "delivered"
    ]
    assert delivered, [event.to_dict() for event in events]
    assert not any(
        event.type == "status" and event.data.get("status") == "stopped"
        for event in events
    )
    assert events[-1].type == "status" and events[-1].data.get("status") == "done"


@pytest.mark.asyncio
async def test_opencode_falls_back_to_waiting_when_cancel_fails(monkeypatch):
    engine = _OpencodeProbe()
    client = _FakeClient()

    async def _boom(session_id: str, **kwargs):
        raise RuntimeError("agent 不支持 session/cancel")

    client.cancel = _boom  # type: ignore[method-assign]
    client.wait_for_cancel = False
    _install_fake(monkeypatch, client)
    queue: asyncio.Queue = asyncio.Queue()
    queue.put_nowait(("live-1", "等整轮结束再说"))

    events = []
    async for event in engine.spawn(
        prompt="第一轮问题", cwd="/tmp", live_message_queue=queue,
    ):
        events.append(event)

    assert len(client.prompts) == 2
    delivered = [
        event for event in events
        if event.type == "live_message"
        and event.data.get("message_id") == "live-1"
        and event.data.get("status") == "delivered"
    ]
    assert delivered


def test_acp_base_spawn_has_no_interrupt_logic():
    """其它引擎走基类：基类 spawn 不轮询队列、不发 cancel、不改 cancelled 语义。"""
    import inspect

    source = inspect.getsource(AcpEngineBase.spawn)
    assert ".cancel(" not in source
    assert "session/cancel" not in source
    assert "interrupt" not in source
    assert "live_message_queue" in source  # 等整轮结束再消费的逻辑仍在
