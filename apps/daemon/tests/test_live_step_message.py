"""Tests for live stage message injection and chat-target context isolation.

Requirement 3: running stages accept ordinary user messages injected
mid-execution (engine support via send_live_step_message).
Requirement 4: chat input can target the stage agent or the coordinator, and
coordinator messages never enter the stage execution context.
"""

import asyncio
import json
import uuid
from types import SimpleNamespace

import pytest

from engines.core.acp_base import AcpEngineBase
from engines.claude_code import ClaudeCodeEngine
from engines.core.events import InternalEvent
from models import CoordinatorTurn, Message, StepSupplement, Task, TaskStep, init_db
from models.fields import utc_now
from streaming.bus import EventBus


# --- Fake subprocess plumbing ---


class FakeStream:
    def __init__(self):
        self.written = b""
        self.closed = False

    def write(self, data):
        self.written += data

    async def drain(self):
        return None

    def close(self):
        self.closed = True

    def is_closing(self):
        return self.closed

    async def read(self):
        return b""


class FakeLines:
    def __init__(self, lines):
        self._lines = list(lines)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._lines:
            raise StopAsyncIteration
        return self._lines.pop(0)


class FakeProcess:
    def __init__(self, stdout_lines, exit_code=0):
        self.stdin = FakeStream()
        self.stdout = FakeLines(stdout_lines)
        self.stderr = FakeStream()
        self.exit_code = exit_code
        self.terminated = False
        self.killed = False

    async def wait(self):
        return self.exit_code

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True


def make_process_factory(process):
    async def factory(*args, **kwargs):
        return process

    return factory


# --- ClaudeCodeEngine live protocol ---


@pytest.mark.anyio
async def test_claude_live_mode_injects_jsonl_messages(monkeypatch):
    process = FakeProcess([
        b'{"type":"system","subtype":"init","session_id":"s1"}',
        b'{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
        b'{"type":"result","subtype":"success","usage":{"input_tokens":1,"output_tokens":1},"session_id":"s1"}',
    ])
    monkeypatch.setattr(asyncio, "create_subprocess_exec", make_process_factory(process))
    monkeypatch.setattr(ClaudeCodeEngine, "resolve_binary", staticmethod(lambda: "/fake/claude"))
    from services.config import config_store
    monkeypatch.setattr(config_store, "get_claude_permission_mode", lambda: "acceptEdits")

    engine = ClaudeCodeEngine()
    queue = asyncio.Queue()
    queue.put_nowait(("live-1", "请停下来修改"))
    events = []
    async for event in engine.spawn("开始任务", cwd="/tmp", live_message_queue=queue):
        events.append(event)

    lines = [
        json.loads(line)
        for line in process.stdin.written.decode().splitlines()
        if line.strip()
    ]
    # Initial prompt is sent as a stream-json user message (stdin stays open).
    assert lines[0]["type"] == "user"
    assert lines[0]["message"]["content"] == "开始任务"
    # The queued live message is injected as another user message.
    injected = [
        line for line in lines[1:]
        if line.get("type") == "user"
        and line.get("message", {}).get("content") == "请停下来修改"
    ]
    assert len(injected) == 1
    # Completion closes the stream and stdin.
    assert any(line.get("type") == "close_stream" for line in lines)
    assert process.stdin.closed is True
    # The engine acknowledged the delivery with a live_message event.
    acks = [event for event in events if event.type == "live_message"]
    assert len(acks) == 1
    assert acks[0].data["message_id"] == "live-1"
    assert acks[0].data["status"] == "delivered"
    assert engine._running is False


@pytest.mark.anyio
async def test_claude_plain_mode_keeps_current_behavior(monkeypatch):
    process = FakeProcess([
        b'{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
    ])
    monkeypatch.setattr(asyncio, "create_subprocess_exec", make_process_factory(process))
    monkeypatch.setattr(ClaudeCodeEngine, "resolve_binary", staticmethod(lambda: "/fake/claude"))
    from services.config import config_store
    monkeypatch.setattr(config_store, "get_claude_permission_mode", lambda: "acceptEdits")

    engine = ClaudeCodeEngine()
    events = []
    async for event in engine.spawn("开始任务", cwd="/tmp"):
        events.append(event)

    # Plain mode writes the raw prompt, closes stdin immediately, and does not
    # emit any stream-json input records.
    assert process.stdin.written.decode().strip() == "开始任务"
    assert process.stdin.closed is True
    assert b"close_stream" not in process.stdin.written
    assert not [event for event in events if event.type == "live_message"]


