"""Tests for live stage message injection and chat-target context isolation.

Requirement 3: running stages accept ordinary user messages injected
mid-execution (engine support via send_live_stage_message).
Requirement 4: chat input can target the stage agent or the coordinator, and
coordinator messages never enter the stage execution context.
"""

import asyncio
import json
import uuid
from types import SimpleNamespace

import pytest

from engines.base import BaseLLMEngine
from engines.claude_code import ClaudeCodeEngine
from engines.events import InternalEvent
from models import CoordinatorTurn, Message, StageSupplement, Task, TaskStep, init_db
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


class LiveFakeEngine(BaseLLMEngine):
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
                delivered = await self.send_live_stage_message(content)
                yield InternalEvent(type="live_message", data={
                    "message_id": message_id,
                    "status": "delivered" if delivered else "error",
                })
        yield InternalEvent(type="text_delta", data={"delta": "working"})
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
    def supports_live_stage_message(self):
        return True

    async def send_live_stage_message(self, content):
        LiveFakeEngine.received.append(content)
        return True

    def build_resume_params(self, session_id):
        return {}


class PlainFakeEngine(LiveFakeEngine):
    @property
    def supports_live_stage_message(self):
        return False


def _make_runner_task(tmp_path, engine_cls):
    from engines.registry import ENGINE_REGISTRY
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


@pytest.mark.anyio
async def test_runner_delivers_live_message_to_running_stage(tmp_path):
    db, task, steps_config, bus, runner, original = _make_runner_task(tmp_path, LiveFakeEngine)
    LiveFakeEngine.received = []
    try:
        pipeline = asyncio.create_task(
            runner.run_pipeline(task, steps_config, tmp_path / "artifacts")
        )
        await asyncio.sleep(0.1)
        accepted = await runner.send_live_message(task.id, "do", "停下！")
        assert accepted["status"] == "queued"
        await pipeline

        assert LiveFakeEngine.received == ["停下！"]
        message = Message.get(Message.id == accepted["message_id"])
        assert message.channel == "execution"
        assert message.role == "user"
        assert message.run_status == "succeeded"
    finally:
        await bus.close()
        from engines.registry import ENGINE_REGISTRY
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_runner_as_guidance_persists_stage_supplement(tmp_path):
    db, task, steps_config, bus, runner, original = _make_runner_task(tmp_path, LiveFakeEngine)
    LiveFakeEngine.received = []
    try:
        pipeline = asyncio.create_task(
            runner.run_pipeline(task, steps_config, tmp_path / "artifacts")
        )
        await asyncio.sleep(0.1)
        accepted = await runner.send_live_message(
            task.id, "do", "请改用中文输出", as_guidance=True
        )
        assert accepted["status"] == "queued"
        await pipeline

        # The message itself is still delivered into the running stage.
        assert LiveFakeEngine.received == ["请改用中文输出"]
        # Guidance is persisted without a source proposal, so future attempts
        # of this step include it in the assembled prompt.
        supplement = StageSupplement.get(
            StageSupplement.task == task,
            StageSupplement.step_key == "do",
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
        from engines.registry import ENGINE_REGISTRY
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
        await asyncio.sleep(0.1)
        with pytest.raises(ValueError, match="不支持执行中消息注入"):
            await runner.send_live_message(task.id, "do", "x")
        await pipeline
    finally:
        await bus.close()
        from engines.registry import ENGINE_REGISTRY
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_runner_rejects_live_message_when_stage_not_running(tmp_path):
    db, task, steps_config, bus, runner, original = _make_runner_task(tmp_path, LiveFakeEngine)
    try:
        with pytest.raises(ValueError, match="未在运行"):
            await runner.send_live_message(task.id, "do", "x")
    finally:
        await bus.close()
        from engines.registry import ENGINE_REGISTRY
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()




@pytest.mark.anyio
async def test_runner_cancel_stops_running_stage(tmp_path):
    db, task, steps_config, bus, runner, original = _make_runner_task(tmp_path, LiveFakeEngine)
    try:
        pipeline = asyncio.create_task(
            runner.run_pipeline(task, steps_config, tmp_path / "artifacts")
        )
        await asyncio.sleep(0.1)
        # Stop the running engine; the step is finalized as failed.
        assert await runner.cancel_step(task.id, "do") is True
        # Idempotent while the step is still being finalized.
        assert await runner.cancel_step(task.id, "do") is True
        await pipeline

        step = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "do"))
        assert step.status == "failed"
        message = Message.get((Message.task == task) & (Message.step_key == "do"))
        assert message.run_status == "failed"
        assert message.ended_at is not None
    finally:
        await bus.close()
        from engines.registry import ENGINE_REGISTRY
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


def test_stage_prompt_never_contains_coordinator_messages(tmp_path):
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
    from services.coordinator import CoordinatorModule
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
    coordinator = CoordinatorModule(EventBus(), None, None)
    try:
        prompt, _ = coordinator._assemble_context(_context_project(tmp_path), task, turn)
        assert "阶段注入消息" not in prompt
        assert "协调问题" in prompt
    finally:
        db.close()
