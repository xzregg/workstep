"""Track single-use device access tickets.

Revision ID: 0012_remote_access
Revises: 0011_capabilities
"""

from alembic import op
import sqlalchemy as sa

revision = "0012_remote_access"
down_revision = "0011_capabilities"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "used_device_access_tickets",
        sa.Column("jti_hash", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("device_id", sa.String(64), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.current_timestamp()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_used_device_access_tickets_expires_at",
                    "used_device_access_tickets", ["expires_at"])


def downgrade():
    op.drop_index("ix_used_device_access_tickets_expires_at",
                  table_name="used_device_access_tickets")
    op.drop_table("used_device_access_tickets")