def test_claude_build_command_opt_in_live_mode():
    cmd = ClaudeCodeEngine.build_command("/fake/claude", "acceptEdits", live_mode=True)
    assert "--input-format" in cmd
    assert cmd[cmd.index("--input-format") + 1] == "stream-json"

    plain = ClaudeCodeEngine.build_command("/fake/claude", "acceptEdits")
    assert "--input-format" not in plain


# --- TaskRunner live delivery ---


class LiveFakeEngine(AcpEngineBase):
    received: list[str] = []

    @staticmethod
    def is_installed():
        return True

    @staticmethod
    def get_version():
        return "fake"

    @staticmethod
    def resolve_binary():
        return "fake"

    async def spawn(self, prompt, cwd, **kwargs):
        queue = kwargs.get("live_message_queue")
        yield InternalEvent(type="status", data={"status": "running"})
        await asyncio.sleep(0.3)
        if queue is not None:
            while not queue.empty():
                message_id, content = queue.get_nowait()
                delivered = await self.send_live_step_message(content)
                yield InternalEvent(type="live_message", data={
                    "message_id": message_id,
                    "status": "delivered" if delivered else "error",
                })
        yield InternalEvent(type="agent_message_chunk", data={"content": {"text": "working"}})
        await asyncio.sleep(0.3)
        yield InternalEvent(type="status", data={"status": "done"})

    async def stop(self):
        return None

    async def inject_response(self, tool_use_id, content):
        return None

    @property
    def supports_resume(self):
        return False

    @property
    def supports_interactive(self):
        return False

    @property
    def supports_live_step_message(self):
        return True

    async def send_live_step_message(self, content):
        LiveFakeEngine.received.append(content)
        return True

    def build_resume_params(self, session_id):
        return {}


class StopRaisesEngine(LiveFakeEngine):
    stop_calls = 0

    async def stop(self):
        type(self).stop_calls += 1
        raise RuntimeError("engine already stopped")


class PlainFakeEngine(LiveFakeEngine):
    @property
    def supports_live_step_message(self):
        return False


class ResumablePromptFakeEngine(LiveFakeEngine):
    prompts: list[str] = []
    sessions: list[str | None] = []

    @property
    def supports_resume(self):
        return True

    async def spawn(self, prompt, cwd, **kwargs):
        type(self).prompts.append(prompt)
        type(self).sessions.append(kwargs.get("session_id"))
        yield InternalEvent(
            type="session_started",
            data={"session_id": kwargs.get("session_id") or "engine-session"},
        )
        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": "done"}},
        )


class SplitLiveFakeEngine(LiveFakeEngine):
    """Emits output before AND after an injected live message, so the runner
    must seal the pre-insert segment and open a new response segment."""

    ready_for_live: asyncio.Event | None = None
    continue_after_live: asyncio.Event | None = None

    async def spawn(self, prompt, cwd, **kwargs):
        queue = kwargs.get("live_message_queue")
        yield InternalEvent(type="status", data={"status": "running"})
        yield InternalEvent(type="agent_message_chunk", data={"content": {"text": "第一段输出"}})
        if type(self).ready_for_live is not None:
            type(self).ready_for_live.set()
        if type(self).continue_after_live is not None:
            await type(self).continue_after_live.wait()
        else:
            await asyncio.sleep(0.05)
        if queue is not None:
            while not queue.empty():
                message_id, content = queue.get_nowait()
                delivered = await self.send_live_step_message(content)
                yield InternalEvent(type="live_message", data={
                    "message_id": message_id,
                    "status": "delivered" if delivered else "error",
                })
        await asyncio.sleep(0.05)
        yield InternalEvent(type="agent_message_chunk", data={"content": {"text": "第二段输出"}})
        yield InternalEvent(type="status", data={"status": "done"})


