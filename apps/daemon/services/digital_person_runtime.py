"""Device companion orchestration. Project data is accessed only through run_db.

Operational state is not a memory store: it contains session pointers, pending
work, delivery receipts and bounded audit records. It never learns prompt rules.
"""
import asyncio
import hashlib
import json
import uuid
from datetime import datetime, timezone
from models.chat_session import ChatSession, ChatMessage, ProjectSetting
from models.fields import utc_now
from services import customization_workspace, digital_person
from services import digital_person_memory_index as memory_index

KEY = 'digital_person_runtime'
CHECK_SESSION_TITLE = '主动思考'


def completed_activity_summary(run):
    knowledge=(run.get('memory_processing') or {}).get('knowledge') or {}
    batch=(run.get('sources') or {}).get('reflection_batch',[])
    sessions=len({(row['project_id'],row['session_id']) for row in batch})
    changes=[row.get('affinity_delta',0) for row in run.get('relationship_updates',[])]
    increased=sum(max(delta,0) for delta in changes)
    decreased=-sum(min(delta,0) for delta in changes)
    parts=[]
    if increased:parts.append(f'上升 {increased:g}')
    if decreased:parts.append(f'下降 {decreased:g}')
    affinity='好感度'+'、'.join(parts) if parts else '好感度无变化'
    return f"整理 {knowledge.get('processed',0)} 条消息（{sessions} 个会话），新增 {knowledge.get('created',0)} 条记忆；{affinity}"


def assessment_audit(context):
    """Keep source coordinates in operational history, never copied message bodies."""
    result={key:value for key,value in context.items() if not key.startswith('_')}
    for key in ('messages','conversation','memory','thought_sources'):
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
        raise ValueError('主动检查未返回检查结果，请检查数字人引擎配置后重试')
    if body in ('NO_REPLY', '[SILENT]', 'HEARTBEAT_OK'):
        return {'decision': 'silent', 'summary': '无需要通知的新变化', 'source_ids': []}
    lines = body.splitlines()
    if len(lines) >= 3 and lines[0].strip().lower() in ('```', '```json') and lines[-1].strip() == '```':
        body = '\n'.join(lines[1:-1]).strip()
    try:
        result = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ValueError('主动检查结果不是有效的 JSON，请重试或更换数字人引擎') from exc
    if (not isinstance(result, dict) or result.get('decision') not in ('silent', 'notify')
            or not isinstance(result.get('summary'), str)
            or not isinstance(result.get('source_ids'), list)
            or any(not isinstance(item, str) for item in result['source_ids'])):
        raise ValueError('主动检查结果结构无效，请重试或更换数字人引擎')
    return result


