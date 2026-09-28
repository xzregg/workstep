"""Enterprise sources, stable subjects, scan attempts and read-only directory.

Revision ID: 0006_external_identity
Revises: 0005_step_up
"""

from alembic import op
import sqlalchemy as sa

revision = "0006_external_identity"
down_revision = "0005_step_up"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "identity_sources",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("tenant_id", sa.String(128), nullable=False),
        sa.Column("client_id", sa.String(256), nullable=False),
        sa.Column("secret_env", sa.String(128), nullable=False),
        sa.Column("agent_id", sa.String(128)),
        sa.Column("enabled", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.current_timestamp()),
        sa.UniqueConstraint("provider", "tenant_id"),
    )
    op.create_table(
        "external_identities",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("source_id", sa.String(64), sa.ForeignKey("identity_sources.id"), nullable=False),
        sa.Column("subject", sa.String(256), nullable=False),
        sa.Column("user_id", sa.String(64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("display_name", sa.String(256), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.current_timestamp()),
        sa.Column("last_login_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("source_id", "subject"),
        sa.UniqueConstraint("source_id", "user_id"),
    )
    op.create_table(
        "external_login_attempts",
        sa.Column("state_hash", sa.String(128), primary_key=True),
        sa.Column("source_id", sa.String(64), sa.ForeignKey("identity_sources.id"), nullable=False),
        sa.Column("nonce", sa.String(128), nullable=False),
        sa.Column("binding_user_id", sa.String(64), sa.ForeignKey("users.id")),
        sa.Column("binding_session_id", sa.String(64), sa.ForeignKey("auth_sessions.id")),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True)),
    )
    op.create_table(
        "directory_departments",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("source_id", sa.String(64), sa.ForeignKey("identity_sources.id"), nullable=False),
        sa.Column("external_id", sa.String(256), nullable=False),
        sa.Column("parent_external_id", sa.String(256)),
        sa.Column("display_name", sa.String(256), nullable=False),
        sa.Column("active", sa.Integer(), nullable=False, server_default="1"),
        sa.UniqueConstraint("source_id", "external_id"),
    )
    op.create_table(
        "directory_people",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("source_id", sa.String(64), sa.ForeignKey("identity_sources.id"), nullable=False),
        sa.Column("subject", sa.String(256), nullable=False),
        sa.Column("display_name", sa.String(256), nullable=False),
        sa.Column("user_id", sa.String(64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("active", sa.Integer(), nullable=False, server_default="1"),
        sa.UniqueConstraint("source_id", "subject"),
    )
    op.create_table(
        "directory_memberships",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("person_id", sa.String(64), sa.ForeignKey("directory_people.id"), nullable=False),
        sa.Column("department_id", sa.String(64), sa.ForeignKey("directory_departments.id"), nullable=False),
        sa.UniqueConstraint("person_id", "department_id"),
    )
    op.create_table(
        "directory_event_receipts",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("source_id", sa.String(64), sa.ForeignKey("identity_sources.id"), nullable=False),
        sa.Column("event_id", sa.String(256), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.current_timestamp()),
        sa.UniqueConstraint("source_id", "event_id"),
    )


def downgrade():
    for table in ("directory_event_receipts", "directory_memberships", "directory_people",
                  "directory_departments", "external_login_attempts", "external_identities", "identity_sources"):
        op.drop_table(table)
