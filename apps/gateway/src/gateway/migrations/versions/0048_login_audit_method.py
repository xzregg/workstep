"""Preserve the verified login provider through single-use desktop authorization."""
from alembic import op
import sqlalchemy as sa
revision = "0048_login_audit_method"
down_revision = "0047_system_group_creator"
branch_labels = depends_on = None


def upgrade():
    op.add_column("auth_sessions", sa.Column("authentication_provider", sa.String(16), nullable=True))
    op.add_column("desktop_auth_codes", sa.Column("login_method", sa.String(16), nullable=False, server_default="unknown"))


def downgrade():
    op.drop_column("desktop_auth_codes", "login_method")
    op.drop_column("auth_sessions", "authentication_provider")
