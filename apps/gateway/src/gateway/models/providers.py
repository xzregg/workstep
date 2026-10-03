from datetime import datetime

from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint, func, text

from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .base import Base, timestamp

class PlatformProvider(Base):
    __tablename__ = "platform_providers"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(256), unique=True)
    type: Mapped[str] = mapped_column(String(64))
    revision: Mapped[int] = mapped_column(Integer, server_default="1")
    enabled: Mapped[int] = mapped_column(Integer, server_default="1")
    config_json: Mapped[str] = mapped_column(Text, server_default="{}")
    secret_ciphertext: Mapped[str | None] = mapped_column(Text)
    models_json: Mapped[str] = mapped_column(Text, server_default="[]")
    prices_json: Mapped[str] = mapped_column(Text, server_default="{}")
    created_by_user_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = timestamp()


class ProviderAssignment(Base):
    __tablename__ = "provider_assignments"
    __table_args__ = (
        UniqueConstraint("provider_id", "subject_type", "subject_id"),
        Index("uq_provider_assignment_default", "subject_type", "subject_id",
              unique=True, sqlite_where=text("is_default = 1 AND revoked_at IS NULL"),
              postgresql_where=text("is_default = 1 AND revoked_at IS NULL")),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    provider_id: Mapped[str] = mapped_column(ForeignKey("platform_providers.id"))
    subject_type: Mapped[str] = mapped_column(String(16))
    subject_id: Mapped[str] = mapped_column(String(64))
    assigned_by_user_id: Mapped[str] = mapped_column(String(64))
    is_default: Mapped[int] = mapped_column(Integer, server_default="0")
    created_at: Mapped[datetime] = timestamp()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DeviceProviderApplication(Base):
    __tablename__ = "device_provider_applications"

    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), primary_key=True)
    desired_revision: Mapped[int] = mapped_column(Integer, server_default="0")
    applied_revision: Mapped[int | None] = mapped_column(Integer)
    last_error: Mapped[str | None] = mapped_column(String(512))
    updated_at: Mapped[datetime] = timestamp()
