"""Track trusted scan authentication on individual sessions."""
from alembic import op
import sqlalchemy as sa
revision = '0038_scan_sessions'
down_revision = '0037_notifications'
branch_labels = depends_on = None

def upgrade():
    op.add_column('auth_sessions', sa.Column('authentication_method', sa.String(16), nullable=False, server_default='password'))
    # Existing passwordless external sessions could only be created by scan login.
    op.execute("UPDATE auth_sessions SET authentication_method = 'scan' WHERE device_id IS NULL AND user_id IN (SELECT users.id FROM users WHERE password_hash IS NULL AND EXISTS (SELECT 1 FROM external_identities WHERE external_identities.user_id = users.id))")

def downgrade():
    op.drop_column('auth_sessions', 'authentication_method')
