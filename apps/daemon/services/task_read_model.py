"""Materialize the canonical task payload within a project database work unit."""

import json

from peewee import fn

from models import CoordinatorSession, Message, ReviewRun, StepRun, Task, TaskStep, WorkflowRun


def latest_previous_step_statuses(task: Task) -> dict[str, str]:
    """Return each step's latest terminal result, independent of reset state."""
    latest_step_run_by_key: dict[str, StepRun] = {}
    for step_run in (
        StepRun.select()
        .join(WorkflowRun)
        .where(
            (WorkflowRun.task == task)
            & (StepRun.status.in_(["succeeded", "reused", "failed", "cancelled", "skipped"]))
        )
        .order_by(StepRun.started_at.desc(), StepRun.attempt.desc())
    ):
        latest_step_run_by_key.setdefault(step_run.step_key, step_run)

    latest_review_by_key: dict[str, ReviewRun] = {}
    for review in (
        ReviewRun.select()
        .where(ReviewRun.task == task)
        .order_by(ReviewRun.started_at.desc(), ReviewRun.attempt.desc(), ReviewRun.id.desc())
    ):
        latest_review_by_key.setdefault(review.step_key, review)

    failed_run_ids = [
        step_run.id for step_run in latest_step_run_by_key.values()
        if step_run.status == "failed"
    ]
    stopped_run_ids = set()
    if failed_run_ids:
        stopped_run_ids = {
            message.step_run_id for message in Message.select(Message.step_run_id).where(
                (Message.step_run_id.in_(failed_run_ids))
                & (Message.channel == "execution")
                & (Message.role == "assistant")
                & (Message.run_status.in_(["cancelled", "stopped"]))
            )
        }

    previous: dict[str, str] = {}
    for step_key, step_run in latest_step_run_by_key.items():
        status = step_run.status
        if status == "failed" and step_run.id in stopped_run_ids:
            status = "cancelled"
        if status in ("succeeded", "reused"):
            review = latest_review_by_key.get(step_key)
            if review is not None and review.step_run_id == step_run.id:
                status = {
                    "pending": "awaiting_review",
                    "running": "reviewing",
                    "passed": "passed",
                    "rejected": "rejected",
                    "failed": "failed",
                    "skipped": "passed",
                }.get(review.status, "passed")
            else:
                status = "passed"
        previous[step_key] = status
    return previous



