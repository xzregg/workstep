"""Engine live stage message injection tests (Codex / ACP / SDK engines)."""

import asyncio
import json
from types import SimpleNamespace

import pytest

from engines.core.acp_base import AcpEngineBase
from engines.core.base import BaseLLMEngine
from engines.claude_agent_sdk import ClaudeAgentSDKEngine
from engines.codex import CodexEngine
from engines.codex_sdk import CodexSDKEngine
from engines.qoder_sdk import QoderSDKEngine
from engines.core.events import InternalEvent
from engines.core.registry import _ALL_ENGINES


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
        (event.data.get("content") or {}).get("text", "")
        for event in events
        if event.type == "agent_message_chunk"
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


async def _collect_codex_args(monkeypatch, config_overrides, model=None):
    """Run one codex spawn and return the subprocess argv."""
    process = _LiveFakeCodexProcess(
        stdout=b'{"type":"thread.started","thread_id":"thread-1"}\n'
        b'{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n'
    )
    captured: dict = {}

    async def fake_create_subprocess_exec(*args, **kwargs):
        process.args = list(args)
        captured["process"] = process
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

    async def consume():
        async for event in CodexEngine().spawn(
            prompt="hello",
            cwd="/tmp",
            model=model,
            config_overrides=config_overrides,
        ):
            pass

    await consume()
    return captured["process"].args


@pytest.mark.anyio
async def test_codex_spawn_applies_config_overrides(monkeypatch):
    """阶段级 config 覆盖 sandbox/推理强度/审批策略并拼入 CLI 参数。"""
    args = await _collect_codex_args(
        monkeypatch,
        {
            "sandbox_mode": "danger-full-access",
            "model_reasoning_effort": "high",
            "approval_policy": "never",
        },
    )
    assert "--sandbox" in args
    assert args[args.index("--sandbox") + 1] == "danger-full-access"
    assert "-c" in args
    assert "model_reasoning_effort=high" in args
    assert "approval_policy=never" in args


@pytest.mark.anyio
async def test_codex_spawn_empty_overrides_fall_back_to_global(monkeypatch):
    """空覆盖项回退全局配置。"""
    args = await _collect_codex_args(monkeypatch, {})
    assert args[args.index("--sandbox") + 1] == "workspace-write"


@pytest.mark.anyio
async def test_codex_spawn_explicit_model_wins_over_override(monkeypatch):
    """显式 model 参数优先于覆盖项中的 model。"""
    args = await _collect_codex_args(
        monkeypatch,
        {"model": "override-model"},
        model="explicit-model",
    )
    assert "--model" in args
    assert args[args.index("--model") + 1] == "explicit-model"


# --- ClaudeAgentSDKEngine / QoderSDKEngine interactive-client live injection ---


class _FakeSdkClient:
    """Minimal bidirectional SDK client stand-in.

    Consumes the streamed prompt source (initial prompt + live injections);
    ``receive_messages`` yields one result after the injected message has been
    consumed (mid-run steering, the supported scenario), then stays open until
    ``end_stream`` (stdin EOF after the prompt source ends → CLI exits → the
    SDK emits its stream-end frame). Records options and every message.
    """

    instances: list["_FakeSdkClient"] = []

    def __init__(self, options=None, transport=None):
        self.options = options
        self.transport = transport
        self.queries: list[str] = []
        self.connected = False
        self.disconnected = False
        self.end_stream = asyncio.Event()
        self.injection_seen = asyncio.Event()
        self.input_ended = asyncio.Event()
        _FakeSdkClient.instances.append(self)

    async def connect(self, prompt=None):
        self.connected = True

    async def query(self, prompt, session_id="default", **kwargs):
        if hasattr(prompt, "__aiter__"):
            async for message in prompt:
                self.queries.append(message["message"]["content"])
                if len(self.queries) > 1:
                    self.injection_seen.set()
        else:
            self.queries.append(prompt)
        self.input_ended.set()

    async def receive_messages(self):
        # 真实 SDK 在回合中收到插入消息后产出 result；无插入时收到
        # stdin EOF（prompt 源结束）直接收流，不产出 result。
        if len(self.queries) <= 1 and not self.end_stream.is_set():
            waiters = [
                asyncio.create_task(self.injection_seen.wait()),
                asyncio.create_task(self.end_stream.wait()),
            ]
            try:
                done, _ = await asyncio.wait(
                    waiters, return_when=asyncio.FIRST_COMPLETED
                )
            finally:
                for waiter in waiters:
                    waiter.cancel()
        if len(self.queries) <= 1:
            return
        yield SimpleNamespace(
            type="result",
            subtype="success",
            result="完成",
            session_id="sess-1",
            usage={},
        )
        await self.end_stream.wait()

    async def disconnect(self):
        self.disconnected = True


