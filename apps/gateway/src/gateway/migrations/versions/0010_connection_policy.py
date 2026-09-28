"""Record applied policy revision for each device connection.

Revision ID: 0010_connection_policy
Revises: 0009_client_releases
"""

from alembic import op
import sqlalchemy as sa

revision = "0010_connection_policy"
down_revision = "0009_client_releases"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("device_connections", sa.Column("applied_policy_revision", sa.Integer()))


def downgrade():
    op.drop_column("device_connections", "applied_policy_revision")