def task_to_dict(task: Task) -> dict:
    """Build the task/list/share projection inside the caller's DB work unit."""
    active_run = None
    if task.active_workflow_run_id:
        active_run = WorkflowRun.get_or_none(
            (WorkflowRun.id == task.active_workflow_run_id)
            & (WorkflowRun.task == task)
        )
    steps = list(TaskStep.select().where(TaskStep.task == task))
    previous_status_by_step = latest_previous_step_statuses(task)
    # 「执行过」判定：步骤是否有 execution 频道的用户/助手消息。
    # 一次分组查询取回所有已执行步骤，避免逐步骤查询。
    executed_step_keys = {
        row.step_key
        for row in (
            Message.select(Message.step_key)
            .where(
                (Message.task == task)
                & (Message.channel == "execution")
                & (Message.role.in_(["user", "assistant"]))
            )
            .group_by(Message.step_key)
        )
    }
    coordinator_session = CoordinatorSession.get_or_none(
        CoordinatorSession.task == task
    )
    coordinator_session_id = (
        coordinator_session.session_id if coordinator_session else None
    )
    # Include the current attempt while it runs: its execution message
    # already shows that reserved artifact round. Ignore interrupted
    # attempts from older runs and failed attempts without artifacts.
    running_step_keys = [
        step.step_key for step in steps if step.status == "running"
    ]
    latest_artifact_round_by_step = {
        row.step_key: row.max_round
        for row in (
            StepRun.select(
                StepRun.step_key,
                fn.MAX(StepRun.artifact_round).alias("max_round"),
            )
            .join(WorkflowRun)
            .where(
                (WorkflowRun.task == task)
                & (StepRun.artifact_round.is_null(False))
                & (
                    StepRun.status.in_(["succeeded", "reused"])
                    | (
                        (StepRun.status == "running")
                        & (WorkflowRun.id == task.active_workflow_run_id)
                        & (StepRun.step_key.in_(running_step_keys))
                    )
                )
            )
            .group_by(StepRun.step_key)
        )
    }
    latest_io_contract_by_step: dict[str, dict] = {}
    for row in (
        StepRun.select(StepRun.step_key, StepRun.io_contract_json)
        .join(WorkflowRun)
        .where(
            (WorkflowRun.task == task)
            & StepRun.io_contract_json.is_null(False)
        )
        .order_by(StepRun.started_at.desc(), StepRun.id.desc())
    ):
        if row.step_key in latest_io_contract_by_step:
            continue
        try:
            contract = json.loads(row.io_contract_json or "")
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(contract, dict):
            latest_io_contract_by_step[row.step_key] = contract
    run_round = 1
    restart_from_step_key = None
    recovered_at = None
    recovered_count = 0
    if active_run is not None:
        restart_from_step_key = active_run.restart_from_step_key
        recovered_at = active_run.recovered_at
        recovered_count = active_run.recovered_count or 0
        depth = 1
        current = active_run
        while current.parent_run_id:
            parent = WorkflowRun.get_or_none(
                (WorkflowRun.id == current.parent_run_id)
                & (WorkflowRun.task == task)
            )
            if parent is None:
                break
            current = parent
            depth += 1
        run_round = depth
    first_message = (
        Message.select(Message.created_at)
        .where(Message.task == task)
        .order_by(Message.created_at, Message.sequence)
        .limit(1)
        .scalar()
    )
    last_step_end = (
        TaskStep.select(TaskStep.ended_at)
        .where((TaskStep.task == task) & (TaskStep.ended_at.is_null(False)))
        .order_by(TaskStep.ended_at.desc())
        .limit(1)
        .scalar()
    )
    duration_ms = None
    if first_message is not None and last_step_end is not None:
        delta = (last_step_end - first_message).total_seconds() * 1000
        if delta > 0:
            duration_ms = int(delta)

    total_tokens = 0
    for msg in Message.select(Message.usage_json).where(Message.task == task):
        if not msg.usage_json:
            continue
        try:
            usage = json.loads(msg.usage_json)
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(usage, dict):
            continue
        total = usage.get("total_tokens", usage.get("tokens"))
        if isinstance(total, (int, float)) and not isinstance(total, bool):
            total_tokens += max(0, int(total))
        else:
            input_tokens = usage.get("input_tokens", usage.get("prompt_tokens", 0))
            output_tokens = usage.get("output_tokens", usage.get("completion_tokens", 0))
            if isinstance(input_tokens, (int, float)) and not isinstance(input_tokens, bool):
                total_tokens += max(0, int(input_tokens))
            if isinstance(output_tokens, (int, float)) and not isinstance(output_tokens, bool):
                total_tokens += max(0, int(output_tokens))

    return {
        "id": task.id,
        "title": task.title,
        "description": task.description,
        "cwd": task.cwd,
        "status": task.status,
        "archived": bool(task.archived),
        "engine": task.engine,
        "model": task.model,
        "coordinator_engine": task.coordinator_engine,
        "coordinator_model": task.coordinator_model,
        "coordinator_fast_model": task.coordinator_fast_model,
        "coordinator_vision_model": task.coordinator_vision_model,
        "coordinator_session_id": coordinator_session_id,
        "active_workflow_run_id": task.active_workflow_run_id,
        "run_round": run_round,
        "restart_from_step_key": restart_from_step_key,
        "recovered_at": recovered_at,
        "recovered_count": recovered_count,
        "state_version": task.state_version,
        "workflow_id": task.workflow_id,
        "first_message_at": first_message,
        "completed_at": last_step_end,
        "duration_ms": duration_ms,
        "total_tokens": total_tokens if total_tokens > 0 else None,
        "created_at": task.created_at,
        "updated_at": task.updated_at,
        "review_overrides": json.loads(task.review_overrides_json) if task.review_overrides_json else None,
        "creator_id": task.creator_id,
        "creator_username": task.creator_username,
        "creator_name": task.creator_name,
        "creator_device_id": task.creator_device_id,
        "creator_device_name": task.creator_device_name,
        "scheduled_start_at": task.scheduled_start_at,
        "scheduled_start_state": task.scheduled_start_state,
        "scheduled_start_error": task.scheduled_start_error,
        "source_dispatch_id": task.source_dispatch_id,
        "source_project_id": task.source_project_id,
        "source_task_id": task.source_task_id,
        "source_step_key": task.source_step_key,
        "input_manifest": json.loads(task.input_manifest_json) if task.input_manifest_json else [],
        "steps": [
            {
                "step_key": step.step_key,
                "status": step.status,
                "engine": step.engine,
                "session_id": step.session_id,
                "started_at": step.started_at,
                "ended_at": step.ended_at,
                "error": step.error,
                "artifact_round": latest_artifact_round_by_step.get(
                    step.step_key
                ),
                "io_contract": latest_io_contract_by_step.get(step.step_key),
                "previous_status": previous_status_by_step.get(step.step_key),
                "has_history": (
                    step.step_key in executed_step_keys
                    or step.started_at is not None
                ),
            }
            for step in steps
        ],
    }
