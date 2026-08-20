"""Chat session models — Codex-style per-project conversations.

A project can hold multiple independent chat sessions; messages live in
their own table (``chat_messages``) instead of the task-bound ``messages``
table. Project-scoped settings (e.g. per-project quick buttons) are stored
in ``project_settings``.
"""

import peewee as pw

from models.base import BaseModel
from models.fields import UTCDateTimeField


class ChatSession(BaseModel):
    """One Codex-style chat conversation scoped to a project."""

    id = pw.TextField(primary_key=True)
    project_id = pw.TextField()
    workflow_id = pw.TextField()
    title = pw.TextField(default="")
    sort_order = pw.IntegerField(default=0)
    engine = pw.TextField()
    model = pw.TextField(null=True)
    fast_model = pw.TextField(null=True)
    provider_id = pw.TextField(null=True)
    engine_session_id = pw.TextField(null=True)
    engine_state_json = pw.TextField(null=True)
    permission_mode = pw.TextField(null=True)
    created_at = UTCDateTimeField()
    updated_at = UTCDateTimeField()

    class Meta:
        table_name = "chat_sessions"
        indexes = (
            (("project_id", "workflow_id", "updated_at"), False),
            (("project_id", "sort_order"), False),
        )


class ChatMessage(BaseModel):
    """One chat message row (user or assistant) inside a chat session."""

    id = pw.TextField(primary_key=True)
    session = pw.ForeignKeyField(ChatSession, backref="messages")
    role = pw.TextField()  # 'user' / 'assistant'
    content = pw.TextField(default="")
    author_id = pw.TextField(null=True)
    author_name = pw.TextField(null=True)
    author_device_id = pw.TextField(null=True)
    author_device_name = pw.TextField(null=True)
    status = pw.TextField(null=True)
    engine = pw.TextField(null=True)
    model = pw.TextField(null=True)
    prompt = pw.TextField(null=True)
    events_json = pw.TextField(null=True)
    usage_json = pw.TextField(null=True)
    created_at = UTCDateTimeField()
    ended_at = UTCDateTimeField(null=True)

    class Meta:
        table_name = "chat_messages"
        indexes = ((("session", "created_at"), False),)


class ProjectSetting(BaseModel):
    """Project-scoped key/value settings (e.g. chat quick buttons)."""

    id = pw.TextField(primary_key=True)
    project_id = pw.TextField()
    key = pw.TextField()
    value_json = pw.TextField(default="")
    updated_at = UTCDateTimeField()

    class Meta:
        table_name = "project_settings"
        indexes = ((("project_id", "key"), True),)
