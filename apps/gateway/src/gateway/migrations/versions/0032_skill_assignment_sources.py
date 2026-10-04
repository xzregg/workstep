"""Allow independent group sources for the same project Skill.

Revision ID: 0032_skill_assignment_sources
Revises: 0031_usage_rollups
"""

from alembic import op
import sqlalchemy as sa

revision = "0032_skill_assignment_sources"
down_revision = "0031_usage_rollups"
branch_labels = None
depends_on = None


def _replace_assignment_table(unique_columns):
    op.create_table(
        "project_skill_assignments_new",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("platform_project_id", sa.String(64), sa.ForeignKey("platform_projects.id"), nullable=False),
        sa.Column("skill_id", sa.String(64), sa.ForeignKey("skill_packages.id"), nullable=False),
        sa.Column("skill_version_id", sa.String(64), sa.ForeignKey("skill_versions.id"), nullable=False),
        sa.Column("source_group_id", sa.String(64), sa.ForeignKey("user_groups.id"), nullable=False),
        sa.Column("assigned_by_user_id", sa.String(64), nullable=False),
        sa.Column("desired_revision", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.current_timestamp()),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint(*unique_columns),
    )
    op.execute(
        "INSERT INTO project_skill_assignments_new "
        "(id,platform_project_id,skill_id,skill_version_id,source_group_id,"
        "assigned_by_user_id,desired_revision,status,created_at,revoked_at) "
        "SELECT id,platform_project_id,skill_id,skill_version_id,source_group_id,"
        "assigned_by_user_id,desired_revision,status,created_at,revoked_at "
        "FROM project_skill_assignments"
    )
    op.drop_index("ix_project_skill_assignments_platform_project_id",
                  table_name="project_skill_assignments")
    op.drop_table("project_skill_assignments")
    op.rename_table("project_skill_assignments_new", "project_skill_assignments")
    op.create_index("ix_project_skill_assignments_platform_project_id",
                    "project_skill_assignments", ["platform_project_id"])


def upgrade():
    _replace_assignment_table(("platform_project_id", "skill_id", "source_group_id"))


def downgrade():
    # Retain one row per Skill, preferring an active group source.
    op.create_table(
        "project_skill_assignments_old",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("platform_project_id", sa.String(64), sa.ForeignKey("platform_projects.id"), nullable=False),
        sa.Column("skill_id", sa.String(64), sa.ForeignKey("skill_packages.id"), nullable=False),
        sa.Column("skill_version_id", sa.String(64), sa.ForeignKey("skill_versions.id"), nullable=False),
        sa.Column("source_group_id", sa.String(64), sa.ForeignKey("user_groups.id"), nullable=False),
        sa.Column("assigned_by_user_id", sa.String(64), nullable=False),
        sa.Column("desired_revision", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.current_timestamp()),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("platform_project_id", "skill_id"),
    )
    op.execute(
        "INSERT INTO project_skill_assignments_old "
        "(id,platform_project_id,skill_id,skill_version_id,source_group_id,"
        "assigned_by_user_id,desired_revision,status,created_at,revoked_at) "
        "SELECT a.id,a.platform_project_id,a.skill_id,a.skill_version_id,a.source_group_id,"
        "a.assigned_by_user_id,a.desired_revision,a.status,a.created_at,a.revoked_at "
        "FROM project_skill_assignments a WHERE a.id = ("
        "SELECT b.id FROM project_skill_assignments b WHERE "
        "b.platform_project_id=a.platform_project_id AND b.skill_id=a.skill_id "
        "ORDER BY CASE WHEN b.revoked_at IS NULL THEN 0 ELSE 1 END, b.id LIMIT 1)"
    )
    op.drop_index("ix_project_skill_assignments_platform_project_id",
                  table_name="project_skill_assignments")
    op.drop_table("project_skill_assignments")
    op.rename_table("project_skill_assignments_old", "project_skill_assignments")
    op.create_index("ix_project_skill_assignments_platform_project_id",
                    "project_skill_assignments", ["platform_project_id"])
