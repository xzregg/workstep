"""Tracked workflow tasks; workflow state, rather than chat turns, owns completion."""

import asyncio
import hashlib
import json
import logging
import uuid
from urllib.parse import urlencode

from models import CoordinatorTurn, Message, Task
from models.chat_session import ChatSession
from models.fields import utc_now
from services.digital_person_tasks import all_executions, resolve_task
from services.memory_secrets import redact
from services.task_state import current_task_steps, summarize_task_state


def task_link(project_id, task_id):
    return 'workstep-task://open?' + urlencode({'project_id': project_id, 'task_id': task_id})


def task_signature(snapshot):
    return hashlib.sha256(json.dumps([
        snapshot.get('execution_id'), snapshot['status'], snapshot.get('status_reason'), snapshot.get('task_run_id'),
        snapshot.get('pending_confirmations', []), snapshot.get('steps', []),
    ], sort_keys=True).encode()).hexdigest()[:24]


def read_task(item, include_content=False):
    """Caller owns the project's database work unit."""
    task = Task.get_or_none(Task.id == item['task_id'])
    if task is None:
        return {**item, 'status': 'missing', 'archived': False, 'content': '', 'question': None}
    steps = current_task_steps(task)
    result = {**item, **summarize_task_state(task.status, steps, reason=task.status_reason),
              'workflow_id': task.workflow_id, 'archived': bool(task.archived),
              'task_run_id': task.active_workflow_run_id, 'content': '', 'question': None,
              'steps': [{'step_key': step.step_key, 'status': step.status} for step in steps]}
    if item.get('coordinator_request_id'):
        turn = CoordinatorTurn.get_or_none(CoordinatorTurn.idempotency_key == item['coordinator_request_id'], CoordinatorTurn.task == task.id)
        result['coordinator_status'] = turn.status if turn else 'missing'
        if include_content and turn and turn.status not in {'queued', 'running'}:
            result['coordinator_result'] = (Message.select(Message.content).where(
                Message.id == turn.assistant_message_id, Message.task == task.id).scalar() or '')[:2000]
    if include_content:
        rows = Message.select(Message.content).where(
            Message.task == task.id, Message.role == 'assistant',
            Message.channel == 'execution', Message.run_status.in_(('succeeded', 'completed')),
        ).order_by(Message.created_at.desc()).limit(3)
        result['content'] = '\n\n'.join(row.content[:2000] for row in rows)
    return result


