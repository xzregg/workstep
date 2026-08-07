"""Persistent task message creation and ordering."""

from models import Message, Task
from models.base import db_proxy


def allocate_message_sequences(task_id: str, count: int = 1) -> int:
    """Atomically reserve ``count`` consecutive sequences for a task.

    Uses a single ``UPDATE ... RETURNING`` so concurrent requests (and even
    multiple daemon processes sharing the project database) can never hand
    out the same sequence twice.
    """
    if count < 1:
        raise ValueError("count must be positive")
    with db_proxy.atomic():
        cursor = db_proxy.execute_sql(
            "UPDATE tasks SET next_message_sequence = "
            "next_message_sequence + ? WHERE id = ? "
            "RETURNING next_message_sequence",
            (count, task_id),
        )
        row = cursor.fetchone()
    if row is None:
        raise ValueError(f"Task not found: {task_id}")
    return int(row[0]) - count


def create_task_message(*, task: Task, channel: str, **fields) -> Message:
    """Create a message with a task-local monotonic sequence."""
    sequence = allocate_message_sequences(task.id)
    task.next_message_sequence = sequence + 1
    return Message.create(
        task=task,
        channel=channel,
        sequence=sequence,
        **fields,
    )
