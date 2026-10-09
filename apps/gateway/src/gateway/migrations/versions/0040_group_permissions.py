"""Allow managed capabilities to be assigned to users or groups at every scope."""
from alembic import op
import sqlalchemy as sa

revision = "0040_group_permissions"
down_revision = "0039_device_owner"
branch_labels = depends_on = None


def upgrade():
    with op.batch_alter_table("capability_assignments") as batch:
        batch.alter_column("user_id", existing_type=sa.String(64), nullable=True)
        batch.add_column(sa.Column("group_id", sa.String(64), nullable=True))
        batch.create_foreign_key("fk_capability_group", "user_groups", ["group_id"], ["id"])
        batch.create_unique_constraint("uq_group_capability_scope", ["group_id", "capability", "scope_type", "scope_id"])
        batch.create_index("ix_capability_assignments_group_id", ["group_id"])


def downgrade():
    op.execute("DELETE FROM capability_assignments WHERE group_id IS NOT NULL")
    with op.batch_alter_table("capability_assignments") as batch:
        batch.drop_index("ix_capability_assignments_group_id")
        batch.drop_constraint("uq_group_capability_scope", type_="unique")
        batch.drop_constraint("fk_capability_group", type_="foreignkey")
        batch.drop_column("group_id")
        batch.alter_column("user_id", existing_type=sa.String(64), nullable=False)
