"""Persisted AI flow-design conversation state (per project + workflow)."""

import peewee as pw

from models.base import BaseModel
from models.fields import UTCDateTimeField


class WorkflowGenSession(BaseModel):
    """One stable AI flow-design conversation for a project workflow.

    Keyed by ``(project_id, workflow_id)`` so editing the same workflow
    always resumes the same conversation; create-mode sessions (no workflow)
    stay memory-only and intentionally start fresh each time.
    """

    id = pw.TextField(primary_key=True)  # f"{project_id}:{workflow_id}"
    project_id = pw.TextField()
    workflow_id = pw.TextField()
    engine = pw.TextField()
    model = pw.TextField(null=True)
    fast_model = pw.TextField(null=True)
    engine_session_id = pw.TextField(null=True)
    engine_state_json = pw.TextField(null=True)
    messages_json = pw.TextField(null=True)
    cwd = pw.TextField(null=True)
    created_at = UTCDateTimeField()
    updated_at = UTCDateTimeField()

    class Meta:
        table_name = "gen_sessions"
        indexes = ((("project_id", "workflow_id"), True),)
