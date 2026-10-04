"""Tests for the task/chat concurrency gate and its runtime integration."""

from contextlib import nullcontext
from types import SimpleNamespace
import asyncio
import json
import threading
import time

import pytest
from httpx import ASGITransport, AsyncClient

from models import ProjectAuditEvent, Task, TaskStep, init_db
from streaming.bus import EventBus


@pytest.fixture(autouse=True)
def _clean_gate():
    from services.concurrency import concurrency_gate

    concurrency_gate.reset()
    yield
    concurrency_gate.reset()


# ── unit: effective config resolution ─────────────────────────────────

def test_effective_config_resolution():
    from services.concurrency import concurrency_gate

    concurrency_gate.configure(max_tasks=3, max_chats=5, schedule_exempt=False)
    assert concurrency_gate.effective_config("p1") == {
        "max_tasks": 3, "max_chats": 5, "schedule_exempt": False,
    }
    # project override wins
    concurrency_gate.set_project_config("p1", {
        "max_tasks": 1, "max_chats": None, "schedule_exempt": True,
    })
    assert concurrency_gate.effective_config("p1") == {
        "max_tasks": 1, "max_chats": 5, "schedule_exempt": True,
    }
    # clearing the override falls back to global
    concurrency_gate.set_project_config("p1", None)
    assert concurrency_gate.effective_config("p1")["max_tasks"] == 3


# ── unit: task channel ────────────────────────────────────────────────

@pytest.mark.anyio
async def test_task_channel_queues_and_wakes_fifo():
    from services.concurrency import ALREADY_ACTIVE, GRANTED, QUEUED, concurrency_gate

    concurrency_gate.configure(max_tasks=1, max_chats=1, schedule_exempt=False)
    assert await concurrency_gate.acquire_task("p", "t1", "manual") == GRANTED
    assert await concurrency_gate.acquire_task("p", "t2", "manual") == QUEUED
    assert await concurrency_gate.acquire_task("p", "t2", "manual") == ALREADY_ACTIVE
    assert concurrency_gate.task_queue_position("p", "t2") == 1

    # t1 finishes -> t2 wakes and runs
    await concurrency_gate.release_task("p", "t1")
    await concurrency_gate.wait_task_slot("p", "t2")
    assert concurrency_gate.task_queue_position("p", "t2") == 0
    await concurrency_gate.release_task("p", "t2")


@pytest.mark.anyio
async def test_task_channel_per_project_pools_are_independent():
    from services.concurrency import GRANTED, QUEUED, concurrency_gate

    concurrency_gate.configure(max_tasks=1, max_chats=1, schedule_exempt=False)
    concurrency_gate.set_project_config("p2", {"max_tasks": 1, "max_chats": 1})
    assert await concurrency_gate.acquire_task("p", "t1", "manual") == GRANTED
    # p1's pool is full, but p2 has its own pool
    assert await concurrency_gate.acquire_task("p2", "t2", "manual") == GRANTED
    assert await concurrency_gate.acquire_task("p", "t3", "manual") == QUEUED
    await concurrency_gate.release_task("p", "t1")
    await concurrency_gate.wait_task_slot("p", "t3")
    await concurrency_gate.release_task("p2", "t2")
    await concurrency_gate.release_task("p", "t3")


@pytest.mark.anyio
async def test_schedule_exempt_bypasses_task_channel():
    from services.concurrency import GRANTED, QUEUED, concurrency_gate

    concurrency_gate.configure(max_tasks=1, max_chats=1, schedule_exempt=True)
    concurrency_gate.set_project_config("p", {"schedule_exempt": True})
    assert await concurrency_gate.acquire_task("p", "t1", "manual") == GRANTED
    # scheduled dispatch passes even though the pool is full
    assert await concurrency_gate.acquire_task("p", "t2", "schedule") == GRANTED
    # but a manual start still queues
    assert await concurrency_gate.acquire_task("p", "t3", "manual") == QUEUED
    await concurrency_gate.release_task("p", "t1")
    await concurrency_gate.release_task("p", "t2")
    await concurrency_gate.wait_task_slot("p", "t3")
    await concurrency_gate.release_task("p", "t3")


