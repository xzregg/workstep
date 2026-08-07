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
    def __init__(self):
        self.stdin = _LiveFakeStdin()
        self.stdout = asyncio.StreamReader()
        self.stdout.feed_data(b'{"type":"turn.started"}\n')
        self.stdout.feed_eof()
        self.stderr = asyncio.StreamReader()
        self.stderr.feed_eof()
        self.returncode = 0

    async def wait(self) -> int:
        return self.returncode


def _codex_config():
    return {
        "sandbox_mode": "workspace-write",
        "model_reasoning_effort": "",
        "approval_policy": "",
    }


@pytest.mark.anyio
async def test_codex_spawn_live_mode_writes_jsonl_events(monkeypatch):
    process = _LiveFakeCodexProcess()

    async def fake_create_subprocess_exec(*args, **kwargs):
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
    queue.put_nowait(("mid-1", "注入内容"))
    events = [
        event
        async for event in CodexEngine().spawn(
            prompt="hello",
            cwd="/tmp",
            live_message_queue=queue,
        )
    ]

    lines = [
        json.loads(line)
        for line in process.stdin.written.decode().strip().splitlines()
        if line.strip()
    ]
    assert lines[0] == {"type": "user_message", "payload": {"content": "hello"}}
    assert lines[1] == {
        "type": "user_message",
        "payload": {"content": "注入内容"},
    }
    assert lines[-1] == {"type": "close_session"}
    delivered = [event for event in events if event.type == "live_message"]
    assert [event.data["message_id"] for event in delivered] == ["mid-1"]
    assert delivered[0].data["status"] == "delivered"


@pytest.mark.anyio
async def test_codex_send_live_stage_message_writes_user_message(monkeypatch):
    engine = CodexEngine()
    stdin = _LiveFakeStdin()
    engine._process = SimpleNamespace(stdin=stdin)
    engine._running = True

    delivered = await engine.send_live_stage_message("补充说明")
    assert delivered is True
    payload = json.loads(stdin.written.decode())
    assert payload == {
        "type": "user_message",
        "payload": {"content": "补充说明"},
    }


def test_all_registered_engines_advertise_live_support_except_placeholder():
    """Every registered engine except the openclaw placeholder supports live injection."""
    for engine_id, engine_cls in _ALL_ENGINES.items():
        engine = engine_cls()
        if engine_id == "openclaw":
            assert engine.supports_live_stage_message is False
        else:
            assert engine.supports_live_stage_message is True, engine_id
        assert isinstance(engine, BaseLLMEngine)


def test_acp_base_engine_advertises_live_support():
    from engines.hermes import HermesEngine

    assert issubclass(HermesEngine, AcpEngineBase)
    engine = HermesEngine()
    assert engine.supports_live_stage_message is True
    assert engine.supports_interactive is True
