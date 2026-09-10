"""Project-scoped channel configuration and chat mappings."""

import peewee as pw

from models.base import BaseModel
from models.fields import UTCDateTimeField


class Channel(BaseModel):
    id = pw.TextField(primary_key=True)
    project_id = pw.TextField()
    channel_type = pw.TextField()
    enabled = pw.BooleanField(default=False)
    assistant_id = pw.TextField(default="channel_chat")
    model = pw.TextField(default="")
    config_json = pw.TextField(default="{}")
    status = pw.TextField(default="not_logged_in")
    account_id = pw.TextField(null=True)
    error_message = pw.TextField(null=True)
    updated_at = UTCDateTimeField()

    class Meta:
        table_name = "channels"
        indexes = ((('project_id', 'channel_type'), True),)


class ChannelChatMapping(BaseModel):
    id = pw.TextField(primary_key=True)
    project_id = pw.TextField()
    channel_id = pw.TextField()
    chat_id = pw.TextField()
    session_id = pw.TextField()
    created_at = UTCDateTimeField()
    updated_at = UTCDateTimeField()

    class Meta:
        table_name = "channel_chat_mappings"
        indexes = ((('project_id', 'channel_id', 'chat_id'), True),)