@pytest.mark.anyio
async def test_cancel_queued_task_removes_waiter():
    from services.concurrency import GRANTED, QUEUED, concurrency_gate

    concurrency_gate.configure(max_tasks=1, max_chats=1, schedule_exempt=False)
    assert await concurrency_gate.acquire_task("p", "t1", "manual") == GRANTED
    assert await concurrency_gate.acquire_task("p", "t2", "manual") == QUEUED
    assert await concurrency_gate.acquire_task("p", "t3", "manual") == QUEUED
    concurrency_gate.cancel_queued_task("p", "t2")
    await asyncio.sleep(0)  # let the cleanup task run
    assert concurrency_gate.task_queue_position("p", "t2") == 0
    # t3 moves up; t1 still owns the slot
    assert concurrency_gate.task_queue_position("p", "t3") == 1
    assert concurrency_gate.task_queue_position("p", "t1") == 0
    # cancelling the last waiter leaves nothing to wake
    concurrency_gate.cancel_queued_task("p", "t3")
    await asyncio.sleep(0)
    assert concurrency_gate.task_queue_position("p", "t3") == 0
    await concurrency_gate.release_task("p", "t1")


# ── unit: chat channel ────────────────────────────────────────────────

@pytest.mark.anyio
async def test_chat_channel_is_independent_from_task_channel():
    from services.concurrency import concurrency_gate

    concurrency_gate.configure(max_tasks=1, max_chats=1, schedule_exempt=False)
    # tasks and chats never share slots
    assert await concurrency_gate.acquire_task("p", "t1", "manual") == "granted"
    await concurrency_gate.acquire_chat("p", "p:s1")
    assert concurrency_gate.active_count("p") == {
        "tasks_running": 1, "tasks_queued": 0, "chats_running": 1, "chats_queued": 0,
    }
    # a second chat queues behind the first, not behind the task
    s2_task = asyncio.create_task(concurrency_gate.acquire_chat("p", "p:s2"))
    await asyncio.sleep(0)  # let s2 enqueue
    assert concurrency_gate.chat_queue_position("p", "p:s2") == 1
    await concurrency_gate.release_chat("p", "p:s1")
    await asyncio.wait_for(s2_task, timeout=2)
    await concurrency_gate.release_chat("p", "p:s2")
    await concurrency_gate.release_task("p", "t1")


@pytest.mark.anyio
async def test_same_session_does_not_block_itself():
    from services.concurrency import concurrency_gate

    concurrency_gate.configure(max_tasks=1, max_chats=1, schedule_exempt=False)
    await concurrency_gate.acquire_chat("p", "p:s1")
    # follow-up message in the same session passes through (session lock serializes)
    await concurrency_gate.acquire_chat("p", "p:s1")
    assert concurrency_gate.active_count("p")["chats_queued"] == 0
    await concurrency_gate.release_chat("p", "p:s1")
    await concurrency_gate.release_chat("p", "p:s1")


# ── integration: workflow runtime queues a task ───────────────────────

class SlowFakeEngine:
    """AcpEngineBase-compatible fake with a controllable completion delay."""

    delay = 0.3

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
        from engines.core.events import InternalEvent

        await asyncio.sleep(SlowFakeEngine.delay)
        yield InternalEvent(type="agent_message_chunk", data={"content": {"text": "done"}})
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

    def build_resume_params(self, session_id):
        return {}


def _make_runtime(tmp_path, gate_config: dict):
    from engines.core.registry import ENGINE_REGISTRY
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    project = SimpleNamespace(
        id="project-1",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [{
                "id": 1,
                "type": "req",
                "title": "需求",
                "engine": "claude",
                "prompt": "Write requirements",
            }],
            "connections": [],
        },
    )

    class ProjectManagerStub:
        def iter_projects(self):
            return [project]

        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

        def find_project_for_task(self, task_id):
            return project

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = SlowFakeEngine
    bus = EventBus()
    runtime = WorkflowRuntime(bus, ProjectManagerStub())
    return runtime, project, db, original, bus


