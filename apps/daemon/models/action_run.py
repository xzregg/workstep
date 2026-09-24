"""One user-triggered shortcut script execution."""

import peewee as pw

from models.base import BaseModel
from models.fields import UTCDateTimeField


class ActionRun(BaseModel):
    id = pw.TextField(primary_key=True)
    project_id = pw.TextField()
    task_id = pw.TextField(null=True)
    session_id = pw.TextField(null=True)
    workflow_id = pw.TextField(null=True)
    step_key = pw.TextField(null=True)
    action_id = pw.TextField()
    button_id = pw.TextField()
    source = pw.TextField()
    title = pw.TextField()
    script_path = pw.TextField()
    cwd = pw.TextField()
    status = pw.TextField(default="preparing")
    active_key = pw.TextField(null=True, unique=True)
    output = pw.TextField(default="")
    log_path = pw.TextField(null=True)
    exit_code = pw.IntegerField(null=True)
    user_message_id = pw.TextField()
    reply_message_id = pw.TextField()
    started_at = UTCDateTimeField()
    ended_at = UTCDateTimeField(null=True)

    class Meta:
        table_name = "action_runs"
        indexes = ((('task_id', 'started_at'), False),)
