"""Stable host identity for device-only webhook forwarding."""
from alembic import op
import sqlalchemy as sa

revision = '0043_hook_device_identity'
down_revision = '0042_project_invitations'
branch_labels = depends_on = None


def upgrade():
    with op.batch_alter_table('devices') as batch:
        batch.add_column(sa.Column('hook_device_id', sa.String(128), nullable=True))
        batch.create_unique_constraint('uq_devices_hook_device_id', ['hook_device_id'])


def downgrade():
    with op.batch_alter_table('devices') as batch:
        batch.drop_constraint('uq_devices_hook_device_id', type_='unique')
        batch.drop_column('hook_device_id')
