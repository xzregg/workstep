"""Persist cancellation of a step whose in-memory runner was lost."""

from pathlib import Path

from models import Message, ReviewRun, StepRun, Task, TaskStep, WorkflowRun
from services.step_execution_config import ACTIVE_STEP_CONFIG_STATUSES
from services.workflow_recovery import lease_held_by_live_owner


def persist_orphan_stop(task_id, step_key, now, instance_id):
    task = Task.get_or_none(Task.id == task_id)
    if task is None:
        raise ValueError(f"Task not found: {task_id}")
    step = TaskStep.get_or_none(
        (TaskStep.task == task) & (TaskStep.step_key == step_key)
    )
    if step is None:
        raise ValueError(f"Step does not exist: {step_key}")
    if step.status == "cancelled":
        return task.active_workflow_run_id, None, True
    if step.status not in {
        *ACTIVE_STEP_CONFIG_STATUSES,
        "reviewing",
        "rework_waiting",
    }:
        raise ValueError(f"步骤未在运行: {step_key}")

    workflow_run = None
    if task.active_workflow_run_id:
        workflow_run = WorkflowRun.get_or_none(
            (WorkflowRun.id == task.active_workflow_run_id)
            & (WorkflowRun.task == task)
        )
    if (
        workflow_run is not None
        and lease_held_by_live_owner(workflow_run, now, instance_id)
    ):
        raise ValueError("任务仍由其他运行器执行，请稍后再试")

    active_message = (
        Message.select()
        .where(
            (Message.task == task)
            & (Message.step_key == step_key)
            & (Message.channel == "execution")
            & (Message.role == "assistant")
            & (Message.run_status == "running")
        )
        .order_by(Message.sequence.desc(), Message.created_at.desc())
        .first()
    )
    # The journal is moved under its resolved engine session as
    # soon as session_started arrives. If the later DB write was
    # lost, recover that already-established id without changing
    # or rebuilding the engine session.
    if not step.session_id and active_message is not None:
        event_path = Path(active_message.event_log_path or "")
        if (
            event_path.parent.parent.name == f"task-{task.id}"
            and event_path.parent.name
        ):
            step.session_id = event_path.parent.name

    stop_reason = "手动停止（运行器已不存在）"
    step.status = "cancelled"
    step.error = stop_reason
    step.ended_at = now
    step.save()

    Message.update(
        run_status="cancelled",
        ended_at=now,
    ).where(
        (Message.task == task)
        & (Message.step_key == step_key)
        & (Message.channel.in_(["execution", "review"]))
        & (Message.run_status == "running")
    ).execute()

    if workflow_run is not None:
        StepRun.update(
            status="failed",
            error=stop_reason,
            ended_at=now,
        ).where(
            (StepRun.run == workflow_run)
            & (StepRun.step_key == step_key)
            & (StepRun.status == "running")
        ).execute()
        ReviewRun.update(
            status="failed",
            error=stop_reason,
            ended_at=now,
        ).where(
            (ReviewRun.workflow_run == workflow_run)
            & (ReviewRun.step_key == step_key)
            & (ReviewRun.status == "running")
        ).execute()
        workflow_run.status = "failed"
        workflow_run.ended_at = now
        workflow_run.owner_id = None
        workflow_run.heartbeat_at = None
        workflow_run.save()

    task.status = "paused"
    task.state_version += 1
    task.updated_at = now
    task.save()
    return (
        workflow_run.id if workflow_run is not None else None,
        active_message.id if active_message is not None else None,
        False,
    )
