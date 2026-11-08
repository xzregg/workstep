"""Allow authorized administrators to copy an existing invitation."""
from alembic import op
import sqlalchemy as sa

revision = '0053_reusable_invitation_links'
down_revision = '0052_user_invitations'
branch_labels = depends_on = None


def upgrade():
    op.add_column('users', sa.Column('invitation_token_ciphertext', sa.Text()))


def downgrade():
    op.drop_column('users', 'invitation_token_ciphertext')
