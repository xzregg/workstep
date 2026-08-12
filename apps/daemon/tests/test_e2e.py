"""End-to-end integration test: task creation → engine run → WebSocket events."""

import asyncio
import json
import pytest
from unittest.mock import patch

from engines.core.events import InternalEvent
from engines.core.base import BaseLLMEngine


class MemoryConfigStore:
    def __init__(self):
        self.values = {}

    def get(self, key, default=None):
        return self.values.get(key, default)

    def set(self, key, value):
        self.values[key] = value


class FakeEngine(BaseLLMEngine):
    """Simulates a Claude-like engine yielding events."""

    @staticmethod
    def is_installed():
        return True

    @staticmethod
    def get_version():
        return "fake-1.0"

    @staticmethod
    def resolve_binary():
        return "fake"

    async def spawn(self, prompt, cwd, model=None, add_dirs=None, session_id=None, **kwargs):
        yield InternalEvent(type="status", data={"status": "initializing"})
        await asyncio.sleep(0.01)
        yield InternalEvent(type="text_delta", data={"delta": "Hello"})
        await asyncio.sleep(0.01)
        yield InternalEvent(type="text_delta", data={"delta": " world"})
        await asyncio.sleep(0.01)
        yield InternalEvent(type="tool_use", data={"id": "t1", "name": "Read", "input": {"path": "/a.py"}})
        await asyncio.sleep(0.01)
        yield InternalEvent(type="tool_result", data={"tool_use_id": "t1", "content": "file contents"})
        await asyncio.sleep(0.01)
        yield InternalEvent(type="usage", data={"input_tokens": 100, "output_tokens": 50})
        yield InternalEvent(type="status", data={"status": "done"})

    async def stop(self):
        pass

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


@pytest.mark.anyio
async def test_e2e_task_run_publishes_events(tmp_path, monkeypatch):
    """Full flow: init project → create task → run → events on bus."""
    from models import init_db
    from streaming.bus import EventBus
    from services.project import ProjectManager
    import services.project as project_service
    from services.task import TaskService
    from engines.core.registry import ENGINE_REGISTRY

    # Patch engine
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = FakeEngine
    monkeypatch.setattr(project_service, "config_store", MemoryConfigStore())
    try:
        # Setup
        bus = EventBus()
        pm = ProjectManager()
        ts = TaskService(bus)

        # 1. Init project
        proj_dir = tmp_path / "e2e-project"
        proj_dir.mkdir()
        proj = pm.init_project(proj_dir)
        assert proj.name == "e2e-project"

        # 2. Create task (explicitly using the patched fake engine)
        task = ts.create_task(title="E2E Test", cwd=str(proj_dir), engine="claude")
        assert task["status"] == "ready"

        # 3. Subscribe to bus BEFORE running
        q = bus.subscribe()

        # 4. Run task
        await ts.run_task(task["id"], "Say hello")

        # 5. Collect events
        events = []
        while not q.empty():
            events.append(await q.get())

        bus.unsubscribe(q)

        # Verify event flow
        assert len(events) > 0

        types = [e["type"] for e in events]
        assert "status" in types        # running + done
        assert "text_delta" in types     # "Hello" + " world"
        assert "tool_use" in types       # Read tool
        assert "tool_result" in types    # file contents
        assert "usage" in types          # token counts

        # Verify text accumulation
        text_events = [e for e in events if e["type"] == "text_delta"]
        assert text_events[0]["data"]["delta"] == "Hello"
        assert text_events[1]["data"]["delta"] == " world"

        # Verify task status updated
        updated = ts.get_task(task["id"])
        assert updated["status"] == "ready"  # completed → back to ready

        # Verify events persisted to message
        from models import Message
        msgs = Message.select().where(Message.task == task["id"])
        assert msgs.count() == 1
        msg = msgs[0]
        stored_events = json.loads(msg.events_json)
        assert len(stored_events) > 0
        assert msg.content == "Hello world"

        # Cleanup
        pm.close_all()

    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)


@pytest.mark.anyio
async def test_e2e_multiple_subscribers_receive_events(tmp_path, monkeypatch):
    """Multiple WebSocket clients all receive the same events."""
    from streaming.bus import EventBus
    from services.task import TaskService
    from engines.core.registry import ENGINE_REGISTRY
    import services.project as project_service

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = FakeEngine
    monkeypatch.setattr(project_service, "config_store", MemoryConfigStore())
    try:
        bus = EventBus()
        pm_cls = __import__("services.project", fromlist=["ProjectManager"]).ProjectManager
        pm = pm_cls()
        proj_dir = tmp_path / "multi-sub"
        proj_dir.mkdir()
        pm.init_project(proj_dir)

        ts = TaskService(bus)
        task = ts.create_task(title="Multi sub", cwd=str(proj_dir))

        # Two subscribers (simulating two WebSocket clients)
        q1 = bus.subscribe()
        q2 = bus.subscribe()

        await ts.run_task(task["id"], "test")

        # Both should receive events
        e1_count = 0
        while not q1.empty():
            await q1.get()
            e1_count += 1

        e2_count = 0
        while not q2.empty():
            await q2.get()
            e2_count += 1

        assert e1_count == e2_count
        assert e1_count > 0

        bus.unsubscribe(q1)
        bus.unsubscribe(q2)
        pm.close_all()

    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
