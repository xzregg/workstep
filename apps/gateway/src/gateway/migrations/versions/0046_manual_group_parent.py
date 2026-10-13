"""Persist parent relationships for manually created user groups."""
from alembic import op
import sqlalchemy as sa

revision = '0046_manual_group_parent'
down_revision = '0045_project_ui_permissions'
branch_labels = depends_on = None


def upgrade():
    with op.batch_alter_table('user_groups') as batch:
        batch.add_column(sa.Column('parent_group_id', sa.String(64), nullable=True))
        batch.create_foreign_key('fk_user_groups_parent_group_id', 'user_groups', ['parent_group_id'], ['id'], ondelete='SET NULL')
        batch.create_index('ix_user_groups_parent_group_id', ['parent_group_id'])


def downgrade():
    with op.batch_alter_table('user_groups') as batch:
        batch.drop_index('ix_user_groups_parent_group_id')
        batch.drop_constraint('fk_user_groups_parent_group_id', type_='foreignkey')
        batch.drop_column('parent_group_id')
