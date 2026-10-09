"""Whole WorkStep instance grants to user groups."""
from alembic import op
import sqlalchemy as sa
revision = '0036_group_devices'
down_revision = '0035_device_management_scopes'
branch_labels = None
depends_on = None

def upgrade():
    op.create_table('group_devices',
        sa.Column('id', sa.String(64), primary_key=True),
        sa.Column('group_id', sa.String(64), sa.ForeignKey('user_groups.id'), nullable=False),
        sa.Column('device_id', sa.String(64), sa.ForeignKey('devices.id'), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.current_timestamp()),
        sa.Column('revoked_at', sa.DateTime(timezone=True)),
        sa.UniqueConstraint('group_id', 'device_id'))
    op.create_index('ix_group_devices_group_id','group_devices',['group_id'])
    op.create_index('ix_group_devices_device_id','group_devices',['device_id'])

def downgrade():
    op.drop_table('group_devices')
