"""Bounded source-backed memory tools; capabilities are minted by execution code only."""
import asyncio
import copy
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
import threading
import time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import peewee as pw

from services import digital_person_memory as memory
from services import digital_person_memory_index as index


@dataclass(frozen=True)
class Access:
    scope: str | None
    project_ids: tuple[str, ...]
    session_id: str
    expires: float
    issuer_project_id: str = ''
    issuer_kind: str = 'chat'
    knowledge_ids: set[str] = field(default_factory=set, compare=False)
    knowledge_reads: dict = field(default_factory=dict, compare=False)
    source_reads: dict = field(default_factory=dict, compare=False)
    assessment: dict = field(default_factory=dict, compare=False)


_executions: dict[tuple[str,str], Access] = {}
_lock = threading.Lock()


def _lookup(value):
    return value if isinstance(value,Access) else None


async def execution_access(projects,project_id,session_id,*,fresh=False):
    """Reading state keyed by an existing run identity, without inferring scope."""
    allowed=tuple(sorted(memory.allowed_projects(projects)))
    now=time.monotonic()
    with _lock:
        for key in list(_executions):
            if _executions[key].expires<=now:del _executions[key]
        key=(project_id,session_id)
        access=_executions.get(key)
        if not fresh and access and access.project_ids==allowed:return access
        if len(_executions)>=4096:del _executions[next(iter(_executions))]
        access=Access(None,allowed,session_id,now+7200,project_id)
        _executions[key]=access
        return access


def release_execution(project_id,session_id,access):
    with _lock:
        if _executions.get((project_id,session_id)) is access:
            del _executions[(project_id,session_id)]


def query_access(projects,project_id='',session_id=''):
    """Caller identity locates an active assessment, never narrows normal queries."""
    with _lock:
        active=_executions.get((project_id,session_id))
        if active and active.assessment and active.expires>time.monotonic():
            return active
        allowed=tuple(sorted(memory.allowed_projects(projects)))
        key=('query',allowed)
        access=_executions.get(key)
        if not access or access.expires<=time.monotonic():
            access=Access(None,allowed,'',time.monotonic()+7200)
            _executions[key]=access
        return access


def _project_filter(ids,project_id):
    if not project_id:return ids
    if project_id not in ids:raise PermissionError('Project does not exist or is not accessible')
    return [project_id]


def bind_assessment(token, context):
    """Internal scheduler only: attach an already claimed, bounded batch."""
    with _lock:
        access = _lookup(token)
        if not access or access.expires <= time.monotonic():
            raise PermissionError('The proactive thinking credentials have expired')
        if context.get('origin_project_id') not in access.project_ids:
            raise PermissionError('Source project is inaccessible')
        access.assessment.update(context=copy.deepcopy(context), observed=False)


def bind_assessment_loader(token, loader):
    """Only the scheduler can bind a lazy, execution-local batch loader."""
    with _lock:
        access = _lookup(token)
        if not access or access.expires <= time.monotonic():
            raise PermissionError('The proactive thinking credentials have expired')
        access.assessment.update(loader=loader, load_lock=asyncio.Lock(), observed=False)


def assessment_observed(token):
    with _lock:
        access = _lookup(token)
        return bool(access and access.expires > time.monotonic() and access.assessment.get('observed'))


def clear_assessment(token):
    with _lock:
        access = _lookup(token)
        if access:
            access.assessment.clear()


