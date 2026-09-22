"""Persistence helpers for project-local pending message inserts."""

import uuid

from models import PendingMessageInsert
from models.fields import utc_now


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
    username: str,
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
    row = PendingMessageInsert.create(
        id=str(uuid.uuid4()),
        target_message_id=target_message_id,
        content=normalized,
        position=(last.position + 1 if last is not None else 0),
        username=username.strip(),
        created_at=now,
        updated_at=now,
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


def delete_pending_insert_batch(ids: list[str]) -> int:
    if not ids:
        return 0
    return (
        PendingMessageInsert.delete()
        .where(PendingMessageInsert.id.in_(ids))
        .execute()
    )
