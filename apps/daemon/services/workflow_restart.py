"""Persist a child workflow run when execution restarts from one step."""

import json
import uuid

from models import Message, ReviewRun, StepRun, Task, TaskStep, WorkflowRun
from models.base import db_proxy
from models.fields import utc_now
from services.artifact_routing import empty_routing_state


def create_restart_run(
    task: Task,
    parent: WorkflowRun,
    schema_version: int,
    step_key: str,
    execution_keys: set[str],
    *,
    instance_id: str,
    reset_session_step_key: str | None = None,
    feedback_inputs: dict[str, dict] | None = None,
) -> tuple[Task, WorkflowRun]:
    """Replace a run atomically inside the selected project's DB executor."""
    now = utc_now()
    with db_proxy.atomic():
        parent.status = "superseded"
        parent.ended_at = parent.ended_at or now
        parent.save()
        StepRun.update(
            status="cancelled",
            ended_at=now,
        ).where(
            (StepRun.run == parent)
            & (StepRun.status == "running")
        ).execute()
        ReviewRun.update(
            status="cancelled",
            ended_at=now,
            error="流程运行已被新的入口替代",
        ).where(
            (ReviewRun.workflow_run == parent)
            & (ReviewRun.status.in_(["pending", "running"]))
        ).execute()
        # A review can be interrupted after its StepRun has succeeded.
        # Close both bubbles from this parent run before launching the
        # replacement; otherwise their old "running" state survives.
        from services.history import project_terminal_message_state

        parent_step_run_ids = [
            row.id for row in StepRun.select(StepRun.id).where(StepRun.run == parent)
        ]
        if parent_step_run_ids:
            stale_messages = Message.select().where(
                (Message.task == task)
                & (Message.step_run_id.in_(parent_step_run_ids))
                & (Message.role == "assistant")
                & (Message.channel.in_(["execution", "review"]))
                & (Message.run_status == "running")
            )
            for message in stale_messages:
                projection = {}
                project_terminal_message_state(projection, message)
                if projection.get("run_status"):
                    message.run_status = projection["run_status"]
                    message.ended_at = projection["ended_at"] or now
                    message.save(only=[Message.run_status, Message.ended_at])
        routing_state = empty_routing_state()
        routing_state["entry_step_key"] = step_key
        routing_state["execution_scope"] = sorted(execution_keys)
        if feedback_inputs:
            routing_state["feedback_inputs"][step_key] = feedback_inputs
            routing_state["active_edges"] = sorted(feedback_inputs)
        child = WorkflowRun.create(
            id=str(uuid.uuid4()),
            task=task,
            status="running",
            workflow_schema_version=schema_version,
            workflow_snapshot_json="{}",
            parent_run_id=parent.id,
            restart_from_step_key=step_key,
            routing_state_json=json.dumps(routing_state, ensure_ascii=False),
            owner_id=instance_id,
            heartbeat_at=now,
            started_at=now,
        )
        reusable = {
            row.step_key
            for row in TaskStep.select().where(
                (TaskStep.task == task)
                & (TaskStep.status == "passed")
                & (~(TaskStep.step_key.in_(execution_keys)))
            )
        }
        for reusable_key in reusable:
            source = (
                StepRun.select()
                .where(
                    (StepRun.run == parent)
                    & (StepRun.step_key == reusable_key)
                    & (StepRun.status.in_(["succeeded", "reused"]))
                )
                .order_by(StepRun.attempt.desc())
                .first()
            )
            if source is None:
                continue
            StepRun.create(
                id=str(uuid.uuid4()),
                run=child,
                step_key=reusable_key,
                attempt=1,
                artifact_round=source.artifact_round,
                status="reused",
                engine=source.engine,
                model=source.model,
                source_step_run_id=source.id,
                started_at=now,
                ended_at=now,
            )
        TaskStep.update(
            status="pending",
            started_at=None,
            ended_at=None,
            error=None,
        ).where(
            (TaskStep.task == task)
            & (TaskStep.step_key.in_(execution_keys))
        ).execute()
        if reset_session_step_key:
            TaskStep.update(
                session_id=None,
                session_provider=None,
                pending_handoff_json=None,
            ).where(
                (TaskStep.task == task)
                & (TaskStep.step_key == reset_session_step_key)
            ).execute()
        TaskStep.update(
            status="cancelled",
            ended_at=now,
            error="已切换到其他流程入口",
        ).where(
            (TaskStep.task == task)
            & (~(TaskStep.step_key.in_(execution_keys)))
            & (TaskStep.status.in_([
                "running", "reviewing", "awaiting_review", "retrying",
                "rework", "rework_waiting",
            ]))
        ).execute()
        task.status = "running"
        task.active_workflow_run_id = child.id
        task.state_version += 1
        task.updated_at = now
        task.save()
    return task, child