@pytest.mark.anyio
async def test_runtime_queues_task_when_channel_full(tmp_path):
    from services.concurrency import concurrency_gate
    from services.remote_access import ActorSnapshot, actor_context

    runtime, project, db, original, _bus = _make_runtime(tmp_path, {})
    concurrency_gate.configure(max_tasks=1, max_chats=1, schedule_exempt=False)
    task_a = Task.create(
        id="task-a", title="A", cwd=str(tmp_path), engine="claude",
        created_at=1, updated_at=1,
    )
    task_b = Task.create(
        id="task-b", title="B", cwd=str(tmp_path), engine="claude",
        created_at=1, updated_at=1,
    )
    try:
        with actor_context(ActorSnapshot(
            actor_id="user-a", user_name="Alice Display", username="alice",
            device_id="device-a", device_name="Laptop", source="managed",
        )):
            handle_a = await runtime.start(project.id, "task-a")
        assert Task.get_by_id("task-a").status == "running"
        # Second task must queue while the channel is full. start() blocks
        # until the slot is granted, so drive it in a task and observe the
        # queued state while it waits.
        with actor_context(ActorSnapshot(
            actor_id="user-b", user_name="Bob Display", username="bob",
            device_id="device-b", device_name="Laptop", source="managed",
        )):
            handle_b_task = asyncio.create_task(runtime.start(
                project.id, "task-b", "排队输入",
            ))
        await asyncio.sleep(0.1)
        assert Task.get_by_id("task-b").status == "queued"
        queued = json.loads(Task.get_by_id("task-b").queued_run_json)
        assert (queued["source"], queued["input"],
                queued["actor"]["author_username"]) == (
                    "manual", "排队输入", "bob",
                )
        audit = ProjectAuditEvent.get(
            (ProjectAuditEvent.task_id == "task-b")
            & (ProjectAuditEvent.action == "task.queue")
        )
        assert (audit.actor_username, audit.initiated_by_username) == (
            "bob", "bob",
        )
        assert concurrency_gate.task_queue_position(project.id, "task-b") == 1
        handle_b = await handle_b_task
        # Task A finishes -> B is woken and runs to completion.
        await runtime.wait(handle_a)
        await runtime.wait(handle_b)
        assert Task.get_by_id("task-b").status == "ready"
    finally:
        from engines.core.registry import ENGINE_REGISTRY

        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_cancel_queued_task_returns_to_ready(tmp_path, monkeypatch):
    from services.concurrency import concurrency_gate
    from services.remote_access import ActorSnapshot, actor_context
    from models import ProjectAuditEvent

    runtime, project, db, original, _bus = _make_runtime(tmp_path, {})
    concurrency_gate.configure(max_tasks=1, max_chats=1, schedule_exempt=False)
    task_a = Task.create(
        id="task-a", title="A", cwd=str(tmp_path), engine="claude",
        created_at=1, updated_at=1,
    )
    task_b = Task.create(
        id="task-b", title="B", cwd=str(tmp_path), engine="claude",
        created_at=1, updated_at=1,
    )
    try:
        with actor_context(ActorSnapshot(
            actor_id="user-a", user_name="Alice Display", username="alice",
            device_id="device-a", device_name="Laptop", source="managed",
        )):
            handle_a = await runtime.start(project.id, "task-a")
            handle_b_task = asyncio.create_task(runtime.start(project.id, "task-b"))
        await asyncio.sleep(0.1)
        assert Task.get_by_id("task-b").status == "queued"
        assert Task.get_by_id("task-b").queued_run_json
        write_started = threading.Event()
        original_execute_sql = db.execute_sql

        def slow_cancel_write(sql, *args, **kwargs):
            if "UPDATE" in sql and "tasks" in sql and not write_started.is_set():
                write_started.set()
                time.sleep(0.35)
            return original_execute_sql(sql, *args, **kwargs)

        monkeypatch.setattr(db, "execute_sql", slow_cancel_write)
        with actor_context(ActorSnapshot(
            actor_id="user-b", user_name="Bob Display", username="bob",
            device_id="device-b", device_name="Desktop", source="managed",
        )):
            cancellation = asyncio.create_task(runtime.cancel("task-b"))
        assert await asyncio.to_thread(write_started.wait, 1)
        import main

        async with AsyncClient(
            transport=ASGITransport(app=main.app), base_url="http://test",
        ) as client:
            health = await asyncio.wait_for(client.get("/api/health"), timeout=0.2)
        assert health.status_code == 200
        assert await cancellation is True
        await asyncio.sleep(0.1)
        assert Task.get_by_id("task-b").status == "ready"
        assert Task.get_by_id("task-b").queued_run_json is None
        cancelled = ProjectAuditEvent.get(
            (ProjectAuditEvent.task_id == "task-b")
            & (ProjectAuditEvent.action == "task.cancel")
        )
        assert cancelled.actor_username == "bob"
        assert cancelled.mode == "managed"
        assert cancelled.metadata_json == '{"status": "ready"}'
        with pytest.raises(asyncio.CancelledError):
            await handle_b_task
        await runtime.wait(handle_a)
    finally:
        from engines.core.registry import ENGINE_REGISTRY

        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_restart_requeue_starts_immediately_when_slot_is_available(tmp_path):
    from engines.core.registry import ENGINE_REGISTRY
    from services.concurrency import concurrency_gate

    runtime, project, db, original, bus = _make_runtime(tmp_path, {})
    concurrency_gate.configure(max_tasks=1, max_chats=1, schedule_exempt=False)
    Task.create(
        id="task-requeued",
        title="Requeued",
        cwd=str(tmp_path),
        engine="claude",
        status="queued",
        created_at=1,
        updated_at=1,
    )
    try:
        assert await runtime.requeue_queued_tasks() == 1
        deadline = asyncio.get_running_loop().time() + 3
        while Task.get_by_id("task-requeued").status != "ready":
            if asyncio.get_running_loop().time() > deadline:
                raise AssertionError("requeued task did not start")
            await asyncio.sleep(0.02)
        assert Task.get_by_id("task-requeued").active_workflow_run_id
    finally:
        await runtime.shutdown()
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_restart_requeue_preserves_starting_user_and_input(tmp_path):
    from engines.core.registry import ENGINE_REGISTRY
    from models import Message, WorkflowRun
    from services.concurrency import concurrency_gate
    from services.remote_access import ActorSnapshot, actor_context

    runtime, project, db, original, bus = _make_runtime(tmp_path, {})
    concurrency_gate.configure(max_tasks=1, max_chats=1, schedule_exempt=False)
    Task.create(
        id="task-queued-actor", title="Queued", cwd=str(tmp_path),
        engine="claude", status="ready", created_at=1, updated_at=1,
    )
    actor = ActorSnapshot(
        actor_id="user-2", user_name="Alice Display", username="alice",
        device_id="device-2", device_name="Office PC", source="managed",
    )
    try:
        with actor_context(actor):
            await runtime._mark_task_status(
                project.id, "task-queued-actor", "queued",
                queue_source="manual", queued_input="恢复后执行",
            )
        assert Task.get_by_id("task-queued-actor").queued_run_json
        assert await runtime.requeue_queued_tasks() == 1
        deadline = asyncio.get_running_loop().time() + 3
        while Task.get_by_id("task-queued-actor").status != "ready":
            if asyncio.get_running_loop().time() > deadline:
                raise AssertionError("queued task did not start")
            await asyncio.sleep(0.02)
        task = Task.get_by_id("task-queued-actor")
        run = WorkflowRun.get_by_id(task.active_workflow_run_id)
        assert (run.initiated_by_user_id, run.initiated_by_username,
                run.initiated_by_name, run.trigger_source) == (
                    "user-2", "alice", "Alice Display", "manual",
                )
        user = Message.get((Message.task == task) & (Message.role == "user"))
        assert (user.content, user.author_id, user.author_username) == (
            "恢复后执行", "user-2", "alice",
        )
        assert task.queued_run_json is None
    finally:
        await runtime.shutdown()
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_scheduled_requeue_keeps_scheduler_source_and_creator(tmp_path):
    from engines.core.registry import ENGINE_REGISTRY
    from models import WorkflowRun
    from services.concurrency import concurrency_gate
    from services.remote_access import ActorSnapshot, actor_context

    runtime, project, db, original, bus = _make_runtime(tmp_path, {})
    concurrency_gate.configure(max_tasks=1, max_chats=1, schedule_exempt=False)
    Task.create(
        id="task-queued-schedule", title="Scheduled", cwd=str(tmp_path),
        engine="claude", status="ready", created_at=1, updated_at=1,
        creator_id="creator-1", creator_username="creator",
        creator_name="Creator Display",
    )
    current = ActorSnapshot(
        actor_id="wrong-user", user_name="Wrong", username="wrong",
        device_id="wrong-device", device_name="Wrong Device", source="managed",
    )
    try:
        with actor_context(current):
            await runtime._mark_task_status(
                project.id, "task-queued-schedule", "queued",
                queue_source="schedule",
            )
        assert json.loads(Task.get_by_id("task-queued-schedule").queued_run_json)[
            "actor"
        ] == {}
        assert await runtime.requeue_queued_tasks() == 1
        deadline = asyncio.get_running_loop().time() + 3
        while Task.get_by_id("task-queued-schedule").status != "ready":
            if asyncio.get_running_loop().time() > deadline:
                raise AssertionError("scheduled queued task did not start")
            await asyncio.sleep(0.02)
        task = Task.get_by_id("task-queued-schedule")
        run = WorkflowRun.get_by_id(task.active_workflow_run_id)
        assert (run.trigger_source, run.initiated_by_user_id,
                run.initiated_by_username) == (
                    "schedule", "creator-1", "creator",
                )
    finally:
        await runtime.shutdown()
        await bus.close()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


