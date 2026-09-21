"""Project-local messages waiting to be inserted after one active reply."""

import peewee as pw

from models.base import BaseModel
from models.fields import UTCDateTimeField


class PendingMessageInsert(BaseModel):
    """A draft follow-up; it is not part of formal conversation history yet."""

    id = pw.TextField(primary_key=True)
    target_message_id = pw.TextField()
    content = pw.TextField()
    position = pw.IntegerField()
    username = pw.TextField(default="")
    created_at = UTCDateTimeField()
    updated_at = UTCDateTimeField()

    class Meta:
        table_name = "pending_message_inserts"
        indexes = (
            (("target_message_id", "position"), False),
        )
