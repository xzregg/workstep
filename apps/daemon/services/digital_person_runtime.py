"""Device companion orchestration. Project data is accessed only through run_db.

Operational state is not a memory store: it contains session pointers, pending
work, delivery receipts and bounded audit records. It never learns prompt rules.
"""
import asyncio
import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from models.chat_session import ChatSession, ChatMessage, ProjectSetting
from models.fields import utc_now
from services import customization_workspace, digital_person
from services import digital_person_memory_index as memory_index
from services.memory_secrets import redact

KEY = 'digital_person_runtime'
CHECK_SESSION_TITLE = '主动思考'


def completed_activity_processing(run):
    knowledge=(run.get('memory_processing') or {}).get('knowledge') or {}
    batch=(run.get('sources') or {}).get('reflection_batch',[])
    sessions=len({(row['project_id'],row['session_id']) for row in batch})
    return {'messages': knowledge.get('processed', 0), 'sessions': sessions, 'memories': knowledge.get('created', 0),
            **({'changes':knowledge['changes']} if 'changes' in knowledge else {})}


def resolve_check_sources(context, references):
    """Resolve exact current-batch read aliases; reject unknown or ambiguous origins."""
    if not isinstance(references, list) or any(not isinstance(value, str) for value in references):
        raise ValueError('The format of the source reference number is incorrect.')
    aliases = {}
    for group in context.get('_groups', [context]):
        for key in ('messages', 'delegations', 'conversation', 'memory', 'thought_sources'):
            for row in group.get(key, []):
                target = (group.get('origin_project_id'), group.get('origin_session_id'), row['id'])
                for value in [row['id'], *row.get('memory_ids', []), *row.get('read_ids', [])]:
                    if isinstance(value, str):
                        aliases.setdefault(value, set()).add(target)
    unknown = sum(not aliases.get(value) for value in references)
    ambiguous = sum(len(aliases.get(value, ())) > 1 for value in references)
    if unknown:
        raise ValueError(f'Of the {len(references)} sources cited in this round, {unknown} could not be matched to the current batch of messages, so the results were not adopted.')
    if ambiguous:
        raise ValueError(f'The {ambiguous} sources cited in this round correspond to multiple sessions; the results for this round have not been adopted.')
    return list(dict.fromkeys(next(iter(aliases[value]))[2] for value in references))


def activity_failure_reason(run):
    error = run.get('error')
    if not error:
        return None
    if error in {'Invalid sources in the check result', '检查结果来源无效'}:
        return 'Could not match the reflection to its source messages. The result was discarded.'
    if error in {'The CLI has not fetched the messages to review', '尚未调用 CLI 获取待整理消息'}:
        return 'Reflection could not finish because it did not fetch the pending messages.'
    if 'JSON' in error or 'result structure' in error or '结果结构' in error:
        return 'Reflection could not finish because its result was incomplete or malformed.'
    if 'not yet read' in error or '尚未读取' in error:
        return 'Some required messages were not read. The reflection result was discarded.'
    if error.startswith('Source changed during thinking') or '来源已变化' in error:
        return 'The source messages changed during reflection. The previous result was discarded.'
    return str(error)


def is_notification_run(run):
    return bool(run.get('deliveries') or run.get('notification_key') or
                run.get('status') in ('notify', 'notifying', 'notified', 'delivery_failed', 'deferred'))


def activity_record_content(run, *, preview=False):
    processing = run.get('processing')
    if processing is None:
        legacy = re.match(r'^整理 (\d+) 条消息（(\d+) 个会话），新增 (\d+) 条记忆', run.get('activity_summary') or '')
        if legacy:
            messages, sessions, memories = map(int, legacy.groups())
            processing = {'messages': messages, 'sessions': sessions, 'memories': memories}
    status = run.get('status')
    thought = '' if is_notification_run(run) else str(run.get('summary') or '')
    if preview:
        thought = '' if processing is not None or status in ('failed', 'error') else thought[:120]
    return {'summary': thought, **({'processing': processing} if processing is not None else {})}


def activity_outcome(run):
    """Small factual projection; never expose recipients or relationship source data."""
    receipts = run.get('deliveries') or []
    if run.get('status') == 'running' or (not receipts and ('deliveries' not in run or 'relationship_updates' not in run)):
        return None
    changes = [row.get('affinity_delta', 0) for row in run.get('relationship_updates') or []]
    failures = [row for row in receipts if row.get('status') in ('failed', 'delivery_failed')]
    reasons = dict.fromkeys(redact(str(row.get('error') or '')).strip() for row in failures)
    reasons.pop('', None)
    return {
        **({'delivery_failure_reasons': list(reasons)} if reasons else {}),
        'sent': sum(row.get('status') == 'delivered' for row in receipts),
        'failed': len(failures),
        'affinity_increased': sum(max(delta, 0) for delta in changes),
        'affinity_decreased': -sum(min(delta, 0) for delta in changes),
    }


def assessment_audit(context):
    """Keep source coordinates in operational history, never copied message bodies."""
    result={key:value for key,value in context.items() if not key.startswith('_')}
    for key in ('messages','conversation','memory','thought_sources','delegation_messages'):
        if key in result:
            result[key]=[{k:v for k,v in row.items() if k not in ('content','source_text','_end')} for row in result[key]]
    if context.get('_groups'):
        result['conversations']=[assessment_audit(group) for group in context['_groups']]
    return result


def _rename_check_session(session_id):
    """Migrate the registered current title inside its project DB executor."""
    if session_id:
        ChatSession.update(title=CHECK_SESSION_TITLE).where(
            ChatSession.id == session_id, ChatSession.title == '主动检查',
            ChatSession.archived == False,
        ).execute()


def read_state(project_id):
    saved = memory_index.read_state(KEY)
    if saved is not None:
        return saved
    row = ProjectSetting.get_or_none(ProjectSetting.project_id == project_id, ProjectSetting.key == KEY)
    value = json.loads(row.value_json) if row else {'main_session_id': '', 'runs': [], 'delegations': [], 'feedback': {}, 'cursor': '', 'last_check': ''}
    if row:
        with memory_index.connect() as db:
            db.execute('INSERT OR IGNORE INTO state VALUES(?,?)', (KEY,json.dumps(value,ensure_ascii=False)))
    return value


def write_state(project_id, state):
    def replace(value):
        value.clear()
        value.update(state)
    memory_index.mutate_state(KEY,replace)


def parse_check_result(content):
    """Validate model output before it can influence cursor or delivery state."""
    body = content.strip()
    if not body:
        raise ValueError('Active check did not return results. Please check the digital human engine configuration and retry.')
    if body in ('NO_REPLY', '[SILENT]', 'HEARTBEAT_OK'):
        return {'decision': 'silent', 'summary': '无需要通知的新变化', 'source_ids': []}
    if '<json>' in body or '</json>' in body:
        prefix, opening, payload = body.partition('<json>')
        if not opening or '</json>' in prefix:
            raise ValueError('The active check result requires a unique and complete <json>...</json> tag')
        try:
            payload = payload.lstrip()
            _, end = json.JSONDecoder().raw_decode(payload)
        except json.JSONDecodeError as exc:
            raise ValueError('Actively check that the label is not valid JSON') from exc
        remainder = payload[end:].lstrip()
        if (not remainder.startswith('</json>') or '<json>' in remainder[7:]
                or '</json>' in remainder[7:]):
            raise ValueError('The active check result requires a unique and complete <json>...</json> tag')
        body = payload[:end]
    lines = body.splitlines()
    if len(lines) >= 3 and lines[0].strip().lower() in ('```', '```json') and lines[-1].strip() == '```':
        body = '\n'.join(lines[1:-1]).strip()
    try:
        result = json.loads(body)
    except json.JSONDecodeError as exc:
        import re
        blocks = re.findall(r'^```([^\r\n]*)\r?\n(.*?)^```[ \t]*$', body,
                            flags=re.MULTILINE | re.DOTALL | re.IGNORECASE)
        if len(blocks) != 1 or blocks[0][0].strip().lower() not in ('', 'json'):
            raise ValueError('The active check result is not valid JSON. Please retry or switch the digital human engine.') from exc
        try:
            result = json.loads(blocks[0][1])
        except json.JSONDecodeError as block_error:
            raise ValueError('The active check result is not valid JSON. Please retry or switch the digital human engine.') from block_error
    if (not isinstance(result, dict) or result.get('decision') not in ('silent', 'notify')
            or not isinstance(result.get('summary'), str)
            or not isinstance(result.get('source_ids'), list)
            or any(not isinstance(item, str) for item in result['source_ids'])):
        raise ValueError('The active check result structure is invalid. Please retry or switch to a different digital human engine.')
    return result


