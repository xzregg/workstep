"""Persistent task message creation and ordering."""

import secrets
import threading
import time
import uuid

from models import Message, Task
from models.base import db_proxy


def current_actor_message_fields() -> dict[str, str]:
    """Snapshot the effective local or remote actor for durable history."""
    from services.remote_project import get_effective_actor

    actor = get_effective_actor()
    if actor is None:
        return {}
    return {
        "author_id": actor.actor_id,
        "author_name": actor.user_name,
        "author_device_id": actor.device_id,
        "author_device_name": actor.device_name,
    }


def current_actor_task_fields() -> dict[str, str]:
    """Snapshot the effective local, browser, or remote actor for task ownership."""
    from services.remote_project import get_effective_actor

    actor = get_effective_actor()
    if actor is None:
        return {}
    return {
        "creator_id": actor.actor_id,
        "creator_name": actor.user_name,
        "creator_device_id": actor.device_id,
        "creator_device_name": actor.device_name,
    }


_AUTHOR_FIELDS = (
    "author_id",
    "author_name",
    "author_device_id",
    "author_device_name",
)


def _message_author_fields(message: Message | None) -> dict[str, str]:
    if message is None:
        return {}
    return {
        field: value
        for field in _AUTHOR_FIELDS
        if (value := getattr(message, field, None))
    }


def attributed_actor_message_fields(
    task: Task,
    *,
    reply_to_message_id: str | None = None,
    channel: str | None = None,
    step_key: str | None = None,
) -> dict[str, str]:
    """Resolve the person whose action caused a task assistant message.

    Prefer an explicit replied-to message, then the newest attributed task
    message.  This makes live ``@stage`` continuations switch attribution at
    the exact response boundary while automatic stages inherit the persisted
    execution chain.  The task creator is the final fallback.
    """
    source = None
    if reply_to_message_id:
        source = Message.get_or_none(Message.id == reply_to_message_id)
    if source is None:
        base_predicate = (
            (Message.task == task)
            & (Message.author_name.is_null(False))
            & (Message.author_name != "")
        )
        if channel == "review" and step_key:
            predicate = base_predicate & (
                (Message.step_key == step_key)
                & (Message.channel.in_(["execution", "review"]))
            )
        elif channel:
            predicate = base_predicate & (Message.channel == channel)
            if step_key:
                source = (
                    Message.select()
                    .where(predicate & (Message.step_key == step_key))
                    .order_by(Message.sequence.desc(), Message.created_at.desc())
                    .first()
                )
        else:
            predicate = base_predicate
        if source is None:
            source = (
                Message.select()
                .where(predicate)
                .order_by(Message.sequence.desc(), Message.created_at.desc())
                .first()
            )
    fields = _message_author_fields(source)
    if fields:
        return fields
    return {
        "author_id": task.creator_id,
        "author_name": task.creator_name,
        "author_device_id": task.creator_device_id,
        "author_device_name": task.creator_device_name,
    } if task.creator_name else {}


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
    if fields.get("role") == "user":
        actor_fields = current_actor_message_fields()
        provided_name = str(fields.get("author_name") or "").strip()
        if not provided_name or provided_name == actor_fields.get("author_name"):
            for key, value in actor_fields.items():
                fields.setdefault(key, value)
    elif fields.get("role") == "assistant":
        actor_fields = attributed_actor_message_fields(
            task,
            reply_to_message_id=fields.get("reply_to_message_id"),
            channel=channel,
            step_key=fields.get("step_key"),
        )
        for key, value in actor_fields.items():
            fields.setdefault(key, value)
    return Message.create(
        task=task,
        channel=channel,
        sequence=sequence,
        **fields,
    )
