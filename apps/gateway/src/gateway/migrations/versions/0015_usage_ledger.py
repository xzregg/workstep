"""Extend device usage ledger and add idempotent receipts.

Revision ID: 0015_usage_ledger
Revises: 0014_device_commands
"""

from alembic import op
import sqlalchemy as sa

revision = "0015_usage_ledger"
down_revision = "0014_device_commands"
branch_labels = None
depends_on = None


def upgrade():
    columns = (
        sa.Column("request_id", sa.String(128)),
        sa.Column("source", sa.String(32), nullable=False, server_default="reported_by_device"),
        sa.Column("initiated_by_user_id", sa.String(64)),
        sa.Column("task_id", sa.String(64)),
        sa.Column("run_id", sa.String(64)),
        sa.Column("message_id", sa.String(64)),
        sa.Column("session_id", sa.String(128)),
        sa.Column("provider_revision", sa.Integer()),
        sa.Column("cache_read_tokens", sa.Integer()),
        sa.Column("cache_write_tokens", sa.Integer()),
        sa.Column("total_tokens", sa.Integer()),
        sa.Column("pricing_version", sa.String(64)),
        sa.Column("unit_price_snapshot_json", sa.Text()),
        sa.Column("currency", sa.String(3)),
        sa.Column("estimated_cost", sa.Numeric(18, 6)),
        sa.Column("metering_status", sa.String(16), nullable=False, server_default="metered"),
    )
    for column in columns:
        op.add_column("usage_events", column)
    op.create_table(
        "usage_event_receipts",
        sa.Column("usage_event_id", sa.String(64), primary_key=True),
        sa.Column("device_id", sa.String(64), nullable=False),
        sa.Column("batch_id", sa.String(128), nullable=False),
        sa.Column("payload_sha256", sa.String(64), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.current_timestamp()),
    )


def downgrade():
    op.drop_table("usage_event_receipts")
    for name in ("metering_status", "estimated_cost", "currency",
                 "unit_price_snapshot_json", "pricing_version", "total_tokens",
                 "cache_write_tokens", "cache_read_tokens", "provider_revision",
                 "session_id", "message_id", "run_id", "task_id",
                 "initiated_by_user_id", "source", "request_id"):
        op.drop_column("usage_events", name)
