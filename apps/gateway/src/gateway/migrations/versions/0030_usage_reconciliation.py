"""Store provider billed cost separately from device estimates.

Revision ID: 0030_usage_reconciliation
Revises: 0029_provider_defaults
"""

from alembic import op
import sqlalchemy as sa

revision = "0030_usage_reconciliation"
down_revision = "0029_provider_defaults"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("usage_events", sa.Column("billed_cost", sa.Numeric(18, 6)))
    op.create_index("ix_usage_source_provider_day", "usage_events",
                    ["source", "provider_id", "model", "occurred_at"])


def downgrade():
    op.drop_index("ix_usage_source_provider_day", table_name="usage_events")
    op.drop_column("usage_events", "billed_cost")
