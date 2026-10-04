"""Track pending verified directory callback triggers.

Revision ID: 0026_directory_callback_queue
Revises: 0025_identity_callback_secrets
"""

from alembic import op
import sqlalchemy as sa

revision = "0026_directory_callback_queue"
down_revision = "0025_identity_callback_secrets"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("directory_event_receipts", sa.Column(
        "status", sa.String(16), nullable=False, server_default="done",
    ))
    op.create_index("ix_directory_event_receipts_status", "directory_event_receipts", ["status"])


def downgrade():
    op.drop_index("ix_directory_event_receipts_status", table_name="directory_event_receipts")
    op.drop_column("directory_event_receipts", "status")