def _make_runner_task(tmp_path, engine_cls):
    from engines.core.registry import ENGINE_REGISTRY
    from services.task_runner import TaskRunner

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id=f"task-{id(engine_cls)}",
        title="Live",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    TaskStep.create(task=task, step_key="do", status="pending", engine="claude")
    steps_config = {
        "steps": [
            {"key": "do", "label": "执行", "engine": "claude", "prompt": "work", "outputs": []},
        ]
    }
    bus = EventBus()
    runner = TaskRunner(bus)
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = engine_cls
    return db, task, steps_config, bus, runner, original


async def _wait_for_running_engine(runner, task_id: str, step_key: str) -> None:
    run_key = f"{task_id}:{step_key}"
    for _ in range(500):
        if runner._live.has_running_engine(run_key):
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"Engine did not start in time: {run_key}")


@pytest.mark.anyio
async def test_runner_sends_compact_prompt_for_resumed_step_followup(tmp_path):
    db, task, steps_config, bus, _, original = _make_runner_task(
        tmp_path, ResumablePromptFakeEngine
    )
    from services.task_runner import TaskRunner

    step = TaskStep.get(
        (TaskStep.task == task) & (TaskStep.step_key == "do")
    )
    step.session_id = "existing-session"
    step.save()
    steps_config["steps"][0]["outputs"] = [
        {"name": "结果", "type": "md"},
    ]
    ResumablePromptFakeEngine.prompts = []
    ResumablePromptFakeEngine.sessions = []
    runner = TaskRunner(
        bus,
        step_followups={"do": "只更新摘要"},
        step_trigger_names={"do": "阶段触发人"},
    )
    try:
        await runner.run_pipeline(task, steps_config, tmp_path / "artifacts")

        prompt = ResumablePromptFakeEngine.prompts[0]
        assert "只更新摘要" in prompt
        assert "## Triggered by\n阶段触发人" in prompt
        assert "结果.md" in prompt
        assert "## 阶段要求\nwork" not in prompt
        assert "WorkStep 工作流中的一个执行阶段" not in prompt
    finally:
        await bus.close()
        from engines.core.registry import ENGINE_REGISTRY
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_pydantic_ai_new_session_uses_response_message_id(tmp_path):
    db, task, steps_config, bus, _, original = _make_runner_task(
        tmp_path, ResumablePromptFakeEngine
    )
    from engines.core.registry import ENGINE_REGISTRY
    from services.task_runner import TaskRunner

    ENGINE_REGISTRY["pydantic_ai"] = ResumablePromptFakeEngine
    steps_config["steps"][0]["engine"] = "pydantic_ai"
    ResumablePromptFakeEngine.sessions = []
    runner = TaskRunner(bus)
    try:
        await runner.run_pipeline(task, steps_config, tmp_path / "artifacts")

        response = Message.get(
            (Message.task == task)
            & (Message.step_key == "do")
            & (Message.role == "assistant")
        )
        step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "do")
        )
        assert ResumablePromptFakeEngine.sessions == [response.id]
        assert step.session_id == response.id
        assert response.event_log_path == (
            f"event_logs/task-{task.id}/{response.id}/{response.id}.jsonl"
        )
        assert (tmp_path / response.event_log_path).is_file()
    finally:
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_runner_delivers_live_message_to_running_step(tmp_path):
    db, task, steps_config, bus, runner, original = _make_runner_task(tmp_path, LiveFakeEngine)
    LiveFakeEngine.received = []
    try:
        pipeline = asyncio.create_task(
            runner.run_pipeline(task, steps_config, tmp_path / "artifacts")
        )
        await _wait_for_running_engine(runner, task.id, "do")
        accepted = await runner.send_live_message(task.id, "do", "停下！")
        assert accepted["status"] == "queued"
        assert isinstance(accepted["sequence"], int)
        assert accepted["created_at"]
        await pipeline

        assert LiveFakeEngine.received == ["停下！"]
        message = Message.get(Message.id == accepted["message_id"])
        assert message.channel == "execution"
        assert message.role == "user"
        assert message.run_status == "succeeded"
        # 响应携带服务端单调序号与时间，前端据此把乐观消息精确落位在
        # 段 A（插入前输出）与段 B（插入后响应）之间，不受客户端时钟影响。
        assert message.sequence == accepted["sequence"]
        assert message.created_at.isoformat() == accepted["created_at"]
    finally:
        await bus.close()
        from engines.core.registry import ENGINE_REGISTRY
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_runner_splits_step_message_on_live_insert(tmp_path, monkeypatch):
    """An injected message lands between the pre-insert stage output and the
    stage's follow-up response, like Codex conversation segments."""
    import threading
    import time

    db, task, steps_config, bus, runner, original = _make_runner_task(tmp_path, SplitLiveFakeEngine)
    from services.remote_project import ActorSnapshot

    monkeypatch.setattr(
        "services.remote_project.get_effective_actor",
        lambda: ActorSnapshot(
            actor_id="user-live",
            user_name="阶段操作人",
            device_id="device-live",
            device_name="操作电脑",
            source="local",
        ),
    )
    LiveFakeEngine.received = []
    SplitLiveFakeEngine.ready_for_live = asyncio.Event()
    SplitLiveFakeEngine.continue_after_live = asyncio.Event()
    events = bus.subscribe()
    next_segment_insert_started = threading.Event()
    original_execute_sql = db.execute_sql
    assistant_inserts = 0

    def slow_next_segment_insert(sql, params=None, commit=None):
        nonlocal assistant_inserts
        if (
            'INSERT INTO "message"' in sql
            and params is not None
            and "execution" in params
            and "assistant" in params
        ):
            assistant_inserts += 1
            if assistant_inserts == 2:
                next_segment_insert_started.set()
                time.sleep(0.35)
        return original_execute_sql(sql, params)

    monkeypatch.setattr(db, "execute_sql", slow_next_segment_insert)
    try:
        pipeline = asyncio.create_task(
            runner.run_pipeline(task, steps_config, tmp_path / "artifacts")
        )
        await asyncio.wait_for(SplitLiveFakeEngine.ready_for_live.wait(), timeout=1)
        accepted = await runner.send_live_message(task.id, "do", "插入内容")
        assert accepted["status"] == "queued"
        SplitLiveFakeEngine.continue_after_live.set()
        assert await asyncio.to_thread(next_segment_insert_started.wait, 2)
        assert not pipeline.done()
        heartbeat_started = time.perf_counter()
        await asyncio.wait_for(asyncio.sleep(0), timeout=0.2)
        assert time.perf_counter() - heartbeat_started < 0.2
        await pipeline

        messages = list(
            Message.select()
            .where(Message.task == task)
            .order_by(Message.sequence)
        )
        # 段 A（插入前输出）→ 用户插入 → 段 B（插入后响应）
        assert [message.role for message in messages] == ["assistant", "user", "assistant"]
        pre_insert, inserted, post_insert = messages
        assert pre_insert.content == "第一段输出"
        assert inserted.content == "插入内容"
        assert inserted.run_status == "succeeded"
        assert post_insert.content == "第二段输出"
        assert pre_insert.run_status == "succeeded"
        assert post_insert.run_status == "succeeded"
        assert inserted.author_name == "阶段操作人"
        assert post_insert.author_id == "claude"
        assert post_insert.author_type == "assistant"
        assert post_insert.initiated_by_user_id == "user-live"
        assert post_insert.initiated_by_username == "阶段操作人"
        assert json.loads(post_insert.prompt_json)["prompt"] == (
            "## Triggered by\n阶段操作人\n\n## User message\n插入内容"
        )
        assert pre_insert.sequence < inserted.sequence < post_insert.sequence
        published = []
        while not events.empty():
            published.append(events.get_nowait())
        assistant_starts = [
            event for event in published
            if event.get("type") == "TEXT_MESSAGE_START"
            and event.get("channel") == "execution"
            and event.get("role") == "assistant"
        ]
        assert [event["messageId"] for event in assistant_starts] == [
            pre_insert.id, post_insert.id,
        ]
        assert assistant_starts[1]["prompt"] == json.loads(post_insert.prompt_json)["prompt"]
        # 段 A 的事件快照只含插入前的事件；段 B 的事件从插入后开始累积。
        assert "第二段" not in (tmp_path / pre_insert.event_log_path).read_text()
    finally:
        if SplitLiveFakeEngine.continue_after_live is not None:
            SplitLiveFakeEngine.continue_after_live.set()
        SplitLiveFakeEngine.ready_for_live = None
        SplitLiveFakeEngine.continue_after_live = None
        await bus.close()
        from engines.core.registry import ENGINE_REGISTRY
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_runner_as_guidance_persists_step_supplement(tmp_path):
    db, task, steps_config, bus, runner, original = _make_runner_task(tmp_path, LiveFakeEngine)
    LiveFakeEngine.received = []
    try:
        pipeline = asyncio.create_task(
            runner.run_pipeline(task, steps_config, tmp_path / "artifacts")
        )
        await _wait_for_running_engine(runner, task.id, "do")
        accepted = await runner.send_live_message(
            task.id, "do", "请改用中文输出", as_guidance=True
        )
        assert accepted["status"] == "queued"
        await pipeline

        # The message itself is still delivered into the running stage.
        assert LiveFakeEngine.received == ["请改用中文输出"]
        # Guidance is persisted without a source proposal, so future attempts
        # of this step include it in the assembled prompt.
        supplement = StepSupplement.get(
            StepSupplement.task == task,
            StepSupplement.step_key == "do",
        )
        assert supplement.content == "请改用中文输出"
        assert supplement.source_proposal is None
        assert supplement.active is True

        from services.pipeline import Step
        from services.prompt import assemble_prompt
        prompt = assemble_prompt(
            task,
            Step.from_dict({"key": "do", "prompt": "do work"}),
            tmp_path / "artifacts",
        )
        assert "请改用中文输出" in prompt
        assert "do work" in prompt
    finally:
        await bus.close()
        from engines.core.registry import ENGINE_REGISTRY
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_runner_rejects_live_message_for_unsupported_engine(tmp_path):
    db, task, steps_config, bus, runner, original = _make_runner_task(tmp_path, PlainFakeEngine)
    try:
        pipeline = asyncio.create_task(
            runner.run_pipeline(task, steps_config, tmp_path / "artifacts")
        )
        await _wait_for_running_engine(runner, task.id, "do")
        with pytest.raises(ValueError, match="不支持执行中消息注入"):
            await runner.send_live_message(task.id, "do", "x")
        await pipeline
    finally:
        await bus.close()
        from engines.core.registry import ENGINE_REGISTRY
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_runner_rejects_live_message_when_step_not_running(tmp_path):
    db, task, steps_config, bus, runner, original = _make_runner_task(tmp_path, LiveFakeEngine)
    try:
        with pytest.raises(ValueError, match="未在运行"):
            await runner.send_live_message(task.id, "do", "x")
    finally:
        await bus.close()
        from engines.core.registry import ENGINE_REGISTRY
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()




