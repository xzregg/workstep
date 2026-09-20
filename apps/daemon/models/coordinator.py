"""Task coordinator conversation and action persistence."""

import peewee as pw

from models.base import BaseModel
from models.fields import UTCDateTimeField
from models.message import Message
from models.task import Task


class CoordinatorSession(BaseModel):
    """The active coordinator conversation state for one task."""

    task = pw.ForeignKeyField(Task, primary_key=True, backref="coordinator_session")
    engine = pw.TextField()
    model = pw.TextField(null=True)
    session_id = pw.TextField(null=True)
    engine_state_json = pw.TextField(null=True)
    summary = pw.TextField(null=True)
    summary_through_sequence = pw.IntegerField(null=True)
    version = pw.IntegerField(default=1)
    status = pw.TextField(default="active")
    last_error = pw.TextField(null=True)
    created_at = UTCDateTimeField()
    updated_at = UTCDateTimeField()

    class Meta:
        table_name = "coordinator_sessions"


class CoordinatorTurn(BaseModel):
    """One queued or completed user-to-coordinator exchange."""

    id = pw.TextField(primary_key=True)
    task = pw.ForeignKeyField(Task, backref="coordinator_turns")
    user_message = pw.ForeignKeyField(Message, backref="coordinator_user_turns")
    assistant_message = pw.ForeignKeyField(
        Message,
        backref="coordinator_assistant_turns",
    )
    idempotency_key = pw.TextField()
    status = pw.TextField(default="queued")
    engine = pw.TextField(null=True)
    model = pw.TextField(null=True)
    session_id = pw.TextField(null=True)
    requested_artifact_ids_json = pw.TextField(null=True)
    error = pw.TextField(null=True)
    started_at = UTCDateTimeField(null=True)
    ended_at = UTCDateTimeField(null=True)
    created_at = UTCDateTimeField()

    class Meta:
        table_name = "coordinator_turns"
        indexes = ((('task', 'idempotency_key'), True),)


class ActionProposal(BaseModel):
    """A coordinator-proposed side effect awaiting explicit confirmation."""

    id = pw.TextField(primary_key=True)
    task = pw.ForeignKeyField(Task, backref="action_proposals")
    source_turn = pw.ForeignKeyField(CoordinatorTurn, backref="action_proposals")
    source_message = pw.ForeignKeyField(Message, backref="action_proposals")
    type = pw.TextField()
    target_step_key = pw.TextField(null=True)
    payload_json = pw.TextField()
    impact_json = pw.TextField(null=True)
    expected_task_version = pw.IntegerField()
    expected_workflow_run_id = pw.TextField(null=True)
    expected_step_run_id = pw.TextField(null=True)
    expected_review_run_id = pw.TextField(null=True)
    status = pw.TextField(default="pending")
    confirm_idempotency_key = pw.TextField(null=True)
    confirmed_at = UTCDateTimeField(null=True)
    executed_at = UTCDateTimeField(null=True)
    result_json = pw.TextField(null=True)
    error = pw.TextField(null=True)
    created_at = UTCDateTimeField()
    updated_at = UTCDateTimeField()

    class Meta:
        table_name = "action_proposals"
        indexes = (
            (("task", "status"), False),
            (("task", "confirm_idempotency_key"), False),
        )


class StageSupplement(BaseModel):
    """Append-only stage guidance for current and future stage attempts.

    Created by a confirmed coordinator ``supplement_stage`` / prompted
    ``rerun_from_stage`` proposal (source_proposal set), or directly by a live
    stage message marked ``as_guidance`` (source_proposal NULL).
    """

    id = pw.TextField(primary_key=True)
    task = pw.ForeignKeyField(Task, backref="stage_supplements")
    step_key = pw.TextField()
    content = pw.TextField()
    source_proposal = pw.ForeignKeyField(
        ActionProposal,
        null=True,
        backref="supplements",
    )
    created_sequence = pw.IntegerField()
    active = pw.BooleanField(default=True)
    created_at = UTCDateTimeField()

    class Meta:
        table_name = "stage_supplements"
        indexes = ((('task', 'step_key', 'active'), False),)