async def _noop_sdk_query(prompt, options):
    if False:  # pragma: no cover
        yield None


def _patch_claude_sdk(monkeypatch):
    _FakeSdkClient.instances.clear()
    monkeypatch.setattr("claude_agent_sdk.ClaudeSDKClient", _FakeSdkClient)
    monkeypatch.setattr("claude_agent_sdk.query", _noop_sdk_query)
    monkeypatch.setattr(
        ClaudeAgentSDKEngine,
        "resolve_binary",
        staticmethod(lambda: "/fake/claude"),
    )
    monkeypatch.setattr(
        "engines.claude_agent_sdk.config_store.get_claude_agent_sdk_config",
        lambda: {
            "permission_mode": "acceptEdits",
            "max_turns": "",
            "fallback_model": "",
        },
    )


def _patch_qoder_sdk(monkeypatch):
    _FakeSdkClient.instances.clear()
    monkeypatch.setattr("qoder_agent_sdk.QoderSDKClient", _FakeSdkClient)
    monkeypatch.setattr("qoder_agent_sdk.query", _noop_sdk_query)
    monkeypatch.setattr(
        QoderSDKEngine,
        "resolve_binary",
        staticmethod(lambda: "/fake/qoder"),
    )
    monkeypatch.setattr(QoderSDKEngine, "is_configured", lambda self: True)
    monkeypatch.setattr(
        "engines.qoder_sdk.config_store.get_qoder_sdk_config",
        lambda: {
            "personal_access_token": "token",
            "permission_mode": "default",
            "model": "",
            "allowed_tools": "",
            "max_turns": "",
            "include_partial_messages": True,
        },
    )



@pytest.mark.anyio
async def test_claude_agent_sdk_client_injects_live_message(monkeypatch):
    """ClaudeSDKClient 交互模式：运行中插入消息经 query() 注入并确认投递。"""
    _patch_claude_sdk(monkeypatch)
    queue: asyncio.Queue = asyncio.Queue()
    events: list[InternalEvent] = []

    async def consume():
        async for event in ClaudeAgentSDKEngine().spawn(
            prompt="开始任务",
            cwd="/tmp",
            session_id="sess-1",
            live_message_queue=queue,
        ):
            events.append(event)

    consumer = asyncio.create_task(consume())
    for _ in range(200):
        if _FakeSdkClient.instances and _FakeSdkClient.instances[0].connected:
            break
        await asyncio.sleep(0.01)
    client = _FakeSdkClient.instances[0]
    assert client.queries == ["开始任务"]
    assert client.options.resume == "sess-1"
    queue.put_nowait(("mid-1", "请停下来改方案"))
    for _ in range(200):
        if client.queries == ["开始任务", "请停下来改方案"]:
            break
        await asyncio.sleep(0.01)
    client.end_stream.set()
    await asyncio.wait_for(consumer, timeout=10)

    assert client.queries == ["开始任务", "请停下来改方案"]
    delivered = [e for e in events if e.type == "live_message"]
    assert delivered and delivered[0].data["message_id"] == "mid-1"
    assert delivered[0].data["status"] == "delivered"
    assert client.disconnected is True


