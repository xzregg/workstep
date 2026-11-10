"""Conversation timer validation, dispatch and lifecycle; DB helpers run in run_db."""
import asyncio
import json
import re
from datetime import timedelta

from models import Schedule, ScheduleRun
from models.chat_session import ChatMessage, ChatSession
from models.fields import utc_now
from services.config import config_store
from services.remote_access import ActorSnapshot, replayed_actor_context
from services.schedule_rules import ScheduleValidationError


def resolve_relative_rule(rule):
    if rule.get('kind') != 'after':
        return rule
    match = re.fullmatch(r'([1-9][0-9]{0,6})([smhd])', str(rule.get('delay', '')))
    if not match:
        raise ScheduleValidationError('Relative delay must be a positive duration, e.g. 30m or 2h')
    seconds = int(match[1]) * {'s':1, 'm':60, 'h':3600, 'd':86400}[match[2]]
    if seconds > 366 * 86400:
        raise ScheduleValidationError('Relative delay must not exceed 366 days')
    return {'kind':'once', 'run_at':(utc_now()+timedelta(seconds=seconds)).isoformat(), 'timezone':rule.get('timezone', 'UTC')}


def validate_session_target(project_id, session_id, instruction, task_id, stop_condition, overlap):
    if not session_id or not str(instruction or '').strip():
        raise ScheduleValidationError('Conversation and message are required')
    if task_id or stop_condition != 'manual' or overlap != 'skip':
        raise ScheduleValidationError('Conversation schedules require manual stop and skip overlap')
    session = ChatSession.get_or_none((ChatSession.id == session_id) & (ChatSession.project_id == project_id))
    if session is None or session.archived:
        raise ScheduleValidationError('Conversation does not exist or is archived')
    channel_destination(session_id)


def channel_destination(session_id):
    data = config_store.get('channel_bots', {})
    route = next((key for key, sid in data.get('sessions', {}).items() if sid == session_id), None)
    if not route:
        if session_id in data.get('session_sources', {}):
            raise ScheduleValidationError('渠道会话映射已失效')
        return None
    bot_id, kind, conversation_id = route.split(':', 2)
    if kind == 'group' and any(row['bot_id'] == bot_id and row['group_id'] == conversation_id for row in data.get('groups', [])):
        raise ScheduleValidationError('该群已绑定任务，请使用协调任务类型')
    return {'enabled':True, 'target':{'session_id':session_id}, 'route':route}


def clear_session_schedules(session_id):
    """Tombstones prevent queued workers/retries from resurrecting deleted timers."""
    ids = [row.id for row in Schedule.select(Schedule.id).where(
        (Schedule.target_type == 'session') & (Schedule.target_session_id == session_id))]
    if not ids:
        return
    Schedule.update(status='deleted', next_run_at=None, updated_at=utc_now()).where(Schedule.id.in_(ids)).execute()
    ScheduleRun.update(status='stopped', reason='会话已删除或归档', ended_at=utc_now(), notification_status='disabled').where(
        ScheduleRun.schedule.in_(ids) & ScheduleRun.status.in_(['queued','running'])).execute()


def reconcile_session_schedules(*, startup, current):
    for row in Schedule.select().where((Schedule.target_type == 'session') & (Schedule.status != 'deleted')):
        session = ChatSession.get_or_none(ChatSession.id == row.target_session_id)
        if session is None or session.archived:
            clear_session_schedules(row.target_session_id)
    if startup:
        ids = Schedule.select(Schedule.id).where(Schedule.target_type == 'session')
        ScheduleRun.update(status='failed', reason='执行因服务重启中断，未自动重放', ended_at=current).where(
            ScheduleRun.schedule.in_(ids) & (ScheduleRun.status == 'running')).execute()


