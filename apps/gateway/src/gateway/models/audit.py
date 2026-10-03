from datetime import datetime

from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint, func, text

from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .base import Base, timestamp

class AuditEvent(Base):
    __tablename__ = "audit_events"
    __table_args__ = (
        Index("ix_audit_actor_time", "user_id", "created_at"),
        Index("ix_audit_project_time", "project_id", "occurred_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(64))
    device_id: Mapped[str | None] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(128))
    result: Mapped[str] = mapped_column(String(16))
    metadata_json: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = timestamp()
    project_id: Mapped[str | None] = mapped_column(String(64))
    task_id: Mapped[str | None] = mapped_column(String(64))
    mode: Mapped[str | None] = mapped_column(String(16))
    actor_username: Mapped[str | None] = mapped_column(String(128))
    actor_name: Mapped[str | None] = mapped_column(String(256))
    actor_type: Mapped[str | None] = mapped_column(String(16))
    actor_device_id: Mapped[str | None] = mapped_column(String(64))
    actor_device_name: Mapped[str | None] = mapped_column(String(256))
    initiated_by_user_id: Mapped[str | None] = mapped_column(String(64))
    initiated_by_username: Mapped[str | None] = mapped_column(String(128))
    occurred_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AuditEventReceipt(Base):
    __tablename__ = "audit_event_receipts"

    audit_event_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    device_id: Mapped[str] = mapped_column(String(64))
    payload_sha256: Mapped[str] = mapped_column(String(64))
    received_at: Mapped[datetime] = timestamp()
