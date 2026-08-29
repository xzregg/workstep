"""Message model — stores LLM interaction records."""

import peewee as pw
from models.base import BaseModel
from models.fields import UTCDateTimeField
from models.task import Task


class Message(BaseModel):
    """A message record for LLM interactions within a task step."""

    id = pw.TextField(primary_key=True)
    task = pw.ForeignKeyField(Task, backref="messages")
    step_key = pw.TextField()
    context_step_key = pw.TextField(null=True)
    channel = pw.TextField(default="execution")
    sequence = pw.IntegerField(null=True)
    reply_to_message_id = pw.TextField(null=True)
    role = pw.TextField()  # 'user' / 'assistant'
    content = pw.TextField(default="")  # user input / concatenated text_delta
    author_id = pw.TextField(null=True)
    author_name = pw.TextField(null=True)
    author_device_id = pw.TextField(null=True)
    author_device_name = pw.TextField(null=True)
    engine = pw.TextField(null=True)
    model = pw.TextField(null=True)
    run_id = pw.TextField(null=True)
    run_status = pw.TextField(null=True)  # running / succeeded / failed
    events_json = pw.TextField(null=True)  # JSON array of InternalEvents
    event_log_path = pw.TextField(null=True)
    event_summary_json = pw.TextField(null=True)
    event_count = pw.IntegerField(default=0)
    last_event_seq = pw.IntegerField(default=0)
    prompt_json = pw.TextField(null=True)
    usage_json = pw.TextField(null=True)
    position = pw.IntegerField()
    started_at = UTCDateTimeField(null=True)
    ended_at = UTCDateTimeField(null=True)
    created_at = UTCDateTimeField()

    class Meta:
        indexes = (
            (("task", "sequence"), True),
            (("task", "channel", "sequence"), False),
            (("task", "position"), False),
            (("task", "created_at"), False),
        )
