"""Persist device ownership independently of login sessions."""
from alembic import op
import sqlalchemy as sa
revision = '0039_device_owner'
down_revision = '0038_scan_sessions'
branch_labels = depends_on = None

def upgrade():
    with op.batch_alter_table('devices') as batch:
        batch.add_column(sa.Column('owner_user_id', sa.String(64), nullable=True))
        batch.create_foreign_key('fk_devices_owner_user_id', 'users', ['owner_user_id'], ['id'])
    op.create_index('ix_devices_owner_user_id', 'devices', ['owner_user_id'])
    # Used PKCE codes provide registration identity; ordinary grants do not.
    op.execute("""UPDATE devices SET owner_user_id = (
        SELECT user_id FROM desktop_auth_codes
        WHERE desktop_auth_codes.app_instance_id = devices.app_instance_id
          AND used_at IS NOT NULL ORDER BY used_at, created_at, code_hash LIMIT 1
    ) WHERE owner_user_id IS NULL""")

def downgrade():
    op.drop_index('ix_devices_owner_user_id', table_name='devices')
    with op.batch_alter_table('devices') as batch:
        batch.drop_constraint('fk_devices_owner_user_id', type_='foreignkey')
        batch.drop_column('owner_user_id')
