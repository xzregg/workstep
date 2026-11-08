"""Task-only recovery, backed by real project databases and the existing runtime."""
import asyncio
import threading
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from models import Message, StepRun, Task, TaskStep, WorkflowRun
from models.fields import utc_now
from services.concurrency import concurrency_gate
from services.project import ProjectManager
from services.task_auto_retry import TaskAutoRetry


@pytest.fixture
def setup_retry(tmp_path):
    manager = ProjectManager()
    project = manager.init_project(tmp_path / "retry")
    config = SimpleNamespace(get_task_retry_interval_minutes=lambda: 5)
    runtime = SimpleNamespace(retry_failed_message=AsyncMock(return_value={"run_id": "new"}))
    service = TaskAutoRetry(manager, runtime, config)
    concurrency_gate.reset()
    yield manager, project, runtime, config, service
    concurrency_gate.reset()
    manager.close_all()


async def seed(manager, project, *, task_id="task", status="failed", archived=0, error="network", age=6):
    def create(_project):
        ended = utc_now() - timedelta(minutes=age)
        task = Task.create(id=task_id, title=task_id, cwd=str(project.path), status=status,
                           archived=archived, created_at=ended, updated_at=ended)
        run = WorkflowRun.create(id=f"run-{task_id}", task=task, status="failed", workflow_schema_version=1,
                                 started_at=ended, ended_at=ended)
        task.active_workflow_run_id = run.id
        task.save()
        TaskStep.create(task=task, step_key="do", status="failed")
        step = StepRun.create(id=f"step-{task_id}", run=run, step_key="do", attempt=1,
                             status="failed", error=error, started_at=ended, ended_at=ended)
        Message.create(id=f"msg-{task_id}", task=task, channel="execution", role="assistant",
                       step_key="do", step_run_id=step.id, run_status="failed", sequence=1,
                       position=1, created_at=ended, ended_at=ended)
    await manager.run_db(project.id, create)


async def test_due_failure_only_and_persistent_cooldown(setup_retry):
    manager, project, runtime, config, service = setup_retry
    await seed(manager, project)
    for status in ("stopped", "running", "queued", "waiting", "completed"):
        await seed(manager, project, task_id=status, status=status)
    await seed(manager, project, task_id="archive", archived=1)
    await seed(manager, project, task_id="recent", age=1)
    await seed(manager, project, task_id="rejected", error="")
    await service.tick()
    runtime.retry_failed_message.assert_awaited_once_with(project.id, "task", "msg-task")
    # A second process/service and immediate ticks cannot submit the same failure again.
    await TaskAutoRetry(manager, runtime, config).tick()
    assert runtime.retry_failed_message.await_count == 1
    await service.tick(utc_now() + timedelta(minutes=6))
    assert runtime.retry_failed_message.await_count == 3  # task + formerly recent failure


async def test_disabled_and_approval_waits(setup_retry):
    manager, project, runtime, config, service = setup_retry
    await seed(manager, project)
    config.get_task_retry_interval_minutes = lambda: 0
    await service.tick()
    runtime.retry_failed_message.assert_not_awaited()
    config.get_task_retry_interval_minutes = lambda: 5
    await manager.run_db(project.id, lambda _: TaskStep.create(task="task", step_key="review", status="awaiting_review"))
    await service.tick()
    runtime.retry_failed_message.assert_not_awaited()


async def test_task_concurrency_and_rejected_retry_release(setup_retry):
    manager, project, runtime, config, service = setup_retry
    await seed(manager, project)
    concurrency_gate.configure(max_tasks=1, max_chats=1, schedule_exempt=True)
    await concurrency_gate.acquire_task(project.id, "busy", "manual")
    await service.tick()
    runtime.retry_failed_message.assert_not_awaited()
    assert concurrency_gate.active_count(project.id)["tasks_queued"] == 0
    await concurrency_gate.release_task(project.id, "busy")
    runtime.retry_failed_message.side_effect = ValueError("failure changed")
    await service.tick()
    assert concurrency_gate.active_count(project.id)["tasks_running"] == 0
    assert concurrency_gate.active_count(project.id)["chats_running"] == 0


async def test_slow_database_does_not_block_health(setup_retry, monkeypatch):
    import time
    import main
    import services.task_auto_retry as module
    from httpx import ASGITransport, AsyncClient
    manager, project, runtime, config, service = setup_retry
    await seed(manager, project)
    original = module.load_candidates
    entered = threading.Event()
    def slow(*args):
        entered.set()
        time.sleep(0.25)
        return original(*args)
    monkeypatch.setattr(module, "load_candidates", slow)
    scanning = asyncio.create_task(service.tick())
    while not entered.is_set():
        await asyncio.sleep(0.001)
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        response = await asyncio.wait_for(client.get("/api/health"), 0.15)
        assert response.status_code == 200
    await scanning


