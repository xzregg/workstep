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
async def test_codex_cli_preserves_explicit_phase_and_unmarked_answers(monkeypatch):
    frames = [
        {"type": "item.completed", "item": {"type": "agent_message", "id": "p", "phase": "commentary", "text": "检查中"}},
        {"type": "item.completed", "item": {"type": "agent_message", "id": "f", "phase": "final_answer", "text": "完成"}},
        {"type": "item.completed", "item": {"type": "agent_message", "id": "old", "text": "普通回复"}},
    ]
    process = _LiveFakeCodexProcess(stdout=("\n".join(json.dumps(frame) for frame in frames) + "\n").encode())

    async def spawn(*args, **kwargs):
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(CodexEngine, "resolve_binary", staticmethod(lambda: "/fake/codex"))
    monkeypatch.setattr("engines.codex.config_store.get_codex_config", _codex_config)
    events = [event async for event in CodexEngine().spawn(prompt="检查", cwd="/tmp")]
    assert [(event.data.get("phase"), event.data.get("source_item_id"), event.data["content"]["text"])
            for event in events if event.type == "agent_message_chunk"] == [
        ("commentary", "p", "检查中"), ("final_answer", "f", "完成"), (None, "old", "普通回复"),
    ]


@pytest.mark.anyio
async def test_codex_cli_marks_intermediate_unphased_messages_as_commentary(monkeypatch):
    """Codex CLI 旧协议不带 phase：只有最后一个未标记消息应作为结果。"""
    frames = [
        {"type": "item.completed", "item": {
            "type": "agent_message", "id": "p1", "text": "我先定位实现。",
        }},
        {"type": "item.started", "item": {
            "type": "command_execution", "id": "c1", "command": "rg phase",
        }},
        {"type": "item.completed", "item": {
            "type": "command_execution", "id": "c1", "output": "ok", "exit_code": 0,
        }},
        {"type": "item.completed", "item": {
            "type": "agent_message", "id": "p2", "text": "我会继续修改并验证。",
        }},
        {"type": "item.started", "item": {
            "type": "command_execution", "id": "c2", "command": "pytest",
        }},
        {"type": "item.completed", "item": {
            "type": "command_execution", "id": "c2", "output": "passed", "exit_code": 0,
        }},
        {"type": "item.completed", "item": {
            "type": "agent_message", "id": "final", "text": "已完成。",
        }},
        {"type": "turn.completed", "usage": {}},
    ]
    process = _LiveFakeCodexProcess(
        stdout=("\n".join(json.dumps(frame) for frame in frames) + "\n").encode()
    )

    async def spawn(*args, **kwargs):
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(CodexEngine, "resolve_binary", staticmethod(lambda: "/fake/codex"))
    monkeypatch.setattr("engines.codex.config_store.get_codex_config", _codex_config)

    events = [event async for event in CodexEngine().spawn(prompt="检查", cwd="/tmp")]

    assert [
        (event.data.get("phase"), event.data.get("source_item_id"), event.data["content"]["text"])
        for event in events
        if event.type == "agent_message_chunk"
    ] == [
        ("commentary", "p1", "我先定位实现。"),
        ("commentary", "p2", "我会继续修改并验证。"),
        (None, "final", "已完成。"),
    ]


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
async def test_codex_send_live_step_message_not_supported(monkeypatch):
    engine = CodexEngine()
    engine._running = True

    delivered = await engine.send_live_step_message("补充说明")
    assert delivered is False


def test_registered_engines_advertise_live_support_honestly():
    """OpenClaw 与 DeepSeek Harness 无运行中注入入口，其余引擎支持。"""
    for engine_id, engine_cls in _ALL_ENGINES.items():
        engine = engine_cls()
        if engine_id in {"openclaw", "deepseek_harness"}:
            assert engine.supports_live_step_message is False, engine_id
        else:
            assert engine.supports_live_step_message is True, engine_id
        assert isinstance(engine, BaseLLMEngine)


def test_acp_base_engine_advertises_live_support():
    from engines.hermes import HermesEngine

    assert issubclass(HermesEngine, AcpEngineBase)
    engine = HermesEngine()
    assert engine.supports_live_step_message is True
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
        self.steered: list[str] = []

    async def steer(self, content):
        self.steered.append(content)

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
        self._client = SimpleNamespace(
            _sync=SimpleNamespace(_approval_handler=None)
        )
        _FakeAsyncCodex.instances.append(self)

    async def thread_start(self, **kwargs):
        thread = _FakeSdkThread(f"thread-{len(self.threads) + 1}")
        self.threads[thread.id] = thread
        return thread

    async def thread_resume(self, session_id, **kwargs):
        thread = _FakeSdkThread(session_id)
        self.threads[session_id] = thread
        return thread

    async def thread_fork(self, session_id, **kwargs):
        thread = _FakeSdkThread(f"{session_id}-fork")
        self.threads[thread.id] = thread
        return thread

    async def close(self):
        self.closed = True


