"""Bind scan callback to a safe local destination.

Revision ID: 0008_scan_redirect
Revises: 0007_desktop_auth
"""

from alembic import op
import sqlalchemy as sa

revision = "0008_scan_redirect"
down_revision = "0007_desktop_auth"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("external_login_attempts", sa.Column("return_to", sa.String(2048)))


def downgrade():
    op.drop_column("external_login_attempts", "return_to")