async def test_real_runtime_recovery_reuses_message_and_releases_slot(setup_retry, monkeypatch):
    from engines.core.acp_base import AcpEngineBase
    from engines.core.events import InternalEvent
    from engines.core.registry import ENGINE_REGISTRY
    from services.workflow_runtime import WorkflowRuntime
    from streaming.bus import EventBus

    manager, project, _, config, _ = setup_retry
    await seed(manager, project)
    class RecoveringEngine(AcpEngineBase):
        ENGINE_ID = "auto-retry-test"
        @staticmethod
        def is_installed(): return True
        @staticmethod
        def get_version(): return "test"
        @staticmethod
        def resolve_binary(): return "test"
        async def spawn(self, prompt, cwd, **kwargs):
            yield InternalEvent(type="agent_message_chunk", data={"content": {"text": "recovered"}})
        async def stop(self): pass
        async def inject_response(self, tool_use_id, content): pass
        @property
        def supports_resume(self): return False
        @property
        def supports_interactive(self): return False
        def build_resume_params(self, session_id): return {}

    monkeypatch.setitem(ENGINE_REGISTRY, "auto-retry-test", RecoveringEngine)
    bus = EventBus()
    runtime = WorkflowRuntime(bus, manager)
    monkeypatch.setattr(runtime, "_current_workflow_steps", lambda p, t: {"nodes": [{
        "id": 1, "type": "do", "key": "do", "title": "执行", "prompt": "执行",
        "engine": "auto-retry-test", "review": {"mode": "skip"},
    }]})
    concurrency_gate.configure(max_tasks=1, max_chats=2, schedule_exempt=False)
    service = TaskAutoRetry(manager, runtime, config)
    try:
        await service.tick()
        async with asyncio.timeout(5):
            while runtime._active_tasks:
                await asyncio.gather(*list(runtime._active_tasks))
        def read(_):
            task = Task.get_by_id("task")
            message = Message.get_by_id("msg-task")
            return task.status, message.content, message.step_run_id
        status, content, step_id = await manager.run_db(project.id, read)
        assert status == "completed"
        assert content == "recovered"
        assert step_id != "step-task"
        assert concurrency_gate.active_count(project.id)["tasks_running"] == 0
        await service.tick(utc_now() + timedelta(hours=1))
        assert (await manager.run_db(project.id, read))[2] == step_id
    finally:
        await service.close()
        await runtime.shutdown()
        await bus.close()


async def test_overlapping_scans_and_manual_change(setup_retry, monkeypatch):
    manager, project, runtime, config, service = setup_retry
    await seed(manager, project)
    await asyncio.gather(service.tick(), TaskAutoRetry(manager, runtime, config).tick())
    assert runtime.retry_failed_message.await_count == 1
    # A stop between discovery and claim prevents launch.
    await seed(manager, project, task_id="stopped-during-scan")
    import services.task_auto_retry as module
    original = module.claim_candidate
    def stopped(candidate, now, minutes):
        Task.update(status="stopped").where(Task.id == candidate[0]).execute()
        return original(candidate, now, minutes)
    monkeypatch.setattr(module, "claim_candidate", stopped)
    await service.tick()
    assert runtime.retry_failed_message.await_count == 1


async def test_close_prevents_scans(setup_retry):
    manager, project, runtime, _, service = setup_retry
    await seed(manager, project)
    service.start()
    await asyncio.wait_for(service.close(), 0.2)
    await service.tick()
    runtime.retry_failed_message.assert_not_awaited()


async def test_old_attempts_do_not_block_latest_failure_and_assistants_are_excluded(setup_retry):
    manager, project, runtime, _, service = setup_retry
    await seed(manager, project)
    await seed(manager, project, task_id="assistant")
    def history(_):
        StepRun.update(attempt=2).where(StepRun.id == "step-task").execute()
        StepRun.create(id="old-step", run="run-task", step_key="do", attempt=1,
                       status="failed", error="old error", ended_at=utc_now() - timedelta(hours=1))
        Message.update(channel="coordinator").where(Message.id == "msg-assistant").execute()
        from models import ChatSession, ChatMessage
        session = ChatSession.create(id="chat", project_id=project.id, workflow_id="", engine="claude",
                                     created_at=utc_now(), updated_at=utc_now())
        ChatMessage.create(id="chat-error", session=session, role="assistant", status="failed",
                           content="network error", created_at=utc_now() - timedelta(hours=1))
    await manager.run_db(project.id, history)
    await service.tick()
    runtime.retry_failed_message.assert_awaited_once_with(project.id, "task", "msg-task")


async def test_disabling_during_claim_does_not_launch(setup_retry, monkeypatch):
    manager, project, runtime, config, service = setup_retry
    await seed(manager, project)
    import services.task_auto_retry as module
    original = module.claim_candidate
    def disable(candidate, now, minutes):
        result = original(candidate, now, minutes)
        config.get_task_retry_interval_minutes = lambda: 0
        return result
    monkeypatch.setattr(module, "claim_candidate", disable)
    await service.tick()
    runtime.retry_failed_message.assert_not_awaited()
    assert concurrency_gate.active_count(project.id)["tasks_running"] == 0
