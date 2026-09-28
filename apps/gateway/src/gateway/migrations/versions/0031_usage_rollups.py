"""Durable queue and rebuildable daily usage summaries.

Revision ID: 0031_usage_rollups
Revises: 0030_usage_reconciliation
"""

from alembic import op
import sqlalchemy as sa

revision = "0031_usage_rollups"
down_revision = "0030_usage_reconciliation"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("usage_rollup_queue",
                    sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
                    sa.Column("usage_event_id", sa.String(64), nullable=False, unique=True),
                    sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
                    sqlite_autoincrement=True)
    op.create_table("usage_rollup_state",
                    sa.Column("id", sa.Integer(), primary_key=True),
                    sa.Column("last_queue_id", sa.Integer(), server_default="0", nullable=False))
    op.create_table("usage_daily_rollups",
                    sa.Column("id", sa.String(64), primary_key=True),
                    sa.Column("day", sa.String(10), nullable=False),
                    sa.Column("source", sa.String(32), nullable=False),
                    sa.Column("metering_status", sa.String(16), nullable=False),
                    sa.Column("user_id", sa.String(64)),
                    sa.Column("device_id", sa.String(64), nullable=False),
                    sa.Column("project_id", sa.String(64)),
                    sa.Column("provider_id", sa.String(64)),
                    sa.Column("model", sa.String(128)),
                    sa.Column("currency", sa.String(3)),
                    sa.Column("event_count", sa.Integer(), server_default="0", nullable=False),
                    sa.Column("unmetered_count", sa.Integer(), server_default="0", nullable=False),
                    sa.Column("cost_missing_count", sa.Integer(), server_default="0", nullable=False),
                    sa.Column("input_tokens", sa.Integer()),
                    sa.Column("output_tokens", sa.Integer()),
                    sa.Column("cache_read_tokens", sa.Integer()),
                    sa.Column("cache_write_tokens", sa.Integer()),
                    sa.Column("total_tokens", sa.Integer()),
                    sa.Column("estimated_cost", sa.Numeric(18, 6)),
                    sa.Column("billed_cost", sa.Numeric(18, 6)))
    op.create_index("ix_usage_rollup_source_day", "usage_daily_rollups",
                    ["source", "day", "provider_id", "model"])
    op.execute("INSERT INTO usage_rollup_state (id, last_queue_id) VALUES (1, 0)")
    op.execute("INSERT INTO usage_rollup_queue (usage_event_id) SELECT id FROM usage_events")


def downgrade():
    op.drop_index("ix_usage_rollup_source_day", table_name="usage_daily_rollups")
    op.drop_table("usage_daily_rollups")
    op.drop_table("usage_rollup_state")
    op.drop_table("usage_rollup_queue")
