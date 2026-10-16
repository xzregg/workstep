"""Schedule-owned destination selection and per-occurrence channel delivery.

Synchronous helpers run exclusively inside the project's database executor.
Network delivery runs on the event loop through the existing channel sender.
"""
import asyncio
import json

from models import Schedule, ScheduleRun, Task, Message, CoordinatorTurn
from models.base import db_proxy
from models.chat_session import ChatSession
from services.config import config_store
from services.schedule_rules import ScheduleValidationError


def notification_run_status(project_id, schedule_id, run_id):
    run = ScheduleRun.get_or_none((ScheduleRun.id == run_id) & (ScheduleRun.schedule == schedule_id))
    if run is None:
        raise ValueError("执行记录不存在")
    sent = run.notification_status == "sent"
    return {"ok": sent, "sent": sent, "notification_status": run.notification_status,
            "error": None if sent else run.notification_error or "通知尚未发送成功"}


def notification_options(project_id, task_id=None):
    data = config_store.get('channel_bots', {})
    bots = {b['id']: b for b in data.get('bots', []) if b.get('enabled')}
    choices = []
    for route, session_id in data.get('sessions', {}).items():
        parts = route.split(':', 2)
        if len(parts) != 3 or parts[0] not in bots:
            continue
        session = ChatSession.get_or_none((ChatSession.id == session_id) & (ChatSession.project_id == project_id) & (ChatSession.archived == False))
        if session:
            bot = bots[parts[0]]
            choices.append({'id': 'session:' + session_id, 'bot_id': bot['id'], 'bot_name': bot['name'],
                            'label': session.title or parts[2], 'target': {'session_id': session_id}})
    default = {'enabled': False}
    for group in data.get('groups', []):
        bot = bots.get(group['bot_id'])
        if not bot or group['project_id'] != project_id:
            continue
        target = {'bot_id': bot['id'], 'group_id': group['group_id']}
        key = 'group:' + bot['id'] + ':' + group['group_id']
        if not any(c['id'] == key for c in choices):
            choices.append({'id': key, 'bot_id': bot['id'], 'bot_name': bot['name'],
                            'label': group.get('group_name') or group['group_id'], 'target': target})
        if task_id and group['task_id'] == task_id and not default['enabled']:
            default = {'enabled': True, 'target': target}
    return {'choices': choices, 'default': default}


def normalize_notification(project_id, value, task_id=None):
    options = notification_options(project_id, task_id)
    if value is None:
        return options['default']
    if not isinstance(value, dict) or type(value.get('enabled')) is not bool:
        raise ScheduleValidationError('notification.enabled must be a boolean')
    if not value['enabled']:
        return {'enabled': False}
    target = value.get('target') or options['default'].get('target')
    if not isinstance(target, dict) or not any(choice['target'] == target for choice in options['choices']):
        raise ScheduleValidationError('通知目标不存在、已停用或不属于此项目')
    return {'enabled': True, 'target': target}


async def deliver_notification(module, project_id, run_id, *, retry=False):
    def claim():
        with db_proxy.atomic('IMMEDIATE'):
            run = ScheduleRun.get_by_id(run_id)
            schedule = Schedule.get_by_id(run.schedule_id)
            if run.notification_json is None:
                return None  # Old occurrences never acquire newly enabled notifications.
            config = json.loads(run.notification_json)
            if not config.get('enabled'):
                if run.notification_status == 'pending':
                    run.notification_status = 'disabled'; run.save()
                return None
            if (schedule.target_type == 'task' and run.status not in {'succeeded', 'failed', 'stopped'}) or (schedule.target_type == 'project' and not run.task_id):
                return None
            if run.notification_status not in ({'failed'} if retry else {'pending'}):
                return None
            task = Task.get_or_none(Task.id == run.task_id)
            if task is None or task.archived:
                run.notification_status, run.notification_error = 'failed', '目标任务不存在或已归档'
                run.save(); return None
            if schedule.target_type == 'task':
                turn = CoordinatorTurn.get_or_none(CoordinatorTurn.id == run.coordinator_turn_id)
                message = Message.get_or_none(Message.id == turn.assistant_message_id) if turn else None
                content = (message.content if message else '') or run.reason or '执行已结束'
                text = f'定时任务：{schedule.name}\n任务：{task.title}\n状态：{run.status}\n\n{content}'
            else:
                text = f'定时任务：{schedule.name}\n已创建任务：{task.title}'
            from urllib.parse import urlencode
            workflow = module._projects.get_project_by_id(project_id).workflow_by_id(task.workflow_id)
            import os, sys
            base = os.environ.get('WORKSTEP_DAEMON_URL', 'http://127.0.0.1:8765').rstrip('/')
            if 'main' in sys.modules and hasattr(sys.modules['main'], 'remote_access_service'):
                from services.notification_hooks import base_addresses
                base = next((b['task_base_url'] for b in base_addresses() if b.get('task_base_url')), base)
            text += '\n任务入口：' + base + '/tasks?' + urlencode({'project': module._projects.get_project_by_id(project_id).name,
                                                      'workflow': (workflow or {}).get('id', task.workflow_id or ''), 'task': task.id})
            run.notification_status, run.notification_error = 'sending', None
            run.save()
            return config['target'], text
    prepared = await module._run_db(project_id, claim)
    if prepared is None:
        return
    status, error = 'sent', None
    try:
        if module._notification_sender is None:
            raise RuntimeError('渠道服务不可用')
        target, text = prepared
        result = await asyncio.wait_for(module._notification_sender.send_message(project_id=project_id, text=text, **target), timeout=30)
        if not result.get('sent'):
            raise RuntimeError(result.get('error') or '渠道未确认发送成功')
    except asyncio.CancelledError:
        status, error = 'failed', '通知发送中断，结果未知，请核对后重试'
        raise
    except Exception as exc:
        status, error = 'failed', str(exc)
    finally:
        def finish():
            ScheduleRun.update(notification_status=status, notification_error=error).where(ScheduleRun.id == run_id).execute()
        await module._run_db(project_id, finish)


async def flush_notifications(module, project_id, *, startup=False):
    def pending():
        if startup:
            ScheduleRun.update(notification_status='failed', notification_error='服务重启中断通知，结果未知，请核对后重试').where(ScheduleRun.notification_status == 'sending').execute()
        return [r.id for r in ScheduleRun.select().where((ScheduleRun.notification_status == 'pending') & ScheduleRun.notification_json.is_null(False))]
    for run_id in await module._run_db(project_id, pending):
        # A slow channel must not delay the scheduler's next occurrence or another project.
        name = f'schedule-notification:{run_id}'
        if not any(worker.get_name() == name for worker in module._workers):
            module._spawn(deliver_notification(module, project_id, run_id), name=name)
