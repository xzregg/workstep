"""Track explicit device project publication metadata.

Revision ID: 0020_project_publication
Revises: 0019_skill_state
"""

from alembic import op
import sqlalchemy as sa

revision = "0020_project_publication"
down_revision = "0019_skill_state"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("platform_projects", sa.Column("published_by_user_id", sa.String(64)))
    op.add_column("platform_projects", sa.Column("published_at", sa.DateTime(timezone=True)))
    op.add_column("platform_projects", sa.Column("created_by_user_id", sa.String(64)))
    op.add_column("platform_projects", sa.Column(
        "updated_at", sa.DateTime(timezone=True), nullable=False,
        server_default=sa.func.current_timestamp(),
    ))


def downgrade():
    for name in ("updated_at", "created_by_user_id", "published_at",
                 "published_by_user_id"):
        op.drop_column("platform_projects", name)
