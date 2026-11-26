"""Prepare and apply follow-up for digital-person delegations."""

import asyncio
import uuid
from collections import defaultdict

from models.chat_session import ChatMessage, ChatSession
from models.fields import utc_now
from services.chat_read_state import TERMINAL
from services.digital_person_companion import timestamp
from services.memory_secrets import redact
from services.digital_person_notifications import safe_model_reason
from services.digital_person_tasks import all_executions, find_execution


ACTIVE_TURNS = ('queued', 'running', 'stopping')
FOLLOWUP_LIMIT = 12
CHAT_DELEGATION_LIMIT = 5
EXECUTION_LABELS = {
    'ready': 'Ready', 'waiting': 'Waiting for input or review',
    'queued': 'Queued', 'running': 'Running', 'stopping': 'Stopping',
    'completed': 'Turn ended', 'failed': 'Failed', 'error': 'Failed',
    'stopped': 'Stopped', 'missing': 'Unavailable',
}
FOLLOWUP_LABELS = {
    'completed': 'Closed', 'needs_user': 'Needs input',
    'stopped': 'Tracking stopped', 'superseded': 'Newer turn',
}
DELEGATION_REVIEW_RULES = (
    'Compare the full reply with the original goal. Treat completion claims as reports. '
    'If material gaps remain (untested cases, missing deliverables, or uncertain results), '
    'continue in the original chat when the worker can resolve them. Ask for the specific check '
    'or fix and its evidence, even if the reply says done. Ignore caveats outside the goal. '
    'Use needs_user for a blocker requiring the user or repeated attempts without progress. '
    'To complete, include evidence as a verbatim excerpt of the concrete result from the latest reply.'
)


def _inline_text(text, limit):
    line = ' '.join(redact(text).split())
    if len(line) > limit:
        line = line[:limit - 1] + '…'
    return line.translate(str.maketrans({char: '\\' + char for char in '\\`*_[]<>'}))


def render_delegation_list(items):
    if not items:
        return ''
    lines = ['## Delegations']
    for item in items:
        question = item['question']
        followup = item.get('followup_state')
        status = item['status']
        if item.get('archived'):
            label = 'Archived'
        elif question:
            label = 'Needs approval' if question.get('method') == 'session/request_permission' else 'Needs input'
            if item.get('reported_question') == question['id']:
                label += ' (notified)'
        elif followup == 'pending' and status == 'completed':
            label = 'Follow-up pending'
        else:
            label = FOLLOWUP_LABELS.get(followup) or EXECUTION_LABELS.get(status, 'Unknown')
        goal = _inline_text(item.get('title') or item.get('root_instruction') or item['instruction'], 80)
        lines.append(f"- `{item['id']}` · {goal} · **{label}**")
        if question and question['title']:
            lines.append('  ' + _inline_text(question['title'], 120))
        target = f"task_id={item['task_id']} workflow_id={item.get('workflow_id', '')}" if item.get('task_id') else f"session_id={item['session_id']}"
        lines.append(f"  project_id={item['project_id']} {target} origin_session_id={item['origin_session_id']}")
    return '\n'.join(lines)


class NoDelegationProgress(ValueError):
    pass


def continuation_ids(request_id):
    return tuple(str(uuid.uuid5(uuid.NAMESPACE_URL, f'{request_id}:{role}'))
                 for role in ('input', 'assistant'))


def outstanding(items):
    return [item for item in items if item.get('followup_state') == 'pending']


def latest_per_session(items):
    """Project one task per execution chat; retain individual turns in storage."""
    selected = {}
    for item in sorted(reversed(list(items)), key=lambda row: str(row.get('updated_at') or row.get('created_at', '')), reverse=True):
        key = (item.get('project_id'), 'task' if item.get('task_id') else 'chat',
               item.get('task_id') or item.get('session_id') or item['id'])
        selected.setdefault(key, item)
    return list(selected.values())


def allows_action(item, action):
    return action['action'] in ('needs_user','notify') or (item['status'] == 'completed' and not item['question'])


