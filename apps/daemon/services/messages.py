"""Persistent task message creation and ordering."""

import secrets
import threading
import time
import uuid

from models import Message, Task
from models.base import db_proxy


_UUID7_RANDOM_BITS = 74
_UUID7_RANDOM_MASK = (1 << _UUID7_RANDOM_BITS) - 1
_uuid7_lock = threading.Lock()
_uuid7_last_timestamp_ms = -1
_uuid7_last_random = 0


def new_message_id() -> str:
    """Return a monotonic UUID v7 suitable for lexicographic ordering."""
    global _uuid7_last_timestamp_ms, _uuid7_last_random

    with _uuid7_lock:
        timestamp_ms = time.time_ns() // 1_000_000
        if timestamp_ms > _uuid7_last_timestamp_ms:
            random_bits = secrets.randbits(_UUID7_RANDOM_BITS)
        else:
            timestamp_ms = _uuid7_last_timestamp_ms
            random_bits = _uuid7_last_random + 1
            if random_bits > _UUID7_RANDOM_MASK:
                timestamp_ms += 1
                random_bits = 0

        _uuid7_last_timestamp_ms = timestamp_ms
        _uuid7_last_random = random_bits

        value = (timestamp_ms & ((1 << 48) - 1)) << 80
        value |= 0x7 << 76
        value |= (random_bits >> 62) << 64
        value |= 0b10 << 62
        value |= random_bits & ((1 << 62) - 1)
        return str(uuid.UUID(int=value))


def allocate_message_sequences(task_id: str, count: int = 1) -> int:
    """Atomically reserve ``count`` consecutive sequences for a task.

    Uses a single ``UPDATE ... RETURNING`` so concurrent requests (and even
    multiple daemon processes sharing the project database) can never hand
    out the same sequence twice.
    """
    if count < 1:
        raise ValueError("count must be positive")
    with db_proxy.atomic():
        # 先对齐再分配：若历史回写导致计数器落后于已有消息的最大 sequence，
        # 在同一事务内自愈（max(next, 实际最大值+1)），避免撞号触发唯一约束冲突。
        cursor = db_proxy.execute_sql(
            "UPDATE tasks SET next_message_sequence = "
            "MAX(next_message_sequence, "
            "COALESCE((SELECT MAX(sequence) + 1 FROM message "
            "WHERE task_id = ?), 1)) + ? WHERE id = ? "
            "RETURNING next_message_sequence",
            (task_id, count, task_id),
        )
        row = cursor.fetchone()
    if row is None:
        raise ValueError(f"Task not found: {task_id}")
    return int(row[0]) - count


def create_task_message(*, task: Task, channel: str, **fields) -> Message:
    """Create a message with a task-local monotonic sequence."""
    sequence = allocate_message_sequences(task.id)
    task.next_message_sequence = sequence + 1
    if "id" not in fields:
        fields["id"] = new_message_id()
    return Message.create(
        task=task,
        channel=channel,
        sequence=sequence,
        **fields,
    )
