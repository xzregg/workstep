"""One-use invitations for administrator-created accounts."""
from alembic import op
import sqlalchemy as sa

revision = '0052_user_invitations'
down_revision = '0051_third_party_auth'
branch_labels = depends_on = None


def upgrade():
    op.add_column('users', sa.Column('invitation_token_hash', sa.String(64)))
    op.add_column('users', sa.Column('invitation_expires_at', sa.DateTime(timezone=True)))
    op.create_index('ix_users_invitation_token_hash', 'users', ['invitation_token_hash'], unique=True)


def downgrade():
    op.drop_index('ix_users_invitation_token_hash', table_name='users')
    op.drop_column('users', 'invitation_expires_at')
    op.drop_column('users', 'invitation_token_hash')
