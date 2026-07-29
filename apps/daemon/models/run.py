"""Persisted workflow and step execution attempts."""

import peewee as pw

from models.base import BaseModel
from models.task import Task


class WorkflowRun(BaseModel):
    """One execution of a task against an immutable workflow snapshot."""

    id = pw.TextField(primary_key=True)
    task = pw.ForeignKeyField(Task, backref="workflow_runs")
    status = pw.TextField(default="running")
    workflow_schema_version = pw.IntegerField()
    workflow_snapshot_json = pw.TextField()
    started_at = pw.IntegerField(null=True)
    ended_at = pw.IntegerField(null=True)

    class Meta:
        table_name = "workflow_runs"


class StepRun(BaseModel):
    """One execution attempt for a step within a workflow run."""

    id = pw.TextField(primary_key=True)
    run = pw.ForeignKeyField(WorkflowRun, backref="step_runs")
    step_key = pw.TextField()
    attempt = pw.IntegerField()
    status = pw.TextField(default="running")
    engine = pw.TextField(null=True)
    model = pw.TextField(null=True)
    error = pw.TextField(null=True)
    started_at = pw.IntegerField(null=True)
    ended_at = pw.IntegerField(null=True)

    class Meta:
        table_name = "step_runs"
        indexes = (
            (("run", "step_key", "attempt"), True),
        )
