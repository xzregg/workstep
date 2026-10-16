"""Internal scheduled submissions: persisted runs are the authority, never HTTP input."""
import json

from models import Schedule, ScheduleRun, Task
from models.base import db_proxy
from services.remote_access import ActorSnapshot, replayed_actor_context


async def submit_scheduled(module, project_id, run_id):
    def persist():
        with db_proxy.atomic("IMMEDIATE"):
            run = ScheduleRun.get_by_id(run_id)
            schedule = Schedule.get_by_id(run.schedule_id)
            task = Task.get_or_none(Task.id == schedule.target_task_id)
            from models.fields import utc_now
            from services.task_schedule_runtime import task_is_terminal
            reason = None
            if schedule.target_type != "task" or task is None or task.archived:
                reason = "定时目标任务不存在或已归档"
            elif run.status != "running" or schedule.status not in {"active", "completed"}:
                reason = "定时规则已暂停、删除或失效"
            elif schedule.stop_condition == "task_terminal" and task_is_terminal(task):
                reason = "任务已结束"
                schedule.status, schedule.invalid_reason, schedule.next_run_at = "completed", reason, None
                schedule.save()
            if reason:
                run.status, run.reason, run.ended_at = "stopped", reason, utc_now()
                run.save()
                return None, None, False, None, None
            creator = json.loads(schedule.task_template_json).get("_creator", {})
            actor = ActorSnapshot(
                actor_id=creator.get("id", ""), username=creator.get("username"),
                user_name=creator.get("name", ""), device_id=creator.get("device_id", ""),
                device_name=creator.get("device_name", ""), source="local", project_id=project_id,
            )
            with replayed_actor_context(actor):
                accepted, message, created = module._persist_submission(
                    project_id, task.id, run.instruction or schedule.instruction,
                    f"schedule-run:{run.id}", author_name=f"定时任务 · {schedule.name}",
                    schedule_run_id=run.id,
                )
            run.coordinator_turn_id = accepted.turn_id
            run.task_id = task.id
            run.save()
            return accepted, message, created, task.id, actor
    accepted, message, created, task_id, actor = await module._run_db(project_id, persist)
    if accepted is None:
        return None
    if created:
        await module._publish_message_event(project_id, task_id, message, "message_started",
                                            {"content": message.content, "status": "completed", "role": "user"}, 0)
    with replayed_actor_context(actor):
        module._schedule_turn(project_id, task_id, accepted.turn_id)
    return accepted


def execution_identity(turn_id):
    """Restore scheduled author attribution for queued turns after a daemon restart."""
    from models import CoordinatorTurn, Message
    turn = CoordinatorTurn.get_by_id(turn_id)
    if turn.execution_scope != "scheduled":
        return turn.execution_scope, None
    message = Message.get_by_id(turn.user_message_id)
    run = ScheduleRun.get_or_none(ScheduleRun.id == turn.schedule_run_id)
    schedule = Schedule.get_or_none(Schedule.id == run.schedule_id) if run else None
    creator = json.loads(schedule.task_template_json).get("_creator", {}) if schedule else {}
    return turn.execution_scope, ActorSnapshot(
        actor_id=message.author_id or "", username=message.author_username,
        user_name=creator.get("name") or message.author_name or "", device_id=message.author_device_id or "",
        device_name=message.author_device_name or "", source="local",
    )


def can_restore_scheduled(turn):
    run = ScheduleRun.get_or_none(ScheduleRun.id == turn.schedule_run_id)
    row = Schedule.get_or_none(Schedule.id == run.schedule_id) if run else None
    task = Task.get_or_none(Task.id == turn.task_id)
    return bool(row and row.status in {"active", "completed"} and task and not task.archived)


def fail_scheduled_preparation(turn_id, error):
    from models import CoordinatorTurn, Message
    from models.fields import utc_now
    turn = CoordinatorTurn.get_or_none(CoordinatorTurn.id == turn_id)
    if turn is None:
        return None
    turn.status, turn.error, turn.ended_at = "failed", error, utc_now()
    turn.save()
    Message.update(run_status="failed", content=error, ended_at=turn.ended_at).where(Message.id == turn.assistant_message_id).execute()
    return Message.get_by_id(turn.assistant_message_id)
