"""Append-only project operation audit and eventual Gateway delivery state."""

import peewee as pw

from models.base import BaseModel
from models.fields import UTCDateTimeField, utc_now


class ProjectAuditEvent(BaseModel):
    id = pw.TextField(primary_key=True)
    project_id = pw.TextField()
    task_id = pw.TextField(null=True)
    action = pw.TextField()
    result = pw.TextField()
    mode = pw.TextField()
    actor_id = pw.TextField(null=True)
    actor_username = pw.TextField(null=True)
    actor_name = pw.TextField(null=True)
    actor_type = pw.TextField()
    device_id = pw.TextField(null=True)
    device_name = pw.TextField(null=True)
    initiated_by_user_id = pw.TextField(null=True)
    initiated_by_username = pw.TextField(null=True)
    metadata_json = pw.TextField(default="{}")
    created_at = UTCDateTimeField(default=utc_now)
    upload_status = pw.TextField(default="pending")
    upload_error = pw.TextField(null=True)
    uploaded_at = UTCDateTimeField(null=True)

    class Meta:
        table_name = "project_audit_events"
        indexes = (
            (("project_id", "created_at"), False),
            (("task_id", "created_at"), False),
            (("upload_status", "created_at"), False),
        )
