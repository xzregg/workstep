"""Account lifecycle and scoped administrator assignments.

Revision ID: 0004_accounts
Revises: 0003_operations
"""

from alembic import op
import sqlalchemy as sa

revision = "0004_accounts"
down_revision = "0003_operations"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("password_changed_at", sa.DateTime(timezone=True)))
    op.add_column("users", sa.Column("is_recovery", sa.Integer(), nullable=False, server_default="0"))
    op.create_table(
        "admin_assignments",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.String(64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("role", sa.String(32), nullable=False),
        sa.Column("scope_type", sa.String(32), nullable=False, server_default="platform"),
        sa.Column("scope_id", sa.String(64)),
        sa.Column("include_subdepartments", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("granted_by_user_id", sa.String(64)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.current_timestamp()),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_admin_user_role", "admin_assignments", ["user_id", "role"])


def downgrade():
    op.drop_table("admin_assignments")
    op.drop_column("users", "is_recovery")
    op.drop_column("users", "password_changed_at")
