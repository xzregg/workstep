"""Optional project UI policy; null preserves existing grants."""
from alembic import op
import sqlalchemy as sa

revision = '0045_project_ui_permissions'
down_revision = '0044_persistent_login_sessions'
branch_labels = depends_on = None


def upgrade():
    op.add_column('project_access_grants', sa.Column('ui_permissions_json', sa.Text(), nullable=True))


def downgrade():
    with op.batch_alter_table('project_access_grants') as batch:
        batch.drop_column('ui_permissions_json')
