"""Persist directory reconciliation status and diff summary.

Revision ID: 0027_directory_sync_state
Revises: 0026_directory_callback_queue
"""

from alembic import op
import sqlalchemy as sa

revision = "0027_directory_sync_state"
down_revision = "0026_directory_callback_queue"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "directory_sync_states",
        sa.Column("source_id", sa.String(64), sa.ForeignKey("identity_sources.id"), primary_key=True),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True)),
        sa.Column("last_success_at", sa.DateTime(timezone=True)),
        sa.Column("last_error_code", sa.String(64)),
        sa.Column("cursor", sa.String(256)),
        sa.Column("changes_json", sa.Text()),
    )


def downgrade():
    op.drop_table("directory_sync_states")
