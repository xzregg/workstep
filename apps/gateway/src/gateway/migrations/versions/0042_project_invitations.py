"""Owner invitations with persisted membership and administrator overrides."""
from alembic import op
import sqlalchemy as sa

revision = "0042_project_invitations"
down_revision = "0041_group_admin_roles"
branch_labels = depends_on = None


def upgrade():
    op.add_column("platform_projects", sa.Column("invitations_enabled", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.create_table("project_invitations",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("project_id", sa.String(64), sa.ForeignKey("platform_projects.id"), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("access_level", sa.String(16), nullable=False),
        sa.Column("created_by_user_id", sa.String(64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("expires_at", sa.DateTime(timezone=True)))
    op.create_index("ix_project_invitations_project_id", "project_invitations", ["project_id"])
    op.create_table("project_invitation_acceptances",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("invitation_id", sa.String(64), sa.ForeignKey("project_invitations.id"), nullable=False),
        sa.Column("user_id", sa.String(64), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("invitation_id", "user_id"))
    op.create_index("ix_project_invitation_acceptances_invitation_id", "project_invitation_acceptances", ["invitation_id"])
    with op.batch_alter_table("project_access_grants") as batch:
        batch.add_column(sa.Column("invitation_id", sa.String(64), nullable=True))
        batch.add_column(sa.Column("invitation_blocked", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.create_foreign_key("fk_project_grant_invitation", "project_invitations", ["invitation_id"], ["id"])


def downgrade():
    with op.batch_alter_table("project_access_grants") as batch:
        batch.drop_constraint("fk_project_grant_invitation", type_="foreignkey")
        batch.drop_column("invitation_id")
        batch.drop_column("invitation_blocked")
    op.drop_table("project_invitation_acceptances")
    op.drop_table("project_invitations")
    op.drop_column("platform_projects", "invitations_enabled")
