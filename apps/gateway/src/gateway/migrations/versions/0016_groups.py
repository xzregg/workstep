"""Add local groups and Skills-only project relationships.

Revision ID: 0016_groups
Revises: 0015_usage_ledger
"""

from alembic import op
import sqlalchemy as sa

revision = "0016_groups"
down_revision = "0015_usage_ledger"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "user_groups",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("slug", sa.String(128), nullable=False, unique=True),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("source_type", sa.String(32), nullable=False, server_default="manual"),
        sa.Column("external_department_id", sa.String(64),
                  sa.ForeignKey("directory_departments.id")),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("created_by_user_id", sa.String(64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.current_timestamp()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.current_timestamp()),
    )
    op.create_table(
        "group_memberships",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("group_id", sa.String(64), sa.ForeignKey("user_groups.id"), nullable=False),
        sa.Column("user_id", sa.String(64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("role", sa.String(16), nullable=False, server_default="member"),
        sa.Column("source", sa.String(32), nullable=False, server_default="manual"),
        sa.Column("assigned_by_user_id", sa.String(64)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.current_timestamp()),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("group_id", "user_id"),
    )
    op.create_index("ix_group_memberships_group_id", "group_memberships", ["group_id"])
    op.create_index("ix_group_memberships_user_id", "group_memberships", ["user_id"])
    op.create_table(
        "group_projects",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("group_id", sa.String(64), sa.ForeignKey("user_groups.id"), nullable=False),
        sa.Column("platform_project_id", sa.String(64), sa.ForeignKey("platform_projects.id"),
                  nullable=False),
        sa.Column("purpose", sa.String(32), nullable=False, server_default="skill_management"),
        sa.Column("assigned_by_user_id", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.current_timestamp()),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("group_id", "platform_project_id"),
    )
    op.create_index("ix_group_projects_group_id", "group_projects", ["group_id"])


def downgrade():
    op.drop_index("ix_group_projects_group_id", table_name="group_projects")
    op.drop_table("group_projects")
    op.drop_index("ix_group_memberships_user_id", table_name="group_memberships")
    op.drop_index("ix_group_memberships_group_id", table_name="group_memberships")
    op.drop_table("group_memberships")
    op.drop_table("user_groups")