class DigitalPersonRuntime:
    def __init__(self, projects, chats, bots, bus):
        self.projects, self.chats, self.bots, self.bus = projects, chats, bots, bus
        self._check_lock = asyncio.Lock()
        self._loop_task = None
        self._cycle_task = None
        self._active_check = None
        self._active_assessment_task = None
        from services.digital_person_followup import DelegationFollower
        self._follower = DelegationFollower(self)

    async def home(self):
        return await customization_workspace.ensure_default_workspace(self.projects)

    async def main_session(self):
        home = await self.home()
        profile = await asyncio.to_thread(digital_person.get_profile)
        def operation(_):
            state = read_state(home.id)
            row = ChatSession.get_or_none(ChatSession.id == state['main_session_id'], ChatSession.archived == False)
            if row:
                return self.chats.get_session(home.id, row.id)
            result = self.chats.create_session(home.id, title=profile.name)
            state['main_session_id'] = result['id']
            write_state(home.id, state)
            return result
        return await self.projects.run_db(home.id, operation)

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
            from collections import Counter
            recent = ChatMessage.select(ChatMessage.content).where(ChatMessage.role == 'user', ChatMessage.session.not_in(state.get('check_sessions', []))).order_by(ChatMessage.created_at.desc()).limit(200)
            counts = Counter(' '.join(r.content.strip().split())[:180] for r in recent if r.content.strip() and len(r.content) <= 300)
            suggestions = [{'id':'frequent-' + str(index),'label':text[:24],'prompt':text,'count':count}
                           for index,(text,count) in enumerate(counts.most_common(3)) if count >= 2]
            return {**state, **statistics, 'suggestions': suggestions, 'checking': self._check_lock.locked(),
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
            delegations.sort(key=lambda item: bool(item.get('notified')))
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
                'delegation_total': len(delegations),
                'delegation_pending': any(not d.get('notified') or notification(d)['notification_state'] == 'notifying' for d in delegations),
                'delegations': [{**{key: row.get(key) for key in ('id', 'project_id', 'session_id', 'status')},
                                 'instruction': str(row.get('instruction') or '')[:120], **notification(row)}
                                for row in delegations[delegation_offset:delegation_offset + limit]],
                'runs': [{**{key: row.get(key) for key in ('id', 'status', 'created_at')},
                          'summary': str(row.get('error') or row.get('activity_summary') or row.get('summary') or '')[:120]}
                         for row in runs[run_offset:run_offset + limit]],
            }
        return await self.projects.run_db(home.id, read)

    async def run_detail(self, run_id):
        home = await self.home()
        def read(_):
            row = next((r for r in read_state(home.id).get('runs', []) if r['id'] == run_id), None)
            if row is None:
                raise ValueError('运行记录已不存在')
            result={key: row.get(key) for key in ('id', 'status', 'summary', 'error', 'created_at', 'ended_at')}
            if row.get('activity_summary'):
                result['summary']=row['activity_summary']+('\n'+row['summary'] if row.get('summary') else '')
            return result
        return await self.projects.run_db(home.id, read)

    async def feedback(self, message_id, value):
        if value not in (-1, 0, 1):
            raise ValueError('反馈只能是 -1、0 或 1')
        home = await self.home()
        def operation(_):
            state = read_state(home.id)
            if not ChatMessage.get_or_none(ChatMessage.id == message_id, ChatMessage.role == 'assistant'):
                raise ValueError('找不到数字人回复')
            state['feedback'][message_id] = value
            write_state(home.id, state)
        await self.projects.run_db(home.id, operation)
        return await self.overview()

    async def delegate(self, project_id, instruction, origin_session_id='', request_id=''):
        if not (await asyncio.to_thread(digital_person.get_profile)).enabled:
            raise ValueError('请先开启数字人')
        if not instruction.strip() or len(instruction) > 12000:
            raise ValueError('请填写有效的执行要求')
        target = self.projects.get_project_by_id(project_id)
        if not target:
            raise ValueError('目标项目不存在')
        home = await self.home()
        if project_id == home.id:
            raise ValueError('请把执行工作交给具体项目')
        if not request_id:
            raise ValueError('缺少委派请求标识')
        # Serialize creation and request deduplication, not the worker execution.
        if not hasattr(self, '_delegate_lock'):
            self._delegate_lock = asyncio.Lock()
        async with self._delegate_lock:
            state = await self.state()
            existing = next((d for d in state['delegations'] if d['request_id'] == request_id), None)
            if existing:
                if existing['project_id'] != project_id or existing['instruction'] != instruction:
                    raise ValueError('请求标识已用于其他委派')
                return existing
            if not origin_session_id:
                origin_session_id = (await self.main_session())['id']
            valid = await self.projects.run_db(home.id, lambda _: ChatSession.get_or_none(ChatSession.id == origin_session_id) is not None)
            if not valid:
                raise ValueError('来源会话不属于数字人工作区')
            def create(_):
                session = self.chats.create_session(project_id, title=instruction[:60])
                accepted = self.chats.submit_message(project_id, session['id'], instruction, request_id, schedule=False)
                return session, accepted
            session, accepted = await self.projects.run_db(project_id, create)
            item = {'id': str(uuid.uuid4()), 'request_id': request_id, 'project_id': project_id,
                    'session_id': session['id'], 'origin_session_id': origin_session_id,
                    'message_id': accepted.assistant_message_id, 'instruction': instruction,
                    'status': 'running', 'created_at': utc_now(), 'notified': False}
            await self.mutate(lambda s: s['delegations'].append(item))
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
        if batch and any(by_id.get('memory:'+str(r['id']),{}).get('source_hash') != r['source_hash'] for r in batch):
            raise ValueError('待思考来源已变化或不可用，请下轮重试')
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
        token = None
        if context.get('origin_session_id') or context.get('_load'):
            from services import memory_query
            token = await memory_query.issue_access(self.projects, scope,
                session_id=context.get('origin_session_id',''), issuer_project_id=context.get('origin_project_id',home.id),
                issuer_kind='task' if context.get('source_kind')=='task' else 'chat')
            from services.digital_person_reflection import model_context
            if context.get('_load'):
                async def load():
                    await context['_load']()
                    return model_context(context, home.id)
                memory_query.bind_assessment_loader(token, load)
            else:
                memory_query.bind_assessment(token, model_context(context, home.id))
            checker._config = replace(checker._config, system_prompt=checker._config.system_prompt +
                '\n' + memory_query.assessment_instruction(token) +
                '\nFirst use the workstep-cli skill to run memory pending to fetch this assessment batch. Read the complete conversation bodies returned by pending. '
                'Use targeted existing-knowledge lookup only when needed to compare or maintain this batch\'s knowledge; never scan old source history.')
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
        await self.bus.publish({'type': 'CUSTOM', 'name': 'channel.session_changed',
                                'channel': 'session_chat', 'project_id': home.id})
        self._active_check = (checker, home.id, row['id'])
        try:
            from services.digital_person_browser import attach
            await asyncio.to_thread(attach, home.id, row['id'])
            checker.start_queued_turn(accepted.turn_id)
            retried_empty = False
            retried_invalid = False
            async with asyncio.timeout(180):
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
                                    'Complete the previous turn by returning the final JSON based on the information already verified. '
                                    'If nothing changed, return {"decision":"silent","summary":"No changes","source_ids":[]}. '
                                    'State uncertain results explicitly as unknown.', str(uuid.uuid4()), schedule=False)
                            accepted = await self.projects.run_db(home.id, confirm)
                            checker.start_queued_turn(accepted.turn_id)
                            continue
                        try:
                            decision = parse_check_result(content)
                            from services.memory_policy import validate_memories
                            versions=memory_query.observed_knowledge_versions(token) if token else {}
                            validate_memories(decision,context,versions)
                        except ValueError as exc:
                            if retried_invalid:
                                raise
                            retried_invalid=True
                            from services.memory_secrets import redact
                            error=redact(str(exc))[:1500]
                            def repair(_):
                                return checker.submit_internal_event(home.id,row['id'],'digital_person.reflection',
                                    'The assessment was not applied. Validation error: '+error+
                                    '\nReturn a corrected complete assessment JSON for the same pending batch. '
                                    'Correct fields using the existing evidence; do not invent missing entities, facts or source IDs. '
                                    'For missing relation endpoints, declare the evidenced entity or omit the unsupported relation. '
                                    'Omit unsupported memory candidates. Preserve unaffected valid candidates. '
                                    'Do not send messages or repeat completed operations.',str(uuid.uuid4()),schedule=False)
                            accepted=await self.projects.run_db(home.id,repair)
                            checker.start_queued_turn(accepted.turn_id)
                            continue
                        if token:
                            if not memory_query.assessment_observed(token):
                                raise ValueError('尚未领取本轮待整理消息，保留待处理状态')
                            decision['_retrieved_knowledge_ids'] = memory_query.observed_knowledge_versions(token)
                            decision['_read_source_ids'] = memory_query.observed_sources(token, context.get('_read_requirements', []))
                        def confirmed(state):
                            state['check_trigger_version'] = 1
                            state['check_context_scope'] = scope
                            state['check_history_cutoff'] = history_cutoff
                            state.pop('check_context_pending_scope', None)
                        await self.mutate(confirmed)
                        return decision
                    if status in ('failed', 'error', 'stopped'):
                        raise RuntimeError('主动检查未完成：' + status)
                    await asyncio.sleep(.25)
        finally:
            if token:
                memory_query.clear_assessment(token)
            await checker.stop_current(row['id'], home.id)
            await checker.shutdown()
            self._active_check = None
            await self.bus.publish({'type': 'CUSTOM', 'name': 'channel.session_changed',
                                    'channel': 'session_chat', 'project_id': home.id})

    async def _deliver_local(self, sid, text, run_id, *, proactive=False, project_id=''):
        home = await self.home()
        if project_id:
            home = self.projects.get_project_by_id(project_id)
            if home is None:
                raise ValueError('通知来源项目不存在')
        mid = str(uuid.uuid5(uuid.NAMESPACE_URL, run_id + sid))
        def write(_):
            if not ChatSession.get_or_none(ChatSession.id == sid, ChatSession.archived == False):
                raise ValueError('通知来源会话已归档或删除')
            if ChatMessage.get_or_none(ChatMessage.id == mid):
                return False
            ChatMessage.insert(id=mid, session=sid, role='assistant', content=text, status='completed', created_at=utc_now(), ended_at=utc_now()).on_conflict_ignore().execute()
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
        from services.memory_secrets import redact
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
        proactive = run.get('trigger') in ('manual','interval') and scope == 'local' and run.get('origin_session_id') not in routes.get('session_sources', {})
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
                    await self._deliver_local(sid, text, run_id, **local_options)
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
            raise ValueError('数字人主动检查未开启')
        if self._check_lock.locked():
            raise ValueError('已有检查正在进行')
        async with self._check_lock:
            from services.memory_pending_queue import has_pending
            from services.digital_person_memory import allowed_projects
            if manual:
                await self.follow_delegations(profile)
                from services.memory_knowledge import ensure_schema
                await asyncio.to_thread(ensure_schema)
            if not await asyncio.to_thread(has_pending,allowed_projects(self.projects)):
                return {'status':'silent','sources':{'no_work':True},'deliveries':[]}
            run = {'id':str(uuid.uuid4()),'created_at':utc_now(),'status':'running','trigger':'manual' if manual else 'interval','sources':[],'deliveries':[],'relationship_updates':[],'memory_updates':[]}
            await self.mutate(lambda s: s['runs'].insert(0, run.copy()))
            claimed = False
            committed = False
            context = {}
            try:
                from services import digital_person_assessment as assessment
                async def load_batch():
                    nonlocal claimed
                    prepared = await self._collect()
                    context.clear()
                    context.update(prepared)
                    if prepared.get('no_work'):
                        return
                    if not await asyncio.to_thread(assessment.claim,prepared.get('reflection_batch',[])):
                        raise ValueError('来源正在处理或已变化，等待下一轮')
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
                if '_load' in context:
                    raise ValueError('尚未调用 CLI 获取待整理消息')
                if context.get('no_work'):
                    run.update(status='silent',summary='没有待处理事件')
                    return run
                ids = decision.get('source_ids', [])
                known = {row['id'] for key in ('messages', 'delegations', 'conversation', 'memory', 'thought_sources') for row in context.get(key, [])}
                if decision.get('decision') not in ('silent','notify') or not isinstance(ids,list) or not set(ids).issubset(known):
                    raise ValueError('检查结果来源无效')
                from services.memory_secrets import redact
                run['summary'] = redact(str(decision.get('summary','')))[:3000]
                run['status'] = decision['decision']
                run['kind'] = decision.get('kind', 'work')
                if run['kind'] not in ('work', 'social'):
                    raise ValueError('主动检查类型无效')
                if decision['decision'] == 'notify':
                    terminal = {d['id'] for d in context.get('delegations', [])
                                if d['status'] in ('completed','succeeded','failed','error','stopped','missing')}
                    terminal.update(m['id'] for key in ('conversation','memory','thought_sources')
                                    for m in context.get(key, []))
                    if not ids or not set(ids).issubset(terminal) or not run['summary'].strip():
                        raise ValueError('尚无可通知的来源或结果')
                from services import digital_person_reflection as reflection
                required={r['id'] for r in context.get('_read_requirements',[])}
                if not required.issubset(set(decision.get('_read_source_ids',[]))):
                    raise ValueError('尚未读取本轮长消息原文，保留待思考状态')

                if not await asyncio.to_thread(reflection.current, context.get('reflection_batch', [])):
                    raise ValueError('思考期间来源已变化，未应用旧结论')
                memories = decision.get('memories', [])
                from services.memory_knowledge import _validate
                available = {int(r['id']):r for r in context.get('reflection_batch',[]) if r.get('needs_knowledge',True)}
                if not isinstance(memories,list) or len(memories)>24:
                    raise ValueError('记忆候选格式无效')
                existing_ids = decision.get('_retrieved_knowledge_ids', [])
                for item in memories:
                    validated = _validate(item,available)
                    if not {f'knowledge:{x}' for x in validated['supersedes']}.issubset(set(existing_ids)):
                        raise ValueError('记忆纠正未引用本轮查询过的知识')
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
                    raise ValueError('主动通知需对应一个明确的来源会话')
                # Validate and atomically commit knowledge before relationship or
                # delivery effects; a stale replacement must not change affinity.
                result = await asyncio.to_thread(assessment.commit,batch_context.get('reflection_batch',[]),memories,run['id'],existing_ids)
                committed = True
                run['memory_processing'] = {'status':'idle','mode':'unified','knowledge':result}
                await asyncio.to_thread(memory_index.mutate_state,'memory_worker',lambda s:s.update(
                    status='idle',mode='unified',error_type=None,retry_at=0,knowledge=result,finished_at=utc_now().isoformat()))
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
                if run['kind'] == 'social' and not manual and not profile.proactive_enabled:
                    run.update(status='silent', summary=run['summary'] or '主动交流已关闭，已完成内部思考')
                    return run
                if context.get('archived_source'):
                    run.update(status='silent', summary=run['summary'] or '归档来源已完成内部思考')
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
                        rows=ChatMessage.select().where(ChatMessage.session==sid)
                        if rows.where(ChatMessage.status.in_(['queued','running','stopping'])).exists():
                            return True
                        timestamps=[m['created_at'] for m in context.get('conversation',[]) if m.get('created_at')]
                        return bool(timestamps and rows.where(ChatMessage.created_at>max(datetime.fromisoformat(str(t)) for t in timestamps)).exists())
                    if await self.projects.run_db(context['origin_project_id'],currently_busy):
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
                                companion.reserve_contact(s, scope, run['id'], utc_now())
                            for item in s['delegations']:
                                if item['id'] in ids:
                                    item.update(notified=True, notification_run_id=run['id'])
                            for record in s['runs']:
                                if record['id']==run['id']:
                                    record.update(status='notifying', summary=run['summary'],
                                                  origin_session_id=run['origin_session_id'], sources=assessment_audit(run['sources']),
                                                  notification_key=fingerprint, notification_sources=ids, kind=run['kind'])
                        await self.mutate(reserve)
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
                    run['activity_summary']=completed_activity_summary(run)
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
                    run.update(status='interrupted', error='服务重启，未自动重发通知')
            _rename_check_session(state.get('check_session_id'))
        await self.mutate(recover)
        from services.memory_knowledge import ensure_schema
        await asyncio.to_thread(ensure_schema)
        self._loop_task = asyncio.create_task(self._loop())

    async def follow_delegations(self, profile=None):
        profile = profile or await asyncio.to_thread(digital_person.get_profile)
        await self._follower.poll(profile)

    async def _tick(self, now=None, *, background=False):
        profile = await asyncio.to_thread(digital_person.get_profile)
        if not profile.enabled or not profile.reflection_enabled:
            return
        now = now or datetime.now(timezone.utc)
        if self._cycle_task and not self._cycle_task.done():
            return
        state = await self.state()
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
        # Drain durable pending work in isolated, bounded source batches.
        # Scheduling time never determines whether an event is eligible.
        while True:
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
            raise ValueError('请等待当前检查完成')
        async with self._check_lock:
            profile = await asyncio.to_thread(digital_person.get_profile)
            if not profile.enabled:
                raise ValueError('数字人已关闭')
            state = await self.state()
            run = next((r for r in state['runs'] if r['id']==run_id),None)
            if not run or run['status'] != 'delivery_failed':
                raise ValueError('没有可重试的投递')
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
                            await self._deliver_local(receipt['session_id'], run['summary'], run_id, **options)
                        result = {}
                    else:
                        binding = next((b for b in bindings if b['id']==receipt.get('binding_id') and b.get('notify')),None)
                        if binding is None:
                            raise ValueError('通知绑定已解除或关闭，请重新选择接收会话')
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
        state=await self.state()
        item=next((d for d in state['delegations'] if d['id']==delegation_id),None)
        if not item:
            raise ValueError('委派不存在')
        await self.chats.stop_current(item['session_id'],item['project_id'],expected_message_id=item['message_id'])
        return {'stopped':True}
