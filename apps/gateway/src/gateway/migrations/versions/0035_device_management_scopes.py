"""Explicit device departments and groups for scoped management."""
from alembic import op
import sqlalchemy as sa
revision = "0035_device_management_scopes"
down_revision = "0034_platform_shares"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("devices") as batch:
        batch.add_column(sa.Column("department_id", sa.String(64), nullable=True))
        batch.create_foreign_key("fk_devices_department", "directory_departments", ["department_id"], ["id"])
        batch.create_index("ix_devices_department_id", ["department_id"])
    op.create_table("device_groups",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(256), nullable=False, unique=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.current_timestamp()))
    op.create_table("device_group_memberships",
        sa.Column("group_id", sa.String(64), sa.ForeignKey("device_groups.id"), primary_key=True),
        sa.Column("device_id", sa.String(64), sa.ForeignKey("devices.id"), primary_key=True))


def downgrade():
    op.drop_table("device_group_memberships")
    op.drop_table("device_groups")
    with op.batch_alter_table("devices") as batch:
        batch.drop_index("ix_devices_department_id")
        batch.drop_constraint("fk_devices_department", type_="foreignkey")
        batch.drop_column("department_id")