class _FakeNativePlanClient:
    def __init__(self):
        self.calls: list[dict] = []
        self._sync = SimpleNamespace(_approval_handler=None)

    async def _start_turn(self, thread_id, prompt, params, for_handle):
        self.calls.append({
            "thread_id": thread_id,
            "prompt": prompt,
            "params": params,
            "for_handle": for_handle,
        })
        return (
            SimpleNamespace(turn=SimpleNamespace(id="turn-native-plan")),
            "subscription-native-plan",
        )


class _FakeLegacyNativePlanClient:
    def __init__(self):
        self.calls: list[dict] = []

    async def turn_start(self, thread_id, prompt, params):
        self.calls.append({
            "thread_id": thread_id,
            "prompt": prompt,
            "params": params,
        })
        return SimpleNamespace(turn=SimpleNamespace(id="turn-legacy-plan"))


class _FakeSdkTurnHandle:
    def __init__(self, client, thread_id, turn_id):
        self.client = client
        self.thread_id = thread_id
        self.id = turn_id


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
async def test_codex_sdk_preserves_message_phases_per_item(monkeypatch):
    _patch_codex_sdk(monkeypatch)

    class PhasedTurn(_FakeSdkTurn):
        async def stream(self):
            for item_id, phase, text, started, streamed in [
                ("progress-1", "commentary", "我先定位组件。", True, True),
                ("progress-2", "commentary", "正在核对。", False, True),
                ("answer", "final_answer", "已完成。", True, False),
            ]:
                item = SimpleNamespace(type="agentMessage", id=item_id, phase=phase, text=text)
                if started:
                    yield SimpleNamespace(method="item/started", payload=SimpleNamespace(item=item))
                if streamed:
                    yield SimpleNamespace(method="item/agentMessage/delta", payload=SimpleNamespace(
                        item_id=item_id, delta=text,
                    ))
                yield SimpleNamespace(method="item/completed", payload=SimpleNamespace(item=item))
                # Repeated completion must not duplicate a message item.
                yield SimpleNamespace(method="item/completed", payload=SimpleNamespace(item=item))

    async def turn(self, prompt, model=None):
        return PhasedTurn("turn-phases", [])

    monkeypatch.setattr(_FakeSdkThread, "turn", turn)
    events = [event async for event in CodexSDKEngine().spawn(prompt="开始", cwd="/tmp")]
    messages = [event.data for event in events if event.type == "agent_message_chunk"]
    assert [(data.get("phase"), data.get("source_item_id"), data["content"]["text"])
            for data in messages] == [
        ("commentary", "progress-1", "我先定位组件。"),
        ("commentary", "progress-2", "正在核对。"),
        ("final_answer", "answer", "已完成。"),
    ]


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("plan_mode", "expected_mode"),
    [(True, "plan"), (False, "default")],
)
async def test_codex_sdk_sends_native_collaboration_mode(
    monkeypatch,
    plan_mode,
    expected_mode,
):
    """Codex SDK 计划开关必须走 app-server collaborationMode。"""
    _patch_codex_sdk(monkeypatch)
    raw_client = _FakeNativePlanClient()
    created_turns: list[dict] = []

    class NativePlanAsyncCodex(_FakeAsyncCodex):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            self._client = raw_client

    class NativePlanTurn(_FakeSdkTurn):
        def __init__(self, client, thread_id, turn_id, *, _subscription=None):
            created_turns.append({
                "client": client,
                "thread_id": thread_id,
                "turn_id": turn_id,
                "subscription": _subscription,
            })
            super().__init__(turn_id, ["完成"])

    monkeypatch.setattr("openai_codex.AsyncCodex", NativePlanAsyncCodex)
    monkeypatch.setattr("openai_codex.AsyncTurnHandle", NativePlanTurn)

    events = [
        event
        async for event in CodexSDKEngine().spawn(
            prompt="处理请求",
            cwd="/tmp",
            model="gpt-5.6-codex",
            thinking_effort="high",
            plan_mode=plan_mode,
        )
    ]

    assert any(event.type == "agent_message_chunk" for event in events)
    assert raw_client.calls == [{
        "thread_id": "thread-1",
        "prompt": "处理请求",
        "params": {
            "collaborationMode": {
                "mode": expected_mode,
                "settings": {
                    "model": "gpt-5.6-codex",
                    "reasoning_effort": "high",
                    "developer_instructions": None,
                },
            },
        },
        "for_handle": True,
    }]
    assert created_turns[0]["subscription"] == "subscription-native-plan"


