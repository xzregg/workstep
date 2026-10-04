from datetime import datetime

from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint, func, text

from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .base import Base, timestamp

class UsageEvent(Base):
    __tablename__ = "usage_events"
    __table_args__ = (
        Index("ix_usage_dimension_time", "user_id", "device_id", "occurred_at"),
        Index("ix_usage_source_provider_day", "source", "provider_id", "model", "occurred_at"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(64))
    device_id: Mapped[str] = mapped_column(String(64))
    project_id: Mapped[str | None] = mapped_column(String(64))
    provider_id: Mapped[str | None] = mapped_column(String(64))
    model: Mapped[str | None] = mapped_column(String(128))
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    request_id: Mapped[str | None] = mapped_column(String(128))
    source: Mapped[str] = mapped_column(String(32), server_default="reported_by_device")
    initiated_by_user_id: Mapped[str | None] = mapped_column(String(64))
    task_id: Mapped[str | None] = mapped_column(String(64))
    run_id: Mapped[str | None] = mapped_column(String(64))
    message_id: Mapped[str | None] = mapped_column(String(64))
    session_id: Mapped[str | None] = mapped_column(String(128))
    provider_revision: Mapped[int | None] = mapped_column(Integer)
    cache_read_tokens: Mapped[int | None] = mapped_column(Integer)
    cache_write_tokens: Mapped[int | None] = mapped_column(Integer)
    total_tokens: Mapped[int | None] = mapped_column(Integer)
    pricing_version: Mapped[str | None] = mapped_column(String(64))
    unit_price_snapshot_json: Mapped[str | None] = mapped_column(Text)
    currency: Mapped[str | None] = mapped_column(String(3))
    estimated_cost: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    billed_cost: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    metering_status: Mapped[str] = mapped_column(String(16), server_default="metered")
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime] = timestamp()


class UsageEventReceipt(Base):
    __tablename__ = "usage_event_receipts"

    usage_event_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    device_id: Mapped[str] = mapped_column(String(64))
    batch_id: Mapped[str] = mapped_column(String(128))
    payload_sha256: Mapped[str] = mapped_column(String(64))
    received_at: Mapped[datetime] = timestamp()


class UsageRollupQueue(Base):
    __tablename__ = "usage_rollup_queue"
    __table_args__ = {"sqlite_autoincrement": True}

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    usage_event_id: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = timestamp()


class UsageRollupState(Base):
    __tablename__ = "usage_rollup_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    last_queue_id: Mapped[int] = mapped_column(Integer, server_default="0")


class UsageDailyRollup(Base):
    __tablename__ = "usage_daily_rollups"
    __table_args__ = (Index("ix_usage_rollup_source_day", "source", "day",
                            "provider_id", "model"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    day: Mapped[str] = mapped_column(String(10))
    source: Mapped[str] = mapped_column(String(32))
    metering_status: Mapped[str] = mapped_column(String(16))
    user_id: Mapped[str | None] = mapped_column(String(64))
    device_id: Mapped[str] = mapped_column(String(64))
    project_id: Mapped[str | None] = mapped_column(String(64))
    provider_id: Mapped[str | None] = mapped_column(String(64))
    model: Mapped[str | None] = mapped_column(String(128))
    currency: Mapped[str | None] = mapped_column(String(3))
    event_count: Mapped[int] = mapped_column(Integer, server_default="0")
    unmetered_count: Mapped[int] = mapped_column(Integer, server_default="0")
    cost_missing_count: Mapped[int] = mapped_column(Integer, server_default="0")
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    cache_read_tokens: Mapped[int | None] = mapped_column(Integer)
    cache_write_tokens: Mapped[int | None] = mapped_column(Integer)
    total_tokens: Mapped[int | None] = mapped_column(Integer)
    estimated_cost: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
    billed_cost: Mapped[Decimal | None] = mapped_column(Numeric(18, 6))
