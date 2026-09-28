"""Store managed provider configuration and assignments.

Revision ID: 0013_providers
Revises: 0012_remote_access
"""

from alembic import op
import sqlalchemy as sa

revision = "0013_providers"
down_revision = "0012_remote_access"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("devices", sa.Column("provider_revision", sa.Integer(),
                                        nullable=False, server_default="0"))
    for name, column in (
        ("config_json", sa.Column("config_json", sa.Text(), nullable=False, server_default="{}")),
        ("secret_ciphertext", sa.Column("secret_ciphertext", sa.Text())),
        ("models_json", sa.Column("models_json", sa.Text(), nullable=False, server_default="[]")),
        ("prices_json", sa.Column("prices_json", sa.Text(), nullable=False, server_default="{}")),
        ("created_by_user_id", sa.Column("created_by_user_id", sa.String(64))),
    ):
        op.add_column("platform_providers", column)
    op.create_table(
        "provider_assignments",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("provider_id", sa.String(64), sa.ForeignKey("platform_providers.id"), nullable=False),
        sa.Column("subject_type", sa.String(16), nullable=False),
        sa.Column("subject_id", sa.String(64), nullable=False),
        sa.Column("assigned_by_user_id", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.current_timestamp()),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("provider_id", "subject_type", "subject_id"),
    )
    op.create_table(
        "device_provider_applications",
        sa.Column("device_id", sa.String(64), sa.ForeignKey("devices.id"), primary_key=True),
        sa.Column("desired_revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("applied_revision", sa.Integer()),
        sa.Column("last_error", sa.String(512)),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.current_timestamp()),
    )


def downgrade():
    op.drop_table("device_provider_applications")
    op.drop_table("provider_assignments")
    for name in ("created_by_user_id", "prices_json", "models_json",
                 "secret_ciphertext", "config_json"):
        op.drop_column("platform_providers", name)
    op.drop_column("devices", "provider_revision")