def validate_actions(actions, sources):
    if not isinstance(actions, list):
        raise ValueError('Invalid delegation actions')
    seen = set()
    for action in actions:
        if not isinstance(action, dict) or not isinstance(action.get('id'), str):
            raise ValueError('Invalid delegation action')
        key = action['id']
        kind = action.get('action')
        body = action.get('instruction') if kind == 'continue' else action.get('summary')
        if (key not in sources or key in seen or kind not in ('continue', 'complete', 'needs_user', 'notify')
                or not isinstance(body, str) or not body.strip() or len(body) > 3000):
            raise ValueError('Invalid delegation action or source')
        if kind == 'continue' and 'summary' in action and (
            not isinstance(action['summary'],str) or not action['summary'].strip() or len(action['summary'])>3000
        ):
            raise ValueError('Invalid delegation notification summary')
        seen.add(key)


class DelegationManagement:
    def __init__(self, runtime):
        self.runtime = runtime
        self.lock = asyncio.Lock()
        self.tracked = {}
        self.questions = {}

    def track(self, item):
        self.tracked[item['project_id'], item['message_id']] = item['id']

    def interaction(self, project_id, message_id, event_type, data):
        key = (project_id, message_id)
        if key not in self.tracked or not data.get('interaction_id'):
            return
        questions = self.questions.setdefault(key, {})
        identifier = data['interaction_id']
        if event_type == 'interaction_response':
            questions.pop(identifier, None)
        else:
            title = data.get('title') or data.get('prompt') or (data.get('tool_call') or {}).get('title')
            questions[identifier] = {'id': identifier, 'method': data.get('method'),
                                     'title': str(title or '')[:500]}

    async def finished(self, project_id, message_id):
        key = (project_id, message_id)
        delegation_id = self.tracked.get(key)
        if delegation_id is None:
            return
        status = await self.runtime.projects.run_db(project_id, lambda _: (
            ChatMessage.select(ChatMessage.status).where(ChatMessage.id == message_id).scalar()
        ))
        if status in TERMINAL:
            await self.update_statuses({(delegation_id, message_id): 'completed' if status == 'succeeded' else status})
            self.tracked.pop(key, None)
            self.questions.pop(key, None)

    async def refresh(self, profile=None):
        if profile is not None and profile.enabled:
            await self.runtime.workflow_delegations.poll(profile)
        state = await self.runtime.state()
        items = [item for item in outstanding(state['delegations'])
                 if not item.get('task_id') and item['status'] not in TERMINAL and item['status'] != 'missing']
        snapshots = await self.read(items)
        previous = {item['id']: item['status'] for item in items}
        changes = {(item['id'], item['message_id']): item['status'] for item in snapshots
                   if previous[item['id']] != item['status']}
        if changes:
            await self.update_statuses(changes)
        if profile is not None:
            from services.digital_person_followup import quiet
            if not quiet(profile):
                async with self.lock:
                    state = await self.runtime.state()
                    items = {identifier:item for item in all_executions(state)
                             for identifier in (item['id'], item.get('execution_id', item['id']))}
                    for run in state['runs']:
                        if not run.get('model_delegation_notice') or run['status']!='deferred':
                            continue
                        item = (run.get('delegation_snapshot') or next(
                            (item for item in all_executions(state) if item.get('notification_run_id') == run['id']), None)
                            or items.get(run.get('delegation_id')))
                        gate = dict(item,question=None) if item else None
                        if gate and gate.get('task_id'):
                            continue  # Workflow polling revalidates the current task snapshot.
                        if gate and await self._still_current(gate):
                            await self._report(dict(item,question=None),run['model_delegation_notice'],
                                               progress=True,profile=profile)


    async def update_statuses(self, changes):
        def update(state):
            for item in all_executions(state):
                key = (item['id'], item['message_id'])
                if key in changes and item['status'] not in TERMINAL:
                    item['status'] = changes[key]
                    item['updated_at'] = utc_now()
        await self.runtime.mutate(update)

    async def for_conversation(self, session_id, state=None):
        state = state if state is not None else await self.runtime.state()
        from services.digital_person_memory import allowed_projects
        from services.digital_person_channels import shared_origins
        origins = await asyncio.to_thread(shared_origins, session_id, state.get('main_session_id'))
        allowed = set(allowed_projects(self.runtime.projects))
        items = latest_per_session([item for item in state['delegations'] if item['origin_session_id'] in origins
                                   and item['project_id'] in allowed])
        selected = items[:CHAT_DELEGATION_LIMIT]
        statuses = {item['id']: item for item in await self.read(selected)}
        return [statuses[item['id']] for item in selected]

    async def read(self, items, *, include_content=False):
        projects = defaultdict(list)
        for item in items:
            projects[item['project_id']].append(item)

        async def from_project(project_id, batch):
            def select(_):
                fields = [ChatMessage.id, ChatMessage.session, ChatMessage.status, ChatSession.id, ChatSession.archived]
                if include_content:
                    fields.extend((ChatMessage.content, ChatMessage.created_at))
                rows = ChatMessage.select(*fields).join(ChatSession).where(
                    ChatSession.project_id == project_id, ChatMessage.id.in_([d['message_id'] for d in batch]))
                chats = {(row.session_id, row.id): (
                    row.status, row.content if include_content else '',
                    row.created_at.isoformat() if include_content and row.created_at else None, row.session.archived,
                ) for row in rows}
                from services.workflow_delegations import read_task
                tasks = {item['task_id']: read_task(item, include_content) for item in batch if item.get('task_id')}
                return chats, tasks

            if self.runtime.projects.get_project_by_id(project_id) is None:
                return [(item, 'missing', '', None, False) for item in batch]
            rows, tasks = await self.runtime.projects.run_db(project_id, select)
            return [(tasks[item['task_id']], tasks[item['task_id']]['status'], tasks[item['task_id']]['content'], None, tasks[item['task_id']]['archived'])
                    if item.get('task_id') else
                    (item, *rows.get((item['session_id'], item['message_id']), ('missing', '', None, False)))
                    for item in batch]

        groups = await asyncio.gather(*(from_project(pid, batch) for pid, batch in projects.items()))
        records = []
        for group in groups:
            for item, status, content, message_created_at, archived in group:
                if status == 'running' and self.runtime.chats.is_turn_queued(item.get('turn_id', '')):
                    status = 'queued'
                if status == 'succeeded':
                    status = 'completed'
                questions = self.questions.get((item['project_id'], item['message_id']), {})
                question = next(iter(questions.values()), None) if status in ACTIVE_TURNS else None
                record = {**item, 'status': status, 'content': content, 'question': question, 'archived': archived}
                if message_created_at:
                    record['message_created_at'] = message_created_at
                records.append(record)
        return records

    async def eligible(self, state):
        from services.digital_person_memory import allowed_projects
        allowed = set(allowed_projects(self.runtime.projects))
        active = [item for item in outstanding(state['delegations'])
                  if not item.get('task_id') and (item['project_id'] in allowed or self.runtime.projects.get_project_by_id(item['project_id']) is None)]
        if not active:
            return []
        home = await self.runtime.home()

        def idle_origins(_):
            ids = {item['origin_session_id'] for item in active}
            busy = ChatMessage.select(ChatMessage.session).where(
                ChatMessage.session.in_(ids), ChatMessage.status.in_(ACTIVE_TURNS))
            return {row.id for row in ChatSession.select(ChatSession.id).where(
                ChatSession.id.in_(ids), ChatSession.archived == False, ChatSession.id.not_in(busy))}

        idle = await self.runtime.projects.run_db(home.id, idle_origins)
        ready = []
        for item in await self.read(active):
            if item['archived']:
                continue
            if item['origin_session_id'] not in idle:
                continue
            questions = self.questions.get((item['project_id'], item['message_id']), {})
            question = next((q for q in questions.values() if q['id'] != item.get('reported_question')), None)
            if item['status'] in TERMINAL or item['status'] == 'missing' or question:
                ready.append({**item, 'question': question})
        return ready[:FOLLOWUP_LIMIT]

    async def recover(self, eligible, profile):
        undecided = []
        async with self.lock:
            for item in eligible:
                saved = item.get('followup_decision')
                question = (item['question'] or {}).get('id')
                if saved and item.get('decision_question') == question:
                    if await self._apply_one(item, saved, profile) is False:
                        undecided.append(item)
                else:
                    undecided.append(item)
        return undecided

    async def attach(self, context, eligible):
        groups = context.get('_groups', [context])
        existing = {(m['project_id'], m['session_id'], m['id'])
                    for group in groups for m in group.get('conversation', [])}
        missing = [item for item in eligible if
                   (item['project_id'], item['session_id'], item['message_id']) not in existing]
        extras = await self.read(missing, include_content=True)
        if extras:
            context['delegation_messages'] = [{
                'id': item['message_id'], 'project_id': item['project_id'], 'session_id': item['session_id'],
                'role': 'assistant', 'content': redact(item['content']),
                **({'created_at': item['message_created_at']} if 'message_created_at' in item else {}),
            } for item in extras]
        context['delegations'] = []
        for item in eligible:
            entry = redact({key: item[key] for key in (
                'id', 'project_id', 'session_id', 'message_id', 'origin_session_id', 'status', 'question',
            )})
            instruction = redact(item['instruction'])
            entry['goal'] = redact(item.get('root_instruction') or item['instruction'])
            if instruction != entry['goal']:
                entry['instruction'] = instruction
            if created_at := timestamp(item.get('created_at')):
                entry['created_at'] = created_at.isoformat()
            if item.get('notified'):
                entry['notified'] = True
            context['delegations'].append(entry)
        context['no_work'] = False

    async def apply(self, actions, eligible, profile, *, audit=None):
        sources = {item['id']: item for item in eligible}
        validate_actions(actions, sources)
        applied = set()
        async with self.lock:
            for action in actions:
                item = sources[action['id']]
                if not allows_action(item, action):
                    if audit is not None:
                        audit.append({'state':'suppressed','reason':'action_not_applicable'})
                    continue
                outcome = await self._apply_one(item, redact(action), profile)
                if audit is not None:
                    audit.append(outcome if isinstance(outcome, dict) else
                                 {'state':'suppressed','reason':'invalid_evidence' if outcome is False else 'unknown'})
                if outcome is not False:
                    applied.add(item['id'])
            for item in eligible:
                if (item['status'] == 'stopped' and not item['question'] and item['id'] not in applied
                        and await self._still_current(item)):
                    # A reviewed interruption with no applicable action needs no further assessment.
                    await self._finish(item, 'stopped')
        return applied


    async def _apply_one(self, item, action, profile):
        runtime = self.runtime
        if not await self._still_current(item):
            return {'state':'suppressed','reason': await self._origin_blocker(item) or 'stale_result'}
        def reserve(state):
            target = find_execution(state, item)
            if target.get('followup_state') != 'pending':
                return None
            if item['question'] and target.get('reported_question') == item['question']['id']:
                return None
            question_id = (item['question'] or {}).get('id')
            if target.get('decision_question') != question_id:
                target.pop('followup_decision', None)
            target['decision_question'] = question_id
            return target.setdefault('followup_decision', action)

        saved = await runtime.mutate(reserve)
        if saved is None:
            return {'state':'suppressed','reason':'duplicate'}
        if saved['action'] == 'continue':
            if item['status'] != 'completed':
                await self._finish(item, 'needs_user')
                return
            try:
                await runtime.delegate(
                    item['project_id'], saved['instruction'], item['origin_session_id'],
                    f"delegation-followup:{item['id']}:{item['message_id']}", item['id'],
                    automatic_result_id=item['message_id'],
                )
            except NoDelegationProgress:
                stalled = {'action': 'needs_user', 'summary':
                           f"委派「{item.get('root_instruction', item['instruction'])[:100]}」在续办后返回了相同结果，已暂停自动跟进。"}
                await runtime.mutate(lambda state: find_execution(state, item).update(followup_decision=stalled))
                return await self._report(item, stalled, profile=profile)
            except Exception:
                notice = await self._report(item, {'action':'notify','summary':
                    f"委派「{safe_model_reason(item.get('title') or item.get('root_instruction') or item['instruction'])[:80]}」自动跟进提交异常，"
                    f"是否已进入执行尚未确认。执行会话：{item['session_id']}（项目：{item['project_id']}），请查看该会话。",'summary_source':'system_status'},
                    progress=True, profile=profile)
                await self._finish(item, 'needs_user')
                return notice
            notice_decision = saved if saved.get('summary') else dict(saved,
                summary=f"委派「{safe_model_reason(item.get('title') or item.get('root_instruction') or item['instruction'])[:80]}」已提交自动跟进，等待执行结果。",
                summary_source='system_status')
            notice = await self._report(item,notice_decision,progress=True,profile=profile)
            await self._finish(item, 'continued')
            return notice
        if item['status'] in TERMINAL:
            completing = saved['action'] == 'complete'

            def latest_result(_):
                fields = [ChatMessage.id]
                if completing:
                    fields.append(ChatMessage.content)
                row = ChatMessage.select(*fields).where(ChatMessage.session == item['session_id'],
                    ChatMessage.role == 'assistant').order_by(ChatMessage.created_at.desc()).first()
                return (row.id, row.content if completing else '') if row else (None, '')

            latest, content = await runtime.projects.run_db(item['project_id'], latest_result)
            if latest != item['message_id']:
                await self._finish(item, 'superseded')
                return {'state':'suppressed','reason':'stale_result'}
            if completing:
                evidence = saved.get('evidence')
                excerpt = ' '.join(evidence.split()) if isinstance(evidence, str) else ''
                if not excerpt or len(excerpt) > 320 or excerpt not in ' '.join(redact(content).split()):
                    def release(state):
                        target = find_execution(state, item)
                        if target.get('followup_decision') == saved:
                            target.pop('followup_decision', None)
                            target.pop('decision_question', None)
                    await runtime.mutate(release)
                    return False
        return await self._report(item, saved, profile=profile)

    async def _still_current(self, item):
        if await self._execution_archived(item):
            return False
        question = item['question']
        if question and question['id'] not in self.questions.get((item['project_id'], item['message_id']), {}):
            return False
        return await self._origin_blocker(item) is None

    async def _execution_archived(self, item):
        if self.runtime.projects.get_project_by_id(item['project_id']) is None:
            return False
        if item.get('task_id'):
            from models import Task
            return bool(await self.runtime.projects.run_db(item['project_id'], lambda _: Task.select(
                Task.archived).where(Task.id == item['task_id']).scalar()))
        return bool(await self.runtime.projects.run_db(item['project_id'], lambda _: (
            ChatSession.select(ChatSession.archived).where(
                ChatSession.id == item['session_id'], ChatSession.project_id == item['project_id'],
            ).scalar()
        )))

    async def _origin_blocker(self, item):
        home = await self.runtime.home()
        def read(_):
            session = ChatSession.get_or_none(ChatSession.id == item['origin_session_id'])
            if session is None or session.archived:
                return 'target_missing'
            if ChatMessage.select().where(ChatMessage.session == item['origin_session_id'],
                                           ChatMessage.status.in_(ACTIVE_TURNS)).exists():
                return 'source_busy'
            return None
        return await self.runtime.projects.run_db(home.id, read)

    @staticmethod
    def _result_state(item, decision):
        if decision['action']=='complete':
            return 'completed'
        if decision['action']=='notify':
            return 'stopped' if item['status']=='stopped' else 'needs_user' if item['status'] in ('failed','error','missing') else 'pending'
        return 'needs_user'

    async def _report(self, item, decision, *, progress=False, profile=None):
        if await self._execution_archived(item):
            return {'state':'suppressed','reason':'execution_archived'}
        runtime = self.runtime
        question = item['question']
        run_key = f"{item['id']}:{question['id'] if question else item['message_id']}" + (':progress' if progress else '')
        run_id = str(uuid.uuid5(uuid.NAMESPACE_URL, 'workstep-managed-delegation:' + run_key))
        from services.digital_person_followup import quiet
        if profile is None:
            from services.digital_person import get_profile
            profile = await asyncio.to_thread(get_profile)
        blocker = await self._origin_blocker(item)
        deferred = quiet(profile) or blocker is not None
        notification = {'state':'deferred' if deferred else 'notifying',
                        'reason':'quiet_hours' if quiet(profile) else blocker or 'unknown'}
        run = {'id': run_id, 'created_at': utc_now(), 'trigger': 'delegation', 'kind': 'work',
               'origin_session_id': item['origin_session_id'], 'notification_sources': [item['id']],
               'delegation_execution_id': item.get('execution_id', item['id']),
               'status': 'deferred' if deferred else 'notifying', 'summary': decision['summary'], 'sources': {}, 'deliveries': [],
               'managed_followup': True, 'automatic_followup': True}
        run['notification'] = notification
        if progress:
            run.update(model_delegation_notice=decision,delegation_id=item['id'],
                       delegation_snapshot={key:value for key,value in item.items() if key != 'content'})

        def reserve(state):
            target = find_execution(state, item)
            if not progress and target.get('followup_state') != 'pending':
                return False
            existing=next((row for row in state['runs'] if row['id']==run_id),None)
            if existing:
                if existing['status']!='deferred' or deferred:
                    return False
                run['created_at']=existing['created_at']
                existing.update(run)
                return True
            if target.get('notification_run_id') == run_id:
                return False
            target['notification_run_id'] = run_id
            state['runs'].insert(0, run.copy())
            return not deferred

        reserved = await runtime.mutate(reserve)
        if reserved:
            run['notification_attempted_at'] = utc_now().isoformat()
            try:
                run['deliveries'] = await runtime._notify(run['summary'], [item['id']], run_id)
                run['status'] = 'notified' if run['deliveries'] and all(row['status'] == 'delivered'
                                                  for row in run['deliveries']) else 'delivery_failed'
                if any(row['status']=='delivered' for row in run['deliveries']):
                    run['notified_at'] = utc_now().isoformat()
            except Exception as exc:
                run.update(status='delivery_failed', error=str(exc)[:500])
            run['ended_at'] = utc_now()
            run['notification'] = {'state':run['status'], 'reason':'delivered' if run['status']=='notified'
                                   else 'delivery_failed' if run['deliveries'] or run.get('error') else 'no_targets'}
            await runtime.mutate(lambda state: next(row for row in state['runs']
                                                    if row['id'] == run_id).update(run))
        else:
            state = await runtime.state()
            existing = next((row for row in state['runs'] if row['id'] == run_id), None)
            if existing and existing['status']=='deferred':
                return {**existing.get('notification', notification), 'run_id':run_id}
            if existing and existing['status'] in ('interrupted', 'notifying'):
                # The local message ID is stable even if a previous attempt committed it.
                await runtime._deliver_local(item['origin_session_id'], run['summary'], run_id, reflection=True)
                receipt = {'kind': 'local', 'session_id': item['origin_session_id'], 'status': 'delivered'}
                await runtime.mutate(lambda state: next(row for row in state['runs'] if row['id'] == run_id).update(
                    deliveries=[receipt], ended_at=utc_now(), status='notified'))
        if progress:
            await runtime.mutate(lambda state: find_execution(state, item).update(notified=True,notification_run_id=run_id))
            return {**run['notification'], 'run_id':run_id}
        await self._finish(item, 'pending' if question else self._result_state(item,decision),
                           run_id=run_id, question=question)
        return {**run['notification'], 'run_id':run_id}

    async def _finish(self, item, status, *, run_id=None, question=None):
        def finish(state):
            target = find_execution(state, item)
            if target.get('followup_state') != 'pending':
                return
            target.update(followup_state=status, status=item['status'])
            target['updated_at'] = utc_now()
            target.pop('followup_decision', None)
            target.pop('decision_question', None)
            if question:
                target['reported_question'] = question['id']
            if run_id:
                target.update(notified=True, notification_run_id=run_id)
        await self.runtime.mutate(finish)