async def pending(projects, context):
    """Return only this execution's scheduler-assigned batch, never global backlog."""
    access, ids = await _authorize(projects, context)
    loader = access.assessment.get('loader')
    if loader:
        async with access.assessment['load_lock']:
            if 'context' not in access.assessment:
                context = await loader()
                projects_in_batch = {r['project_id'] for r in context.get('conversations', [])}
                projects_in_batch.update(r['project_id'] for r in context.get('delegations', [])
                                         if r['status'] != 'missing')
                projects_in_batch.add(context.get('origin_project_id'))
                if not projects_in_batch.issubset(set(ids)):
                    raise PermissionError('Source project is inaccessible')
                access.assessment['context'] = copy.deepcopy(context)
    assigned = access.assessment.get('context')
    if assigned is None or assigned.get('origin_project_id') not in ids:
        raise PermissionError('No active thinking batches available for claim in this execution')
    async with access.assessment.setdefault('catalog_lock', asyncio.Lock()):
        context = access.assessment.get('context')
        if context is not None and context.get('origin_project_id') in ids and 'session_knowledge' not in context:
            from services.memory_session_context import catalog, preferences
            groups = context.get('conversations', [context])
            sessions = [(g.get('project_id', g.get('origin_project_id', context['origin_project_id'])),
                         g.get('session_id', g.get('origin_session_id', '')),
                         g.get('companion', {}).get('scope', '')) for g in groups]
            directory = await asyncio.to_thread(catalog, sessions, ids)
            snapshot,versions = await asyncio.to_thread(preferences, sessions, ids)
            context['session_knowledge'] = directory
            context['user_preferences'] = snapshot
            access.assessment['preference_versions'] = versions
            access.knowledge_ids.update(versions)
    with _lock:
        context = access.assessment.get('context')
        if context is None or context.get('origin_project_id') not in ids:
            raise PermissionError('No active thinking batches available for claim in this execution')
        access.assessment['observed'] = True
        return copy.deepcopy(context)


def observed_knowledge(token):
    with _lock:
        access = _lookup(token)
        return sorted(access.knowledge_ids) if access and access.expires > time.monotonic() else []


def observed_knowledge_versions(token):
    with _lock:
        access=_lookup(token)
        if not access or access.expires<=time.monotonic():
            return {}
        result=dict(access.assessment.get('preference_versions',{}))
        for (kid,version,total),ranges in access.knowledge_reads.items():
            end=0
            for start,stop in sorted(ranges):
                if start>end: break
                end=max(end,stop)
            if end>=total: result[kid]=version
        return result


def observed_sources(token, requirements):
    """Report only ranges actually returned by this execution's read tool."""
    with _lock:
        access = _lookup(token)
        if not access or access.expires <= time.monotonic():
            return []
        covered = []
        for item in requirements:
            end = item['offset']
            key = (item['project_id'], item['source_message_id'], item['offset'], item['source_hash'])
            for start, stop in sorted(access.source_reads.get(key, [])):
                if start > end:
                    break
                end = max(end, stop)
            if end >= item['offset'] + item['length']:
                covered.append(item['id'])
        return covered


async def create_context(projects, scope, project_ids=None, session_id='', ttl=7200, issuer_project_id='', issuer_kind='chat'):
    """Build internal reading state without issuing a credential."""
    allowed = set(memory.allowed_projects(projects))
    if project_ids is not None:
        allowed.intersection_update(project_ids)
    return Access(scope,tuple(sorted(allowed)),session_id,time.monotonic()+min(max(ttl,1),7200),issuer_project_id,issuer_kind)


def instruction():
    return ''


async def _authorize(projects, token):
    from services.digital_person import get_profile
    if not (await asyncio.to_thread(get_profile)).enabled:
        raise PermissionError("Memory feature is disabled")
    with _lock:
        access = _lookup(token)
    if access is None or access.expires <= time.monotonic():
        raise PermissionError("Invalid or expired memory access credentials, please retry in a new execution round")
    allowed = set(memory.allowed_projects(projects)).intersection(access.project_ids)
    return access, sorted(allowed)


async def _preference_source_authors(projects, records):
    from models.chat_session import ChatMessage, ChatSession
    from models.message import Message

    by_project = {}
    for record in records:
        for source in record['sources']:
            if source['role'] == 'user':
                by_project.setdefault(source['project_id'], []).append(source)

    def read(project_id, sources):
        authors = {}
        automated = {"scheduler", "assistant", "system", "coordinator"}
        chat_ids = {source['message_id'] for source in sources if source['source_kind'] == 'chat'}
        task_ids = {source['message_id'].removeprefix('task:') for source in sources if source['source_kind'] == 'task'}
        for row in (ChatMessage.select(ChatMessage.id, ChatMessage.session, ChatMessage.author_id,
                                       ChatMessage.author_type, ChatMessage.author_name)
                    .join(ChatSession).where(ChatMessage.id.in_(chat_ids), ChatMessage.role == 'user',
                                             ChatSession.project_id == project_id)):
            if row.author_type not in automated:
                authors[('chat', row.session_id, row.id)] = (row.author_id, row.author_name)
        for row in (Message.select(Message.id, Message.task, Message.author_id, Message.author_type, Message.author_name)
                    .where(Message.id.in_(task_ids), Message.role == 'user')):
            if row.author_type not in automated:
                authors[('task', row.task_id, 'task:' + row.id)] = (row.author_id, row.author_name)
        return {source['id']: authors.get((source['source_kind'], source['session_id'], source['message_id']), (None, None))
                for source in sources}

    batches = await asyncio.gather(*(projects.run_db(project_id, lambda _, pid=project_id, rows=sources: read(pid, rows))
                                     for project_id, sources in by_project.items()))
    return {source_id: author for batch in batches for source_id, author in batch.items()}