async def execute_session_schedule(module, project_id, run_id):
    runtime = None
    accepted = None
    session_id = None
    try:
        while accepted is None:
            def submit():
                run = ScheduleRun.get_or_none(ScheduleRun.id == run_id)
                if run is None or run.status != 'running':
                    return None
                schedule = run.schedule
                if schedule.status in {'deleted','invalid','paused'}:
                    run.status, run.reason, run.ended_at = 'stopped', '规则已关闭', utc_now()
                    run.save(); return None
                sid = schedule.target_session_id
                try:
                    validate_session_target(project_id, sid, run.instruction or schedule.instruction, None, 'manual', 'skip')
                    destination = channel_destination(sid)
                except ScheduleValidationError as exc:
                    schedule.status, schedule.invalid_reason, schedule.next_run_at = 'invalid', str(exc), None
                    schedule.save()
                    raise
                if json.loads(schedule.notification_json) != (destination or {"enabled":False}):
                    schedule.status, schedule.invalid_reason, schedule.next_run_at = 'invalid', '渠道会话映射已变化，请重新创建定时任务', None
                    schedule.save()
                    raise ScheduleValidationError(schedule.invalid_reason)
                selected_runtime = module._channel_sessions if destination else module._chat_sessions
                if selected_runtime is None:
                    raise RuntimeError('Conversation runtime is not initialized')
                if ChatMessage.select().where((ChatMessage.session == sid) & ChatMessage.status.in_(['queued','running','stopping'])).exists():
                    return 'busy'
                creator = json.loads(schedule.task_template_json).get('_creator', {})
                actor = ActorSnapshot(
                    actor_id=creator.get('id', ''), username=creator.get('username'),
                    user_name=creator.get('name', ''), device_id=creator.get('device_id', ''),
                    device_name=creator.get('device_name', ''), source=creator.get('source') or 'local',
                    project_id=project_id,
                )
                with replayed_actor_context(actor):
                    result = selected_runtime.submit_message(project_id, sid, run.instruction or schedule.instruction,
                                                             f'schedule:{run_id}', schedule=False)
                run.session_id, run.session_turn_id = sid, result.turn_id
                user = ChatMessage.select(ChatMessage.id).where((ChatMessage.session == sid) & (ChatMessage.role == "user")).order_by(ChatMessage.created_at.desc()).first()
                run.session_user_message_id, run.session_assistant_message_id = (user.id if user else None), result.assistant_message_id
                if user:
                    label = '定时任务：' + schedule.name
                    ChatMessage.update(author_name=label, author_type='scheduler').where(ChatMessage.id == user.id).execute()
                    state = getattr(selected_runtime, '_turn_states', {}).get(result.turn_id, {})
                    memory = getattr(selected_runtime, '_sessions', {}).get(state.get('memory_key'))
                    if memory:
                        for message in memory.messages:
                            if message.get('id') == user.id:
                                message.update(author_name=label, author_type='scheduler')
                run.notification_json = json.dumps(destination or {'enabled':False})
                run.instruction = run.instruction or schedule.instruction
                run.save()
                return selected_runtime, result, sid, actor
            prepared = await module._run_db(project_id, submit)
            if prepared is None:
                return
            if prepared == 'busy':
                await asyncio.sleep(.25)
                continue
            runtime, accepted, session_id, actor = prepared
        with replayed_actor_context(actor):
            runtime.start_queued_turn(accepted.turn_id)
        while True:
            def inspect():
                run = ScheduleRun.get_or_none(ScheduleRun.id == run_id)
                session = ChatSession.get_or_none(ChatSession.id == session_id)
                if run is None or run.status == 'stopped' or run.schedule.status == 'deleted' or session is None or session.archived:
                    return 'stopped', True
                message = ChatMessage.get_or_none(ChatMessage.id == accepted.assistant_message_id)
                return (message.status if message else 'failed'), False
            status, invalid = await module._run_db(project_id, inspect)
            if invalid:
                await runtime.stop_current(session_id, project_id=project_id, expected_message_id=accepted.assistant_message_id)
                return
            if status not in {'queued','running','stopping'}:
                def finish():
                    ScheduleRun.update(status=status if status in {'succeeded','failed','stopped'} else 'failed', ended_at=utc_now()).where(
                        (ScheduleRun.id == run_id) & (ScheduleRun.status == 'running')).execute()
                await module._run_db(project_id, finish)
                await module._notify_run(project_id, run_id)
                return
            await asyncio.sleep(.25)
    except asyncio.CancelledError:
        if runtime and accepted:
            await runtime.stop_current(session_id, project_id=project_id, expected_message_id=accepted.assistant_message_id)
        raise


def conversation_schedule_context(session):
    user = next((item for item in reversed(session.messages) if item.get('role') == 'user'), {})
    context = json.dumps({'project_id':session.project_id, 'session_id':session.session_id,
                          'source_message_id':user.get('id')}, ensure_ascii=False)
    return (
        '[WorkStep conversation scheduling] ' + context + '\n'
        'When the user explicitly asks to check or act later in this conversation, use '
        'workstep schedule create --target session --project <project_id> --session <session_id> '
        '--name <name> --instruction <action to perform at that time> --after 2h --json. '
        'Use --at for an exact datetime. --after is one-shot, not --every-minutes. '
        'Use --idempotency-key <source_message_id> to avoid duplicates on retry. '
        'These are WorkStep IDs, not engine thread IDs or external group IDs. '
        'A channel conversation automatically sends the final reply to its original channel. '
        'Report success only after the CLI succeeds, including the returned execution time. '
        'At execution time perform the requested action, do not schedule it again.'
    )
