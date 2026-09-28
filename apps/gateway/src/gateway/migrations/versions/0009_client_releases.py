"""Add immutable managed client release registry.

Revision ID: 0009_client_releases
Revises: 0008_scan_redirect
"""

from alembic import op
import sqlalchemy as sa

revision = "0009_client_releases"
down_revision = "0008_scan_redirect"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "client_releases",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("gateway_id", sa.String(128), nullable=False),
        sa.Column("os", sa.String(16), nullable=False),
        sa.Column("arch", sa.String(16), nullable=False),
        sa.Column("version", sa.String(64), nullable=False),
        sa.Column("filename", sa.String(256), nullable=False),
        sa.Column("storage_name", sa.String(256), nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("signature", sa.Text(), nullable=False),
        sa.Column("gateway_public_key_fingerprint", sa.String(64), nullable=False),
        sa.Column("minimum_protocol_version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="published"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.current_timestamp(), nullable=False),
        sa.UniqueConstraint("gateway_id", "os", "arch", "version"),
    )


def downgrade():
    op.drop_table("client_releases")