class DigitalPersonRuntime:
    def __init__(self, projects, chats, bots, bus):
        self.projects, self.chats, self.bots, self.bus = projects, chats, bots, bus
        self._check_lock = asyncio.Lock()
        self._delegate_lock = asyncio.Lock()
        self._loop_task = None
        self._cycle_task = None
        self._active_check = None
        self._active_assessment_task = None
        from services.digital_person_followup import DelegationFollower
        from services.digital_person_delegations import DelegationManagement
        self._follower = DelegationFollower(self)
        self.delegation_management = DelegationManagement(self)
        self.chats.digital_person_delegations = self.delegation_management

    async def home(self):
        return await customization_workspace.ensure_default_workspace(self.projects)

    async def main_session(self):
        home = await self.home()
        profile = await asyncio.to_thread(digital_person.get_profile)
        def operation(_):
            state = read_state(home.id)
            row = ChatSession.get_or_none(ChatSession.id == state['main_session_id'], ChatSession.archived == False)
            if row:
                return self.chats.get_session(home.id, row.id), None
            previous = state['main_session_id']
            result = self.chats.create_session(home.id, title=profile.name)
            state['main_session_id'] = result['id']
            write_state(home.id, state)
            return result, previous
        result, previous = await self.projects.run_db(home.id, operation)
        if previous:
            from services.chat_session_retention import release_main_session_retention
            await release_main_session_retention(home.id, previous)
        return result

    async def face_welcome_activity(self):
        home = await self.home()

        def read(_):
            session = read_state(home.id).get('main_session_id')
            if not session:
                return None, False
            rows = ChatMessage.select().where(ChatMessage.session == session)
            last_user = rows.where(ChatMessage.role == 'user').order_by(ChatMessage.created_at.desc()).first()
            message = ({'id': last_user.id, 'role': last_user.role, 'created_at': last_user.created_at,
                        'content': last_user.content} if last_user else None)
            return message, rows.where(ChatMessage.status.in_(['queued', 'running', 'stopping'])).exists()

        return await self.projects.run_db(home.id, read)

    async def state(self):
        home = await self.home()
        return await self.projects.run_db(home.id, lambda _: read_state(home.id))

    async def mutate(self, change):
        home = await self.home()
        def operation(_):
            return memory_index.mutate_state(KEY, change, default=read_state(home.id))
        return await self.projects.run_db(home.id, operation)

    async def overview(self):
        home = await self.home()
        def operation(_):
            state = read_state(home.id)
            answers = list(ChatMessage.select(ChatMessage.id, ChatMessage.content, ChatMessage.created_at)
                           .where(ChatMessage.session.not_in(state.get('check_sessions', [])), ChatMessage.role == 'assistant', ChatMessage.status.in_(['completed', 'succeeded']))
                           .order_by(ChatMessage.created_at.desc()).limit(500))
            feedback = state['feedback']
            from services.digital_person_statistics import read_statistics
            statistics = read_statistics(state)
            return {**state, **statistics, 'suggestions': [], 'checking': self._check_lock.locked(),
                    'answers': [{'id': row.id, 'content': row.content[:300], 'feedback': feedback.get(row.id, 0)} for row in answers[:20]]}
        from services.digital_person_statistics import enabled_skills
        result, skills = await asyncio.gather(self.projects.run_db(home.id, operation), asyncio.to_thread(enabled_skills, home))
        return {**result, 'skills': skills}

    async def activity_records(self, run_offset=0, delegation_offset=0, limit=5):
        """Small list projection; do not load statistics, skills or message bodies."""
        home = await self.home()
        def read(_):
            state = read_state(home.id)
            all_runs = state.get('runs', [])
            runs = [row for row in all_runs if row.get('trigger') != 'delegation']
            delivery_runs = {row['id']: row for row in all_runs}
            delegations = sorted(state.get('delegations', []),
                                 key=lambda item: str(item.get('created_at', '')), reverse=True)
            def notification(item):
                run_id = item.get('notification_run_id') or str(uuid.uuid5(
                    uuid.NAMESPACE_URL, 'workstep-delegation:' + item['id']))
                delivery = delivery_runs.get(run_id)
                value = item.get('notification_state')
                if value != 'read' and delivery is not None:
                    value = delivery.get('status')
                return {'notification_state': value or 'pending',
                        'notification_run_id': run_id if delivery else None}
            return {
                'checking': self._check_lock.locked(),
                'run_total': len(runs),
                'reflection_count': state.get('reflection_count', len(runs)),
                'reflection_count_lower_bound': state.get('reflection_count_lower_bound', len(all_runs) >= 100),
                'delegation_total': len(delegations),
                'delegation_pending': any((d.get('followup_state') == 'pending' if d.get('followup_state')
                                           else not d.get('notified'))
                                          or notification(d)['notification_state'] == 'notifying' for d in delegations),
                'delegations': [{**{key: row.get(key) for key in ('id', 'project_id', 'session_id', 'message_id', 'turn_id', 'title', 'status', 'followup_state', 'created_at')},
                                 'instruction': str(row.get('instruction') or '')[:120], **notification(row)}
                                for row in delegations[delegation_offset:delegation_offset + limit]],
                'runs': [{**{key: row.get(key) for key in ('id', 'status', 'created_at')},
                          'outcome': activity_outcome(row),
                          **activity_record_content(row, preview=True)}
                         for row in runs[run_offset:run_offset + limit]],
            }
        result = await self.projects.run_db(home.id, read)
        from services.chat_read_state import TERMINAL, is_read
        groups = {}
        for row in result['delegations']:
            row['result_viewed'] = (row['notification_state'] == 'read') if row['status'] in TERMINAL else None
            if row['project_id'] and row['message_id']:
                groups.setdefault(row['project_id'], []).append(row)

        async def hydrate(project_id, rows):
            def status_from_messages(_):
                messages = ChatMessage.select(ChatMessage.id, ChatMessage.session, ChatMessage.status,
                                              ChatMessage.created_at).join(ChatSession).where(
                    ChatSession.project_id == project_id, ChatMessage.role == 'assistant',
                    ChatMessage.id.in_({row['message_id'] for row in rows}))
                by_id = {message.id: message for message in messages}
                projection = []
                for row in rows:
                    message = by_id.get(row['message_id'])
                    if message is None or message.session_id != row['session_id']:
                        projection.append(('missing', None))
                    else:
                        status = message.status
                        projection.append((status, is_read(project_id, message) if status in TERMINAL else None))
                return projection
            try:
                statuses = await self.projects.run_db(project_id, status_from_messages)
            except (ValueError, LookupError):
                statuses = [('missing', None)] * len(rows)
            for row, (status, viewed) in zip(rows, statuses):
                if status == 'running' and row['turn_id'] and self.chats.is_turn_queued(row['turn_id']):
                    status = 'queued'
                row['status'] = 'completed' if status == 'succeeded' else status
                row['result_viewed'] = viewed

        await asyncio.gather(*(hydrate(project_id, rows) for project_id, rows in groups.items()))
        for row in result['delegations']:
            row.pop('turn_id')
        return result


    async def run_detail(self, run_id):
        home = await self.home()
        def read(_):
            row = next((r for r in read_state(home.id).get('runs', []) if r['id'] == run_id), None)
            if row is None:
                raise ValueError('The run record no longer exists')
            result={key: row.get(key) for key in ('id', 'status', 'error', 'created_at', 'ended_at')}
            result.update(activity_record_content(row))
            message = row.get('notification_message') or (row.get('summary') if is_notification_run(row) else None)
            result['notification_message'] = redact(message) if message else None
            result['outcome'] = activity_outcome(row)
            result['draft_summary'] = row.get('draft_summary')
            result['failure_reason'] = activity_failure_reason(row)
            return result
        return await self.projects.run_db(home.id, read)

    async def run_knowledge(self, run_id):
        from services import memory_atlas
        detail = await self.run_detail(run_id)
        if detail.get('processing', {}).get('memories') == 0:
            return {'status': 'empty', 'items': [], 'unavailable': 0}
        return await memory_atlas.reflection_additions(self.projects, run_id)

    async def feedback(self, message_id, value):
        if value not in (-1, 0, 1):
            raise ValueError('Feedback can only be -1, 0, or 1')
        home = await self.home()
        def operation(_):
            state = read_state(home.id)
            if not ChatMessage.get_or_none(ChatMessage.id == message_id, ChatMessage.role == 'assistant'):
                raise ValueError('Digital reply not found')
            state['feedback'][message_id] = value
            write_state(home.id, state)
        await self.projects.run_db(home.id, operation)
        return await self.overview()

    async def list_delegations(self, project_id=None, origin_session_id=None, delegation_id=''):
        state = await self.state()
        items = [item for item in reversed(state['delegations'])
                 if (not project_id or item.get('project_id') == project_id)
                 and (origin_session_id is None or item.get('origin_session_id') == origin_session_id)]
        if delegation_id:
            item = next((item for item in items if item['id'] == delegation_id), None)
            if item is None:
                return {'items': []}
            snapshot, = await self.delegation_management.read([item], include_content=True)
            return {'items': [redact({key: snapshot.get(key) for key in (
                'id', 'project_id', 'session_id', 'message_id', 'title', 'instruction', 'status',
                'followup_state', 'question', 'created_at',
            )} | {'goal': snapshot.get('root_instruction') or snapshot['instruction'],
                  'result': snapshot['content']})]}
        return {'items': [{key: item.get(key) for key in ('id', 'project_id', 'session_id', 'title', 'instruction', 'status', 'followup_state', 'created_at')}
                          for item in items[:20]]}

    async def delegate(self, project_id, instruction, origin_session_id='', request_id='', continuation_of='',
                       *, automatic_result_id=None, target_session_id='', title=None):
        if not (await asyncio.to_thread(digital_person.get_profile)).enabled:
            raise ValueError('Please enable the digital human first')
        if not instruction.strip() or len(instruction) > 12000:
            raise ValueError('Please provide valid execution requirements')
        if title is not None:
            title = title.strip()
            if not title or len(title) > 60 or len(title.splitlines()) != 1:
                raise ValueError('Delegation title must be one line of 1 to 60 characters')
        target = self.projects.get_project_by_id(project_id)
        if not target:
            raise ValueError('Target project does not exist')
        home = await self.home()
        if project_id == home.id:
            raise ValueError('Please delegate the execution task to the specific project')
        if not request_id:
            raise ValueError('Missing delegation request identifier')
        if target_session_id and continuation_of:
            raise ValueError('Choose a target session or a prior delegation')
        # Serialize creation and request deduplication, not the worker execution.
        async with self._delegate_lock:
            state = await self.state()
            if not origin_session_id:
                origin_session_id = (await self.main_session())['id']
            previous = next((item for item in state['delegations'] if item['id'] == continuation_of), None) if continuation_of else None
            delegation_title = title or (previous.get('title') if previous else None)
            existing = next((d for d in state['delegations'] if d['request_id'] == request_id), None)
            if existing:
                existing_target = existing.get('target_session_id', '')
                if (existing['project_id'], existing['instruction'], existing['origin_session_id'],
                        existing_target, '' if existing_target else existing.get('continuation_of', ''),
                        existing.get('title')) != (
                    project_id, instruction, origin_session_id, target_session_id, continuation_of, delegation_title,
                ):
                    raise ValueError('Request identifier already used for another delegation')
                return existing
            origin_archived = await self.projects.run_db(home.id, lambda _: ChatSession.select(ChatSession.archived).where(
                ChatSession.id == origin_session_id, ChatSession.project_id == home.id,
            ).scalar())
            if origin_archived is None or (target_session_id and origin_archived):
                raise ValueError('The source session is archived or does not belong to the digital human workspace')
            if continuation_of and (not previous or previous['project_id'] != project_id
                                    or previous['origin_session_id'] != origin_session_id):
                raise ValueError('The delegation to be continued does not belong to the current source session or target project')
            if target_session_id:
                previous = next((item for item in reversed(state['delegations'])
                                 if item['project_id'] == project_id
                                 and item['origin_session_id'] == origin_session_id
                                 and item['session_id'] == target_session_id), None)
            if automatic_result_id and (not previous or previous.get('followup_state') != 'pending'
                                        or previous['message_id'] != automatic_result_id):
                raise ValueError('The delegation has changed')

            def submit(_):
                busy = False
                if target_session_id or previous:
                    session_id = target_session_id or previous['session_id']
                    row = ChatSession.get_or_none(ChatSession.id == session_id, ChatSession.project_id == project_id)
                    if row is None or row.archived:
                        raise ValueError('The original execution session has been deleted or archived, and no further requests can be appended.')
                    if target_session_id:
                        from services.channels.session_source import channel_session_source
                        if channel_session_source(row.id)['source'] != 'chat':
                            raise ValueError('The target must be an ordinary project conversation')
                    busy = ChatMessage.select().where(
                        ChatMessage.session == session_id, ChatMessage.role == 'assistant',
                        ChatMessage.status.in_(('queued', 'running', 'stopping')),
                    ).exists()
                else:
                    session_id = self.chats.create_session(project_id, title=delegation_title or instruction[:60])['id']
                if automatic_result_id:
                    from agent_assistants.chat_session import ChatAccepted
                    from models.base import db_proxy
                    from services.digital_person_delegations import NoDelegationProgress, continuation_ids
                    turn_id, message_id = continuation_ids(request_id)
                    recovered = ChatMessage.get_or_none(ChatMessage.session == session_id,
                                                        ChatMessage.id == message_id)
                    if recovered is not None:
                        return ChatAccepted(session_id, turn_id, message_id, recovered.status), busy
                    latest = ChatMessage.select(ChatMessage.id, ChatMessage.content).where(
                        ChatMessage.session == session_id, ChatMessage.role == 'assistant',
                    ).order_by(ChatMessage.created_at.desc()).first()
                    if busy or latest is None or latest.id != automatic_result_id:
                        raise ValueError('The execution conversation has advanced')
                    parent = next((row for row in state['delegations']
                                   if row['id'] == previous.get('continuation_of')), None)
                    if parent:
                        earlier = ChatMessage.select(ChatMessage.content).where(
                            ChatMessage.session == session_id, ChatMessage.id == parent['message_id'],
                        ).scalar()
                        if earlier and earlier.split() == latest.content.split():
                            raise NoDelegationProgress('The execution result is unchanged')
                    with db_proxy.atomic():
                        accepted = self.chats.submit_internal_event(
                            project_id, session_id, 'digital_person.delegation_followup', instruction,
                            request_id, schedule=False, reserved_message_ids=(turn_id, message_id),
                        )
                elif target_session_id:
                    from services.chat_submission import submit_turn
                    accepted, _, _ = submit_turn(
                        self.chats, project_id, session_id, instruction, f'delegation-existing:{request_id}',
                    )
                else:
                    accepted = self.chats.submit_message(project_id, session_id, instruction, request_id, schedule=False)
                return accepted, busy

            accepted, busy = await self.projects.run_db(project_id, submit)
            item = {'id': str(uuid.uuid4()), 'request_id': request_id, 'project_id': project_id,
                    'session_id': accepted.session_id, 'origin_session_id': origin_session_id,
                    'message_id': accepted.assistant_message_id, 'instruction': instruction,
                    **({'title': delegation_title} if delegation_title else {}),
                    'turn_id': accepted.turn_id, 'continuation_of': previous['id'] if previous else '',
                    **({'target_session_id': target_session_id} if target_session_id else {}),
                    'status': 'queued' if busy else 'running', 'created_at': utc_now(), 'notified': False,
                    'followup_state': 'pending',
                    'root_instruction': previous.get('root_instruction', previous['instruction']) if previous else instruction}
            def record(state):
                state['delegations'].append(item)
                if previous and previous.get('followup_state'):
                    parent = next(row for row in state['delegations'] if row['id'] == previous['id'])
                    parent['followup_state'] = 'continued'
                    parent.pop('followup_decision', None)
            await self.mutate(record)
            self.delegation_management.track(item)
            self.chats.start_queued_turn(accepted.turn_id)
            return item

    async def _collect(self, *, batch_rows=None, shared=None):
        from services import digital_person_memory as memory, digital_person_reflection as reflection
        from services import digital_person_assessment as assessment, digital_person_companion as companion
        indexed=0
        if shared is None:
            home = await self.home()
            await self.mutate(lambda s: s.setdefault('assessment_live_since', utc_now().isoformat()))
            state = await self.state()
            boundary=await asyncio.to_thread(reflection.cutoff)
            await asyncio.to_thread(reflection.ignore_deliveries, home.id, state.get('runs', []))
            profile = await asyncio.to_thread(digital_person.get_profile)
        else:
            home,state,boundary,profile=shared
        batch = batch_rows if batch_rows is not None else await asyncio.to_thread(assessment.pending, memory.allowed_projects(self.projects),
            state.get('check_sessions', []), baseline=boundary or state['assessment_live_since'], previous=state.get('last_origin', ''), limit=profile.memory_batch_size)
        groups = {}
        for item in batch:
            key = (item['project_id'], item['session_id'], item['scope'], item['source_kind'], bool(item['historical']), bool(item['needs_reflection']))
            groups.setdefault(key, []).append(item)
        if len(groups) > 1:
            contexts = [await self._collect(batch_rows=rows,shared=(home,state,boundary,profile)) for rows in groups.values()]
            contexts = [item for item in contexts if not item.get('no_work')]
            if not contexts:
                return {'origin_project_id':home.id,'no_work':True, 'reflection_batch':[], 'conversation':[]}
            merged = dict(contexts[0])
            for key in ('messages','conversation','reflection_batch','_read_requirements'):
                merged[key] = [row for item in contexts for row in item.get(key, [])]
            merged['_groups'] = contexts
            merged['indexed'] = indexed
            return merged
        origin = batch[0]['session_id'] if batch else state.get('main_session_id', '')
        pid = batch[0]['project_id'] if batch else home.id
        kind = batch[0]['source_kind'] if batch else 'chat'
        def source(_):
            if kind == 'task':
                from models import Task, Message
                task = Task.get_or_none(Task.id == origin)
                return (bool(task and Message.select().where(Message.task == origin, Message.run_status.in_(['queued','running','stopping'])).exists()),
                        bool(task and task.archived), [])
            session = ChatSession.get_or_none(ChatSession.id == origin)
            if not session:
                return False, False, batch
            busy = ChatMessage.select().where(ChatMessage.session == origin,ChatMessage.status.in_(['queued','running','stopping'])).exists()
            discarded = []
            if session.context_reset_at:
                selected = ChatMessage.select(ChatMessage.id).where(ChatMessage.session == origin, ChatMessage.created_at >= session.context_reset_at)
                allowed = {m.id for m in selected}
                discarded = [r for r in batch if r['source_message_id'] not in allowed]
            return busy, session.archived, discarded
        busy, archived, discarded = await self.projects.run_db(pid, source) if origin else (False, False, [])
        if discarded:
            await asyncio.to_thread(assessment.commit, discarded, [], 'context-boundary')
            batch = [r for r in batch if r not in discarded]
        if not batch:
            return {'messages': [], 'delegations': [], 'conversation': [], 'origin_session_id': origin,
                    'origin_project_id':pid,'source_kind':kind,'busy':busy,'no_work':True,'reflection_batch':[],'indexed':indexed}
        hits = await memory.read_projects(self.projects, batch) if batch else []
        by_id = {h['id']: h for h in hits}
        unavailable = {(r['project_id'],r['source_message_id']) for r in batch
                       if by_id.get('memory:'+str(r['id']),{}).get('source_hash') != r['source_hash']}
        if unavailable:
            # Keep all fragments of an unavailable message out of this assessment.
            skipped = [r for r in batch if (r['project_id'],r['source_message_id']) in unavailable]
            await asyncio.to_thread(assessment.defer_unavailable, skipped)
            batch = [r for r in batch if (r['project_id'],r['source_message_id']) not in unavailable]
        if not batch:
            return {'origin_project_id':pid,'origin_session_id':origin,'no_work':True,
                    'reflection_batch':[],'conversation':[]}
        scope = batch[0]['scope']
        historical = bool(batch and batch[0]['historical'])
        memory_only = bool(batch and not batch[0]['needs_reflection'])
        recent = {}
        for row in batch:
            hit = by_id['memory:'+str(row['id'])]
            message = recent.setdefault((row['project_id'],row['source_message_id']), {
                'id':row['source_message_id'],'project_id':row['project_id'],'session_id':row['session_id'],'scope':row['scope'],'role':row['role'],
                'author_id':hit.get('author_id'),'author_name':hit.get('author_name'),
                'content':'','created_at':hit['created_at'],'memory_ids':[],'read_ids':[],
                '_end':row['offset']})
            overlap=max(0,message['_end']-row['offset'])
            message['content'] += hit['content'][overlap:]
            message['_end']=row['offset']+len(hit['content'])
            message['read_ids'].append(hit['id'])
            if row['needs_knowledge']:
                message['memory_ids'].append(hit['id'])
        recent = list(recent.values())
        # Read complete source messages in the owning project executor, not assembled chunks.
        read_requirements=[]
        messages = [{k:m[k] for k in ('id','session_id','content','created_at')} for m in recent if m['role']=='user']
        last_user = next((m for m in reversed(recent) if m['role']=='user'), None)
        from services import digital_person_affect as affect
        person = affect.subject(last_user, scope) if last_user else None
        affinity = (await asyncio.to_thread(affect.read, person))['affinity'] if person else 50
        interval = companion.contact_interval(profile.proactive_contact_interval_minutes, affinity)
        def observe(s):
            if not historical and not memory_only:
                companion.observe_user(s, scope, last_user)
            return companion.snapshot(s, scope, last_user.get('created_at') if last_user else None, utc_now(),
                                      interval_minutes=interval)
        social = await self.mutate(observe)
        for key in ('thought', 'mood', 'intensity'):
            social.pop(key, None)
        evidence = []
        await self.mutate(lambda s:s.update(last_origin=origin))
        from services import digital_person_affect as affect
        relationships = await asyncio.to_thread(affect.review_context,pid,recent,scope) if not historical and not memory_only else []
        prior = [{'source_ids':r.get('notification_sources',[]), 'status':r.get('status'),
                  'created_at':str(r.get('created_at') or ''),
                  'attempted_at':r.get('notification_attempted_at'), 'notified_at':r.get('notified_at')} for r in state['runs']
                 if r.get('status') in ('notified','delivery_failed') and r.get('origin_session_id')==origin][:10]
        return {'messages':messages,'delegations':[],'conversation':recent,'origin_session_id':origin,
                'origin_project_id':pid,'source_kind':kind,'busy':busy,'previous_notifications':prior,'memory':[],
                'companion':social,'relationships':relationships,'thought_sources':evidence,'reflection_batch':batch,
                'archived_source':archived,'historical_batch':historical,'memory_only':memory_only,'indexed':indexed,
                '_read_requirements':read_requirements,
                'clock':datetime.now().astimezone().isoformat()}

    async def _decide(self, context):
        from dataclasses import replace
        from agent_assistants.chat_session import ChatSessionModule
        profile = await asyncio.to_thread(digital_person.get_profile)
        home = await self.home()
        from services import digital_person_assessment as assessment
        from services import digital_person_reflection as reflection
        history_cutoff=await asyncio.to_thread(reflection.cutoff)
        checker = ChatSessionModule(self.bus, self.projects)
        checker._config = replace(checker._config, name='digital_person', channel='session_chat', workstep_tools=True,
            system_prompt_transport=True,
            system_prompt=assessment.instruction(profile))
        scope = context.get('companion', {}).get('scope') or 'local'
        from services import memory_query
        from services.digital_person_reflection import model_context
        def start(_):
            state = read_state(home.id)
            legacy_scopes = state.pop('check_sessions_by_scope', {})
            known = list(dict.fromkeys(state.get('check_sessions', []) + list(legacy_scopes.values())))
            preferred = state.get('check_session_id') or (known[-1] if known else None)
            existing = (ChatSession.get_or_none(ChatSession.id == preferred,
                        ChatSession.project_id == home.id, ChatSession.archived == False)
                        if preferred and preferred != state.get('main_session_id') else None)
            row = {'id': existing.id} if existing else checker.create_session(home.id, title=CHECK_SESSION_TITLE)
            _rename_check_session(row['id'])
            previous_scope = state.get('check_context_scope') or next(
                (key for key, sid in legacy_scopes.items() if sid == row['id']), None)
            # One visible check conversation; source changes must not resume another
            # contact's engine thread or inject their history into a fresh thread.
            reset_context = (bool(context.get('_load')) or not profile.proactive_shared_context
                             or state.get('check_trigger_version') != 1
                             or state.get('check_history_cutoff') != history_cutoff
                             or bool(state.get('check_context_pending_scope'))
                             or (existing is not None and previous_scope != scope))
            if row['id'] not in known:
                known.append(row['id'])
            state['check_sessions'] = known
            state['check_session_id'] = row['id']
            # Do not claim a scope switch succeeded before the queued turn resets
            # its native context. A failed/interrupted attempt must start fresh.
            state['check_context_pending_scope'] = scope
            # Consolidate only registered check conversations, never same-title user
            # chats. Keep every historical message; defer any conversation still busy.
            busy_sessions = ChatMessage.select(ChatMessage.session).where(
                ChatMessage.status.in_(['queued', 'running', 'stopping']))
            ChatSession.update(archived=True, archived_at=utc_now()).where(
                ChatSession.project_id == home.id, ChatSession.id.in_(known),
                ChatSession.id != row['id'], ChatSession.id != state.get('main_session_id', ''),
                ChatSession.archived == False, ChatSession.id.not_in(busy_sessions),
            ).execute()
            write_state(home.id, state)
            prompt = 'Start this background assessment: follow the system instructions to retrieve the pending messages and return the result.'
            extra = profile.proactive_instruction.strip()
            # This old built-in default was a task-notification template, not an
            # intentional personal preference. Preserve config but stop re-injecting it.
            if extra and extra != digital_person.LEGACY_PROACTIVE_INSTRUCTION:
                prompt += '\nAdditional preferences for this assessment:\n' + extra
            accepted = checker.submit_internal_event(home.id, row['id'], 'digital_person.reflection', prompt, str(uuid.uuid4()),
                                              schedule=False, reset_context=reset_context)
            return row, accepted
        row, accepted = await self.projects.run_db(home.id, start)
        access=None
        if context.get('origin_session_id') or context.get('_load'):
            access=await memory_query.execution_access(self.projects,home.id,row['id'],fresh=True)
            if context.get('_load'):
                async def load():
                    await context['_load']()
                    return model_context(context,home.id)
                memory_query.bind_assessment_loader(access,load)
            else:
                memory_query.bind_assessment(access,model_context(context,home.id))

        await self.bus.publish({'type': 'CUSTOM', 'name': 'channel.session_changed',
                                'channel': 'session_chat', 'project_id': home.id})
        self._active_check = (checker, home.id, row['id'])
        try:
            from services.digital_person_browser import attach
            await asyncio.to_thread(attach, home.id, row['id'])
            checker.start_queued_turn(accepted.turn_id)
            retried_empty = False
            repair_errors = set()
            async with asyncio.timeout(600):
                while True:
                    def result(_):
                        m = ChatMessage.get_by_id(accepted.assistant_message_id)
                        return m.status, m.content
                    status, content = await self.projects.run_db(home.id, result)
                    if status in ('completed', 'succeeded'):
                        if not content.strip() and not retried_empty:
                            # Empty final output is not a successful silent check. Ask
                            # once on the retained engine thread; never repeat tools.
                            retried_empty = True
                            def confirm(_):
                                return checker.submit_internal_event(home.id, row['id'], 'digital_person.reflection',
                                    'Complete the previous turn with final JSON in one <json>...</json> pair, using the information already verified. '
                                    'If nothing changed, return <json>{"decision":"silent","summary":"No changes","source_ids":[]}</json>. '
                                    'State uncertain results explicitly as unknown.', str(uuid.uuid4()), schedule=False)
                            accepted = await self.projects.run_db(home.id, confirm)
                            checker.start_queued_turn(accepted.turn_id)
                            continue
                        try:
                            decision = parse_check_result(content)
                            from services.memory_policy import validate_memories
                            versions=memory_query.observed_knowledge_versions(access) if access else {}
                            validate_memories(decision,context,versions)
                        except ValueError as exc:
                            error=str(exc)
                            if error in repair_errors or len(repair_errors)>=2:
                                raise
                            repair_errors.add(error)
                            from services.memory_policy import repair_instruction
                            correction=repair_instruction(error,context)
                            def repair(_):
                                return checker.submit_internal_event(home.id,row['id'],'digital_person.reflection',
                                    correction,str(uuid.uuid4()),schedule=False)
                            accepted=await self.projects.run_db(home.id,repair)
                            checker.start_queued_turn(accepted.turn_id)
                            continue
                        if access:
                            if not memory_query.assessment_observed(access):
                                raise ValueError('Unclaimed pending messages for this round; retain pending status')
                            decision['_retrieved_knowledge_ids'] = memory_query.observed_knowledge_versions(access)
                            decision['_read_source_ids'] = memory_query.observed_sources(access, context.get('_read_requirements', []))
                        def confirmed(state):
                            state['check_trigger_version'] = 1
                            state['check_context_scope'] = scope
                            state['check_history_cutoff'] = history_cutoff
                            state.pop('check_context_pending_scope', None)
                        await self.mutate(confirmed)
                        return decision
                    if status in ('failed', 'error', 'stopped'):
                        raise RuntimeError('Active check incomplete:' + status)
                    await asyncio.sleep(.25)
        finally:
            if access:
                memory_query.release_execution(home.id,row['id'],access)
            await checker.stop_current(row['id'], home.id)
            await checker.shutdown()
            self._active_check = None
            await self.bus.publish({'type': 'CUSTOM', 'name': 'channel.session_changed',
                                    'channel': 'session_chat', 'project_id': home.id})

    async def _deliver_local(self, sid, text, run_id, *, proactive=False, reflection=False, project_id=''):
        home = await self.home()
        if project_id:
            home = self.projects.get_project_by_id(project_id)
            if home is None:
                raise ValueError('The source project for the notification does not exist')
        mid = str(uuid.uuid5(uuid.NAMESPACE_URL, run_id + sid))
        def write(_):
            if not ChatSession.get_or_none(ChatSession.id == sid, ChatSession.archived == False):
                raise ValueError('The source session of the notification has been archived or deleted')
            if ChatMessage.get_or_none(ChatMessage.id == mid):
                return False
            ChatMessage.insert(id=mid, session=sid, role='assistant', content=text, status='completed',
                               context_json=json.dumps({'digital_person_proactive': True}) if proactive or reflection else None,
                               created_at=utc_now(), ended_at=utc_now()).on_conflict_ignore().execute()
            ChatSession.update(updated_at=utc_now()).where(ChatSession.id == sid).execute()
            from services.digital_person_reflection import ignore
            ignore(home.id, mid)
            return True
        inserted = await self.projects.run_db(home.id, write)
        if not inserted:
            return
        await self.bus.publish({'type':'TEXT_MESSAGE_START','channel':'session_chat','project_id':home.id,'session_id':sid,'messageId':mid,'role':'assistant','proactive':proactive})
        await self.bus.publish({'type':'TEXT_MESSAGE_CONTENT','channel':'session_chat','project_id':home.id,'session_id':sid,'messageId':mid,'content':text})
        await self.bus.publish({'type':'TEXT_MESSAGE_END','channel':'session_chat','project_id':home.id,'session_id':sid,'messageId':mid,'status':'completed'})
        if proactive:
            await self.bus.publish({'type':'CUSTOM','name':'digital_person.proactive_message',
                'channel':'digital_person','project_id':home.id,'session_id':sid,
                'value':{'message_id':mid,'text':text}})

    async def _notify(self, text, source_ids, run_id):
        text = redact(text)
        state = await self.state()
        targets = {d['origin_session_id'] for d in state['delegations'] if d['id'] in source_ids}
        run = next((r for r in state['runs'] if r['id'] == run_id), {})
        if run.get('origin_session_id'):
            targets.add(run['origin_session_id'])
        if not targets:
            targets = {(await self.main_session())['id']}
        routes = await self.bots._load() if self.bots else {'sessions': {}, 'session_sources': {}}
        scope = run.get('sources', {}).get('companion', {}).get('scope') if isinstance(run.get('sources'), dict) else None
        reflection = run.get('trigger') in ('manual', 'interval')
        proactive = reflection and scope == 'local' and run.get('origin_session_id') not in routes.get('session_sources', {})
        if proactive:
            targets = {(await self.main_session())['id']}
        receipts = []
        for sid in targets:
            source_project = (run.get('sources') or {}).get('origin_project_id') if isinstance(run.get('sources'),dict) else None
            local_options = {'project_id':source_project} if source_project and not proactive and sid == run.get('origin_session_id') else {}
            try:
                if proactive:
                    await self._deliver_local(sid, text, run_id, proactive=True)
                else:
                    await self._deliver_local(sid, text, run_id, reflection=reflection or run.get('managed_followup', False), **local_options)
                receipts.append({'kind':'local','session_id':sid,'status':'delivered','proactive':proactive,**local_options})
            except Exception as exc:
                receipts.append({'kind':'local','session_id':sid,'status':'failed','error':str(exc)[:500],'proactive':proactive,**local_options})
        # Only explicitly selected notification destinations receive broadcasts.
        from services.digital_person_channels import get_bindings
        channel_origins = targets.intersection(routes.get('session_sources', {}))
        for binding in await asyncio.to_thread(get_bindings):
            if not binding.get('notify'):
                continue
            if not proactive and (channel_origins or run.get('kind') == 'social'):
                route = f"{binding['bot_id']}:{binding['conversation_type']}:{binding['conversation_id']}"
                if routes['sessions'].get(route) not in (channel_origins if channel_origins else targets):
                    continue
            try:
                from services.digital_person_channels import send_binding
                receipt = await send_binding(self.bots, binding, text)
                receipts.append({'kind':'channel','binding_id':binding['id'],'status':'delivered','message_id':receipt.get('message_id')})
            except Exception as exc:
                receipts.append({'kind':'channel','binding_id':binding['id'],'status':'failed','error':str(exc)[:500]})
        return receipts

    async def check(self, manual=True):
        profile = await asyncio.to_thread(digital_person.get_profile)
        if not profile.enabled:
            raise ValueError('Digital human proactive check is not enabled')
        if self._check_lock.locked():
            raise ValueError('An existing check is in progress')
        async with self._check_lock:
            from services.memory_pending_queue import has_pending
            from services.digital_person_memory import allowed_projects
            if manual:
                await self.follow_delegations(profile)
                from services.memory_knowledge import ensure_schema
                await asyncio.to_thread(ensure_schema)
            management = self.delegation_management
            eligible = await management.eligible(await self.state())
            eligible = await management.recover(eligible, profile)
            eligible = await management.recover_foreground(eligible, profile)
            if not eligible and not await asyncio.to_thread(has_pending,allowed_projects(self.projects)):
                return {'status':'silent','sources':{'no_work':True},'deliveries':[]}
            run = {'id':str(uuid.uuid4()),'created_at':utc_now(),'status':'running','trigger':'manual' if manual else 'interval','sources':[],'deliveries':[],'relationship_updates':[],'memory_updates':[]}
            def start_run(state):
                if 'reflection_count' not in state:
                    state['reflection_count'] = sum(row.get('trigger') != 'delegation' for row in state['runs'])
                    state['reflection_count_lower_bound'] = len(state['runs']) >= 100
                state['reflection_count'] += 1
                state['runs'].insert(0, run.copy())
            await self.mutate(start_run)
            claimed = False
            committed = False
            context = {}
            try:
                from services import digital_person_assessment as assessment
                async def load_batch():
                    nonlocal claimed
                    prepared = await self._collect()
                    if eligible:
                        await management.attach(prepared, eligible)
                    context.clear()
                    context.update(prepared)
                    if prepared.get('no_work'):
                        return
                    if not await asyncio.to_thread(assessment.claim,prepared.get('reflection_batch',[])):
                        raise ValueError('The source is being processed or has changed, waiting for the next round')
                    claimed = True
                    run['sources'] = prepared
                    run['origin_session_id'] = prepared.get('origin_session_id','')
                context['_load'] = load_batch
                self._active_assessment_task = asyncio.create_task(self._decide(context))
                try:
                    decision = await self._active_assessment_task
                except asyncio.CancelledError:
                    if not asyncio.current_task().cancelling():
                        run.update(status='cancelled',summary='已停止本轮思考')
                        return run
                    raise
                finally:
                    self._active_assessment_task = None
                from services.memory_secrets import redact
                run['draft_summary'] = redact(str(decision.get('summary', '')))[:3000]
                if '_load' in context:
                    raise ValueError('The CLI has not fetched the messages to review')
                if context.get('no_work'):
                    run.update(status='silent',summary='没有待处理事件')
                    return run
                if decision.get('decision') not in ('silent','notify'):
                    raise ValueError('The thinking result lacks a valid processing method.')
                ids = resolve_check_sources(context, decision.get('source_ids', []))
                run['summary'] = run.pop('draft_summary', '')
                run['status'] = decision['decision']
                run['kind'] = decision.get('kind', 'work')
                if run['kind'] not in ('work', 'social'):
                    raise ValueError('Invalid proactive check type')
                if decision['decision'] == 'notify':
                    terminal = {d['id'] for d in context.get('delegations', [])
                                if d['status'] in ('completed','succeeded','failed','error','stopped','missing')}
                    terminal.update(m['id'] for key in ('conversation','memory','thought_sources')
                                    for m in context.get(key, []))
                    if not ids or not set(ids).issubset(terminal) or not run['summary'].strip():
                        raise ValueError('No source or result to notify')
                from services import digital_person_reflection as reflection
                required={r['id'] for r in context.get('_read_requirements',[])}
                if not required.issubset(set(decision.get('_read_source_ids',[]))):
                    raise ValueError('Original long message not yet read, retained in thinking state:')

                if not await asyncio.to_thread(reflection.current, context.get('reflection_batch', [])):
                    raise ValueError('Source changed during thinking; old conclusion not applied')
                from services.digital_person_delegations import validate_actions
                actions = decision.get('delegation_actions', [])
                validate_actions(actions, {item['id']: item for item in eligible})
                memories = decision.get('memories', [])
                from services.memory_knowledge import _validate
                available = {int(r['id']):r for r in context.get('reflection_batch',[]) if r.get('needs_knowledge',True)}
                if not isinstance(memories,list):
                    raise ValueError('Invalid memory candidate format')
                existing_ids = decision.get('_retrieved_knowledge_ids', [])
                for item in memories:
                    validated = _validate(item,available)
                    if not {f'knowledge:{x}' for x in validated['supersedes']}.issubset(set(existing_ids)):
                        raise ValueError('Memory correction did not reference knowledge queried in this round')
                batch_context = context
                groups = context.get('_groups', [context])
                relationship_results = []
                delegations=(await self.state()).get('delegations',[])
                locations={}
                for group in groups:
                    for message in group.get('conversation',[]):
                        locations.setdefault(message['id'],set()).add((group['origin_project_id'],group['origin_session_id']))
                updates=[value for value in decision.get('relationship_updates',[]) if isinstance(value,dict)
                         and isinstance(value.get('source_ids'),list)
                         and all(isinstance(mid,str) and len(locations.get(mid,()))==1 for mid in value['source_ids'])] if isinstance(decision.get('relationship_updates',[]),list) else []
                from services import digital_person_affect as affect
                selected = [group for group in groups if set(ids).intersection(m['id'] for m in group.get('conversation',[]))]
                if decision['decision']=='notify' and groups[0].get('conversation') and len(selected)!=1:
                    raise ValueError('Active notification must correspond to a specific source session')
                # Validate and atomically commit knowledge before relationship or
                # delivery effects; a stale replacement must not change affinity.
                result = await asyncio.to_thread(assessment.commit,batch_context.get('reflection_batch',[]),memories,run['id'],existing_ids)
                committed = True
                run['memory_processing'] = {'status':'idle','mode':'unified','knowledge':result}
                await management.apply(actions, eligible, profile)
                for group in groups:
                    group_scope=group.get('companion',{}).get('scope')
                    delegated=any(d.get('project_id')==group.get('origin_project_id') and d.get('session_id')==group.get('origin_session_id') for d in delegations)
                    if group_scope and not delegated and not group.get('historical_batch') and not group.get('memory_only') and not group_scope.startswith('task:'):
                        relationship_results.extend(await asyncio.to_thread(affect.apply_review,
                            group['origin_project_id'],group['origin_session_id'],group.get('conversation',[]),
                            updates,group_scope))
                run['relationship_updates']=relationship_results
                context = selected[0] if selected else groups[0]
                scope = context.get('companion', {}).get('scope')
                delegated_source = any(d.get('project_id') == context.get('origin_project_id')
                                       and d.get('session_id') == context.get('origin_session_id')
                                       for d in delegations)
                internal_only = (context.get('historical_batch') or context.get('memory_only')
                                 or (scope or '').startswith('task:') or delegated_source)
                if scope and not internal_only:
                    from services import digital_person_companion as companion
                    home = await self.home()
                    from services import digital_person_affect as affect
                    # Apply this round's affinity before the final social-contact gate.
                    last_user = next((m for m in reversed(context.get('conversation', [])) if m.get('role')=='user'), None)
                    person = affect.subject(last_user, scope) if last_user else None
                    affinity = (await asyncio.to_thread(affect.read, person))['affinity'] if person else 50
                    interval = companion.contact_interval(profile.proactive_contact_interval_minutes, affinity)
                    latest_state = await self.state()
                    context.setdefault('companion', {})['contact_policy'] = companion.contact_policy(
                        latest_state.get('companions', {}).get(scope, {}),
                        last_user.get('created_at') if last_user else None, utc_now(), interval_minutes=interval)

                if internal_only:
                    run.update(status='silent',summary=run['summary'] or '已完成内部记忆整理')
                    return run
                if decision['decision'] == 'notify':
                    run['notification_message'] = redact(run['summary'])
                if run['kind'] == 'social' and not manual and not profile.proactive_enabled:
                    run.update(status='silent', summary=run['summary'] or '主动交流已关闭，已完成内部思考')
                    return run
                if context.get('archived_source'):
                    run.update(status='silent', summary=run['summary'] or 'Archived source processed internally; no notification sent.')
                    return run
                if run['kind'] == 'social' and run['status'] == 'notify' and not context.get('companion', {}).get('contact_policy', {}).get('allowed', False):
                    run.update(status='silent', summary=context.get('companion', {}).get('contact_policy', {}).get('reason', '主动联系条件不满足'))
                    return run
                if decision['decision'] == 'notify':
                    def currently_busy(_):
                        sid=context.get('origin_session_id')
                        if context.get('source_kind')=='task':
                            from models import Message
                            return Message.select().where(Message.task==sid,Message.run_status.in_(['queued','running','stopping'])).exists()
                        session=ChatSession.get_or_none(ChatSession.id==sid)
                        if session is None or session.archived:
                            return 'archived'
                        rows=ChatMessage.select().where(ChatMessage.session==sid)
                        if rows.where(ChatMessage.status.in_(['queued','running','stopping'])).exists():
                            return True
                        timestamps=[m['created_at'] for m in context.get('conversation',[]) if m.get('created_at')]
                        return bool(timestamps and rows.where(ChatMessage.created_at>max(datetime.fromisoformat(str(t)) for t in timestamps)).exists())
                    source_state=await self.projects.run_db(context['origin_project_id'],currently_busy)
                    if source_state=='archived':
                        run.update(status='silent',summary='Archived source processed internally; no notification sent.')
                        return run
                    if source_state:
                        run.update(status='silent',summary='来源会话正在执行，已完成记忆整理')
                        return run
                    run['origin_session_id']=context.get('origin_session_id','')
                    run['sources']=dict(context,reflection_batch=batch_context.get('reflection_batch',[]))
                    fingerprint = hashlib.sha256(json.dumps([sorted(set(ids)), ''.join(run['summary'].split())], ensure_ascii=False).encode()).hexdigest()
                    state = await self.state()
                    if any(r.get('notification_key') == fingerprint and r.get('origin_session_id') == run['origin_session_id']
                           and r.get('status') in ('notified', 'delivery_failed') for r in state['runs']):
                        run.update(status='silent', summary='相同结果已经处理，未重复通知')
                        return run
                    run.update(notification_key=fingerprint, notification_sources=ids)
                    current = await asyncio.to_thread(digital_person.get_profile)
                    hour = datetime.now().astimezone().hour
                    quiet = (current.quiet_start <= hour < current.quiet_end) if current.quiet_start < current.quiet_end else (hour >= current.quiet_start or hour < current.quiet_end) if current.quiet_start != current.quiet_end else False
                    if not current.enabled:
                        run['status'] = 'cancelled'
                    elif quiet and not manual:
                        run['status'] = 'deferred'
                    else:
                        def reserve(s):
                            if run['kind'] == 'social' and scope:
                                if scope == 'local':
                                    from services import face_welcome
                                    last_local_user = next((m.get('created_at') for m in reversed(context.get('conversation', []))
                                                            if m.get('role') == 'user'), None)
                                    if face_welcome.blocks_social(s, last_local_user, utc_now()):
                                        return False
                                companion.reserve_contact(s, scope, run['id'], utc_now())
                            for item in s['delegations']:
                                if item['id'] in ids:
                                    item.update(notified=True, notification_run_id=run['id'])
                            for record in s['runs']:
                                if record['id']==run['id']:
                                    record.update(status='notifying', summary=run['summary'],
                                                  origin_session_id=run['origin_session_id'], sources=assessment_audit(run['sources']),
                                                  notification_key=fingerprint, notification_sources=ids, kind=run['kind'])
                            return True
                        if not await self.mutate(reserve):
                            run.update(status='silent', summary='近期已进行人脸欢迎，暂不主动打扰')
                            return run
                        run['notification_attempted_at'] = utc_now().isoformat()
                        run['deliveries'] = await self._notify(run['summary'], ids, run['id'])
                        if any(r['status']=='delivered' for r in run['deliveries']):
                            run['notified_at'] = utc_now().isoformat()
                        run['status'] = 'notified' if all(r['status']=='delivered' for r in run['deliveries']) else 'delivery_failed'
                        def mark(s):
                            for d in s['delegations']:
                                result = next((r for r in context['delegations'] if r['id']==d['id']),None)
                                if result:
                                    d['status'] = 'completed' if result['status'] in ('completed','succeeded') else result['status']
                                if d['id'] in ids:
                                    d['notified'] = True
                        await self.mutate(mark)
            except asyncio.CancelledError:
                run['status'] = 'cancelled'
                raise
            except Exception as exc:
                run.update(status='failed',error=str(exc)[:1000])
            finally:
                if claimed and not committed:
                    await asyncio.to_thread(assessment.release,run.get('sources',context).get('reflection_batch',[]))
                if committed:
                    run['processing']=completed_activity_processing(run)
                run['ended_at'] = utc_now()
                def finish(s):
                    saved=dict(run,sources=assessment_audit(run.get('sources') or {}))
                    s['runs'] = [saved if r['id']==run['id'] else r for r in s['runs']][:100]
                    s['last_check'] = run['ended_at']
                await self.mutate(finish)
            return run

    async def start(self):
        if self._loop_task:
            return
        def recover(state):
            for run in state['runs']:
                if run['status'] in ('running', 'notifying'):
                    run.update(status='interrupted', error='The service restarted. The notification was not sent again automatically.')
            _rename_check_session(state.get('check_session_id'))
        await self.mutate(recover)
        from services.digital_person_delegations import outstanding
        for item in outstanding((await self.state())['delegations']):
            self.delegation_management.track(item)
        from services.memory_knowledge import ensure_schema
        await asyncio.to_thread(ensure_schema)
        self._loop_task = asyncio.create_task(self._loop())

    async def follow_delegations(self, profile=None):
        profile = profile or await asyncio.to_thread(digital_person.get_profile)
        if profile.enabled:
            await self.delegation_management.refresh()
        await self._follower.poll(profile)

    async def trigger_check(self):
        profile = await asyncio.to_thread(digital_person.get_profile)
        if not profile.enabled:
            raise ValueError('Digital human proactive check is not enabled')
        if self._check_lock.locked() or (self._cycle_task and not self._cycle_task.done()):
            raise ValueError('An existing check is in progress')
        self._cycle_task = asyncio.create_task(self.check(manual=True))
        self._cycle_task.add_done_callback(self._cycle_finished)
        return {'status': 'accepted'}

    async def _tick(self, now=None, *, background=False):
        profile = await asyncio.to_thread(digital_person.get_profile)
        if not profile.enabled or not profile.reflection_enabled:
            return
        now = now or datetime.now(timezone.utc)
        if self._cycle_task and not self._cycle_task.done():
            return
        state = await self.state()
        if self._check_lock.locked() or (self._cycle_task and not self._cycle_task.done()):
            return
        last_at = state.get('last_check') or state.get('reflection_started_at')
        if not last_at and not profile.proactive_enabled:
            # Establish the first due time without shortening the thinking interval.
            await self.mutate(lambda s: s.setdefault('reflection_started_at', now.isoformat()))
            return
        last = datetime.fromisoformat(last_at).timestamp() if last_at else 0
        if (now or datetime.now(timezone.utc)).timestamp() - last >= profile.proactive_interval_minutes * 60:
            if background:
                self._cycle_task = asyncio.create_task(self._drain_assessments())
                self._cycle_task.add_done_callback(self._cycle_finished)
            else:
                await self._drain_assessments()

    def _cycle_finished(self, task):
        if not task.cancelled():
            try:
                task.result()
            except Exception:
                import logging
                logging.getLogger(__name__).exception('Digital person assessment cycle failed')

    async def _drain_assessments(self):
        profile = await asyncio.to_thread(digital_person.get_profile)
        if not profile.enabled or not profile.reflection_enabled:
            return
        await self.follow_delegations(profile)
        seen = set()
        # Bound each scheduled cycle, including messages arriving while it runs.
        # Remaining durable work waits for the next configured interval.
        for _ in range(2):
            profile = await asyncio.to_thread(digital_person.get_profile)
            if not profile.enabled or not profile.reflection_enabled:
                break
            result = await self.check(manual=False)
            if not isinstance(result, dict) or result.get('status') in ('failed','cancelled','deferred'):
                break
            sources = result.get('sources') or {}
            batch = tuple(row['id'] for row in sources.get('reflection_batch', []))
            knowledge = (result.get('memory_processing') or {}).get('knowledge') or {}
            if batch:
                if batch in seen:
                    break
                seen.add(batch)
            elif not knowledge.get('processed') and not sources.get('indexed'):
                break


    async def _loop(self):
        while True:
            await asyncio.sleep(15)
            try:
                await self._tick(background=True)
            except asyncio.CancelledError:
                raise
            except Exception:
                import logging
                logging.getLogger(__name__).exception('Digital person tick failed')

    async def stop_check(self):
        cycle = self._cycle_task
        if cycle and not cycle.done() and cycle is not asyncio.current_task():
            cycle.cancel()
            await asyncio.gather(cycle,return_exceptions=True)
            return
        task = self._active_assessment_task
        if task:
            task.cancel()
            await asyncio.gather(task,return_exceptions=True)
        if self._active_check:
            checker, pid, sid = self._active_check
            await checker.stop_current(sid, pid)

    async def shutdown(self):
        if self._loop_task:
            self._loop_task.cancel()
        await self.stop_check()
        if self._loop_task:
            await asyncio.gather(self._loop_task,return_exceptions=True)
        self._loop_task = None
        self._cycle_task = None

    async def retry_delivery(self, run_id):
        """Retry failed channel receipts only; never replay successful recipients."""
        from services.digital_person_channels import get_bindings, send_binding
        if self._check_lock.locked():
            raise ValueError('Please wait for the current check to complete')
        async with self._check_lock:
            profile = await asyncio.to_thread(digital_person.get_profile)
            if not profile.enabled:
                raise ValueError('Digital human is closed')
            state = await self.state()
            run = next((r for r in state['runs'] if r['id']==run_id),None)
            if not run or run['status'] != 'delivery_failed':
                raise ValueError('No retryable deliveries')
            bindings = await asyncio.to_thread(get_bindings)
            for receipt in run['deliveries']:
                if receipt['status'] != 'failed':
                    continue
                run['notification_attempted_at'] = utc_now().isoformat()
                try:
                    if receipt.get('kind') == 'local':
                        if receipt.get('proactive'):
                            await self._deliver_local(receipt['session_id'], run['summary'], run_id, proactive=True)
                        else:
                            options = {'project_id':receipt['project_id']} if receipt.get('project_id') else {}
                            await self._deliver_local(receipt['session_id'], run['summary'], run_id,
                                                      reflection=run.get('trigger') in ('manual', 'interval'), **options)
                        result = {}
                    else:
                        binding = next((b for b in bindings if b['id']==receipt.get('binding_id') and b.get('notify')),None)
                        if binding is None:
                            raise ValueError('Notification binding has been disconnected or disabled. Please reselect the receiving session.')
                        result = await send_binding(self.bots,binding,run['summary'])
                    receipt.update(status='delivered',message_id=result.get('message_id'))
                    run['notified_at'] = utc_now().isoformat()
                    receipt.pop('error',None)
                except Exception as exc:
                    receipt['error']=str(exc)[:500]
                # Persist each completed receipt before trying the next destination.
                await self.mutate(lambda s:s.update(runs=[run if r['id']==run_id else r for r in s['runs']]))
            run['status']='notified' if all(r['status']=='delivered' for r in run['deliveries']) else 'delivery_failed'
            run['retried_at']=utc_now().isoformat()
            await self.mutate(lambda s:s.update(runs=[run if r['id']==run_id else r for r in s['runs']]))
            return run

    async def stop_delegation(self, delegation_id):
        def stop(state):
            item = next((d for d in state['delegations'] if d['id'] == delegation_id), None)
            if item is None:
                raise ValueError('Delegation does not exist')
            if item.get('followup_state') == 'pending':
                item['followup_state'] = 'stopped'
                item.pop('followup_decision', None)
            return item
        async with self._delegate_lock:
            item = await self.mutate(stop)
        await self.chats.stop_current(item['session_id'],item['project_id'],expected_message_id=item['message_id'])
        return {'stopped':True}
