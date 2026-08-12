"""Project-local scheduled task definitions and execution logs."""

import peewee as pw

from models.base import BaseModel
from models.fields import UTCDateTimeField


class Schedule(BaseModel):
    id = pw.TextField(primary_key=True)
    name = pw.TextField()
    workflow_id = pw.TextField()
    task_template_json = pw.TextField()
    rule_json = pw.TextField()
    cron_expression = pw.TextField(null=True)
    timezone = pw.TextField()
    execution_mode = pw.TextField(default="workflow")
    overlap_policy = pw.TextField(default="skip")
    status = pw.TextField(default="active")
    invalid_reason = pw.TextField(null=True)
    next_run_at = UTCDateTimeField(null=True)
    last_run_at = UTCDateTimeField(null=True)
    created_at = UTCDateTimeField()
    updated_at = UTCDateTimeField()

    class Meta:
        table_name = "schedules"


class ScheduleRun(BaseModel):
    id = pw.TextField(primary_key=True)
    schedule = pw.ForeignKeyField(
        Schedule,
        backref="runs",
        column_name="schedule_id",
        on_delete="CASCADE",
    )
    scheduled_for = UTCDateTimeField()
    status = pw.TextField(default="queued")
    reason = pw.TextField(null=True)
    task_id = pw.TextField(null=True)
    workflow_run_id = pw.TextField(null=True)
    started_at = UTCDateTimeField(null=True)
    ended_at = UTCDateTimeField(null=True)
    created_at = UTCDateTimeField()

    class Meta:
        table_name = "schedule_runs"
        indexes = ((('schedule', 'scheduled_for'), True),)
