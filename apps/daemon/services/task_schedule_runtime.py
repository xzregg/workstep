"""Task schedule dispatch and reconciliation, separate from project task creation."""
import asyncio

from models import ActionProposal, Schedule, ScheduleRun, Task, TaskStep, WorkflowRun, CoordinatorTurn
from models.fields import utc_now

TERMINAL = { "completed", "failed", "cancelled", "stopped"}


def task_is_terminal(task):
    if task.status in TERMINAL:
        return True
    if task.status != "ready":
        return False
    if WorkflowRun.select().where((WorkflowRun.task == task) & (WorkflowRun.status == "succeeded")).exists():
        return True
    steps = list(TaskStep.select().where(TaskStep.task == task))
    return bool(steps) and any(step.started_at for step in steps) and all(step.status in {"passed", "skipped"} for step in steps)


def reconcile_task_schedules(*, startup, current):
    for row in Schedule.select().where(Schedule.target_type == "task"):
        task = Task.get_or_none(Task.id == row.target_task_id)
        if task is None or task.archived:
            if row.status == "deleted":
                continue
            row.status, row.invalid_reason, row.next_run_at = "invalid", "目标任务不存在或已归档", None
            row.save()
        elif row.status == "active" and row.stop_condition == "task_terminal" and task_is_terminal(task):
            row.status, row.invalid_reason, row.next_run_at = "completed", "任务已结束", None
            row.save()
        for run in ScheduleRun.select().where((ScheduleRun.schedule == row) & ScheduleRun.status.in_(["queued", "running"])):
            turn = CoordinatorTurn.get_or_none(CoordinatorTurn.id == run.coordinator_turn_id) if run.coordinator_turn_id else None
            if turn and turn.status not in {"queued", "running"}:
                run.status, run.reason, run.ended_at = turn.status, turn.error, turn.ended_at or current
                run.save()
            elif row.status == "invalid" or (run.status == "queued" and row.status not in {"active", "completed"}):
                run.status, run.reason, run.ended_at = "stopped", row.invalid_reason or "规则已关闭", current
                run.save()
            elif startup and run.status == "running" and not turn:
                run.status, run.reason, run.ended_at = "failed", "执行因服务重启中断，未自动重放", current
                run.save()


async def execute_task_schedule(module, project_id, run_id):
    if module._coordinator is None:
        raise RuntimeError("Coordinator is not initialized")
    accepted = await module._coordinator.submit_scheduled(project_id, run_id)
    if accepted is not None:
        await watch_task_schedule(module, project_id, run_id, accepted)


async def watch_task_schedule(module, project_id, run_id, accepted):
    while True:
        def inspect():
            run = ScheduleRun.get_by_id(run_id)
            turn = CoordinatorTurn.get_or_none(CoordinatorTurn.id == accepted.turn_id)
            if turn is None:
                return "stopped", "目标任务已删除", accepted.assistant_message_id, run.task_id, True
            task = Task.get_or_none(Task.id == turn.task_id)
            return turn.status, turn.error, turn.assistant_message_id, turn.task_id, task is None or task.archived
        status, error, message_id, task_id, invalid = await module._run_db(project_id, inspect)
        if invalid:
            background = module._coordinator._turn_tasks.get(accepted.turn_id)
            engine = module._coordinator._running_engines.get(accepted.turn_id)
            if background and not background.done():
                background.cancel()
            if engine:
                try:
                    await asyncio.wait_for(engine.stop(), timeout=5)
                except (TimeoutError, RuntimeError):
                    pass
        if invalid and status in {"running", "queued"}:
            await module._coordinator.stop_current(project_id, task_id, expected_message_id=message_id)
            status = "stopped"
        if status not in {"running", "queued"}:
            def finish():
                run = ScheduleRun.get_by_id(run_id)
                waiting = status == "succeeded" and ActionProposal.select().where((ActionProposal.source_turn == accepted.turn_id) & (ActionProposal.status == "pending")).exists()
                run.status, run.reason, run.ended_at = status, error or ("待用户确认" if waiting else None), utc_now()
                run.save()
            await module._run_db(project_id, finish)
            await module._notify_run(project_id, run_id)
            return
        await asyncio.sleep(0.25)


def invalidate_task_schedules(task_id):
    """Called inside successful archive/delete transactions, including CLI paths."""
    Schedule.update(status="invalid", invalid_reason="目标任务已归档或删除", next_run_at=None, updated_at=utc_now()).where(
        (Schedule.target_type == "task") & (Schedule.target_task_id == task_id) & (Schedule.status != "deleted")
    ).execute()


async def restore_task_watchers(module, project_id):
    """Reattach completion/cancellation tracking to queued coordinator turns after restart."""
    from types import SimpleNamespace
    def read():
        return [
            (run.id, turn.id, turn.assistant_message_id)
            for run in ScheduleRun.select().where(
                (ScheduleRun.status == "running") & ScheduleRun.coordinator_turn_id.is_null(False)
            )
            if (turn := CoordinatorTurn.get_or_none(CoordinatorTurn.id == run.coordinator_turn_id))
            and turn.status in {"queued", "running"}
        ]
    for run_id, turn_id, message_id in await module._run_db(project_id, read):
        name = f"schedule-run:{run_id}"
        if not any(worker.get_name() == name for worker in module._workers):
            accepted = SimpleNamespace(turn_id=turn_id, assistant_message_id=message_id)
            module._spawn(watch_task_schedule(module, project_id, run_id, accepted), name=name)
