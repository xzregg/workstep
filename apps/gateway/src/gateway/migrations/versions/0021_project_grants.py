"""Track the administrator who grants project access.

Revision ID: 0021_project_grants
Revises: 0020_project_publication
"""

from alembic import op
import sqlalchemy as sa

revision = "0021_project_grants"
down_revision = "0020_project_publication"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("project_access_grants", sa.Column("assigned_by_user_id", sa.String(64)))


def downgrade():
    op.drop_column("project_access_grants", "assigned_by_user_id")
