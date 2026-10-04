"""Track explicit capability grants and device policy revisions.

Revision ID: 0011_capabilities
Revises: 0010_connection_policy
"""

from alembic import op
import sqlalchemy as sa

revision = "0011_capabilities"
down_revision = "0010_connection_policy"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("devices", sa.Column("policy_revision", sa.Integer(),
                                        nullable=False, server_default="0"))
    op.create_table(
        "capability_assignments",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("capability", sa.String(64), nullable=False),
        sa.Column("scope_type", sa.String(16), nullable=False),
        sa.Column("scope_id", sa.String(64), nullable=False, server_default=""),
        sa.Column("effect", sa.String(16), nullable=False),
        sa.Column("assigned_by_user_id", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.current_timestamp()),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("user_id", "capability", "scope_type", "scope_id"),
    )


def downgrade():
    op.drop_table("capability_assignments")
    op.drop_column("devices", "policy_revision")