async def list_preferences(projects, context, *, project_id, session_id, sender_id=None, self_only=False, cursor=0, limit=20):
    from services.conversation_context import active_conversation_sender
    from services.project_scope import require_catalog_project
    from services.remote_access import get_current_actor
    from services import memory_knowledge

    require_catalog_project('')
    access, ids = await _authorize(projects, context)
    if access.assessment:
        raise PermissionError('Use the assigned batch to review preferences during background assessment')

    sender = active_conversation_sender(project_id, session_id)
    current_sender = sender.get('sender_id')
    if self_only:
        if not current_sender:
            raise PermissionError('No identified sender for the current conversation turn')
        sender_id = current_sender
    if project_id or session_id:
        if not current_sender or project_id not in ids:
            raise PermissionError('No identified sender for the current conversation turn')
        if sender_id != current_sender:
            from services.config import config_store

            device = await asyncio.to_thread(config_store.get, 'device', {})
            if not isinstance(device, dict) or current_sender != device.get('device_id'):
                raise PermissionError("Only the host user can look up other senders' preferences")
    else:
        actor = get_current_actor()
        if actor is not None and actor.source != 'local':
            raise PermissionError('A sender lookup without a conversation requires local host access')
    display_name = sender.get('sender_name') if current_sender == sender_id else None
    records = []
    before_id = cursor
    while len(records) <= limit:
        batch = await memory_knowledge.search(
            projects, None, kind='preference', project_ids=ids, before_id=before_id,
            limit=50, include_source_locations=True,
        )
        if not batch:
            break
        authors = await _preference_source_authors(projects, batch)
        for record in batch:
            evidence = [authors[source['id']] for source in record['sources'] if source['role'] == 'user']
            owner_ids = {author_id for author_id, _ in evidence}
            if len(owner_ids) != 1:
                continue
            owner_id = next(iter(owner_ids))
            if owner_id and (sender_id is None or owner_id == sender_id):
                source_name = next((name for _, name in evidence if name), None)
                if current_sender != sender_id and not display_name and len(records) < limit:
                    display_name = source_name
                records.append((record, {'sender_id': owner_id, 'display_name': source_name}))
        before_id = int(batch[-1]['id'].split(':', 1)[1])
    items = [
        {**{key: record[key] for key in ('id', 'summary', 'state', 'valid_until')},
         'source_ids': [source['id'] for source in record['sources']],
         **({'owner': owner} if sender_id is None else {})}
        for record, owner in records[:limit]
    ]
    has_more = len(records) > limit
    if active_conversation_sender(project_id, session_id) != sender:
        raise PermissionError('The conversation turn has changed, retry in the current turn')
    return {**({'owner': {'sender_id': sender_id, 'display_name': display_name or None}} if sender_id is not None else {}),
            'items': items, 'has_more': has_more,
            'next_cursor': int(items[-1]['id'].split(':', 1)[1]) if has_more else None}


def time_range(*, since=None, before=None, period='', timezone_name='Asia/Shanghai', now=None):
    try:
        zone = ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as exc:
        raise ValueError("Invalid timezone") from exc
    def normalize(value):
        if not value:
            return None
        value = datetime.fromisoformat(value.replace('Z', '+00:00')) if isinstance(value, str) else value
        if value.tzinfo is None:
            value = value.replace(tzinfo=zone)
        return value.astimezone(timezone.utc).isoformat()
    if period:
        if since or before:
            raise ValueError("period and since/before cannot be used together")
        local = (now or datetime.now(timezone.utc)).astimezone(zone)
        first = local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        if period in ('上月', 'last_month'):
            before, since = first, (first - timedelta(days=1)).replace(day=1)
        elif period in ('本月', 'this_month'):
            since, before = first, local
        elif period in ('昨天', 'yesterday', '今天', 'today'):
            day = local.replace(hour=0, minute=0, second=0, microsecond=0)
            since, before = (day - timedelta(days=1), day) if period in ('昨天', 'yesterday') else (day, local)
        else:
            raise ValueError("Unsupported time range, please use explicit since/before")
    start, end = normalize(since), normalize(before)
    if start and end and start >= end:
        raise ValueError("since must be earlier than before")
    return start, end


