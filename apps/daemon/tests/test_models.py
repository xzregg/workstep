"""Tests for data models: init_db, CRUD operations."""

import time
import uuid
import pytest
from pathlib import Path


@pytest.fixture
def tmp_db(tmp_path):
    """Create a temporary SQLite database for testing."""
    from models import init_db, Task, TaskStep, Message

    db_path = str(tmp_path / "test.db")
    db = init_db(db_path)
    yield db, tmp_path
    db.close()


def test_init_db_creates_tables(tmp_db):
    """init_db creates all expected tables."""
    db, _ = tmp_db
    tables = db.get_tables()
    assert "task" in tables
    assert "taskstep" in tables
    assert "message" in tables


def test_task_crud(tmp_db):
    """Create, read, update, delete a task."""
    db, _ = tmp_db
    from models import Task

    now = int(time.time())
    task = Task.create(
        id=str(uuid.uuid4()),
        title="Test task",
        cwd="/tmp/test",
        created_at=now,
        updated_at=now,
    )

    # Read
    fetched = Task.get_by_id(task.id)
    assert fetched.title == "Test task"
    assert fetched.status == "ready"

    # Update
    fetched.status = "running"
    fetched.save()
    assert Task.get_by_id(task.id).status == "running"

    # Delete
    fetched.delete_instance()
    assert Task.select().count() == 0


def test_task_step_composite_key(tmp_db):
    """TaskStep uses composite primary key (task, step_key)."""
    db, _ = tmp_db
    from models import Task, TaskStep

    now = int(time.time())
    task = Task.create(
        id=str(uuid.uuid4()),
        title="Parent task",
        cwd="/tmp",
        created_at=now,
        updated_at=now,
    )

    step = TaskStep.create(
        task=task,
        step_key="req",
        status="pending",
    )

    # Same task, different step_key — allowed
    TaskStep.create(task=task, step_key="ui", status="pending")
    assert TaskStep.select().where(TaskStep.task == task).count() == 2

    # Same task + step_key — duplicate key error
    with pytest.raises(Exception):
        TaskStep.create(task=task, step_key="req", status="pending")


def test_message_with_events_json(tmp_db):
    """Message stores events as JSON text."""
    db, _ = tmp_db
    from models import Task, Message
    import json

    now = int(time.time())
    task = Task.create(
        id=str(uuid.uuid4()),
        title="Msg test",
        cwd="/tmp",
        created_at=now,
        updated_at=now,
    )

    events = [
        {"type": "text_delta", "delta": "hello"},
        {"type": "tool_use", "name": "Read", "input": {"path": "/a"}},
    ]

    msg = Message.create(
        id=str(uuid.uuid4()),
        task=task,
        step_key="req",
        role="assistant",
        content="hello",
        events_json=json.dumps(events),
        position=1,
        created_at=now,
    )

    fetched = Message.get_by_id(msg.id)
    parsed = json.loads(fetched.events_json)
    assert len(parsed) == 2
    assert parsed[0]["type"] == "text_delta"
