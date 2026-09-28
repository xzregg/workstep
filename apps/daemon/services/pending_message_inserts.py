"""Persistence helpers for project-local pending message inserts."""

import uuid

from models import Message, PendingMessageInsert
from models.fields import utc_now
from services.remote_access import (
    ActorSnapshot, get_effective_actor, require_user_actor,
)


def serialize_pending_insert(row: PendingMessageInsert) -> dict:
    return {
        "id": row.id,
        "target_message_id": row.target_message_id,
        "content": row.content,
        "position": row.position,
        "username": row.username,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
    }


def list_pending_inserts(target_message_id: str) -> list[dict]:
    return [
        serialize_pending_insert(row)
        for row in (
            PendingMessageInsert.select()
            .where(PendingMessageInsert.target_message_id == target_message_id)
            .order_by(PendingMessageInsert.position, PendingMessageInsert.created_at)
        )
    ]


def create_pending_insert(
    target_message_id: str,
    content: str,
    username: str | None,
) -> dict:
    normalized = content.strip()
    if not target_message_id.strip():
        raise ValueError("Target message id is required")
    if not normalized:
        raise ValueError("消息内容不能为空")
    last = (
        PendingMessageInsert.select(PendingMessageInsert.position)
        .where(PendingMessageInsert.target_message_id == target_message_id)
        .order_by(PendingMessageInsert.position.desc())
        .first()
    )
    now = utc_now()
    actor = require_user_actor() if username is None else get_effective_actor()
    display_name = (
        username if username is not None else actor.user_name if actor is not None else ""
    ).strip()
    actor_fields = (
        {
            "author_id": actor.actor_id,
            "author_username": actor.username or actor.user_name,
            "author_name": actor.user_name,
            "author_device_id": actor.device_id,
            "author_device_name": actor.device_name,
            "author_source": actor.source,
        }
        if actor is not None and actor.user_name == display_name else {}
    )
    row = PendingMessageInsert.create(
        id=str(uuid.uuid4()),
        target_message_id=target_message_id,
        content=normalized,
        position=(last.position + 1 if last is not None else 0),
        username=display_name,
        created_at=now,
        updated_at=now,
        **actor_fields,
    )
    return serialize_pending_insert(row)


def update_pending_insert(insert_id: str, content: str) -> dict:
    normalized = content.strip()
    if not normalized:
        raise ValueError("消息内容不能为空")
    row = PendingMessageInsert.get_or_none(PendingMessageInsert.id == insert_id)
    if row is None:
        raise ValueError("待插入消息不存在")
    row.content = normalized
    row.updated_at = utc_now()
    row.save()
    return serialize_pending_insert(row)


def reorder_pending_inserts(target_message_id: str, ids: list[str]) -> list[dict]:
    rows = list(
        PendingMessageInsert.select().where(
            PendingMessageInsert.target_message_id == target_message_id
        )
    )
    existing = {row.id: row for row in rows}
    if len(ids) != len(rows) or set(ids) != set(existing):
        raise ValueError("待插入消息顺序与当前队列不一致")
    now = utc_now()
    with PendingMessageInsert._meta.database.atomic():
        for position, insert_id in enumerate(ids):
            row = existing[insert_id]
            row.position = position
            row.updated_at = now
            row.save(only=[PendingMessageInsert.position, PendingMessageInsert.updated_at])
    return list_pending_inserts(target_message_id)


def delete_pending_insert(insert_id: str) -> bool:
    return bool(
        PendingMessageInsert.delete()
        .where(PendingMessageInsert.id == insert_id)
        .execute()
    )


def clear_pending_inserts(target_message_id: str) -> int:
    return (
        PendingMessageInsert.delete()
        .where(PendingMessageInsert.target_message_id == target_message_id)
        .execute()
    )


def pending_insert_batch(target_message_id: str) -> tuple[list[str], str, str]:
    """Return ordered ids, merged content and the first non-empty username."""
    rows = list(
        PendingMessageInsert.select()
        .where(PendingMessageInsert.target_message_id == target_message_id)
        .order_by(PendingMessageInsert.position, PendingMessageInsert.created_at)
    )
    return (
        [row.id for row in rows],
        "\n\n".join(row.content.strip() for row in rows if row.content.strip()),
        next((row.username for row in rows if row.username.strip()), ""),
    )


def pending_insert_actor(target_message_id: str) -> ActorSnapshot | None:
    """Restore the first named insert's persisted actor for its merged reply."""
    rows = (
        PendingMessageInsert.select()
        .where(PendingMessageInsert.target_message_id == target_message_id)
        .order_by(PendingMessageInsert.position, PendingMessageInsert.created_at)
    )
    for row in rows:
        if not row.username.strip():
            continue
        if not row.author_id or not row.author_name:
            return None
        return ActorSnapshot(
            actor_id=row.author_id,
            user_name=row.author_name,
            username=row.author_username or row.author_name,
            device_id=row.author_device_id or "",
            device_name=row.author_device_name or "",
            source=row.author_source or "pending_insert",
        )
    return None


def oldest_task_pending_batch(
    task_id: str,
) -> tuple[str, list[str], str, str] | None:
    """Select the oldest pending target for a task and merge its inserts."""
    first = (
        PendingMessageInsert.select(PendingMessageInsert, Message)
        .join(Message, on=(PendingMessageInsert.target_message_id == Message.id))
        .where(Message.task == task_id)
        .order_by(PendingMessageInsert.created_at, PendingMessageInsert.position)
        .first()
    )
    if first is None:
        return None
    target = Message.get_by_id(first.target_message_id)
    ids, content, username = pending_insert_batch(target.id)
    if not ids or not content:
        return None
    return target.step_key, ids, content, username


def delete_pending_insert_batch(ids: list[str]) -> int:
    if not ids:
        return 0
    return (
        PendingMessageInsert.delete()
        .where(PendingMessageInsert.id.in_(ids))
        .execute()
    )
