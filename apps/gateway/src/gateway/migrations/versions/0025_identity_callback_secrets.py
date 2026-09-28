"""Store only environment references for enterprise callback credentials.

Revision ID: 0025_identity_callback_secrets
Revises: 0024_audit_actor_device
"""

from alembic import op
import sqlalchemy as sa

revision = "0025_identity_callback_secrets"
down_revision = "0024_audit_actor_device"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("identity_sources", sa.Column("callback_token_env", sa.String(128)))
    op.add_column("identity_sources", sa.Column("callback_aes_key_env", sa.String(128)))


def downgrade():
    op.drop_column("identity_sources", "callback_aes_key_env")
    op.drop_column("identity_sources", "callback_token_env")