@pytest.mark.anyio
async def test_codex_sdk_native_plan_keeps_legacy_sdk_compatibility():
    """0.147.x 没有早订阅入口时仍能通过 raw turn_start 启动模式。"""
    raw_client = _FakeLegacyNativePlanClient()
    client = SimpleNamespace(_client=raw_client)
    thread = _FakeSdkThread("thread-legacy")

    turn = await CodexSDKEngine._start_collaboration_turn(
        client,
        thread,
        "规划请求",
        model="gpt-5.6-codex",
        reasoning_effort=None,
        plan_mode=True,
        turn_handle_type=_FakeSdkTurnHandle,
    )

    assert turn.id == "turn-legacy-plan"
    assert raw_client.calls[0]["params"]["collaborationMode"]["mode"] == "plan"


@pytest.mark.anyio
async def test_codex_sdk_forks_to_an_independent_thread(monkeypatch):
    _patch_codex_sdk(monkeypatch)

    forked = await CodexSDKEngine().fork_session("thread-source", "/tmp")

    assert forked == "thread-source-fork"
    assert _FakeAsyncCodex.instances[0].closed is True


@pytest.mark.anyio
async def test_codex_sdk_acks_live_message_before_response_events(monkeypatch):
    """CodexSDK：插入消息的 delivered ack 必须先于响应事件，runner 才能
    在收到 ack 时封口插入前的输出段并开启新的响应段。"""
    _patch_codex_sdk(monkeypatch)
    queue: asyncio.Queue = asyncio.Queue()
    # 预置插入消息：活动 turn 建立后应立即 steer，不应另开响应 turn。
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
    ] == ["第一段输出"]
    acks = [event for event in events if event.type == "live_message"]
    assert len(acks) == 1
    assert acks[0].data["message_id"] == "mid-1"
    assert acks[0].data["status"] == "delivered"
    ack_index = events.index(acks[0])
    # 预置消息先 steer 当前 turn，再消费当前 turn 的输出。
    first_index = events.index(deltas[0])
    assert ack_index < first_index
    thread = next(iter(_FakeAsyncCodex.instances[0].threads.values()))
    assert thread._turn_count == 1
    assert _FakeAsyncCodex.instances and _FakeAsyncCodex.instances[0].closed is True


@pytest.mark.anyio
async def test_codex_sdk_steers_the_active_turn_before_it_completes(monkeypatch):
    """执行中的插入消息必须 steer 当前 turn，不能等当前 turn 完成后再开新 turn。"""
    _patch_codex_sdk(monkeypatch)
    queue: asyncio.Queue = asyncio.Queue()
    turn_started = asyncio.Event()
    release_turn = asyncio.Event()

    class ActiveTurn(_FakeSdkTurn):
        async def stream(self):
            turn_started.set()
            yield SimpleNamespace(
                method="item/agentMessage/delta",
                payload=SimpleNamespace(delta="执行中"),
            )
            await release_turn.wait()
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

    active_turn = ActiveTurn("turn-active", [])

    async def turn(self, prompt, model=None):
        return active_turn

    monkeypatch.setattr(_FakeSdkThread, "turn", turn)
    events: list[InternalEvent] = []

    async def consume():
        async for event in CodexSDKEngine().spawn(
            prompt="开始任务",
            cwd="/tmp",
            live_message_queue=queue,
        ):
            events.append(event)

    consume_task = asyncio.create_task(consume())
    await asyncio.wait_for(turn_started.wait(), timeout=1)
    queue.put_nowait(("mid-active", "立即调整方向"))
    try:
        await asyncio.sleep(0.05)
        steered_while_running = active_turn.steered == ["立即调整方向"]
    finally:
        release_turn.set()
        await asyncio.wait_for(consume_task, timeout=1)

    assert steered_while_running is True
    assert any(
        event.type == "live_message"
        and event.data.get("message_id") == "mid-active"
        and event.data.get("status") == "delivered"
        for event in events
    )
