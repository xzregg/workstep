"""Persisted workflow and step execution attempts."""

import peewee as pw

from models.base import BaseModel
from models.fields import UTCDateTimeField
from models.task import Task


class WorkflowRun(BaseModel):
    """One execution of a task.

    ``workflow_snapshot_json`` is a legacy compatibility column.  Existing
    project databases define it as ``NOT NULL``, so new rows keep a tiny empty
    object there until those databases can be rebuilt without the column.
    Runtime behaviour must not read workflow definitions from it.
    """

    id = pw.TextField(primary_key=True)
    task = pw.ForeignKeyField(Task, backref="workflow_runs")
    status = pw.TextField(default="running")
    workflow_schema_version = pw.IntegerField()
    workflow_snapshot_json = pw.TextField(default="{}")
    parent_run_id = pw.TextField(null=True)
    restart_from_step_key = pw.TextField(null=True)
    recovered_at = UTCDateTimeField(null=True)
    recovered_count = pw.IntegerField(default=0)
    # 执行该 run 的 daemon 实例身份与续约心跳：一个 run 同时只能被一个实例执行，
    # 启动恢复只接管租约已失效（或来自无租约旧库）的 run。
    owner_id = pw.TextField(null=True)
    heartbeat_at = UTCDateTimeField(null=True)
    routing_state_json = pw.TextField(null=True)
    started_at = UTCDateTimeField(null=True)
    ended_at = UTCDateTimeField(null=True)

    class Meta:
        table_name = "workflow_runs"
        indexes = ((("status",), False),)


class StepRun(BaseModel):
    """One execution attempt for a step within a workflow run."""

    id = pw.TextField(primary_key=True)
    run = pw.ForeignKeyField(WorkflowRun, backref="step_runs")
    step_key = pw.TextField()
    attempt = pw.IntegerField()
    artifact_round = pw.IntegerField(null=True)
    input_rounds_json = pw.TextField(null=True)
    input_snapshot_json = pw.TextField(null=True)
    io_contract_json = pw.TextField(null=True)
    status = pw.TextField(default="running")
    engine = pw.TextField(null=True)
    model = pw.TextField(null=True)
    source_step_run_id = pw.TextField(null=True)
    error = pw.TextField(null=True)
    started_at = UTCDateTimeField(null=True)
    ended_at = UTCDateTimeField(null=True)

    class Meta:
        table_name = "step_runs"
        indexes = (
            (("run", "step_key", "attempt"), True),
        )
