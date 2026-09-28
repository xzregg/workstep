"""Gateway-owned relational schema. Project SQLite models stay in daemon."""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


def timestamp() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.current_timestamp())


class PlatformSetting(Base):
    __tablename__ = "platform_settings"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value_json: Mapped[str] = mapped_column(Text)
    updated_by_user_id: Mapped[str | None] = mapped_column(String(64))
    updated_at: Mapped[datetime] = timestamp()


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    username: Mapped[str] = mapped_column(String(128), unique=True)
    display_name: Mapped[str] = mapped_column(String(256))
    password_hash: Mapped[str | None] = mapped_column(Text)
    registration_source: Mapped[str] = mapped_column(String(32), server_default="local")
    status: Mapped[str] = mapped_column(String(16), server_default="pending")
    must_change_password: Mapped[int] = mapped_column(Integer, server_default="0")
    created_at: Mapped[datetime] = timestamp()
    updated_at: Mapped[datetime] = timestamp()
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by_user_id: Mapped[str | None] = mapped_column(String(64))


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(128), unique=True)
    created_at: Mapped[datetime] = timestamp()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    device_id: Mapped[str | None] = mapped_column(String(64))
    device_name: Mapped[str | None] = mapped_column(String(256))


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(256))
    public_key: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), server_default="pending")
    created_at: Mapped[datetime] = timestamp()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DeviceConnection(Base):
    __tablename__ = "device_connections"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)
    connected_at: Mapped[datetime] = timestamp()
    disconnected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    close_reason: Mapped[str | None] = mapped_column(String(64))


class UserDevice(Base):
    __tablename__ = "user_devices"
    __table_args__ = (UniqueConstraint("user_id", "device_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"))
    access_level: Mapped[str] = mapped_column(String(16), server_default="edit")
    created_at: Mapped[datetime] = timestamp()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PlatformProject(Base):
    __tablename__ = "platform_projects"
    __table_args__ = (UniqueConstraint("device_id", "host_project_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"))
    host_project_id: Mapped[str] = mapped_column(String(128))
    name: Mapped[str] = mapped_column(String(256))
    access_mode: Mapped[str] = mapped_column(String(32), server_default="policy_only")
    status: Mapped[str] = mapped_column(String(16), server_default="active")
    created_at: Mapped[datetime] = timestamp()


class ProjectAccessGrant(Base):
    __tablename__ = "project_access_grants"
    __table_args__ = (UniqueConstraint("project_id", "subject_type", "subject_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("platform_projects.id"))
    subject_type: Mapped[str] = mapped_column(String(16))
    subject_id: Mapped[str] = mapped_column(String(64))
    access_level: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = timestamp()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PlatformProvider(Base):
    __tablename__ = "platform_providers"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(256), unique=True)
    type: Mapped[str] = mapped_column(String(64))
    revision: Mapped[int] = mapped_column(Integer, server_default="1")
    enabled: Mapped[int] = mapped_column(Integer, server_default="1")
    created_at: Mapped[datetime] = timestamp()


class UsageEvent(Base):
    __tablename__ = "usage_events"
    __table_args__ = (Index("ix_usage_dimension_time", "user_id", "device_id", "occurred_at"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(64))
    device_id: Mapped[str] = mapped_column(String(64))
    project_id: Mapped[str | None] = mapped_column(String(64))
    provider_id: Mapped[str | None] = mapped_column(String(64))
    model: Mapped[str | None] = mapped_column(String(128))
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime] = timestamp()


class AuditEvent(Base):
    __tablename__ = "audit_events"
    __table_args__ = (Index("ix_audit_actor_time", "user_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(64))
    device_id: Mapped[str | None] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(128))
    result: Mapped[str] = mapped_column(String(16))
    metadata_json: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = timestamp()


class DeviceOperationBatch(Base):
    __tablename__ = "device_operation_batches"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    action: Mapped[str] = mapped_column(String(64))
    parameters_json: Mapped[str] = mapped_column(Text)
    max_concurrency: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = timestamp()


class DeviceCommand(Base):
    __tablename__ = "device_commands"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    batch_id: Mapped[str] = mapped_column(ForeignKey("device_operation_batches.id"), index=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(128), unique=True)
    status: Mapped[str] = mapped_column(String(16))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
