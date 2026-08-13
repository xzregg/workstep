"""Tests for P4: intervention, history replay, artifact versioning."""

import asyncio
import json
import time
import uuid
import pytest
from pathlib import Path

from services.intervention import InterventionManager
from services.history import get_task_history, get_step_history, replay_events
from models import init_db, Task, TaskStep, Message


# --- InterventionManager ---

def test_intervention_deliver_response():
    """deliver_response resolves a pending request."""
    mgr = InterventionManager()

    async def _test():
        # Start a request in the background
        task = asyncio.create_task(
            mgr.request_response("int-1", "task-1", "step-1", {"q": "approve?"})
        )
        # Give it a moment to register
        await asyncio.sleep(0.01)
        assert mgr.pending_count == 1
        assert "int-1" in mgr.list_pending()

        # Deliver response
        assert mgr.deliver_response("int-1", {"answer": "yes"})

        # Request should complete
        result = await task
        assert result == {"answer": "yes"}
        assert mgr.pending_count == 0

    asyncio.run(_test())


def test_intervention_unknown_returns_false():
    mgr = InterventionManager()
    assert mgr.deliver_response("nonexistent", {}) is False


def test_intervention_cancel():
    mgr = InterventionManager()

    async def _test():
        task = asyncio.create_task(
            mgr.request_response("int-2", "t", "s", {"q": "?"})
        )
        await asyncio.sleep(0.01)
        assert mgr.cancel("int-2")
        result = await task
        assert result["error"] == "cancelled"

    asyncio.run(_test())


def test_intervention_timeout():
    """request_response times out after the specified duration."""
    mgr = InterventionManager()

    async def _test():
        # Use a very short timeout by patching
        original_wait_for = asyncio.wait_for

        async def fast_wait(future, timeout):
            return await original_wait_for(future, timeout=0.05)

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(asyncio, "wait_for", fast_wait)
            result = await mgr.request_response("int-3", "t", "s", {"q": "?"})
            assert result["error"] == "timeout"

    asyncio.run(_test())


def test_intervention_double_deliver():
    """Second deliver_response returns False."""
    mgr = InterventionManager()

    async def _test():
        task = asyncio.create_task(
            mgr.request_response("int-4", "t", "s", {"q": "?"})
        )
        await asyncio.sleep(0.01)
        assert mgr.deliver_response("int-4", {"a": 1})
        assert not mgr.deliver_response("int-4", {"a": 2})  # already resolved
        await task

    asyncio.run(_test())


# --- History replay ---

@pytest.fixture
def db_with_history(tmp_path):
    """Create a DB with task, steps, and messages for history tests."""
    db = init_db(str(tmp_path / "test.db"))
    now = int(time.time())
    task_id = str(uuid.uuid4())

    task = Task.create(
        id=task_id, title="History test", cwd=str(tmp_path),
        created_at=now, updated_at=now,
    )
    TaskStep.create(task=task, step_key="req", status="passed")
    TaskStep.create(task=task, step_key="ui", status="passed")

    # Messages with events
    events_req = [
        {"type": "text_delta", "data": {"delta": "PRD "}, "timestamp": now * 1000},
        {"type": "text_delta", "data": {"delta": "content"}, "timestamp": now * 1000 + 1},
        {"type": "usage", "data": {"input_tokens": 50, "output_tokens": 20}},
    ]
    Message.create(
        id=str(uuid.uuid4()), task=task, step_key="req", role="assistant",
        content="PRD content", run_status="succeeded",
        events_json=json.dumps(events_req),
        position=1, created_at=now, ended_at=now,
    )

    events_ui = [
        {"type": "text_delta", "data": {"delta": "UI spec"}, "timestamp": now * 1000},
    ]
    Message.create(
        id=str(uuid.uuid4()), task=task, step_key="ui", role="assistant",
        content="UI spec", run_status="succeeded",
        events_json=json.dumps(events_ui),
        position=1, created_at=now, ended_at=now,
    )

    yield db, task_id
    db.close()


def test_get_task_history(db_with_history):
    _, task_id = db_with_history
    history = get_task_history(task_id)
    assert len(history) == 2
    assert history[0]["step_key"] == "req"
    assert history[0]["content"] == "PRD content"
    assert len(history[0]["events"]) == 3
    assert history[1]["step_key"] == "ui"
    assert history[1]["content"] == "UI spec"


def test_get_step_history(db_with_history):
    _, task_id = db_with_history
    history = get_step_history(task_id, "req")
    assert len(history) == 1
    assert history[0]["events"][0]["type"] == "TEXT_MESSAGE_CHUNK"


def test_replay_events(db_with_history):
    _, task_id = db_with_history
    history = get_task_history(task_id)
    all_events = []
    for msg in history:
        for event in replay_events(msg["events"]):
            all_events.append(event)
    assert len(all_events) == 4  # 3 from req + 1 from ui


def test_history_empty_task(tmp_path):
    """History for a task with no messages returns empty list."""
    db = init_db(str(tmp_path / "test.db"))
    task_id = str(uuid.uuid4())
    Task.create(
        id=task_id, title="Empty", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    assert get_task_history(task_id) == []
    db.close()
