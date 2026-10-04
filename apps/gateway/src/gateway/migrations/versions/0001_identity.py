"""Platform settings, users and sessions.

Revision ID: 0001_identity
Revises:
"""

from alembic import op
import sqlalchemy as sa

revision = "0001_identity"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "platform_settings",
        sa.Column("key", sa.String(128), primary_key=True),
        sa.Column("value_json", sa.Text(), nullable=False),
        sa.Column("updated_by_user_id", sa.String(64)),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.current_timestamp(), nullable=False),
    )
    op.create_table(
        "users",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("username", sa.String(128), nullable=False, unique=True),
        sa.Column("display_name", sa.String(256), nullable=False),
        sa.Column("password_hash", sa.Text()),
        sa.Column("registration_source", sa.String(32), nullable=False, server_default="local"),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("must_change_password", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.current_timestamp()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.current_timestamp()),
        sa.Column("last_login_at", sa.DateTime(timezone=True)),
        sa.Column("created_by_user_id", sa.String(64)),
    )
    op.create_table(
        "auth_sessions",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("token_hash", sa.String(128), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.current_timestamp()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("last_seen_at", sa.DateTime(timezone=True)),
        sa.Column("device_id", sa.String(64)),
        sa.Column("device_name", sa.String(256)),
    )
    op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"])
    op.create_index("ix_auth_sessions_expires_at", "auth_sessions", ["expires_at"])


def downgrade():
    op.drop_table("auth_sessions")
    op.drop_table("users")
    op.drop_table("platform_settings")
