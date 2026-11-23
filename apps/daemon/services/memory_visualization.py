"""Host memory browser: bounded results, verified sources, no extraction on read."""
import asyncio
import json
from datetime import datetime, timezone, timedelta
from services import digital_person_memory as memory, digital_person_memory_index as index
from services import memory_knowledge as knowledge
from services.memory_secrets import redact

KINDS = ('preference', 'experience', 'fact', 'event')
PREVIEW_LIMIT = 50
PAGE_SIZE = 40
SOURCE_LIMIT = 50


def library_stats(project_ids):
    """Count indexed metadata, independently of bounded/search-filtered results.

    No project source hydration or extraction is triggered. Counts exclude removed
    registrations, forgotten sources and invalid/expired knowledge. Source-file
    availability is verified on opening, not by scanning every source on refresh.
    """
    result = {'knowledge_count':0, 'indexed_count':0, 'processed_count':0,
              'pending_count':0, 'today_count':0, 'latest_knowledge_at':None,
              'by_kind':dict.fromkeys(KINDS,0)}
    if not project_ids:
        return result
    knowledge.ensure_schema()
    from services.memory_pending_queue import install
    now = datetime.now(timezone.utc)
    start = now.astimezone(timezone(timedelta(hours=8))).replace(hour=0,minute=0,second=0,microsecond=0).astimezone(timezone.utc).isoformat()
    marks = ','.join('?' for _ in project_ids)
    with index.connect() as db:
        install(db)
        counts = db.execute(f"""SELECT COUNT(*) AS total,
          COALESCE(SUM(memory_status='done'),0) AS processed
          FROM memories WHERE forgotten=0 AND project_id IN ({marks})""",tuple(project_ids)).fetchone()
        result.update(indexed_count=counts['total'], processed_count=counts['processed'],
                      pending_count=counts['total']-counts['processed'])
        rows = db.execute(f"""SELECT k.kind, COUNT(*) AS n, MAX(k.created_at) AS latest,
          SUM(julianday(k.created_at)>=julianday(?)) AS today
          FROM memory_knowledge k WHERE k.state IN ('active','conflict')
          AND (k.valid_until IS NULL OR julianday(k.valid_until)>julianday(?))
          AND {knowledge.catalog_evidence_condition(project_ids)}
          GROUP BY k.kind""",(start,now.isoformat(),*project_ids))
        for row in rows:
            result['knowledge_count'] += row['n']
            result['today_count'] += row['today'] or 0
            result['by_kind'][row['kind']] = row['n']
            latest = result['latest_knowledge_at']
            if latest is None or datetime.fromisoformat(row['latest']) > datetime.fromisoformat(latest):
                result['latest_knowledge_at'] = row['latest']
    return result