@pytest.mark.anyio
async def test_runner_cancel_stops_running_step(tmp_path):
    db, task, steps_config, bus, runner, original = _make_runner_task(tmp_path, LiveFakeEngine)
    try:
        pipeline = asyncio.create_task(
            runner.run_pipeline(task, steps_config, tmp_path / "artifacts")
        )
        await _wait_for_running_engine(runner, task.id, "do")
        # Stop the running engine; the step is finalized as failed.
        assert await runner.cancel_step(task.id, "do") is True
        # Idempotent while the step is still being finalized.
        assert await runner.cancel_step(task.id, "do") is True
        await pipeline

        step = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "do"))
        assert step.status == "cancelled"
        assert step.error == "手动停止"
        message = Message.get((Message.task == task) & (Message.step_key == "do"))
        assert message.run_status == "cancelled"
        assert message.ended_at is not None
    finally:
        await bus.close()
        from engines.core.registry import ENGINE_REGISTRY
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_runner_cancel_step_is_idempotent_and_swallows_stop_errors(tmp_path):
    db, task, steps_config, bus, runner, original = _make_runner_task(
        tmp_path, StopRaisesEngine
    )
    StopRaisesEngine.stop_calls = 0
    try:
        pipeline = asyncio.create_task(
            runner.run_pipeline(task, steps_config, tmp_path / "artifacts")
        )
        await _wait_for_running_engine(runner, task.id, "do")
        # 第一次停止成功（即使引擎 stop() 抛错也不冒泡）。
        assert await runner.cancel_step(task.id, "do") is True
        # 重复停止幂等：不再重复调用 stop()，也返回成功。
        assert await runner.cancel_step(task.id, "do") is True
        await pipeline
        assert StopRaisesEngine.stop_calls == 1
        step = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "do"))
        assert step.status == "cancelled"
        assert step.error == "手动停止"
    finally:
        await bus.close()
        from engines.core.registry import ENGINE_REGISTRY
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()

