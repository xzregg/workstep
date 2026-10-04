"""Separate the actor's device from the reporting host PC.

Revision ID: 0024_audit_actor_device
Revises: 0023_audit_upload
"""

from alembic import op
import sqlalchemy as sa

revision = "0024_audit_actor_device"
down_revision = "0023_audit_upload"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("audit_events", sa.Column("actor_device_id", sa.String(64)))
    op.add_column("audit_events", sa.Column("actor_device_name", sa.String(256)))


def downgrade():
    op.drop_column("audit_events", "actor_device_name")
    op.drop_column("audit_events", "actor_device_id")
