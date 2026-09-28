"""Add immutable Skill packages and reviewed versions.

Revision ID: 0017_skill_catalog
Revises: 0016_groups
"""

from alembic import op
import sqlalchemy as sa

revision = "0017_skill_catalog"
down_revision = "0016_groups"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "skill_packages",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("slug", sa.String(128), nullable=False, unique=True),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("owner_user_id", sa.String(64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.current_timestamp()),
    )
    op.create_table(
        "skill_versions",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("skill_id", sa.String(64), sa.ForeignKey("skill_packages.id"), nullable=False),
        sa.Column("version", sa.String(64), nullable=False),
        sa.Column("digest", sa.String(64), nullable=False),
        sa.Column("storage_name", sa.String(128), nullable=False, unique=True),
        sa.Column("file_count", sa.Integer(), nullable=False),
        sa.Column("total_size", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending_review"),
        sa.Column("uploaded_by_user_id", sa.String(64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("reviewed_by_user_id", sa.String(64), sa.ForeignKey("users.id")),
        sa.Column("published_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("revoke_reason", sa.String(512)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.current_timestamp()),
        sa.UniqueConstraint("skill_id", "version"),
    )
    op.create_index("ix_skill_versions_skill_id", "skill_versions", ["skill_id"])


def downgrade():
    op.drop_index("ix_skill_versions_skill_id", table_name="skill_versions")
    op.drop_table("skill_versions")
    op.drop_table("skill_packages")
