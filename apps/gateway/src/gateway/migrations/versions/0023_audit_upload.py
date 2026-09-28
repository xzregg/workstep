"""Preserve uploaded project audit snapshots and idempotency receipts.

Revision ID: 0023_audit_upload
Revises: 0022_project_sessions
"""

from alembic import op
import sqlalchemy as sa

revision = "0023_audit_upload"
down_revision = "0022_project_sessions"
branch_labels = None
depends_on = None


def upgrade():
    for name, column_type in (
        ("project_id", sa.String(64)),
        ("task_id", sa.String(64)),
        ("mode", sa.String(16)),
        ("actor_username", sa.String(128)),
        ("actor_name", sa.String(256)),
        ("actor_type", sa.String(16)),
        ("initiated_by_user_id", sa.String(64)),
        ("initiated_by_username", sa.String(128)),
        ("occurred_at", sa.DateTime(timezone=True)),
    ):
        op.add_column("audit_events", sa.Column(name, column_type))
    op.create_index("ix_audit_project_time", "audit_events", ["project_id", "occurred_at"])
    op.create_table(
        "audit_event_receipts",
        sa.Column("audit_event_id", sa.String(64), primary_key=True),
        sa.Column("device_id", sa.String(64), nullable=False),
        sa.Column("payload_sha256", sa.String(64), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True),
                  nullable=False, server_default=sa.func.current_timestamp()),
    )


def downgrade():
    op.drop_table("audit_event_receipts")
    op.drop_index("ix_audit_project_time", table_name="audit_events")
    for name in (
        "occurred_at", "initiated_by_username", "initiated_by_user_id",
        "actor_type", "actor_name", "actor_username", "mode", "task_id",
        "project_id",
    ):
        op.drop_column("audit_events", name)