# --- Chat-target context isolation (requirement 4) ---


def _context_project(tmp_path):
    return SimpleNamespace(
        id="project-1",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [
                {"id": 1, "type": "do", "title": "Do", "engine": "claude"},
            ],
            "connections": [],
        },
    )


def test_step_prompt_never_contains_coordinator_messages(tmp_path):
    from services.pipeline import Step
    from services.prompt import assemble_prompt

    db = init_db(str(tmp_path / "context.db"))
    task = Task.create(
        id="task-ctx",
        title="Ctx",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    now = utc_now()
    Message.create(
        id=str(uuid.uuid4()),
        task=task, channel="coordinator", step_key="do", sequence=1,
        role="user", content="秘密的协调对话", position=0,
        started_at=now, created_at=now,
    )
    try:
        prompt = assemble_prompt(
            task,
            Step.from_dict({"key": "do", "prompt": "do work"}),
            tmp_path / "artifacts",
        )
        assert "秘密的协调对话" not in prompt
        assert "do work" in prompt
    finally:
        db.close()


def test_coordinator_context_only_uses_coordinator_messages(tmp_path):
    from agent_assistants.coordinator_context import assemble_context
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "coordinator-context.db"))
    task = Task.create(
        id="task-coord-ctx",
        title="Ctx",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    now = utc_now()
    user_msg = Message.create(
        id=str(uuid.uuid4()),
        task=task, channel="coordinator", step_key="do", sequence=1,
        role="user", content="协调问题", position=0,
        started_at=now, created_at=now,
    )
    assistant_msg = Message.create(
        id=str(uuid.uuid4()),
        task=task, channel="coordinator", step_key="do", sequence=2,
        role="assistant", content="", position=1,
        started_at=now, created_at=now,
    )
    Message.create(
        id=str(uuid.uuid4()),
        task=task, channel="execution", step_key="do", sequence=3,
        role="user", content="阶段注入消息", position=2,
        started_at=now, created_at=now,
    )
    turn = CoordinatorTurn.create(
        id="turn-ctx",
        task=task,
        user_message=user_msg,
        assistant_message=assistant_msg,
        idempotency_key="k1",
        status="running",
        created_at=now,
    )
    try:
        prompt, _ = assemble_context(_context_project(tmp_path), task, turn)
        assert "阶段注入消息" not in prompt
        assert "协调问题" in prompt
    finally:
        db.close()


def test_message_sequence_allocation_is_atomic_across_threads(tmp_path):
    """Concurrent allocations must never collide on (task_id, sequence)."""
    import threading

    from models.base import db_proxy
    from services.messages import allocate_message_sequences

    db = init_db(str(tmp_path / "seq.db"))
    task = Task.create(
        id="task-seq",
        title="Seq",
        cwd=str(tmp_path),
        engine="claude",
        created_at=1,
        updated_at=1,
    )
    results: list[int] = []
    errors: list[BaseException] = []
    barrier = threading.Barrier(8)

    def worker():
        try:
            token = db_proxy.activate(db)
            try:
                barrier.wait(timeout=10)
                results.append(allocate_message_sequences(task.id))
            finally:
                db_proxy.reset(token)
        except BaseException as exc:  # noqa: BLE001 - surfaced to the test
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    db.close()

    assert not errors, errors
    assert sorted(results) == list(range(1, 9))
    assert len(set(results)) == 8


def test_allocate_message_sequences_self_heals_stale_counter(tmp_path):
    """计数器被旧 task.save() 回写落后于已有消息时，分配不得撞号。"""
    from models.base import db_proxy
    from services.messages import create_task_message

    db = init_db(str(tmp_path / "stale.db"))
    try:
        task = Task.create(
            id="task-stale",
            title="Stale",
            cwd=str(tmp_path),
            engine="claude",
            created_at=1,
            updated_at=1,
        )
        now = utc_now()
        Message.create(
            id="msg-1",
            task=task,
            channel="execution",
            step_key="do",
            sequence=1,
            role="user",
            content="已存在",
            position=1,
            created_at=now,
        )
        Message.create(
            id="msg-2",
            task=task,
            channel="execution",
            step_key="do",
            sequence=2,
            role="assistant",
            content="已存在",
            position=2,
            created_at=now,
        )
        # 模拟旧 task 对象被 save() 回写：计数器落后于实际最大 sequence(2)。
        token = db_proxy.activate(db)
        try:
            Task.update(next_message_sequence=1).where(
                Task.id == task.id
            ).execute()
            # 计数器落后于已有消息最大 sequence(2) 时，新消息应从 3 开始且不撞号。
            with db_proxy.atomic():
                msg = create_task_message(
                    task=task,
                    channel="chat",
                    step_key="do",
                    role="user",
                    content="新消息",
                    position=3,
                    created_at=utc_now(),
                )
            assert msg.sequence == 3
        finally:
            db_proxy.reset(token)
        rows = list(Message.select().where(Message.task == task.id))
        sequences = sorted(r.sequence for r in rows)
        assert sequences == [1, 2, 3]
        assert len(sequences) == len(set(sequences))
    finally:
        db.close()


class IgnoreLiveQueueEngine(LiveFakeEngine):
    """Spawn 收流结束前不消费插入消息队列（模拟引擎已收流）。"""

    async def spawn(self, prompt, cwd, **kwargs):
        yield InternalEvent(type="status", data={"status": "running"})
        await asyncio.sleep(0.3)
        yield InternalEvent(type="status", data={"status": "done"})


@pytest.mark.anyio
async def test_runner_marks_undelivered_message_failed_on_finish(tmp_path):
    """阶段收尾时队列残留的插入消息标记 failed，避免永久停留在 running。"""
    db, task, steps_config, bus, runner, original = _make_runner_task(
        tmp_path, IgnoreLiveQueueEngine
    )
    try:
        pipeline = asyncio.create_task(
            runner.run_pipeline(task, steps_config, tmp_path / "artifacts")
        )
        await asyncio.sleep(0.1)
        accepted = await runner.send_live_message(task.id, "do", "没被接收的消息")
        assert accepted["status"] == "queued"
        await pipeline

        message = Message.get(Message.id == accepted["message_id"])
        assert message.run_status == "failed"
        assert message.ended_at is not None
    finally:
        await bus.close()
        from engines.core.registry import ENGINE_REGISTRY
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


class IdleHangEngine(LiveFakeEngine):
    """Emits a session then never yields again, simulating a stalled engine."""

    closed = False
    stop_calls = 0

    async def spawn(self, prompt, cwd, **kwargs):
        yield InternalEvent(type="status", data={"status": "running"})
        yield InternalEvent(type="session_started", data={"session_id": "session-idle-1"})
        try:
            await asyncio.Event().wait()
        finally:
            type(self).closed = True

    async def stop(self):
        type(self).stop_calls += 1
        return None

    @property
    def supports_resume(self):
        return True


@pytest.mark.anyio
async def test_runner_idle_timeout_fails_step_and_keeps_session(tmp_path, monkeypatch):
    """An engine that stalls (no events) is stopped after the idle timeout;
    the stage fails but the session id survives for a resumable re-run."""
    from services.config import config_store

    monkeypatch.setattr(
        config_store, "get_engine_idle_timeout_seconds", lambda: 0.2
    )
    db, task, steps_config, bus, runner, original = _make_runner_task(
        tmp_path, IdleHangEngine
    )
    IdleHangEngine.closed = False
    IdleHangEngine.stop_calls = 0
    try:
        pipeline = asyncio.create_task(
            runner.run_pipeline(task, steps_config, tmp_path / "artifacts")
        )
        await pipeline

        ts = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "do"))
        assert ts.status == "failed"
        assert "空闲超时" in (ts.error or "")
        assert ts.session_id == "session-idle-1"
        assert IdleHangEngine.closed is True
        assert IdleHangEngine.stop_calls == 1

        message = Message.get(Message.task == task)
        assert message.run_status == "failed"
        events = json.loads(message.events_json or "[]")
        assert any(
            "空闲超时" in str(event.get("data", {}).get("message", ""))
            for event in events
        )
    finally:
        await bus.close()
        from engines.core.registry import ENGINE_REGISTRY
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()
