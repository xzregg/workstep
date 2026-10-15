"""Preserve owner-only share credentials for later copying."""
from alembic import op
import sqlalchemy as sa
revision = "0049_share_credentials"
down_revision = "0048_login_audit_method"
branch_labels = depends_on = None


def upgrade():
    op.add_column("platform_shares", sa.Column("credentials_ciphertext", sa.Text(), nullable=True))


def downgrade():
    op.drop_column("platform_shares", "credentials_ciphertext")
