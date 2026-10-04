"""Single-use desktop authorization codes and registered device metadata.

Revision ID: 0007_desktop_auth
Revises: 0006_external_identity
"""

from alembic import op
import sqlalchemy as sa

revision = "0007_desktop_auth"
down_revision = "0006_external_identity"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("devices", sa.Column("public_key_fingerprint", sa.String(64)))
    op.add_column("devices", sa.Column("app_instance_id", sa.String(128)))
    op.add_column("devices", sa.Column("version", sa.String(64)))
    op.create_table(
        "desktop_auth_codes",
        sa.Column("code_hash", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("gateway_id", sa.String(128), nullable=False),
        sa.Column("app_instance_id", sa.String(128), nullable=False),
        sa.Column("state_hash", sa.String(64), nullable=False),
        sa.Column("nonce_hash", sa.String(64), nullable=False),
        sa.Column("pkce_challenge", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.current_timestamp()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True)),
    )


def downgrade():
    op.drop_table("desktop_auth_codes")
    op.drop_column("devices", "version")
    op.drop_column("devices", "app_instance_id")
    op.drop_column("devices", "public_key_fingerprint")
