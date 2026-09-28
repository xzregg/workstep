"""Record Desktop platform for release status projection.

Revision ID: 0033_device_platform
Revises: 0032_skill_assignment_sources
"""

from alembic import op
import sqlalchemy as sa

revision = "0033_device_platform"
down_revision = "0032_skill_assignment_sources"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("os", sa.String(16), nullable=True))
    op.add_column("devices", sa.Column("arch", sa.String(16), nullable=True))


def downgrade() -> None:
    op.drop_column("devices", "arch")
    op.drop_column("devices", "os")
