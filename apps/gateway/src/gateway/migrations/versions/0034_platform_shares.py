"""Gateway-owned public task shares and visitor sessions.

Revision ID: 0034_platform_shares
Revises: 0033_device_platform
"""

from alembic import op
import sqlalchemy as sa

revision = "0034_platform_shares"
down_revision = "0033_device_platform"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "platform_shares",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("device_id", sa.String(64), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column("project_id", sa.String(64), sa.ForeignKey("platform_projects.id"), nullable=False),
        sa.Column("task_id", sa.String(128), nullable=False),
        sa.Column("mode", sa.String(16), nullable=False),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("password_hash", sa.Text()),
        sa.Column("created_by_user_id", sa.String(64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.current_timestamp()),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_platform_shares_device_id", "platform_shares", ["device_id"])
    op.create_index("ix_platform_shares_project_id", "platform_shares", ["project_id"])
    op.create_table(
        "platform_share_sessions",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("share_id", sa.String(64), sa.ForeignKey("platform_shares.id"), nullable=False),
        sa.Column("session_token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.current_timestamp()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("last_seen_at", sa.DateTime(timezone=True)),
        sa.Column("client_fingerprint_hash", sa.String(64)),
    )
    op.create_index("ix_platform_share_sessions_share_id", "platform_share_sessions", ["share_id"])
    op.create_index("ix_platform_share_sessions_expires_at", "platform_share_sessions", ["expires_at"])


def downgrade() -> None:
    op.drop_index("ix_platform_share_sessions_expires_at", table_name="platform_share_sessions")
    op.drop_index("ix_platform_share_sessions_share_id", table_name="platform_share_sessions")
    op.drop_table("platform_share_sessions")
    op.drop_index("ix_platform_shares_project_id", table_name="platform_shares")
    op.drop_index("ix_platform_shares_device_id", table_name="platform_shares")
    op.drop_table("platform_shares")
