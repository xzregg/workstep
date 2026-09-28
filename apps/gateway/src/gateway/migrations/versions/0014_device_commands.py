"""Add command result metadata.

Revision ID: 0014_device_commands
Revises: 0013_providers
"""

from alembic import op
import sqlalchemy as sa

revision = "0014_device_commands"
down_revision = "0013_providers"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("device_commands", sa.Column("created_at", sa.DateTime(timezone=True),
                                                nullable=False, server_default=sa.func.current_timestamp()))
    op.add_column("device_commands", sa.Column("completed_at", sa.DateTime(timezone=True)))
    op.add_column("device_commands", sa.Column("last_error", sa.String(512)))
    op.add_column("device_commands", sa.Column("target_order", sa.Integer(),
                                                nullable=False, server_default="0"))
    op.create_index("ix_device_commands_expiry_status", "device_commands",
                    ["status", "expires_at"])


def downgrade():
    op.drop_index("ix_device_commands_expiry_status", table_name="device_commands")
    for name in ("target_order", "last_error", "completed_at", "created_at"):
        op.drop_column("device_commands", name)