async def search(projects, context, *, query='', cursor=0, limit=20, since=None, before=None,
                 period='', timezone_name='Asia/Shanghai', include_knowledge=True, snapshot='',
                 include_sources=False, source_chars=2400, person='', event='', object='', place='', time='', relation='',
                 filter_project_id='',filter_session_id='', knowledge_only=False):
    access, ids = await _authorize(projects, context)
    ids=_project_filter(ids,filter_project_id)
    if access.assessment and (not any(isinstance(value,str) and value.strip() for value in (query,person,event,object,place,time,relation)) or since or before or period or include_sources):
        raise PermissionError('Background organization only allows targeted queries of existing knowledge; reviewing historical original text is not permitted.')
    if not 1 <= limit <= 100 or cursor < 0 or len(query) > 1000 or not 1 <= source_chars <= 6000:
        raise ValueError("Invalid query or pagination parameters")
    filters={}
    for kind,value in (('person',person),('event',event),('object',object),('place',place),('time',time)):
        if not isinstance(value,str) or (value and not 1 <= len(value.strip()) <= 120):
            raise ValueError('Entity condition must be 1–120 characters')
        if value:
            filters[kind]=value.strip()
    if not isinstance(relation,str) or (relation and not 1 <= len(relation.strip()) <= 120):
        raise ValueError('The relationship condition must be 1 to 120 characters')
    relation=relation.strip()
    structured=bool(filters or relation)
    query = query.strip()
    if not knowledge_only and not structured and (not query or since or before or period):
        from services.memory_history import page
        result = await page(projects, access.scope, ids, context, cursor=cursor, limit=limit,
                          since=since, before=before, period=period, timezone_name=timezone_name, snapshot=snapshot, query=query,session_id=filter_session_id)
        return await _with_sources(projects, context, result, source_chars) if include_sources else result
    if snapshot or cursor:
        raise ValueError('Knowledge search returns ranked results; history cursors apply only to date-range history')
    since, before = time_range(since=since, before=before, period=period, timezone_name=timezone_name)
    from services import memory_knowledge
    knowledge = await memory_knowledge.search(projects, access.scope, query, limit=min(limit,20),
        project_ids=ids, since=since, before=before, filters=filters, relation=relation,session_id=filter_session_id) if include_knowledge else []
    with _lock:
        access.knowledge_ids.update(item['id'] for item in knowledge)
    result = {'items':[], 'knowledge':knowledge, 'has_more':False, 'next_cursor':None,
              'coverage':{'basis':'knowledge_index','complete_source_history':False,
                          'project_ids':ids,'since':since,'before':before,
                          'filter_session_id':filter_session_id,'note':'Ranked knowledge results only; unprocessed messages are not searched. Read source IDs for originals.'}}
    return await _with_sources(projects, context, result, source_chars) if include_sources else result


async def _with_sources(projects, token, result, source_chars):
    """Expand only returned evidence, reusing read authorization and version checks."""
    access, project_ids = await _authorize(projects, token)
    source_ids = list(dict.fromkeys(
        [s['id'] for k in result.get('knowledge', []) for s in k.get('sources', [])]
        + [item['id'] for item in result.get('items', [])]))
    texts, seen, deferred, unavailable = [], {}, [], []
    budget = 12000
    for mid in source_ids:
        # Bound work as well as output even if one knowledge item cites many chunks.
        if len(texts) + len(unavailable) >= 20 or budget <= 0:
            deferred.append(mid)
            continue
        row = await asyncio.to_thread(_find, access.scope, project_ids, mid)
        if row is None:
            unavailable.append(mid)
            continue
        key = (row['project_id'], row['source_message_id'])
        if key in seen:
            seen[key]['source_ids'].append(mid)
            continue
        try:
            original = await read(projects, token, mid, offset=0, limit=min(source_chars, budget))
        except (LookupError, OSError, sqlite3.DatabaseError, pw.DatabaseError):
            unavailable.append(mid)
            continue
        source = {k:original[k] for k in (
            'id','project_id','session_id','source_message_id','role','author_id','author_name',
            'source_kind','outcome','created_at','content','offset','next_offset','has_more','total_chars') if k in original}
        source['source_ids'] = [mid]
        texts.append(source)
        seen[key] = source
        budget -= len(source['content'])
    result['source_texts'] = texts
    result['source_coverage'] = {
        'complete': not deferred and not unavailable and not any(s['has_more'] for s in texts),
        'deferred_ids': deferred, 'unavailable_ids': unavailable,
        'max_sources': 20, 'max_total_chars': 12000,
    }
    return result


