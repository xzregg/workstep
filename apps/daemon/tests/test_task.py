"""Tests for task service: create, list, run with mock engine."""

import asyncio
import json
import time
import uuid
import pytest

from models import init_db
from streaming.bus import EventBus
from services.task import TaskService
from engines.events import InternalEvent
from engines.base import BaseLLMEngine


class MockEngine(BaseLLMEngine):
    """Mock engine that yields predefined events."""

    def __init__(self, events=None, fail=False):
        self._events = events or []
        self._fail = fail
        self._stopped = False

    @staticmethod
    def is_installed():
        return True

    @staticmethod
    def get_version():
        return "mock-1.0"

    @staticmethod
    def resolve_binary():
        return "mock"

    async def spawn(self, prompt, cwd, model=None, add_dirs=None, session_id=None):
        if self._fail:
            yield InternalEvent(type="error", data={"message": "mock failure"})
            raise RuntimeError("mock failure")
        for event in self._events:
            yield event

    async def stop(self):
        self._stopped = True

    async def inject_response(self, tool_use_id, content):
        pass

    @property
    def supports_resume(self):
        return False

    @property
    def supports_interactive(self):
        return False

    def build_resume_params(self, session_id):
        return {}


@pytest.fixture
def db_and_service(tmp_path):
    """Set up DB + TaskService with EventBus."""
    db_path = str(tmp_path / "test.db")
    db = init_db(db_path)
    bus = EventBus()
    service = TaskService(bus)
    yield service, bus
    bus.close() if hasattr(bus, '_closed') else None
    db.close()


@pytest.fixture
async def subscriber(db_and_service):
    """Subscribe to event bus for capturing published events."""
    service, bus = db_and_service
    q = bus.subscribe()
    yield q, service, bus
    bus.unsubscribe(q)


def test_create_task(db_and_service):
    """create_task creates a task with default step."""
    service, _ = db_and_service
    task = service.create_task(title="Test", cwd="/tmp")

    assert task["title"] == "Test"
    assert task["cwd"] == "/tmp"
    assert task["status"] == "ready"
    assert task["engine"] == "claude"

    from models import TaskStep
    steps = TaskStep.select().where(TaskStep.task == task["id"])
    assert steps.count() == 1
    assert steps[0].step_key == "do"
    assert steps[0].status == "pending"


def test_list_tasks(db_and_service):
    """list_tasks returns all tasks."""
    service, _ = db_and_service
    service.create_task(title="First", cwd="/tmp")
    service.create_task(title="Second", cwd="/tmp")

    tasks = service.list_tasks()
    assert len(tasks) == 2
    titles = {t["title"] for t in tasks}
    assert titles == {"First", "Second"}


def test_get_task(db_and_service):
    """get_task returns task by ID or None."""
    service, _ = db_and_service
    created = service.create_task(title="Find me", cwd="/tmp")

    found = service.get_task(created["id"])
    assert found["title"] == "Find me"

    assert service.get_task("nonexistent") is None


@pytest.mark.anyio
async def test_run_task_success(subscriber):
    """run_task spawns engine and publishes events to bus."""
    q, service, bus = subscriber

    # Patch registry to use mock engine
    from engines import registry
    original = registry.ENGINE_REGISTRY.copy()
    registry.ENGINE_REGISTRY["claude"] = lambda: MockEngine(events=[
        InternalEvent(type="text_delta", data={"delta": "Hello"}),
        InternalEvent(type="text_delta", data={"delta": " world"}),
        InternalEvent(type="usage", data={"input_tokens": 10, "output_tokens": 5}),
    ])

    try:
        task = service.create_task(title="Run test", cwd="/tmp")
        await service.run_task(task["id"], "Say hello")

        # Collect events from bus
        events = []
        while not q.empty():
            events.append(await q.get())

        # Should have status:running, text_deltas, usage, status:passed
        types = [e["type"] for e in events]
        assert "status" in types
        assert "text_delta" in types

        # Task should be back to ready (single stage completed)
        updated = service.get_task(task["id"])
        assert updated["status"] == "ready"

    finally:
        registry.ENGINE_REGISTRY.clear()
        registry.ENGINE_REGISTRY.update(original)


@pytest.mark.anyio
async def test_run_task_failure(subscriber):
    """run_task handles engine failure gracefully."""
    q, service, bus = subscriber

    from engines import registry
    original = registry.ENGINE_REGISTRY.copy()

    class FailEngine(MockEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            yield InternalEvent(type="error", data={"message": "boom"})
            raise RuntimeError("boom")

    registry.ENGINE_REGISTRY["claude"] = lambda: FailEngine()

    try:
        task = service.create_task(title="Fail test", cwd="/tmp")
        await service.run_task(task["id"], "do something")

        # Task should be stopped
        updated = service.get_task(task["id"])
        assert updated["status"] == "stopped"

    finally:
        registry.ENGINE_REGISTRY.clear()
        registry.ENGINE_REGISTRY.update(original)


@pytest.mark.anyio
async def test_cancel_task(db_and_service):
    """cancel_task stops a running engine."""
    service, bus = db_and_service
    mock = MockEngine(events=[
        InternalEvent(type="text_delta", data={"delta": "slow..."}),
    ])
    service._running_engines["test-id"] = mock

    result = await service.cancel_task("test-id")
    assert result is True
    assert mock._stopped is True

    # Cancel non-running returns False
    assert await service.cancel_task("nonexistent") is False
