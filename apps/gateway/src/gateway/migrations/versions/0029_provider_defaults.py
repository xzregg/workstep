"""Allow one active default provider per user or device.

Revision ID: 0029_provider_defaults
Revises: 0028_group_project_capabilities
"""

from alembic import op
import sqlalchemy as sa

revision = "0029_provider_defaults"
down_revision = "0028_group_project_capabilities"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("provider_assignments", sa.Column(
        "is_default", sa.Integer(), server_default="0", nullable=False,
    ))
    active_default = sa.text("is_default = 1 AND revoked_at IS NULL")
    op.create_index("uq_provider_assignment_default", "provider_assignments",
                    ["subject_type", "subject_id"], unique=True,
                    sqlite_where=active_default, postgresql_where=active_default)


def downgrade():
    op.drop_index("uq_provider_assignment_default", table_name="provider_assignments")
    op.drop_column("provider_assignments", "is_default")
