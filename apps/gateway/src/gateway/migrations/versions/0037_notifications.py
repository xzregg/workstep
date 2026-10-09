"""Device completion summaries and per-user read cursor."""
from alembic import op
import sqlalchemy as sa
revision = '0037_notifications'
down_revision = '0036_group_devices'
branch_labels = depends_on = None

def upgrade():
    op.create_table('completion_notifications',
        sa.Column('sequence',sa.Integer,primary_key=True,autoincrement=True),
        sa.Column('event_key',sa.String(64),nullable=False,unique=True),
        sa.Column('device_id',sa.String(64),sa.ForeignKey('devices.id'),nullable=False),
        sa.Column('host_project_id',sa.String(128),nullable=False),
        sa.Column('project_name',sa.String(256),nullable=False),
        sa.Column('payload_json',sa.Text,nullable=False),
        sa.Column('occurred_at',sa.Float,nullable=False),
        sqlite_autoincrement=True)
    for column in ('device_id','host_project_id','occurred_at'):
        op.create_index('ix_completion_notifications_'+column,'completion_notifications',[column])
    op.create_table('notification_read_cursors',
        sa.Column('user_id',sa.String(64),sa.ForeignKey('users.id'),primary_key=True),
        sa.Column('through',sa.Integer,nullable=False))

def downgrade():
    op.drop_table('notification_read_cursors')
    op.drop_table('completion_notifications')