@pytest.mark.anyio
async def test_claude_agent_sdk_client_reports_failed_injection(monkeypatch):
    """引擎已收流后放入的插入消息不再被投递（delivered）；runner 在阶段
    收尾时会把队列残留消息统一标记 failed（见 runner 用例），不静默丢失。"""
    _patch_claude_sdk(monkeypatch)
    queue: asyncio.Queue = asyncio.Queue()
    events: list[InternalEvent] = []

    async def consume():
        async for event in ClaudeAgentSDKEngine().spawn(
            prompt="开始任务",
            cwd="/tmp",
            live_message_queue=queue,
        ):
            events.append(event)

    consumer = asyncio.create_task(consume())
    for _ in range(200):
        if _FakeSdkClient.instances and _FakeSdkClient.instances[0].queries:
            break
        await asyncio.sleep(0.01)
    client = _FakeSdkClient.instances[0]
    # 先结束流（stdin EOF）并等 prompt 源收尾，再放入插入消息：
    # 引擎已收流、无人消费，消息不应被投递。
    client.end_stream.set()
    for _ in range(200):
        if client.input_ended.is_set():
            break
        await asyncio.sleep(0.01)
    assert client.input_ended.is_set()
    queue.put_nowait(("late-1", "迟到的消息"))
    await asyncio.wait_for(consumer, timeout=10)

    assert not any(
        e.type == "live_message" and e.data.get("status") == "delivered"
        for e in events
    ), "收流后放入的插入消息不应被投递"
    assert client.disconnected is True


@pytest.mark.anyio
async def test_qoder_sdk_client_injects_live_message(monkeypatch):
    """QoderSDKClient 交互模式：运行中插入消息经 query() 注入并确认投递。"""
    _patch_qoder_sdk(monkeypatch)
    queue: asyncio.Queue = asyncio.Queue()
    events: list[InternalEvent] = []

    async def consume():
        async for event in QoderSDKEngine().spawn(
            prompt="开始任务",
            cwd="/tmp",
            session_id="sess-1",
            live_message_queue=queue,
        ):
            events.append(event)

    consumer = asyncio.create_task(consume())
    for _ in range(200):
        if _FakeSdkClient.instances and _FakeSdkClient.instances[0].queries:
            break
        await asyncio.sleep(0.01)
    client = _FakeSdkClient.instances[0]
    assert client.queries == ["开始任务"]
    assert client.options.resume == "sess-1"
    queue.put_nowait(("mid-1", "请停下来改方案"))
    for _ in range(200):
        if client.queries == ["开始任务", "请停下来改方案"]:
            break
        await asyncio.sleep(0.01)
    client.end_stream.set()
    await asyncio.wait_for(consumer, timeout=10)

    assert client.queries == ["开始任务", "请停下来改方案"]
    delivered = [e for e in events if e.type == "live_message"]
    assert delivered and delivered[0].data["message_id"] == "mid-1"
    assert delivered[0].data["status"] == "delivered"
    assert client.disconnected is True


@pytest.mark.anyio
async def test_qoder_sdk_client_reports_failed_injection(monkeypatch):
    """Qoder：引擎已收流后放入的插入消息不再被投递（delivered）。"""
    _patch_qoder_sdk(monkeypatch)
    queue: asyncio.Queue = asyncio.Queue()
    events: list[InternalEvent] = []

    async def consume():
        async for event in QoderSDKEngine().spawn(
            prompt="开始任务",
            cwd="/tmp",
            live_message_queue=queue,
        ):
            events.append(event)

    consumer = asyncio.create_task(consume())
    for _ in range(200):
        if _FakeSdkClient.instances and _FakeSdkClient.instances[0].queries:
            break
        await asyncio.sleep(0.01)
    client = _FakeSdkClient.instances[0]
    # 先结束流（stdin EOF）并等 prompt 源收尾，再放入插入消息：
    # 引擎已收流、无人消费，消息不应被投递。
    client.end_stream.set()
    for _ in range(200):
        if client.input_ended.is_set():
            break
        await asyncio.sleep(0.01)
    assert client.input_ended.is_set()
    queue.put_nowait(("late-1", "迟到的消息"))
    await asyncio.wait_for(consumer, timeout=10)

    assert not any(
        e.type == "live_message" and e.data.get("status") == "delivered"
        for e in events
    ), "收流后放入的插入消息不应被投递"
    assert client.disconnected is True


