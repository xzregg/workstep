"""Administrator roles can be inherited through current group membership."""
from alembic import op
import sqlalchemy as sa

revision = "0041_group_admin_roles"
down_revision = "0040_group_permissions"
branch_labels = depends_on = None


def upgrade():
    with op.batch_alter_table("admin_assignments") as batch:
        batch.alter_column("user_id", existing_type=sa.String(64), nullable=True)
        batch.add_column(sa.Column("group_id", sa.String(64), nullable=True))
        batch.create_foreign_key("fk_admin_group", "user_groups", ["group_id"], ["id"])
        batch.create_index("ix_admin_assignments_group_id", ["group_id"])


def downgrade():
    op.execute("DELETE FROM admin_assignments WHERE group_id IS NOT NULL")
    with op.batch_alter_table("admin_assignments") as batch:
        batch.drop_index("ix_admin_assignments_group_id")
        batch.drop_constraint("fk_admin_group", type_="foreignkey")
        batch.drop_column("group_id")
        batch.alter_column("user_id", existing_type=sa.String(64), nullable=False)
