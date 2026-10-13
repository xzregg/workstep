"""Represent system-created groups without inventing a user identity."""
from alembic import op
import sqlalchemy as sa

revision='0047_system_group_creator'
down_revision='0046_manual_group_parent'
branch_labels=depends_on=None


def upgrade():
    with op.batch_alter_table('user_groups') as batch:
        batch.alter_column('created_by_user_id',existing_type=sa.String(64),nullable=True)
    op.execute(sa.text("UPDATE user_groups SET created_by_user_id=NULL WHERE created_by_user_id='system:directory-sync' AND NOT EXISTS (SELECT 1 FROM users WHERE users.id=user_groups.created_by_user_id)"))


def downgrade():
    if op.get_bind().execute(sa.text('SELECT COUNT(*) FROM user_groups WHERE created_by_user_id IS NULL')).scalar():
        raise RuntimeError('Assign a real creator to system groups before downgrading this schema')
    with op.batch_alter_table('user_groups') as batch:
        batch.alter_column('created_by_user_id',existing_type=sa.String(64),nullable=False)
