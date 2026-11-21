"""Bounded keyset traversal of authoritative project histories, independent of index lag."""
import asyncio
import copy
from datetime import datetime, timezone
import secrets
import threading
import time

import peewee as pw
from services import digital_person_memory as memory, digital_person_memory_index as index

_snapshots = {}
_lock = threading.Lock()


def _scan(project_id, kind, scope, since, before, cutoff, after, limit, query="",session_id=""):
    from models.chat_session import ChatMessage, ChatSession
    from models import Message
    from services.digital_person_runtime import read_state
    # Narrow non-owner scopes before LIMIT/counting; post-filtering would reveal
    # private activity through empty pages and scanned/excluded counters.
    scoped_session = scoped_task = None
    if scope is not None and scope != 'local':
        if kind == 'chat':
            data = memory.digital_person.config_store.get('channel_bots', {})
            if scope.startswith('channel:'):
                scoped_session = data.get('sessions', {}).get(scope.removeprefix('channel:'))
            elif scope.startswith('session:'):
                candidate = scope.removeprefix('session:')
                if candidate in data.get('session_sources', {}):
                    scoped_session = candidate
            if not scoped_session or memory.scope_for_session(scoped_session) != scope:
                return [], 0, after, 0
        else:
            if not scope.startswith('task:'):
                return [], 0, after, 0
            scoped_task = scope.removeprefix('task:')
            if memory.scope_for_task(project_id, scoped_task) != scope:
                return [], 0, after, 0
    memory.migrate_legacy(project_id)
    if kind == 'chat':
        model = ChatMessage
        stamp = pw.fn.JULIANDAY(ChatMessage.created_at)
        excluded = read_state(project_id).get('check_sessions', [])
        rows = ChatMessage.select(ChatMessage, stamp.alias('_memory_time')).join(ChatSession).where(
            ChatSession.project_id == project_id, ChatSession.id.not_in(excluded),
            ((ChatMessage.role == 'user') & (ChatMessage.status.is_null() | ChatMessage.status.in_(['completed','succeeded']))) |
            ((ChatMessage.role == 'assistant') & ChatMessage.status.in_(['completed','succeeded'])))
    else:
        model = Message
        stamp = pw.fn.JULIANDAY(pw.fn.COALESCE(Message.ended_at, Message.created_at))
        rows = Message.select(Message, stamp.alias('_memory_time')).where(
            Message.run_status.in_(memory.TASK_TERMINAL), Message.role.in_(['user','assistant']))
    if session_id:
        if kind=='chat' and session_id.startswith('task:'):return [],0,after,0
        rows=rows.where((ChatMessage.session if kind=='chat' else Message.task)==session_id.removeprefix('task:'))
    if scoped_session:
        rows = rows.where(ChatMessage.session == scoped_session)
    if scoped_task:
        rows = rows.where(Message.task == scoped_task)
    rows = rows.where(stamp <= pw.fn.JULIANDAY(cutoff))
    if since:
        rows = rows.where(stamp >= pw.fn.JULIANDAY(since))
    if before:
        rows = rows.where(stamp < pw.fn.JULIANDAY(before))
    if after:
        rows = rows.where((stamp > after[0]) | ((stamp == after[0]) & (model.id > after[1])))
    batch = list(rows.order_by(stamp, model.id).limit(limit))
    hits, excluded_count = [], 0
    for message in batch:
        source_id = message.id if kind == 'chat' else 'task:'+message.id
        source_scope = memory.scope_for_session(message.session_id) if kind == 'chat' else memory.scope_for_task(project_id, message.task_id)
        if (scope is not None and source_scope != scope) or memory.source_forgotten({'project_id':project_id,'source_message_id':source_id}):
            excluded_count += 1
            continue
        full_text = message.content if kind == 'chat' else memory.task_source_text(message)
        if query and not any(term.casefold() in full_text.casefold() for term in query.split()):
            continue
        if kind == 'chat':
            memory.capture_message(message, source_scope)
        else:
            memory.capture_task_message(project_id, message)
        with index.connect() as db:
            row = db.execute('SELECT * FROM memories WHERE project_id=? AND source_message_id=? AND offset=0 AND forgotten=0', (project_id, source_id)).fetchone()
        hit = memory._hydrate(dict(row)) if row else None
        if hit:
            full_text = message.content if kind == 'chat' else memory.task_source_text(message)
            hit.update(total_chars=len(full_text), truncated=len(full_text)>len(hit['content']),
                       needs_read=len(full_text)>len(hit['content']))
            hits.append(hit)
        else:
            excluded_count += 1
    last = [batch[-1]._memory_time, batch[-1].id] if batch else after
    return hits, len(batch), last, excluded_count


