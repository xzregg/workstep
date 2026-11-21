"""Prepare and apply follow-up for digital-person delegations."""

import asyncio
import json
import uuid
from collections import defaultdict
from datetime import datetime
from peewee import fn

from models.chat_session import ChatMessage, ChatSession
from models.fields import utc_now
from services.chat_read_state import TERMINAL
from services.memory_secrets import redact


ACTIVE_TURNS = ('queued', 'running', 'stopping')
FOLLOWUP_LIMIT = 12
CHAT_DELEGATION_LIMIT = 5
EXECUTION_LABELS = {
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
        if question:
            label = 'Needs approval' if question.get('method') == 'session/request_permission' else 'Needs input'
            if item.get('reported_question') == question['id']:
                label += ' (notified)'
        elif followup == 'pending' and status == 'completed':
            label = 'Follow-up pending'
        else:
            label = FOLLOWUP_LABELS.get(followup) or EXECUTION_LABELS.get(status, 'Unknown')
        goal = _inline_text(item.get('root_instruction') or item['instruction'], 80)
        lines.append(f"- `{item['id']}` · {goal} · **{label}**")
        if question and question['title']:
            lines.append('  ' + _inline_text(question['title'], 120))
    return '\n'.join(lines)


class NoDelegationProgress(ValueError):
    pass


def continuation_ids(request_id):
    return tuple(str(uuid.uuid5(uuid.NAMESPACE_URL, f'{request_id}:{role}'))
                 for role in ('input', 'assistant'))


def outstanding(items):
    return [item for item in items if item.get('followup_state') == 'pending']


def actionable(item):
    question = item['question']
    if item.get('followup_state') != 'pending' or item.get('followup_decision'):
        return False
    return (item['status'] in TERMINAL or item['status'] == 'missing'
            or bool(question and question['id'] != item.get('reported_question')))


def allows_action(item, action):
    return action['action'] == 'needs_user' or (item['status'] == 'completed' and not item['question'])


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
        if (key not in sources or key in seen or kind not in ('continue', 'complete', 'needs_user')
                or not isinstance(body, str) or not body.strip() or len(body) > 3000):
            raise ValueError('Invalid delegation action or source')
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
            await self.update_statuses({delegation_id: 'completed' if status == 'succeeded' else status})
            self.tracked.pop(key, None)
            self.questions.pop(key, None)

    async def refresh(self):
        state = await self.runtime.state()
        items = [item for item in outstanding(state['delegations'])
                 if item['status'] not in TERMINAL and item['status'] != 'missing']
        snapshots = await self.read(items)
        previous = {item['id']: item['status'] for item in items}
        changes = {item['id']: item['status'] for item in snapshots if previous[item['id']] != item['status']}
        if changes:
            await self.update_statuses(changes)

    async def update_statuses(self, changes):
        def update(state):
            for item in state['delegations']:
                if item['id'] in changes and item['status'] not in TERMINAL:
                    item['status'] = changes[item['id']]
        await self.runtime.mutate(update)

    async def for_conversation(self, session_id, state=None):
        state = state if state is not None else await self.runtime.state()
        from services.digital_person_memory import allowed_projects
        allowed = set(allowed_projects(self.runtime.projects))
        items = [item for item in state['delegations'] if item['origin_session_id'] == session_id
                 and item['project_id'] in allowed
                 and item.get('followup_state') != 'continued']
        def priority(item):
            questions = self.questions.get((item['project_id'], item['message_id']), {})
            if any(key != item.get('reported_question') for key in questions):
                return 0
            if item.get('followup_state') == 'pending' and item['status'] in TERMINAL:
                return 1
            return 2

        selected = sorted(reversed(items), key=priority)[:CHAT_DELEGATION_LIMIT]
        statuses = {item['id']: item for item in await self.read(selected)}
        return [statuses[item['id']] for item in selected]

    async def read(self, items, *, include_content=False):
        projects = defaultdict(list)
        for item in items:
            projects[item['project_id']].append(item)

        async def from_project(project_id, batch):
            def select(_):
                fields = [ChatMessage.id, ChatMessage.session, ChatMessage.status]
                if include_content:
                    fields.append(ChatMessage.content)
                rows = ChatMessage.select(*fields).where(ChatMessage.id.in_([d['message_id'] for d in batch]))
                return {(row.session_id, row.id): (
                    row.status, row.content if include_content else '',
                ) for row in rows}

            if self.runtime.projects.get_project_by_id(project_id) is None:
                return [(item, 'missing', '') for item in batch]
            rows = await self.runtime.projects.run_db(project_id, select)
            return [(item, *rows.get((item['session_id'], item['message_id']), ('missing', '')))
                    for item in batch]

        groups = await asyncio.gather(*(from_project(pid, batch) for pid, batch in projects.items()))
        records = []
        for group in groups:
            for item, status, content in group:
                if status == 'running' and self.runtime.chats.is_turn_queued(item.get('turn_id', '')):
                    status = 'queued'
                if status == 'succeeded':
                    status = 'completed'
                questions = self.questions.get((item['project_id'], item['message_id']), {})
                question = next(iter(questions.values()), None) if status in ACTIVE_TURNS else None
                records.append({**item, 'status': status, 'content': content, 'question': question})
        return records

    async def eligible(self, state):
        from services.digital_person_memory import allowed_projects
        allowed = set(allowed_projects(self.runtime.projects))
        active = [item for item in outstanding(state['delegations'])
                  if item['project_id'] in allowed or self.runtime.projects.get_project_by_id(item['project_id']) is None]
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
        for item in active:
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

    async def recover_foreground(self, eligible, profile):
        if not eligible:
            return eligible
        home = await self.runtime.home()
        sources = {item['id']: item for item in eligible}
        origins = {item['origin_session_id'] for item in eligible}
        timestamps = [datetime.fromisoformat(str(item['created_at'])) for item in eligible if item.get('created_at')]

        def read(_):
            rows = ChatMessage.select(ChatMessage.session, ChatMessage.context_json).where(
                ChatMessage.session.in_(origins), ChatMessage.role == 'assistant',
                ChatMessage.status.in_(('completed', 'succeeded')),
                fn.INSTR(ChatMessage.context_json, '"delegation_followup"') > 0,
            ).order_by(ChatMessage.created_at.desc())
            if len(timestamps) == len(eligible):
                rows = rows.where(ChatMessage.created_at >= min(timestamps))
            settled = {}
            for row in rows:
                for receipt in json.loads(row.context_json).get('delegation_followup', []):
                    action = receipt['action']
                    item = sources.get(action['id'])
                    if (item and item['origin_session_id'] == row.session_id
                            and receipt['result_id'] == item['message_id']
                            and receipt['question_id'] == (item['question'] or {}).get('id')
                            and allows_action(item, action)):
                        settled.setdefault(action['id'], action)
            return settled

        saved = await self.runtime.projects.run_db(home.id, read)
        applied = set()
        if saved:
            applied = await self.apply(list(saved.values()), eligible, profile, foreground=True)
        return [item for item in eligible if item['id'] not in applied]

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
            } for item in extras]
        context['delegations'] = [redact({key: item[key] for key in (
            'id', 'project_id', 'session_id', 'message_id', 'origin_session_id', 'instruction',
            'status', 'question',
        )} | {'goal': item.get('root_instruction', item['instruction'])}) for item in eligible]
        context['no_work'] = False

    async def apply(self, actions, eligible, profile, *, foreground=False):
        sources = {item['id']: item for item in eligible}
        validate_actions(actions, sources)
        applied = set()
        async with self.lock:
            for action in actions:
                item = sources[action['id']]
                if not allows_action(item, action):
                    continue
                if await self._apply_one(item, redact(action), profile, foreground=foreground) is not False:
                    applied.add(item['id'])
        return applied

    async def _apply_one(self, item, action, profile, *, foreground=False):
        runtime = self.runtime
        if not await self._still_current(item, foreground=foreground):
            return
        def reserve(state):
            target = next(row for row in state['delegations'] if row['id'] == item['id'])
            if target.get('followup_state') != 'pending':
                return None
            if foreground and target.get('followup_decision'):
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
            return
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
                await runtime.mutate(lambda state: next(
                    row for row in state['delegations'] if row['id'] == item['id']
                ).update(followup_decision=stalled))
                from services.digital_person_followup import quiet
                if not quiet(profile):
                    await self._report(item, stalled)
                return
            except ValueError:
                await self._finish(item, 'needs_user')
                return
            await self._finish(item, 'continued')
            return
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
                return
            if completing:
                evidence = saved.get('evidence')
                excerpt = ' '.join(evidence.split()) if isinstance(evidence, str) else ''
                if not excerpt or len(excerpt) > 320 or excerpt not in ' '.join(redact(content).split()):
                    def release(state):
                        target = next(row for row in state['delegations'] if row['id'] == item['id'])
                        if target.get('followup_decision') == saved:
                            target.pop('followup_decision', None)
                            target.pop('decision_question', None)
                    await runtime.mutate(release)
                    return False
        if foreground:
            await self._finish(item, 'pending' if item['question'] else
                               'completed' if saved['action'] == 'complete' else 'needs_user',
                               reported=True, question=item['question'])
            return
        from services.digital_person_followup import quiet
        if quiet(profile):
            return
        await self._report(item, saved)

    async def _still_current(self, item, *, foreground):
        home = await self.runtime.home()
        question = item['question']
        if question and question['id'] not in self.questions.get((item['project_id'], item['message_id']), {}):
            return False
        return await self.runtime.projects.run_db(home.id, lambda _: (
            ChatSession.select().where(ChatSession.id == item['origin_session_id'],
                                       ChatSession.archived == False).exists()
            and (foreground or not ChatMessage.select().where(ChatMessage.session == item['origin_session_id'],
                                                              ChatMessage.status.in_(ACTIVE_TURNS)).exists())
        ))

    async def _report(self, item, decision):
        runtime = self.runtime
        question = item['question']
        run_key = f"{item['id']}:{question['id'] if question else item['message_id']}"
        run_id = str(uuid.uuid5(uuid.NAMESPACE_URL, 'workstep-managed-delegation:' + run_key))
        run = {'id': run_id, 'created_at': utc_now(), 'trigger': 'delegation', 'kind': 'work',
               'origin_session_id': item['origin_session_id'], 'notification_sources': [item['id']],
               'status': 'notifying', 'summary': decision['summary'], 'sources': {}, 'deliveries': [],
               'managed_followup': True}

        def reserve(state):
            target = next(row for row in state['delegations'] if row['id'] == item['id'])
            if target.get('followup_state') != 'pending' or target.get('notification_run_id') == run_id:
                return False
            target['notification_run_id'] = run_id
            state['runs'].insert(0, run.copy())
            return True

        reserved = await runtime.mutate(reserve)
        if reserved:
            try:
                run['deliveries'] = await runtime._notify(run['summary'], [item['id']], run_id)
                run['status'] = 'notified' if run['deliveries'] and all(row['status'] == 'delivered'
                                                  for row in run['deliveries']) else 'delivery_failed'
            except Exception as exc:
                run.update(status='delivery_failed', error=str(exc)[:500])
            run['ended_at'] = utc_now()
            await runtime.mutate(lambda state: next(row for row in state['runs']
                                                    if row['id'] == run_id).update(run))
        else:
            state = await runtime.state()
            existing = next((row for row in state['runs'] if row['id'] == run_id), None)
            if existing and existing['status'] in ('interrupted', 'notifying'):
                # The local message ID is stable even if a previous attempt committed it.
                await runtime._deliver_local(item['origin_session_id'], run['summary'], run_id, reflection=True)
                receipt = {'kind': 'local', 'session_id': item['origin_session_id'], 'status': 'delivered'}
                await runtime.mutate(lambda state: next(row for row in state['runs'] if row['id'] == run_id).update(
                    deliveries=[receipt], ended_at=utc_now(), status='notified'))
        await self._finish(item, 'pending' if question else
                           'completed' if decision['action'] == 'complete' else 'needs_user',
                           run_id=run_id, question=question)

    async def _finish(self, item, status, *, run_id=None, question=None, reported=False):
        def finish(state):
            target = next(row for row in state['delegations'] if row['id'] == item['id'])
            if target.get('followup_state') != 'pending':
                return
            target.update(followup_state=status, status=item['status'])
            target.pop('followup_decision', None)
            target.pop('decision_question', None)
            if question:
                target['reported_question'] = question['id']
            if run_id:
                target.update(notified=True, notification_run_id=run_id)
            elif reported:
                target.update(notified=True, notification_state='notified')
        await self.runtime.mutate(finish)
