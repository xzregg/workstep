"""Persisted automatic and manual review attempts."""

import peewee as pw

from models.base import BaseModel
from models.run import StepRun, WorkflowRun
from models.task import Task


class ReviewRun(BaseModel):
    """One review decision for one concrete step execution attempt."""

    id = pw.TextField(primary_key=True)
    workflow_run = pw.ForeignKeyField(WorkflowRun, backref="review_runs")
    step_run = pw.ForeignKeyField(StepRun, backref="review_runs")
    task = pw.ForeignKeyField(Task, backref="review_runs")
    step_key = pw.TextField()
    attempt = pw.IntegerField(default=1)
    mode = pw.TextField()  # auto / manual
    status = pw.TextField(default="pending")
    engine = pw.TextField(null=True)
    model = pw.TextField(null=True)
    prompt_json = pw.TextField(null=True)
    response_text = pw.TextField(null=True)
    report_json = pw.TextField(null=True)
    decision = pw.TextField(null=True)
    decision_comment = pw.TextField(null=True)
    decided_at = pw.IntegerField(null=True)
    started_at = pw.IntegerField(null=True)
    ended_at = pw.IntegerField(null=True)
    error = pw.TextField(null=True)

    class Meta:
        table_name = "review_runs"
        indexes = (
            (("step_run", "attempt"), True),
            (("task", "step_key"), False),
        )
