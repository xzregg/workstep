"""Persist follow-up messages and validate failed-message retries."""

from models import Message, ReviewRun, StepRun, Task, TaskStep
from models.fields import utc_now
from services.messages import create_task_message, new_message_id
from services.step_execution_config import ACTIVE_STEP_CONFIG_STATUSES


def persist_step_followup(task_id, step_key, normalized, author_name, pending_insert_ids):
    """Write a validated follow-up and clear its consumed queue entries."""
    task = Task.get_or_none(Task.id == task_id)
    if task is None:
        raise ValueError(f"Task not found: {task_id}")
    step = TaskStep.get_or_none(
        (TaskStep.task == task) & (TaskStep.step_key == step_key)
    )
    if step is None:
        raise ValueError(f"Step does not exist: {step_key}")
    allowed_statuses = {
        "cancelled",
        "failed",
        "rejected",
        "awaiting_review",
        "passed",
        "skipped",
    }
    # 正在执行的步骤不接受 @ 重跑：实时注入走 message 接口。
    if step.status in ACTIVE_STEP_CONFIG_STATUSES or step.status in (
        "reviewing",
        "rework_waiting",
    ):
        raise ValueError(
            f"步骤当前不可重新执行: {step_key}（当前状态 {step.status}）"
        )
    # `pending` 通常代表从未启动；但只要有执行历史（曾经跑过又回到
    # 待执行，例如上游重跑把下游重置），就按「执行过一次」处理，允许 @。
    has_history = (
        Message.select()
        .where(
            (Message.task == task)
            & (Message.step_key == step_key)
            & (Message.channel == "execution")
            & (Message.role.in_(["user", "assistant"]))
        )
        .exists()
        or step.started_at is not None
    )
    if step.status not in allowed_statuses and not has_history:
        raise ValueError(
            f"步骤当前不可重新执行: {step_key}（当前状态 {step.status}）"
        )
    pending_review = None
    if step.status == "awaiting_review":
        pending_review = (
            ReviewRun.select()
            .where(
                (ReviewRun.task == task)
                & (ReviewRun.step_key == step_key)
            )
            .order_by(ReviewRun.started_at.desc(), ReviewRun.id.desc())
            .first()
        )
        if (
            pending_review is None
            or pending_review.mode != "manual"
            or pending_review.status != "pending"
        ):
            raise ValueError("步骤没有可跳过的人工审核")
    now = utc_now()
    message_id = new_message_id()
    user_message = create_task_message(
        id=message_id,
        task=task,
        channel="execution",
        step_key=step_key,
        role="user",
        content=normalized,
        run_id=message_id,
        run_status="completed",
        position=0,
        started_at=now,
        ended_at=now,
        created_at=now,
        **({"author_name": author_name} if author_name else {}),
    )
    if pending_insert_ids:
        from services.pending_message_inserts import (
            delete_pending_insert_batch,
        )

        delete_pending_insert_batch(pending_insert_ids)
    task.state_version += 1
    task.save()
    return (
        user_message,
        pending_review.id if pending_review else None,
        user_message.author_name or task.creator_name or "",
    )


def inspect_failed_message_retry(task_id: str, message_id: str, active_runner: bool) -> tuple[str, str]:
    """Return the current failed step/run when this message may be retried."""
    task = Task.get_or_none(Task.id == task_id)
    message = Message.get_or_none(Message.id == message_id)
    if task is None or message is None or message.task_id != task_id:
        raise ValueError("失败消息不存在")
    if (
        message.role != "assistant"
        or message.channel != "execution"
        or message.run_status != "failed"
        or not message.step_run_id
    ):
        raise ValueError("只能重启失败的阶段执行消息")
    step_run = StepRun.get_or_none(StepRun.id == message.step_run_id)
    if (
        step_run is None
        or step_run.step_key != message.step_key
        or step_run.status != "failed"
        or step_run.run_id != task.active_workflow_run_id
    ):
        raise ValueError("只能重启当前流程的最新失败消息")
    latest_step_message = (
        Message.select()
        .where((Message.task == task) & (Message.step_key == step_run.step_key))
        .order_by(Message.sequence.desc(), Message.created_at.desc())
        .first()
    )
    if latest_step_message is None or latest_step_message.id != message_id:
        raise ValueError("只能重启该步骤最后一条失败消息")
    if not (step_run.error or "").strip():
        raise ValueError("只有异常错误导致的失败消息可以重启")
    latest_step_run = (
        StepRun.select()
        .where(
            (StepRun.run == step_run.run)
            & (StepRun.step_key == step_run.step_key)
        )
        .order_by(StepRun.attempt.desc(), StepRun.started_at.desc())
        .first()
    )
    latest_message = (
        Message.select()
        .where(
            (Message.task == task)
            & (Message.step_run_id == step_run.id)
            & (Message.channel == "execution")
            & (Message.role == "assistant")
        )
        .order_by(Message.sequence.desc(), Message.created_at.desc())
        .first()
    )
    step = TaskStep.get_or_none(
        (TaskStep.task == task) & (TaskStep.step_key == step_run.step_key)
    )
    if (
        latest_step_run is None or latest_step_run.id != step_run.id
        or latest_message is None or latest_message.id != message_id
        or step is None or step.status != "failed"
    ):
        raise ValueError("只能重启当前阶段最新的失败消息")
    active_steps = TaskStep.select().where(
        (TaskStep.task == task)
        & (TaskStep.status.in_([
            *ACTIVE_STEP_CONFIG_STATUSES,
            "reviewing", "awaiting_review", "rework_waiting",
        ]))
    )
    if active_steps.exists() or active_runner:
        raise ValueError("其他步骤正在执行或等待审核，请先处理后再重启")
    return step_run.step_key, step_run.run_id
