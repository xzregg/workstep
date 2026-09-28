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
    password_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    is_recovery: Mapped[int] = mapped_column(Integer, server_default="0")
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
    step_up_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    device_id: Mapped[str | None] = mapped_column(String(64))
    device_name: Mapped[str | None] = mapped_column(String(256))


class AdminAssignment(Base):
    __tablename__ = "admin_assignments"
    __table_args__ = (Index("ix_admin_user_role", "user_id", "role"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    role: Mapped[str] = mapped_column(String(32))
    scope_type: Mapped[str] = mapped_column(String(32), server_default="platform")
    scope_id: Mapped[str | None] = mapped_column(String(64))
    include_subdepartments: Mapped[int] = mapped_column(Integer, server_default="0")
    granted_by_user_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = timestamp()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class IdentitySource(Base):
    __tablename__ = "identity_sources"
    __table_args__ = (UniqueConstraint("provider", "tenant_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    provider: Mapped[str] = mapped_column(String(32))
    tenant_id: Mapped[str] = mapped_column(String(128))
    client_id: Mapped[str] = mapped_column(String(256))
    secret_env: Mapped[str] = mapped_column(String(128))
    agent_id: Mapped[str | None] = mapped_column(String(128))
    enabled: Mapped[int] = mapped_column(Integer, server_default="1")
    created_at: Mapped[datetime] = timestamp()


class ExternalIdentity(Base):
    __tablename__ = "external_identities"
    __table_args__ = (UniqueConstraint("source_id", "subject"), UniqueConstraint("source_id", "user_id"))

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("identity_sources.id"))
    subject: Mapped[str] = mapped_column(String(256))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    display_name: Mapped[str] = mapped_column(String(256))
    created_at: Mapped[datetime] = timestamp()
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ExternalLoginAttempt(Base):
    __tablename__ = "external_login_attempts"

    state_hash: Mapped[str] = mapped_column(String(128), primary_key=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("identity_sources.id"))
    nonce: Mapped[str] = mapped_column(String(128))
    binding_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    binding_session_id: Mapped[str | None] = mapped_column(ForeignKey("auth_sessions.id"))
    return_to: Mapped[str | None] = mapped_column(String(2048))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DirectoryDepartment(Base):
    __tablename__ = "directory_departments"
    __table_args__ = (UniqueConstraint("source_id", "external_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("identity_sources.id"))
    external_id: Mapped[str] = mapped_column(String(256))
    parent_external_id: Mapped[str | None] = mapped_column(String(256))
    display_name: Mapped[str] = mapped_column(String(256))
    active: Mapped[int] = mapped_column(Integer, server_default="1")


class DirectoryPerson(Base):
    __tablename__ = "directory_people"
    __table_args__ = (UniqueConstraint("source_id", "subject"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("identity_sources.id"))
    subject: Mapped[str] = mapped_column(String(256))
    display_name: Mapped[str] = mapped_column(String(256))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    active: Mapped[int] = mapped_column(Integer, server_default="1")


class DirectoryMembership(Base):
    __tablename__ = "directory_memberships"
    __table_args__ = (UniqueConstraint("person_id", "department_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    person_id: Mapped[str] = mapped_column(ForeignKey("directory_people.id"))
    department_id: Mapped[str] = mapped_column(ForeignKey("directory_departments.id"))


class DirectoryEventReceipt(Base):
    __tablename__ = "directory_event_receipts"
    __table_args__ = (UniqueConstraint("source_id", "event_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    source_id: Mapped[str] = mapped_column(ForeignKey("identity_sources.id"))
    event_id: Mapped[str] = mapped_column(String(256))
    received_at: Mapped[datetime] = timestamp()


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(256))
    public_key: Mapped[str] = mapped_column(Text)
    public_key_fingerprint: Mapped[str | None] = mapped_column(String(64))
    app_instance_id: Mapped[str | None] = mapped_column(String(128))
    version: Mapped[str | None] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), server_default="pending")
    created_at: Mapped[datetime] = timestamp()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DesktopAuthCode(Base):
    __tablename__ = "desktop_auth_codes"

    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    gateway_id: Mapped[str] = mapped_column(String(128))
    app_instance_id: Mapped[str] = mapped_column(String(128))
    state_hash: Mapped[str] = mapped_column(String(64))
    nonce_hash: Mapped[str] = mapped_column(String(64))
    pkce_challenge: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = timestamp()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


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