async def browse(projects, query='', *, kind='', project_id='', page=1):
    query = query.strip()
    paged = bool(kind or project_id or query)
    library_ids = memory.allowed_projects(projects)
    ids = set(library_ids)
    names = {p.id:p.name for p in projects.iter_projects() if p.id in ids}
    matching_projects = [pid for pid, name in names.items() if query and query.casefold() in name.casefold()]
    source_ids = None
    if matching_projects:
        source_ids, query = set(matching_projects), ''
    if project_id:
        source_ids = (ids if source_ids is None else source_ids) & {project_id}

    async def search(category, limit, offset=0):
        return await knowledge.search(projects, None, query, limit=limit, project_ids=ids, candidate_limit=limit,
                                      kind=category, source_project_ids=source_ids, offset=offset)

    limit = PAGE_SIZE if paged else PREVIEW_LIMIT
    derived = await search(kind, limit + 1 if paged else limit, (page - 1) * limit if paged else 0)
    has_next = paged and len(derived) > limit
    derived = derived[:limit]
    if not paged and len(derived) == limit:
        # Keep the preview bounded while giving each available category a first group.
        missing = [category for category in KINDS if sum(r['kind'] == category for r in derived) < 3]
        if missing:
            samples = await asyncio.gather(*(search(category, 3) for category in missing))
            by_id = {row['id']: row for row in derived + [row for sample in samples for row in sample]}
            required = {row['id'] for category in KINDS
                        for row in [r for r in by_id.values() if r['kind'] == category][:3]}
            remaining = [kid for kid in by_id if kid not in required]
            kept = required.union(remaining[:limit-len(required)])
            derived = [row for kid, row in by_id.items() if kid in kept]

    hits = []
    if page == 1 and kind in ('', 'event'):
        rows = await asyncio.to_thread(index.candidates, None, query, limit=SOURCE_LIMIT,
                                       project_ids=ids if source_ids is None else source_ids)
        hits = await memory.read_projects(projects, rows, query)
    covered = {s['id'] for item in derived for s in item['sources']}
    items = []
    for item in derived:
        sources = [{**s, 'project_name':names.get(s['project_id'], s['project_id'])} for s in item['sources']]
        items.append({**item, 'sources':sources,
                      'time':item['event_time'] or max(s['source_time'] for s in sources),
                      'time_is_source':not bool(item['event_time'])})
    for hit in hits:
        if hit['id'] in covered:
            continue
        items.append({'id':hit['id'], 'summary':hit['content'], 'kind':'event',
                      'outcome':'unknown', 'state':'source', 'interpretation':False,
                      'time':hit['created_at'], 'time_is_source':True, 'entities':[], 'relations':[],
                      'sources':[{'id':hit['id'], 'project_id':hit['project_id'],
                                  'project_name':names.get(hit['project_id'],hit['project_id']),
                                  'source_time':hit['created_at'], 'source_kind':hit['source_kind'],
                                  'role':hit.get('role','')}]})
    stats = await asyncio.to_thread(library_stats, library_ids)
    return redact({'items':items, 'bounded':True, 'knowledge_limit':limit, 'source_limit':SOURCE_LIMIT,
                   'has_next':has_next, 'projects':[{'id':pid, 'name':name} for pid, name in names.items()],
                   'stats':stats})


def _source(projects_ids, source_id):
    if not source_id.startswith('memory:') or not source_id[7:].isdigit():
        raise ValueError('Invalid source ID')
    with index.connect() as db:
        row = db.execute('SELECT * FROM memories WHERE id=? AND forgotten=0', (int(source_id[7:]),)).fetchone()
        return dict(row) if row and row['project_id'] in projects_ids else None


def _turn_companion(row):
    """Resolve only the other indexed message of the same completed chat turn."""
    if row['source_kind'] != 'chat' or row['role'] not in ('user', 'assistant'):
        return None
    turn = json.loads(row['source_metadata_json']).get('turn_assistant_id')
    if not turn:
        return None
    role = 'user' if row['role'] == 'assistant' else 'assistant'
    with index.connect() as db:
        rows = db.execute("""SELECT * FROM memories
            WHERE project_id=? AND session_id=? AND scope=? AND role=?
            AND source_kind='chat' AND forgotten=0
            AND json_extract(source_metadata_json,'$.turn_assistant_id')=?
            LIMIT 2""", (row['project_id'], row['session_id'], row['scope'], role, turn)).fetchall()
    if len(rows) != 1:
        return None
    companion = dict(rows[0])
    assistant = row if row['role'] == 'assistant' else companion
    if assistant['source_message_id'] != turn or not memory.source_text(companion):
        return None
    return {'id':f"memory:{companion['id']}", 'project_id':row['project_id'],
            'source_time':companion['source_time'], 'source_kind':'chat', 'role':role}


async def read(projects, source_id, *, offset=0, limit=2400):
    row = await asyncio.to_thread(_source, memory.allowed_projects(projects), source_id)
    if not row:
        raise LookupError('Source does not exist or is inaccessible')
    hits = await memory.read_projects(projects, [row])
    if not hits:
        raise LookupError('Source has been deleted, forgotten, or is inaccessible')
    def read_source(_):
        content = memory.source_text(row)
        companion = _turn_companion(row) if content and offset == 0 else None
        return content, companion

    content, companion = await projects.run_db(row['project_id'], read_source)
    if content is None:
        raise LookupError('Source is no longer available')
    end = min(len(content), offset + limit)
    return redact({**hits[0], 'content':content[offset:end], 'offset':offset,
                   'next_offset':end if end < len(content) else None,
                   'has_more':end < len(content), 'total_chars':len(content),
                   **({'companion':companion} if companion else {})})
