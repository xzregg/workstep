"""TaskShare model — one public share link per task, password-protected."""

import peewee as pw
from models.base import BaseModel
from models.fields import UTCDateTimeField
from models.task import Task


class TaskShare(BaseModel):
    """A public, password-protected, read-only share link for a task.

    Each task has at most one active share (enforced by a unique index on
    `task_id`). The token is the public identifier used in the URL; the
    password_hash is verified server-side to mint short-lived session
    tokens that gate REST and WebSocket access.
    """

    class Meta:
        table_name = "task_shares"

    id = pw.TextField(primary_key=True)
    task = pw.ForeignKeyField(Task, backref="shares", unique=True)
    token = pw.TextField(unique=True, index=True)
    title = pw.TextField(null=True)
    password_hash = pw.TextField(null=True)
    salt = pw.TextField(null=True)
    revoked = pw.IntegerField(default=0)
    created_at = UTCDateTimeField()
    revoked_at = UTCDateTimeField(null=True)