async def history(projects, context, *, query='', cursor=0, limit=20, since=None, before=None,
                  period='', timezone_name='Asia/Shanghai', include_knowledge=True, snapshot='',filter_project_id='',filter_session_id=''):
    from services.memory_history import page
    access, ids = await _authorize(projects, context)
    ids=_project_filter(ids,filter_project_id)
    if access.assessment:
        raise PermissionError('Background cleanup does not allow reviewing the original text')
    return await page(projects, access.scope, ids, context, cursor=cursor, limit=limit,
                      since=since, before=before, period=period, timezone_name=timezone_name, snapshot=snapshot, query=query,session_id=filter_session_id)


def _find(scope, ids, memory_id):
    try:
        mid = int(str(memory_id).removeprefix('memory:'))
    except ValueError as exc:
        raise ValueError("Invalid memory ID") from exc
    with index.connect() as db:
        alias=db.execute('SELECT memory_id FROM memory_source_aliases WHERE old_id=?',(mid,)).fetchone()
        mid=alias[0] if alias else mid
        row = db.execute('SELECT * FROM memories WHERE id=? AND (? IS NULL OR scope=?) AND forgotten=0', (mid, scope,scope)).fetchone()
        if not row or row['project_id'] not in ids:
            return None
        forgotten = db.execute('SELECT 1 FROM memories WHERE project_id=? AND source_message_id=? AND forgotten=1 LIMIT 1',
                               (row['project_id'], row['source_message_id'])).fetchone()
        return None if forgotten else dict(row)


async def read(projects, context, memory_id, *, offset=0, limit=2400, events=False,filter_project_id='',filter_session_id=''):
    access, ids = await _authorize(projects, context)
    ids=_project_filter(ids,filter_project_id)
    if offset < 0 or not 1 <= limit <= 6000:
        raise ValueError("Invalid pagination parameters")
    if str(memory_id).startswith('knowledge:'):
        if events: raise ValueError('Knowledge record has no execution log')
        if memory_id not in access.knowledge_ids:
            raise PermissionError('Please search for the knowledge record first')
        from services.memory_knowledge import read_record
        record=await asyncio.to_thread(read_record,access.scope,ids,memory_id,filter_session_id)
        text=record.pop('content');version=record.pop('version')
        end=min(len(text),offset+limit)
        with _lock:
            access.knowledge_reads.setdefault((memory_id,version,len(text)),[]).append((offset,end))
        return {**record,'content':text[offset:end],'offset':offset,'has_more':end<len(text),
                'next_offset':end if end<len(text) else None,'total_chars':len(text)}
    if access.assessment:
        raise PermissionError('Background cleanup reads new evidence via pending; only allows reading already-located knowledge')
    row = await asyncio.to_thread(_find, access.scope, ids, memory_id)
    if not row:
        raise LookupError("Memory does not exist or is not accessible")
    if filter_session_id and row['session_id']!=filter_session_id.removeprefix('task:'):
        raise LookupError('Memory not found in the specified session')
    hits = await memory.read_projects(projects, [row])
    if not hits:
        raise LookupError("Memory original is no longer available")
    if events:
        from services.digital_person_memory import read_task_events
        result = await read_task_events(projects, row, offset=offset, limit=min(limit,100))
        if result is None:
            raise LookupError("The original event does not exist or is inaccessible")
        return result
    def original(_):
        return memory.source_text(row)
    text = await projects.run_db(row['project_id'], original)
    if text is None:
        raise LookupError("Memory original is no longer available")
    end = min(len(text), offset + limit)
    with _lock:
        key=(row['project_id'],row['source_message_id'],0,'')
        access.source_reads.setdefault(key, []).append((offset,end))
    return {**hits[0], 'content': text[offset:end], 'offset': offset, 'has_more': end < len(text),
            'next_offset': end if end < len(text) else None, 'total_chars': len(text)}
