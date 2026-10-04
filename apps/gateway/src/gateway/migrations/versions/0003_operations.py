"""Provider, usage, audit and device operations.

Revision ID: 0003_operations
Revises: 0002_devices_projects
"""

from alembic import op
import sqlalchemy as sa

revision = "0003_operations"
down_revision = "0002_devices_projects"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "platform_providers",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(256), nullable=False, unique=True),
        sa.Column("type", sa.String(64), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("enabled", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.current_timestamp()),
    )
    op.create_table(
        "usage_events",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(64)),
        sa.Column("device_id", sa.String(64), nullable=False),
        sa.Column("project_id", sa.String(64)),
        sa.Column("provider_id", sa.String(64)),
        sa.Column("model", sa.String(128)),
        sa.Column("input_tokens", sa.Integer()),
        sa.Column("output_tokens", sa.Integer()),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.current_timestamp()),
    )
    op.create_index("ix_usage_dimension_time", "usage_events", ["user_id", "device_id", "occurred_at"])
    op.create_table(
        "audit_events",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(64)),
        sa.Column("device_id", sa.String(64)),
        sa.Column("action", sa.String(128), nullable=False),
        sa.Column("result", sa.String(16), nullable=False),
        sa.Column("metadata_json", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.current_timestamp()),
    )
    op.create_index("ix_audit_actor_time", "audit_events", ["user_id", "created_at"])
    op.create_table(
        "device_operation_batches",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("parameters_json", sa.Text(), nullable=False),
        sa.Column("max_concurrency", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.current_timestamp()),
    )
    op.create_table(
        "device_commands",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("batch_id", sa.String(64), sa.ForeignKey("device_operation_batches.id"), nullable=False),
        sa.Column("device_id", sa.String(64), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column("idempotency_key", sa.String(128), nullable=False, unique=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_device_commands_batch_id", "device_commands", ["batch_id"])
    op.create_index("ix_device_commands_device_id", "device_commands", ["device_id"])


def downgrade():
    op.drop_table("device_commands")
    op.drop_table("device_operation_batches")
    op.drop_table("audit_events")
    op.drop_table("usage_events")
    op.drop_table("platform_providers")
