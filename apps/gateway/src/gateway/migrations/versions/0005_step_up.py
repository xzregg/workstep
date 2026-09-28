"""Short-lived step-up authentication on browser sessions.

Revision ID: 0005_step_up
Revises: 0004_accounts
"""

from alembic import op
import sqlalchemy as sa

revision = "0005_step_up"
down_revision = "0004_accounts"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("auth_sessions", sa.Column("step_up_expires_at", sa.DateTime(timezone=True)))


def downgrade():
    op.drop_column("auth_sessions", "step_up_expires_at")
