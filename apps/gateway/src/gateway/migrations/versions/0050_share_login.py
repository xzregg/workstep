"""Allow task shares to require a live Gateway login instead of a password."""
from alembic import op
import sqlalchemy as sa

revision = '0050_share_login'
down_revision = '0049_share_credentials'
branch_labels = depends_on = None


def upgrade():
    op.add_column('platform_shares', sa.Column('require_login', sa.Boolean(), nullable=False, server_default=sa.false()))

    op.execute("UPDATE platform_shares SET require_login = true, password_hash = NULL WHERE mode = 'interactive'")

def downgrade():
    op.drop_column('platform_shares', 'require_login')
