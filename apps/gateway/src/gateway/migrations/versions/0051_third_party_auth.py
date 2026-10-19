"""Request-bound third-party login codes."""
from alembic import op
import sqlalchemy as sa

revision = '0051_third_party_auth'
down_revision = '0050_share_login'
branch_labels = depends_on = None


def upgrade():
    op.create_table('third_party_auth_codes',
        sa.Column('code_hash', sa.String(128), primary_key=True),
        sa.Column('request_id_hash', sa.String(128), nullable=False),
        sa.Column('user_id', sa.String(64), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('callback', sa.String(2048), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('used_at', sa.DateTime(timezone=True)),
    )
    op.create_index('ix_third_party_auth_codes_expires_at', 'third_party_auth_codes', ['expires_at'])


def downgrade():
    op.drop_table('third_party_auth_codes')
