"""Persistent task message creation and ordering."""

from models import Message, Task
from models.base import db_proxy


def create_task_message(*, task: Task, channel: str, **fields) -> Message:
    """Create a message with a task-local monotonic sequence."""
    with db_proxy.atomic():
        current = Task.get_by_id(task.id)
        sequence = current.next_message_sequence
        current.next_message_sequence = sequence + 1
        current.save(only=[Task.next_message_sequence])
        task.next_message_sequence = current.next_message_sequence
        return Message.create(
            task=task,
            channel=channel,
            sequence=sequence,
            **fields,
        )
