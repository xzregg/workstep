"""Bind remote sessions to a single published project.

Revision ID: 0022_project_sessions
Revises: 0021_project_grants
"""

from alembic import op
import sqlalchemy as sa

revision = "0022_project_sessions"
down_revision = "0021_project_grants"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("auth_sessions", sa.Column("project_id", sa.String(64)))
    op.add_column("auth_sessions", sa.Column("project_access_level", sa.String(16)))


def downgrade():
    op.drop_column("auth_sessions", "project_access_level")
    op.drop_column("auth_sessions", "project_id")