class WorkflowDelegations:
    def __init__(self, runtime):
        self.runtime = runtime
        self.poll_lock = asyncio.Lock()

    async def delegate(self, project_id, instruction, origin_session_id, request_id, *,
                       workflow_id='', target_task_id='', continuation_of='', title=None):
        from main import task_service, workflow_runtime, coordinator_module
        from services import digital_person
        from services.digital_person_channels import shared_origins
        from services.remote_access import get_current_actor, has_project_edit_scope
        runtime = self.runtime
        actor = get_current_actor()
        if actor is not None and actor.project_id is not None:
            raise PermissionError('Host authorization is required for delegation')
        if not has_project_edit_scope(project_id):
            raise PermissionError('Project edit permission is required')
        if not (await asyncio.to_thread(digital_person.get_profile)).enabled:
            raise ValueError('Please enable the digital human first')
        if not instruction.strip() or len(instruction) > 12000:
            raise ValueError('Please provide valid execution requirements')
        if title is not None and (not title.strip() or len(title.strip()) > 60 or len(title.strip().splitlines()) != 1):
            raise ValueError('Delegation title must be one line of 1 to 60 characters')
        if ((workflow_id and (target_task_id or continuation_of))
                or not any((workflow_id, target_task_id, continuation_of))):
            raise ValueError('Choose a workflow, an existing task, or a prior delegation')
        project = runtime.projects.get_project_by_id(project_id)
        if project is None:
            raise ValueError('Target project does not exist')
        home = await runtime.home()
        if project_id == home.id:
            raise ValueError('Please delegate work to the specific project')
        async with runtime._delegate_lock:
            origin_session_id = origin_session_id or (await runtime.main_session())['id']
            origin = await runtime.projects.run_db(home.id, lambda _: ChatSession.get_or_none(
                ChatSession.id == origin_session_id, ChatSession.archived == False) is not None)
            if not origin:
                raise ValueError('Origin conversation is unavailable')
            state = await runtime.state()
            signature = [project_id, instruction, origin_session_id, workflow_id, target_task_id, continuation_of, title]
            previous_request = next((row for row in all_executions(state) if row.get('request_id') == request_id), None)
            if previous_request and previous_request.get('request_signature') != signature:
                raise ValueError('Request identifier already used with different requirements')
            if previous_request and previous_request.get('creation_state') == 'ready':
                return previous_request
            previous = resolve_task(state, continuation_of) if continuation_of else next((
                row for row in state['delegations'] if target_task_id and row['project_id'] == project_id
                and row.get('task_id') == target_task_id), None)
            origins = await asyncio.to_thread(shared_origins, origin_session_id, state.get('main_session_id'))
            if previous and (previous['project_id'] != project_id or previous['origin_session_id'] not in origins):
                raise ValueError('Delegation does not belong to this source conversation and project')
            if continuation_of and (previous is None or (not target_task_id and not previous.get('task_id'))):
                raise ValueError('Workflow task delegation does not exist')
            if target_task_id:
                owner = next((row for row in state['delegations'] if row['project_id'] == project_id
                              and row.get('task_id') == target_task_id), None)
                if owner and previous and owner['id'] != previous['id']:
                    raise ValueError('Task is already tracked by another delegation')
                snapshot = await runtime.projects.run_db(project_id, lambda _: read_task({'task_id': target_task_id}))
                if snapshot['status'] == 'missing' or snapshot['archived']:
                    raise ValueError('Task is unavailable or archived')
                workflow_id = snapshot['workflow_id']
            if workflow_id and not target_task_id:
                def validate(p):
                    workflow = p.workflow_by_id(workflow_id)
                    if not workflow or workflow.get('debug_source_id'):
                        raise ValueError('Workflow not found')
                await runtime.projects.run_db(project_id, validate)
            execution_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f'workstep-workflow-delegation:{project_id}:{origin_session_id}:{request_id}'))
            item = previous_request or {
                'id': previous['id'] if previous else execution_id, 'execution_id': execution_id,
                'kind': 'workflow_task', 'project_id': project_id,
                'task_id': target_task_id or (previous['task_id'] if previous else execution_id),
                'workflow_id': workflow_id or (previous['workflow_id'] if previous else ''),
                'origin_session_id': previous['origin_session_id'] if previous else origin_session_id,
                'session_id': '', 'message_id': execution_id, 'turn_id': '',
                'instruction': instruction, 'root_instruction': previous.get('root_instruction', previous['instruction']) if previous else instruction,
                'title': (title or (previous or {}).get('title') or instruction[:60]).strip(),
                'request_id': request_id, 'request_signature': signature,
                'operation': 'updated' if previous else 'created', 'creation_state': 'pending',
                'status': 'ready', 'followup_state': 'pending', 'created_at': utc_now(), 'notified': False,
            }
            item['task_detail_url'] = task_link(project_id, item['task_id'])
            if not previous_request:
                def reserve(saved):
                    if previous:
                        current = resolve_task(saved, previous['id'])
                        saved['delegation_executions'].append(current.copy())
                        current.clear()
                        current.update(item)
                    else:
                        saved['delegations'].append(item.copy())
                await runtime.mutate(reserve)
            if continuation_of and not target_task_id:
                if coordinator_module is None:
                    raise ValueError('Coordinator is not initialized')
                snapshot = await runtime.projects.run_db(project_id, lambda _: read_task(item))
                if snapshot['archived'] or snapshot['status'] == 'missing':
                    raise ValueError('Task is unavailable or archived')
                # Coordinator submissions use their own persisted idempotency key.
                item['followup_task_signature'] = task_signature(snapshot)
                item['coordinator_request_id'] = execution_id
                await self._save(item)
                accepted = await coordinator_module.submit_message(project_id, item['task_id'], instruction, execution_id)
                item['coordinator_turn_id'] = accepted.turn_id
            elif not target_task_id:
                if task_service is None:
                    raise ValueError('Task service is not initialized')
                from services.task_creation import create_project_task
                from services.messages import current_actor_task_fields
                from services.config import config_store, DEFAULT_EXECUTION_ENGINE
                engine = await asyncio.to_thread(config_store.get_execution_default_engine)
                created = await create_project_task(
                    project_manager=runtime.projects, task_service=task_service, workflow_runtime=workflow_runtime,
                    project_id=project_id, title=item['title'], description=instruction,
                    workflow_id=workflow_id, execution_mode='manual', task_id=item['task_id'],
                    engine=engine or DEFAULT_EXECUTION_ENGINE,
                    creator_fields=current_actor_task_fields())
                await runtime.bus.publish({'type': 'CUSTOM', 'name': 'workstep.task_created',
                                           'channel': 'task_board', 'project_id': project_id,
                                           'value': {'task': {key: value for key, value in created.task.items() if key != 'cwd'}}})
                # Reserve before startup; a lost response must never restart an already-created task.
                if not item.get('start_attempted'):
                    item['start_attempted'] = True
                    await self._save(item)
                    try:
                        if workflow_runtime is None:
                            raise ValueError('Workflow runtime not initialized')
                        await workflow_runtime.start(project_id, item['task_id'], '', source='manual')
                    except Exception:
                        item['startup_error'] = '任务已创建，启动未确认，请打开任务详情查看或启动。'
            snapshot = await runtime.projects.run_db(project_id, lambda _: read_task(item))
            item.update(status=snapshot['status'], creation_state='ready')
            await self._save(item)
            return item

    async def _save(self, item):
        from services.digital_person_tasks import find_execution
        await self.runtime.mutate(lambda state: find_execution(state, item).update(item))

    async def poll(self, profile):
        if self.poll_lock.locked():
            return
        async with self.poll_lock:
            from services.digital_person_memory import allowed_projects
            allowed = set(allowed_projects(self.runtime.projects))
            state = await self.runtime.state()
            for item in state['delegations']:
                if not item.get('task_id') or item.get('followup_state') in {'stopped', 'completed'}:
                    continue
                if item['project_id'] not in allowed and self.runtime.projects.get_project_by_id(item['project_id']) is not None:
                    continue
                try:
                    async with self.runtime._delegate_lock:
                        await self._poll_one(item, profile)
                except Exception:
                    logging.getLogger(__name__).exception('Workflow delegation follow-up failed: %s', item['id'])

    async def _poll_one(self, item, profile):
        manager = self.runtime.delegation_management
        snapshot, = await manager.read([item], include_content=True)
        if snapshot['archived']:
            return
        if item.get('creation_state') != 'ready' and snapshot['status'] != 'missing':
            item['creation_state'] = 'ready'
            if snapshot['status'] == 'ready':
                item['startup_error'] = '任务已创建，启动未确认，请打开任务详情查看或启动。'
            await self._save(item)
        signature = task_signature(snapshot)
        pending_followup = bool(item.get('coordinator_request_id') and item.get('followup_task_signature') == signature)
        changed = signature != item.get('task_signature')
        if changed:
            item.update(task_signature=signature, status=snapshot['status'], notified=False,
                        followup_state='pending', updated_at=utc_now())
            await self._save(item)
        if pending_followup and snapshot.get('coordinator_status') in {'queued', 'running'}:
            return
        needs_notice = (snapshot['status'] in {'waiting', 'failed', 'stopped', 'completed', 'missing'}
                        or bool(snapshot.get('pending_confirmations')) or bool(item.get('startup_error') and snapshot['status'] == 'ready'))
        if not needs_notice or item.get('reported_task_signature') == signature:
            return
        # Retire obsolete deferred notices before reporting the latest real state.
        def retire(state):
            for run in state['runs']:
                saved = run.get('delegation_snapshot') or {}
                if run['status'] == 'deferred' and saved.get('id') == item['id'] and saved.get('task_signature') != signature:
                    run.update(status='silent', notification={'state': 'suppressed', 'reason': 'stale_result'})
        await self.runtime.mutate(retire)
        if await manager._origin_blocker(item):
            return
        current = resolve_task(await self.runtime.state(), item['id'])
        latest, = await manager.read([item])
        if (current is None or current.get('execution_id') != item.get('execution_id')
                or current.get('followup_state') == 'stopped' or latest['archived']
                or task_signature(latest) != signature):
            return
        labels = {'ready': '待启动', 'waiting': '等待处理', 'failed': '执行失败', 'stopped': '已停止',
                  'completed': '已完成', 'missing': '已不可用', 'running': '需要处理'}
        reasons = {'manual_review': '等待审核', 'tool_approval': '等待工具授权',
                   'user_input': '等待补充信息', 'manual_continue': '等待继续执行'}
        details = [f"{entry['step_key']}：{reasons.get(entry['reason'], '等待处理')}"
                   for entry in snapshot.get('pending_confirmations', [])]
        if snapshot.get('status_reason') in reasons and not details:
            details.append(reasons[snapshot['status_reason']])
        if item.get('startup_error') and snapshot['status'] == 'ready':
            details.append(item['startup_error'])
        if snapshot['status'] == 'completed' and snapshot['content'] and not pending_followup:
            details.append(snapshot['content'][:2000])
        summary = f"委派任务「{item['title']}」{labels.get(snapshot['status'], snapshot['status'])}。"
        if pending_followup:
            state = '已回复' if snapshot.get('coordinator_status') == 'succeeded' else '处理未完成'
            summary = f"委派任务「{item['title']}」的补充指令{state}，原任务尚无新的执行结果。"
            if snapshot.get('coordinator_result'):
                details.append(snapshot['coordinator_result'])
        summary += '\n\n' + '\n'.join(details) if details else ''
        summary = redact(summary) + f"\n\n[打开任务详情]({item['task_detail_url']})"
        notice = {**item, 'question': {'id': signature}}
        outcome = await manager._report(notice, {'action': 'notify', 'summary': summary,
                                                'summary_source': 'system_status'}, progress=True, profile=profile)
        if outcome and outcome.get('state') in {'notified', 'delivery_failed'}:
            item.update(reported_task_signature=signature, notified=True,
                        followup_state='completed' if snapshot['status'] == 'completed' and not pending_followup else 'pending')
            await self._save(item)
