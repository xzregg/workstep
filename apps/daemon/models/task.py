"""Task and TaskStep models."""

import peewee as pw
from models.base import BaseModel
from models.fields import UTCDateTimeField


class Task(BaseModel):
    """A task (card) in the workflow pipeline."""

    class Meta:
        table_name = "tasks"

    id = pw.TextField(primary_key=True)
    title = pw.TextField()
    description = pw.TextField(null=True)
    cwd = pw.TextField()
    workflow_id = pw.TextField(null=True)  # FK-like: which workflow this task belongs to
    status = pw.TextField(default="ready")  # ready / running / paused / stopped
    engine = pw.TextField(null=True)  # claude / codex / hermes
    model = pw.TextField(null=True)
    coordinator_engine = pw.TextField(null=True)
    coordinator_model = pw.TextField(null=True)
    coordinator_fast_model = pw.TextField(null=True)
    active_workflow_run_id = pw.TextField(null=True)
    state_version = pw.IntegerField(default=0)
    next_message_sequence = pw.IntegerField(default=1)
    pipeline_version = pw.TextField(null=True)
    review_overrides_json = pw.TextField(null=True)
    created_at = UTCDateTimeField()
    updated_at = UTCDateTimeField()


class TaskStep(BaseModel):
    """Per-stage progress tracking for a task."""

    task = pw.ForeignKeyField(Task, backref="steps")
    step_key = pw.TextField()  # 'req' / 'ui' / 'frontend' / etc.
    status = pw.TextField(default="pending")  # pending / running / passed / failed / skipped
    engine = pw.TextField(null=True)
    started_at = UTCDateTimeField(null=True)
    ended_at = UTCDateTimeField(null=True)
    error = pw.TextField(null=True)

    class Meta:
        primary_key = pw.CompositeKey("task", "step_key")