# --- CodexSDKEngine live injection ordering ---


class _FakeSdkTurn:
    def __init__(self, turn_id: str, deltas: list[str]):
        self.id = turn_id
        self._deltas = list(deltas)

    async def stream(self):
        for delta in self._deltas:
            yield SimpleNamespace(
                method="item/agentMessage/delta",
                payload=SimpleNamespace(delta=delta),
            )
        yield SimpleNamespace(
            method="turn/completed",
            payload=SimpleNamespace(
                turn=SimpleNamespace(
                    id=self.id,
                    status=SimpleNamespace(value="completed"),
                    error=None,
                )
            ),
        )


class _FakeSdkThread:
    def __init__(self, thread_id: str):
        self.id = thread_id
        self._turn_count = 0

    async def turn(self, prompt, model=None):
        self._turn_count += 1
        if self._turn_count == 1:
            return _FakeSdkTurn(f"turn-{self._turn_count}", ["第一段输出"])
        return _FakeSdkTurn(f"turn-{self._turn_count}", ["插入后的响应"])


class _FakeAsyncCodex:
    instances: list["_FakeAsyncCodex"] = []

    def __init__(self, **kwargs):
        self.closed = False
        self.threads: dict[str, _FakeSdkThread] = {}
        _FakeAsyncCodex.instances.append(self)

    async def thread_start(self, **kwargs):
        thread = _FakeSdkThread(f"thread-{len(self.threads) + 1}")
        self.threads[thread.id] = thread
        return thread

    async def thread_resume(self, session_id, **kwargs):
        thread = _FakeSdkThread(session_id)
        self.threads[session_id] = thread
        return thread

    async def close(self):
        self.closed = True


def _patch_codex_sdk(monkeypatch):
    _FakeAsyncCodex.instances.clear()
    monkeypatch.setattr("openai_codex.AsyncCodex", _FakeAsyncCodex)
    monkeypatch.setattr(
        "openai_codex.Sandbox",
        SimpleNamespace(
            read_only="read_only",
            workspace_write="workspace_write",
            full_access="full_access",
        ),
    )
    monkeypatch.setattr(
        "engines.codex_sdk.config_store.get_codex_sdk_config",
        lambda: {
            "model_reasoning_effort": "",
            "approval_mode": "",
            "sandbox": "workspace-write",
        },
    )


@pytest.mark.anyio
async def test_codex_sdk_acks_live_message_before_response_events(monkeypatch):
    """CodexSDK：插入消息的 delivered ack 必须先于响应事件，runner 才能
    在收到 ack 时封口插入前的输出段并开启新的响应段。"""
    _patch_codex_sdk(monkeypatch)
    queue: asyncio.Queue = asyncio.Queue()
    # 预置插入消息：首轮结束后立即被消费并开启响应轮（引擎在队列为空时
    # 立即收尾，不再等待插入窗口，因此消息必须在首轮完成前就已排队）。
    queue.put_nowait(("mid-1", "插入内容"))
    events: list[InternalEvent] = []

    async for event in CodexSDKEngine().spawn(
        prompt="开始任务",
        cwd="/tmp",
        live_message_queue=queue,
    ):
        events.append(event)

    deltas = [event for event in events if event.type == "agent_message_chunk"]
    assert [
        (event.data.get("content") or {}).get("text", "")
        for event in deltas
    ] == ["第一段输出", "插入后的响应"]
    acks = [event for event in events if event.type == "live_message"]
    assert len(acks) == 1
    assert acks[0].data["message_id"] == "mid-1"
    assert acks[0].data["status"] == "delivered"
    ack_index = events.index(acks[0])
    # 首轮输出在 ack 之前，插入后的响应在 ack 之后
    first_index = events.index(deltas[0])
    response_index = events.index(deltas[1])
    assert first_index < ack_index < response_index
    assert _FakeAsyncCodex.instances and _FakeAsyncCodex.instances[0].closed is True