# ── integration: assistant chat channel queues sessions ───────────────

class SlowChatEngine:
    """Minimal engine stub whose turns stay running for ``delay`` seconds."""

    delay = 0.5

    capabilities = SimpleNamespace(
        supports_coordinator=True,
        supports_live_step_message=True,
    )
    supports_resume = False
    supports_message_history = False

    async def spawn(self, prompt, cwd, **kwargs):
        from engines.core.events import InternalEvent

        await asyncio.sleep(SlowChatEngine.delay)
        yield InternalEvent(type="agent_message_chunk", data={"content": {"text": "hi"}})
        yield InternalEvent(type="status", data={"status": "done"})

    async def stop(self):
        return None

    async def inject_response(self, tool_use_id, content):
        return None

    def build_resume_params(self, session_id):
        return {}

    @staticmethod
    def supports_provider(provider):
        return provider.get("protocol") == "openai_compatible"


@pytest.mark.anyio
async def test_chat_channel_queues_second_session(tmp_path, monkeypatch):
    from agent_assistants.chat_session import ChatSessionModule
    import agent_assistants.chat_session as chat_service
    import agent_assistants.base as assistant_base
    import services.config as config_service
    import services.project as project_service
    from services.concurrency import concurrency_gate

    from tests.test_chat_session import MemoryConfigStore  # noqa: PLC2701

    store = MemoryConfigStore()
    monkeypatch.setattr(config_service, "config_store", store)
    monkeypatch.setattr(project_service, "config_store", store)
    monkeypatch.setattr(chat_service, "config_store", store)
    monkeypatch.setattr(assistant_base, "config_store", store)
    monkeypatch.setattr(
        chat_service, "create_engine", lambda engine_id: SlowChatEngine()
    )
    monkeypatch.setattr(
        assistant_base, "create_engine", lambda engine_id: SlowChatEngine()
    )

    from services.project import ProjectManager

    manager = ProjectManager()
    bus = EventBus()
    # ChatSessionModule.__init__ registers the chat_session assistant.
    module = ChatSessionModule(bus, manager)
    project = manager.init_project(tmp_path / "chat-proj")
    concurrency_gate.configure(max_tasks=1, max_chats=1, schedule_exempt=False)
    try:
        s1 = module.create_session(project.id)
        s2 = module.create_session(project.id)
        acc1 = module.submit_message(
            project.id, s1["id"], "第一条", idempotency_key="k1"
        )
        await asyncio.sleep(0.1)
        assert module._turn_states[acc1.turn_id]["status"] == "running"
        # Second session queues while the chat channel is full.
        acc2 = module.submit_message(
            project.id, s2["id"], "第二条", idempotency_key="k2"
        )
        await asyncio.sleep(0.1)
        assert module._turn_states[acc2.turn_id]["status"] == "queued"
        # First turn finishes -> second wakes and completes.
        async with asyncio.timeout(SlowChatEngine.delay * 2 + 2):
            while module._turn_states[acc2.turn_id]["status"] != "completed":
                await asyncio.sleep(0.05)
        assert module._turn_states[acc1.turn_id]["status"] == "completed"
        assert module._turn_states[acc2.turn_id]["status"] == "completed"
        assert concurrency_gate.active_count(project.id)["chats_queued"] == 0
    finally:
        await module.shutdown()
        await bus.close()
        manager.close_all()


@pytest.mark.anyio
async def test_chat_waiter_wakes_when_limit_becomes_unlimited():
    from services.concurrency import concurrency_gate

    concurrency_gate.configure(max_tasks=1, max_chats=1, schedule_exempt=False)
    await concurrency_gate.acquire_chat("p", "p:s1")
    waiter = asyncio.create_task(concurrency_gate.acquire_chat("p", "p:s2"))
    await asyncio.sleep(0)
    assert concurrency_gate.chat_queue_position("p", "p:s2") == 1

    concurrency_gate.configure(max_tasks=1, max_chats=0, schedule_exempt=False)
    await asyncio.wait_for(waiter, timeout=1)

    assert concurrency_gate.chat_queue_position("p", "p:s2") == 0
