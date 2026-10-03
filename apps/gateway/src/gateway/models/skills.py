from datetime import datetime

from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint, func, text

from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .base import Base, timestamp

class SkillPackage(Base):
    __tablename__ = "skill_packages"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(256))
    slug: Mapped[str] = mapped_column(String(128), unique=True)
    description: Mapped[str] = mapped_column(Text, server_default="")
    owner_user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(16), server_default="active")
    created_at: Mapped[datetime] = timestamp()


class SkillVersion(Base):
    __tablename__ = "skill_versions"
    __table_args__ = (UniqueConstraint("skill_id", "version"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    skill_id: Mapped[str] = mapped_column(ForeignKey("skill_packages.id"), index=True)
    version: Mapped[str] = mapped_column(String(64))
    digest: Mapped[str] = mapped_column(String(64))
    storage_name: Mapped[str] = mapped_column(String(128), unique=True)
    file_count: Mapped[int] = mapped_column(Integer)
    total_size: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(32), server_default="pending_review")
    uploaded_by_user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    reviewed_by_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoke_reason: Mapped[str | None] = mapped_column(String(512))
    created_at: Mapped[datetime] = timestamp()


class GroupSkillCatalog(Base):
    __tablename__ = "group_skill_catalog"
    __table_args__ = (UniqueConstraint("group_id", "skill_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    group_id: Mapped[str] = mapped_column(ForeignKey("user_groups.id"), index=True)
    skill_id: Mapped[str] = mapped_column(ForeignKey("skill_packages.id"))
    skill_version_id: Mapped[str] = mapped_column(ForeignKey("skill_versions.id"))
    granted_by_user_id: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = timestamp()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ProjectSkillAssignment(Base):
    __tablename__ = "project_skill_assignments"
    __table_args__ = (UniqueConstraint("platform_project_id", "skill_id", "source_group_id"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    platform_project_id: Mapped[str] = mapped_column(ForeignKey("platform_projects.id"), index=True)
    skill_id: Mapped[str] = mapped_column(ForeignKey("skill_packages.id"))
    skill_version_id: Mapped[str] = mapped_column(ForeignKey("skill_versions.id"))
    source_group_id: Mapped[str] = mapped_column(ForeignKey("user_groups.id"))
    assigned_by_user_id: Mapped[str] = mapped_column(String(64))
    desired_revision: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), server_default="active")
    created_at: Mapped[datetime] = timestamp()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DeviceProjectSkillState(Base):
    __tablename__ = "device_project_skill_state"

    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id"), primary_key=True)
    host_project_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    platform_project_id: Mapped[str] = mapped_column(ForeignKey("platform_projects.id"))
    desired_revision: Mapped[int] = mapped_column(Integer)
    applied_revision: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16))
    last_error_code: Mapped[str | None] = mapped_column(String(64))
    acknowledged_at: Mapped[datetime] = timestamp()
