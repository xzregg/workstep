"""Authorize reviewed Skills for groups and linked projects.

Revision ID: 0018_skill_assignments
Revises: 0017_skill_catalog
"""

from alembic import op
import sqlalchemy as sa

revision = "0018_skill_assignments"
down_revision = "0017_skill_catalog"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("platform_projects", sa.Column(
        "skill_revision", sa.Integer(), nullable=False, server_default="0",
    ))
    op.create_table(
        "group_skill_catalog",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("group_id", sa.String(64), sa.ForeignKey("user_groups.id"), nullable=False),
        sa.Column("skill_id", sa.String(64), sa.ForeignKey("skill_packages.id"), nullable=False),
        sa.Column("skill_version_id", sa.String(64), sa.ForeignKey("skill_versions.id"),
                  nullable=False),
        sa.Column("granted_by_user_id", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.current_timestamp()),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("group_id", "skill_id"),
    )
    op.create_index("ix_group_skill_catalog_group_id", "group_skill_catalog", ["group_id"])
    op.create_table(
        "project_skill_assignments",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("platform_project_id", sa.String(64),
                  sa.ForeignKey("platform_projects.id"), nullable=False),
        sa.Column("skill_id", sa.String(64), sa.ForeignKey("skill_packages.id"),
                  nullable=False),
        sa.Column("skill_version_id", sa.String(64), sa.ForeignKey("skill_versions.id"),
                  nullable=False),
        sa.Column("source_group_id", sa.String(64), sa.ForeignKey("user_groups.id"),
                  nullable=False),
        sa.Column("assigned_by_user_id", sa.String(64), nullable=False),
        sa.Column("desired_revision", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.current_timestamp()),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("platform_project_id", "skill_id"),
    )
    op.create_index("ix_project_skill_assignments_platform_project_id",
                    "project_skill_assignments", ["platform_project_id"])


def downgrade():
    op.drop_index("ix_project_skill_assignments_platform_project_id",
                  table_name="project_skill_assignments")
    op.drop_table("project_skill_assignments")
    op.drop_index("ix_group_skill_catalog_group_id", table_name="group_skill_catalog")
    op.drop_table("group_skill_catalog")
    op.drop_column("platform_projects", "skill_revision")
