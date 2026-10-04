"""Add dynamic project task creation permissions for user groups.

Revision ID: 0028_group_project_capabilities
Revises: 0027_directory_sync_state
"""

from alembic import op
import sqlalchemy as sa

revision = "0028_group_project_capabilities"
down_revision = "0027_directory_sync_state"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "group_capability_assignments",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("group_id", sa.String(64), sa.ForeignKey("user_groups.id"), nullable=False),
        sa.Column("project_id", sa.String(64), sa.ForeignKey("platform_projects.id"), nullable=False),
        sa.Column("capability", sa.String(64), nullable=False),
        sa.Column("effect", sa.String(16), nullable=False),
        sa.Column("assigned_by_user_id", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.current_timestamp(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("group_id", "project_id", "capability"),
    )
    op.create_index("ix_group_capability_assignments_group_id", "group_capability_assignments", ["group_id"])
    op.create_index("ix_group_capability_assignments_project_id", "group_capability_assignments", ["project_id"])


def downgrade():
    op.drop_index("ix_group_capability_assignments_project_id", table_name="group_capability_assignments")
    op.drop_index("ix_group_capability_assignments_group_id", table_name="group_capability_assignments")
    op.drop_table("group_capability_assignments")
