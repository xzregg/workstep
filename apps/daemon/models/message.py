"""Message model — stores LLM interaction records."""

import peewee as pw
from models.base import BaseModel
from models.task import Task


class Message(BaseModel):
    """A message record for LLM interactions within a task step."""

    id = pw.TextField(primary_key=True)
    task = pw.ForeignKeyField(Task, backref="messages")
    step_key = pw.TextField()
    role = pw.TextField()  # 'user' / 'assistant'
    content = pw.TextField(default="")  # user input / concatenated text_delta
    engine = pw.TextField(null=True)
    model = pw.TextField(null=True)
    run_id = pw.TextField(null=True)
    run_status = pw.TextField(null=True)  # running / succeeded / failed
    events_json = pw.TextField(null=True)  # JSON array of InternalEvents
    prompt_json = pw.TextField(null=True)
    usage_json = pw.TextField(null=True)
    position = pw.IntegerField()
    started_at = pw.IntegerField(null=True)
    ended_at = pw.IntegerField(null=True)
    created_at = pw.IntegerField()
