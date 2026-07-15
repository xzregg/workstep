"""Task and TaskStep models."""

import peewee as pw
from models.base import BaseModel


class Task(BaseModel):
    """A task (card) in the workflow pipeline."""

    id = pw.TextField(primary_key=True)
    title = pw.TextField()
    description = pw.TextField(null=True)
    cwd = pw.TextField()
    status = pw.TextField(default="ready")  # ready / running / paused / stopped
    engine = pw.TextField(null=True)  # claude / codex / hermes
    model = pw.TextField(null=True)
    pipeline_version = pw.TextField(null=True)
    created_at = pw.IntegerField()
    updated_at = pw.IntegerField()


class TaskStep(BaseModel):
    """Per-stage progress tracking for a task."""

    task = pw.ForeignKeyField(Task, backref="steps")
    step_key = pw.TextField()  # 'req' / 'ui' / 'frontend' / etc.
    status = pw.TextField(default="pending")  # pending / running / passed / failed / skipped
    engine = pw.TextField(null=True)
    started_at = pw.IntegerField(null=True)
    ended_at = pw.IntegerField(null=True)
    error = pw.TextField(null=True)

    class Meta:
        primary_key = pw.CompositeKey("task", "step_key")
