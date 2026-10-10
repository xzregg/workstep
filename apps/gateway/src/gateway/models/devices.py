from datetime import datetime

from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint, func, text

from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .base import Base, timestamp

class UsedDeviceAccessTicket(Base):
    __tablename__ = "used_device_access_tickets"

    jti_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"))
    used_at: Mapped[datetime] = timestamp()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(256))
    owner_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), index=True)
    department_id: Mapped[str | None] = mapped_column(ForeignKey("directory_departments.id"), index=True)
    public_key: Mapped[str] = mapped_column(Text)
    public_key_fingerprint: Mapped[str | None] = mapped_column(String(64))
    app_instance_id: Mapped[str | None] = mapped_column(String(128))
    hook_device_id: Mapped[str | None] = mapped_column(String(128), unique=True)
    version: Mapped[str | None] = mapped_column(String(64))
    os: Mapped[str | None] = mapped_column(String(16))
    arch: Mapped[str | None] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), server_default="pending")
    policy_revision: Mapped[int] = mapped_column(Integer, server_default="0")
    provider_revision: Mapped[int] = mapped_column(Integer, server_default="0")
    created_at: Mapped[datetime] = timestamp()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DeviceGroup(Base):
    __tablename__ = "device_groups"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(256), unique=True)
    created_at: Mapped[datetime] = timestamp()


class DeviceGroupMembership(Base):
    __tablename__ = "device_group_memberships"
    group_id: Mapped[str] = mapped_column(ForeignKey("device_groups.id"), primary_key=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), primary_key=True)


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


class ClientRelease(Base):
    __tablename__ = "client_releases"
    __table_args__ = (UniqueConstraint("gateway_id", "os", "arch", "version"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    gateway_id: Mapped[str] = mapped_column(String(128))
    os: Mapped[str] = mapped_column(String(16))
    arch: Mapped[str] = mapped_column(String(16))
    version: Mapped[str] = mapped_column(String(64))
    filename: Mapped[str] = mapped_column(String(256))
    storage_name: Mapped[str] = mapped_column(String(256))
    file_size: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    signature: Mapped[str] = mapped_column(Text)
    gateway_public_key_fingerprint: Mapped[str] = mapped_column(String(64))
    minimum_protocol_version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), server_default="published")
    created_at: Mapped[datetime] = timestamp()


class DeviceConnection(Base):
    __tablename__ = "device_connections"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)
    connected_at: Mapped[datetime] = timestamp()
    disconnected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    close_reason: Mapped[str | None] = mapped_column(String(64))
    applied_policy_revision: Mapped[int | None] = mapped_column(Integer)


class UserDevice(Base):
    __tablename__ = "user_devices"
    __table_args__ = (UniqueConstraint("user_id", "device_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"))
    access_level: Mapped[str] = mapped_column(String(16), server_default="edit")
    created_at: Mapped[datetime] = timestamp()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CapabilityAssignment(Base):
    __tablename__ = "capability_assignments"
    __table_args__ = (UniqueConstraint("user_id", "capability", "scope_type", "scope_id"),
                     UniqueConstraint("group_id", "capability", "scope_type", "scope_id"))

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    group_id: Mapped[str | None] = mapped_column(ForeignKey("user_groups.id"), index=True)
    capability: Mapped[str] = mapped_column(String(64))
    scope_type: Mapped[str] = mapped_column(String(16))
    scope_id: Mapped[str] = mapped_column(String(64), server_default="")
    effect: Mapped[str] = mapped_column(String(16))
    assigned_by_user_id: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = timestamp()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class GroupDevice(Base):
    __tablename__ = 'group_devices'
    __table_args__ = (UniqueConstraint('group_id', 'device_id'),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    group_id: Mapped[str] = mapped_column(ForeignKey('user_groups.id'), index=True)
    device_id: Mapped[str] = mapped_column(ForeignKey('devices.id'), index=True)
    created_at: Mapped[datetime] = timestamp()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