async def page(projects, scope, project_ids, token, *, cursor=0, limit=20, since=None, before=None,
               period='', timezone_name='Asia/Shanghai', snapshot='', query='',session_id=''):
    from services.memory_query import time_range
    query=query.strip()
    if cursor < 0 or not 1 <= limit <= 100 or len(query)>1000:
        raise ValueError('Invalid pagination parameters')
    fingerprint = (token, scope, tuple(project_ids), str(since), str(before), period, timezone_name, query,session_id)
    if snapshot:
        with _lock:
            saved = _snapshots.get(snapshot)
            if not saved or saved['expires'] <= time.monotonic() or saved['fingerprint'] != fingerprint:
                raise ValueError('The memory history snapshot has expired or the query range has changed. Please start querying from the beginning.')
            if cursor not in saved['positions']:
                raise ValueError('Please use the returned next_cursor to continue reading history')
            state = copy.deepcopy(saved['positions'][cursor])
            bounds, cutoff = saved['bounds'], saved['cutoff']
    else:
        if cursor:
            raise ValueError('Historical pagination must include snapshot and next_cursor')
        bounds = time_range(since=since, before=before, period=period, timezone_name=timezone_name)
        cutoff = datetime.now(timezone.utc).isoformat()
        state = {'project': 0, 'kind': 0, 'after': None, 'scanned': 0, 'excluded': 0, 'unavailable_projects': []}
        snapshot = secrets.token_urlsafe(16)
        with _lock:
            for key in list(_snapshots):
                if _snapshots[key]['expires'] <= time.monotonic():
                    del _snapshots[key]
            if len(_snapshots) >= 32:
                del _snapshots[min(_snapshots, key=lambda key: _snapshots[key]['expires'])]
            saved = {'fingerprint': fingerprint, 'expires': time.monotonic()+600, 'bounds': bounds,
                     'cutoff': cutoff, 'positions': {0: copy.deepcopy(state)}}
            _snapshots[snapshot] = saved
    items, scanned_this_page = [], 0
    # Each call scans at most limit source rows. Empty/forgotten/wrong-scope rows
    # advance the cursor too; one project/kind is processed at a time.
    while state['project'] < len(project_ids) and scanned_this_page < limit:
        pid = project_ids[state['project']]
        kind = ('chat', 'task')[state['kind']]
        try:
            project = projects.get_project_by_id(pid)
            if not project or not await asyncio.to_thread(project.db_path.is_file):
                raise LookupError('source unavailable')
            hits, scanned, last, excluded_count = await projects.run_db(pid, lambda _: _scan(
                pid, kind, scope, *bounds, cutoff, state['after'], limit-scanned_this_page, query,session_id))
        except (ValueError, LookupError, OSError, pw.DatabaseError):
            state['unavailable_projects'].append(pid)
            state.update(project=state['project']+1, kind=0, after=None)
            continue
        items.extend(hits)
        remaining = limit-scanned_this_page
        scanned_this_page += scanned
        state['scanned'] += scanned
        state['excluded'] += excluded_count
        state['after'] = last
        if scanned < remaining:
            state['kind'] += 1
            state['after'] = None
            if state['kind'] == 2:
                state.update(project=state['project']+1, kind=0)
    has_more = state['project'] < len(project_ids)
    next_cursor = cursor + 1
    with _lock:
        saved['positions'][next_cursor] = copy.deepcopy(state)
        # Bounded replay cache; sequential paging remains available for any history size.
        if len(saved['positions']) > 128:
            del saved['positions'][min(saved['positions'])]
    return {'items': items, 'snapshot': snapshot, 'has_more': has_more,
            'next_cursor': next_cursor if has_more else None,
            'coverage': {'basis': 'authoritative_terminal_messages', 'project_ids': project_ids,
                         'since': bounds[0], 'before': bounds[1], 'filter_session_id':session_id, 'snapshot_at': cutoff,
                         'scanned_sources': state['scanned'], 'excluded_sources': state['excluded'],
                         'unavailable_projects': state['unavailable_projects'],
                         'query':query, 'keyword_match':'any whitespace-separated literal term; case-insensitive',
                         'complete_source_history': not query and not has_more and not state['unavailable_projects'],
                         'complete_filtered_history': bool(query) and not has_more and not state['unavailable_projects'],
                         'ordering': 'project, source_kind, source_time, source_id',
                         'pagination_consistency': 'keyset with time cutoff, not a transaction snapshot; concurrent edits, deletes or messages becoming terminal may change evidence',
                         'note': 'Coverage means eligible terminal chat/task messages in accessible registered projects, excluding private scopes, forgotten sources and internal check sessions. It does not prove every real-world activity or completion. For needs_read=true, page through the source with memory_read before claiming a complete content review; total_chars includes text beyond the preview.'}}
