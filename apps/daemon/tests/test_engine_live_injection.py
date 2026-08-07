"""Engine live stage message injection tests (API / Codex / ACP / SDK engines)."""

import asyncio
import json
from types import SimpleNamespace

import pytest

from engines.acp_base import AcpEngineBase
from engines.api import APIEngine
from engines.base import BaseLLMEngine
from engines.codex import CodexEngine
from engines.events import InternalEvent
from engines.registry import _ALL_ENGINES


class _FakeApiConfigStore:
    def get_api_engine_config(self):
        return {
            "provider": "openai",
            "api_key": "test",
            "base_url": "http://localhost:1/v1",
            "model": "gpt-test",
        }


@pytest.mark.anyio
async def test_api_engine_injects_live_messages_between_rounds(monkeypatch):
    from engines import api as api_module

    monkeypatch.setattr(api_module, "config_store", _FakeApiConfigStore())
    APIEngine._live_message_wait_seconds = 0.05
    calls: list[list[dict]] = []

    async def fake_call(self, client, model, messages, api_base):
        calls.append(list(messages))
        return [InternalEvent(type="text_delta", data={"delta": f"round-{len(calls)}"})]

    monkeypatch.setattr(APIEngine, "_call_openai", fake_call)

    queue: asyncio.Queue = asyncio.Queue()
    queue.put_nowait(("mid-1", "第一条注入"))
    events = [
        event
        async for event in APIEngine().spawn(
            prompt="原始任务",
            cwd="/tmp",
            live_message_queue=queue,
        )
    ]

    assert len(calls) == 2
    assert calls[0][0]["role"] == "user"
    assert calls[0][0]["content"] == "原始任务"
    # 第二轮：user + assistant + 注入 user
    assert [item["role"] for item in calls[1]] == ["user", "assistant", "user"]
    assert calls[1][2]["content"] == "第一条注入"
    delivered = [event for event in events if event.type == "live_message"]
    assert [event.data["message_id"] for event in delivered] == ["mid-1"]
    assert delivered[0].data["status"] == "delivered"


class _LiveFakeStdin:
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


class _LiveFakeCodexProcess:
    def __init__(self, stdout: bytes | None = None, eof: bool = True):
        self.stdin = _LiveFakeStdin()
        self.stdout = asyncio.StreamReader()
        if stdout is not None:
            self.stdout.feed_data(stdout)
        if eof:
            self.stdout.feed_eof()
        self.stderr = asyncio.StreamReader()
        self.stderr.feed_eof()
        self.returncode = 0
        self.terminated = False
        self.args: list[str] = []

    async def wait(self) -> int:
        return self.returncode

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.terminated = True


def _codex_config():
    return {
        "sandbox_mode": "workspace-write",
        "model_reasoning_effort": "",
        "approval_policy": "",
    }


@pytest.mark.anyio
async def test_codex_spawn_restarts_with_resume_on_live_message(monkeypatch):
    """codex exec 无注入协议：插入消息时终止当前进程，用新消息 resume 重启会话。"""
    first = _LiveFakeCodexProcess(
        stdout=b'{"type":"thread.started","thread_id":"thread-1"}\n',
        eof=False,
    )
    second = _LiveFakeCodexProcess(
        stdout=(
            b'{"type":"thread.started","thread_id":"thread-1"}\n'
            b'{"type":"item.completed",'
            b'"item":{"type":"agent_message","text":"resumed answer"}}\n'
        )
    )
    spawned = [first, second]

    async def fake_create_subprocess_exec(*args, **kwargs):
        process = spawned.pop(0)
        process.args = list(args)
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(
        CodexEngine,
        "resolve_binary",
        staticmethod(lambda: "/fake/codex"),
    )
    monkeypatch.setattr(
        "engines.codex.config_store.get_codex_config",
        lambda: _codex_config(),
    )

    queue: asyncio.Queue = asyncio.Queue()
    events: list[InternalEvent] = []

    async def consume():
        async for event in CodexEngine().spawn(
            prompt="hello",
            cwd="/tmp",
            live_message_queue=queue,
        ):
            events.append(event)

    consumer = asyncio.create_task(consume())
    # 等待首个会话建立（thread.started 已被读取、_thread_id 已就绪）后再插入
    for _ in range(200):
        if any(event.type == "session_started" for event in events):
            break
        await asyncio.sleep(0.01)
    assert any(event.type == "session_started" for event in events)
    queue.put_nowait(("mid-1", "注入内容"))
    await asyncio.wait_for(consumer, timeout=10)

    # 插入消息以 delivered 上报，当前进程被终止
    delivered = [event for event in events if event.type == "live_message"]
    assert len(delivered) == 1
    assert delivered[0].data["message_id"] == "mid-1"
    assert delivered[0].data["content"] == "注入内容"
    assert delivered[0].data["status"] == "delivered"
    assert first.terminated is True

    # 第二次启动使用 `codex exec resume <thread_id> <插入消息>` 延续会话
    assert second.args[:4] == [
        "/fake/codex", "exec", "--json", "--skip-git-repo-check",
    ]
    assert second.args[4:7] == ["resume", "thread-1", "注入内容"]
    deltas = "".join(
        event.data.get("delta", "")
        for event in events
        if event.type == "text_delta"
    )
    assert deltas == "resumed answer"


@pytest.mark.anyio
async def test_codex_send_live_stage_message_not_supported(monkeypatch):
    engine = CodexEngine()
    engine._running = True

    delivered = await engine.send_live_stage_message("补充说明")
    assert delivered is False


def test_all_registered_engines_advertise_live_support_except_placeholder():
    """除 openclaw（占位引擎）外均支持 live 注入（codex 以 resume 重启方式支持）。"""
    for engine_id, engine_cls in _ALL_ENGINES.items():
        engine = engine_cls()
        if engine_id == "openclaw":
            assert engine.supports_live_stage_message is False, engine_id
        else:
            assert engine.supports_live_stage_message is True, engine_id
        assert isinstance(engine, BaseLLMEngine)


def test_acp_base_engine_advertises_live_support():
    from engines.hermes import HermesEngine

    assert issubclass(HermesEngine, AcpEngineBase)
    engine = HermesEngine()
    assert engine.supports_live_stage_message is True
    assert engine.supports_interactive is True
