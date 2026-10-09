from datetime import datetime

from decimal import Decimal

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint, false, func, text, true

from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .base import Base, timestamp

class PlatformShare(Base):
    __tablename__ = "platform_shares"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("platform_projects.id"), index=True)
    task_id: Mapped[str] = mapped_column(String(128))
    mode: Mapped[str] = mapped_column(String(16))
    title: Mapped[str] = mapped_column(String(256))
    password_hash: Mapped[str | None] = mapped_column(Text)
    created_by_user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(16), server_default="active")
    created_at: Mapped[datetime] = timestamp()
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PlatformShareSession(Base):
    __tablename__ = "platform_share_sessions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    share_id: Mapped[str] = mapped_column(ForeignKey("platform_shares.id"), index=True)
    session_token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = timestamp()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    client_fingerprint_hash: Mapped[str | None] = mapped_column(String(64))


class UserGroup(Base):
    __tablename__ = "user_groups"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(256))
    slug: Mapped[str] = mapped_column(String(128), unique=True)
    description: Mapped[str] = mapped_column(Text, server_default="")
    source_type: Mapped[str] = mapped_column(String(32), server_default="manual")
    external_department_id: Mapped[str | None] = mapped_column(ForeignKey("directory_departments.id"))
    status: Mapped[str] = mapped_column(String(16), server_default="active")
    created_by_user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = timestamp()
    updated_at: Mapped[datetime] = timestamp()


class GroupMembership(Base):
    __tablename__ = "group_memberships"
    __table_args__ = (UniqueConstraint("group_id", "user_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    group_id: Mapped[str] = mapped_column(ForeignKey("user_groups.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    role: Mapped[str] = mapped_column(String(16), server_default="member")
    source: Mapped[str] = mapped_column(String(32), server_default="manual")
    assigned_by_user_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = timestamp()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class GroupProject(Base):
    __tablename__ = "group_projects"
    __table_args__ = (UniqueConstraint("group_id", "platform_project_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    group_id: Mapped[str] = mapped_column(ForeignKey("user_groups.id"), index=True)
    platform_project_id: Mapped[str] = mapped_column(ForeignKey("platform_projects.id"))
    purpose: Mapped[str] = mapped_column(String(32), server_default="skill_management")
    assigned_by_user_id: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = timestamp()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class GroupCapabilityAssignment(Base):
    __tablename__ = "group_capability_assignments"
    __table_args__ = (UniqueConstraint("group_id", "project_id", "capability"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    group_id: Mapped[str] = mapped_column(ForeignKey("user_groups.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("platform_projects.id"), index=True)
    capability: Mapped[str] = mapped_column(String(64))
    effect: Mapped[str] = mapped_column(String(16))
    assigned_by_user_id: Mapped[str] = mapped_column(String(64))
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
    invitations_enabled: Mapped[bool] = mapped_column(Boolean, server_default=true())
    status: Mapped[str] = mapped_column(String(16), server_default="active")
    skill_revision: Mapped[int] = mapped_column(Integer, server_default="0")
    published_by_user_id: Mapped[str | None] = mapped_column(String(64))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by_user_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = timestamp()
    updated_at: Mapped[datetime] = timestamp()


class ProjectAccessGrant(Base):
    __tablename__ = "project_access_grants"
    __table_args__ = (UniqueConstraint("project_id", "subject_type", "subject_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("platform_projects.id"))
    subject_type: Mapped[str] = mapped_column(String(16))
    subject_id: Mapped[str] = mapped_column(String(64))
    access_level: Mapped[str] = mapped_column(String(16))
    assigned_by_user_id: Mapped[str | None] = mapped_column(String(64))
    invitation_id: Mapped[str | None] = mapped_column(ForeignKey("project_invitations.id"))
    invitation_blocked: Mapped[bool] = mapped_column(Boolean, server_default=false())
    created_at: Mapped[datetime] = timestamp()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ProjectInvitation(Base):
    __tablename__ = "project_invitations"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("platform_projects.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    access_level: Mapped[str] = mapped_column(String(16))
    created_by_user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(16), server_default="active")
    created_at: Mapped[datetime] = timestamp()
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ProjectInvitationAcceptance(Base):
    __tablename__ = "project_invitation_acceptances"
    __table_args__ = (UniqueConstraint("invitation_id", "user_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    invitation_id: Mapped[str] = mapped_column(ForeignKey("project_invitations.id"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    accepted_at: Mapped[datetime] = timestamp()
