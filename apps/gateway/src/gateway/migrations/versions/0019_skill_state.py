"""Track per-device project Skill application acknowledgments.

Revision ID: 0019_skill_state
Revises: 0018_skill_assignments
"""

from alembic import op
import sqlalchemy as sa

revision = "0019_skill_state"
down_revision = "0018_skill_assignments"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "device_project_skill_state",
        sa.Column("device_id", sa.String(64), sa.ForeignKey("devices.id"), primary_key=True),
        sa.Column("host_project_id", sa.String(128), primary_key=True),
        sa.Column("platform_project_id", sa.String(64),
                  sa.ForeignKey("platform_projects.id"), nullable=False),
        sa.Column("desired_revision", sa.Integer(), nullable=False),
        sa.Column("applied_revision", sa.Integer()),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("last_error_code", sa.String(64)),
        sa.Column("acknowledged_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.current_timestamp()),
    )


def downgrade():
    op.drop_table("device_project_skill_state")
