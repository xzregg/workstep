"""Keep platform login sessions until explicitly revoked."""
from alembic import op
import sqlalchemy as sa

revision = '0044_persistent_login_sessions'
down_revision = '0043_hook_device_identity'
branch_labels = depends_on = None


def upgrade():
    with op.batch_alter_table('auth_sessions') as batch:
        batch.alter_column('expires_at', existing_type=sa.DateTime(timezone=True), nullable=True)
    # Preserve revoked/expired sessions and short-lived remote workspace grants.
    op.execute(sa.text("UPDATE auth_sessions SET expires_at = NULL WHERE revoked_at IS NULL AND device_id IS NULL AND expires_at > CURRENT_TIMESTAMP"))


def downgrade():
    op.execute(sa.text("UPDATE auth_sessions SET expires_at = CURRENT_TIMESTAMP WHERE expires_at IS NULL"))
    with op.batch_alter_table('auth_sessions') as batch:
        batch.alter_column('expires_at', existing_type=sa.DateTime(timezone=True), nullable=False)
