from datetime import datetime

from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint, func, text

from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .base import Base, timestamp

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
    authentication_method: Mapped[str] = mapped_column(String(16), server_default="password")
    device_id: Mapped[str | None] = mapped_column(String(64))
    device_name: Mapped[str | None] = mapped_column(String(256))
    project_id: Mapped[str | None] = mapped_column(String(64))
    project_access_level: Mapped[str | None] = mapped_column(String(16))


class AdminAssignment(Base):
    __tablename__ = "admin_assignments"
    __table_args__ = (Index("ix_admin_user_role", "user_id", "role"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    group_id: Mapped[str | None] = mapped_column(ForeignKey("user_groups.id"), index=True)
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
    callback_token_env: Mapped[str | None] = mapped_column(String(128))
    callback_aes_key_env: Mapped[str | None] = mapped_column(String(128))
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
    status: Mapped[str] = mapped_column(String(16), server_default="done", index=True)
    received_at: Mapped[datetime] = timestamp()


class DirectorySyncState(Base):
    __tablename__ = "directory_sync_states"

    source_id: Mapped[str] = mapped_column(ForeignKey("identity_sources.id"), primary_key=True)
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error_code: Mapped[str | None] = mapped_column(String(64))
    cursor: Mapped[str | None] = mapped_column(String(256))
    changes_json: Mapped[str | None] = mapped_column(Text)
