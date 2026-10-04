"""Devices, connection history and project grants.

Revision ID: 0002_devices_projects
Revises: 0001_identity
"""

from alembic import op
import sqlalchemy as sa

revision = "0002_devices_projects"
down_revision = "0001_identity"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "devices",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("public_key", sa.Text(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.current_timestamp()),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
    )
    op.create_table(
        "device_connections",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("device_id", sa.String(64), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column("connected_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.current_timestamp()),
        sa.Column("disconnected_at", sa.DateTime(timezone=True)),
        sa.Column("close_reason", sa.String(64)),
    )
    op.create_index("ix_device_connections_device_id", "device_connections", ["device_id"])
    op.create_table(
        "user_devices",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("device_id", sa.String(64), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column("access_level", sa.String(16), nullable=False, server_default="edit"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.current_timestamp()),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("user_id", "device_id"),
    )
    op.create_table(
        "platform_projects",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("device_id", sa.String(64), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column("host_project_id", sa.String(128), nullable=False),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("access_mode", sa.String(32), nullable=False, server_default="policy_only"),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.current_timestamp()),
        sa.UniqueConstraint("device_id", "host_project_id"),
    )
    op.create_table(
        "project_access_grants",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("project_id", sa.String(64), sa.ForeignKey("platform_projects.id"), nullable=False),
        sa.Column("subject_type", sa.String(16), nullable=False),
        sa.Column("subject_id", sa.String(64), nullable=False),
        sa.Column("access_level", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.current_timestamp()),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("project_id", "subject_type", "subject_id"),
    )


def downgrade():
    op.drop_table("project_access_grants")
    op.drop_table("platform_projects")
    op.drop_table("user_devices")
    op.drop_table("device_connections")
    op.drop_table("devices")
