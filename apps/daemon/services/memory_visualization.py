"""Host memory browser: bounded results, verified sources, no extraction on read."""
import asyncio
from datetime import datetime, timezone, timedelta
from services import digital_person_memory as memory, digital_person_memory_index as index
from services import memory_knowledge as knowledge
from services.memory_secrets import redact


def library_stats(project_ids):
    """Count indexed metadata, independently of bounded/search-filtered results.

    No project source hydration or extraction is triggered. Counts exclude removed
    registrations, forgotten sources and invalid/expired knowledge. Source-file
    availability is verified on opening, not by scanning every source on refresh.
    """
    result = {'knowledge_count':0, 'indexed_count':0, 'processed_count':0,
              'pending_count':0, 'today_count':0, 'latest_knowledge_at':None,
              'by_kind':dict.fromkeys(('preference','experience','fact','event'),0)}
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
          AND EXISTS (SELECT 1 FROM memory_knowledge_sources s WHERE s.knowledge_id=k.id)
          AND NOT EXISTS (SELECT 1 FROM memory_knowledge_sources s LEFT JOIN memories m ON m.id=s.memory_id
            WHERE s.knowledge_id=k.id AND (m.id IS NULL OR m.forgotten=1 OR m.scope!=k.scope
              OR m.source_hash!=s.source_hash OR m.project_id NOT IN ({marks})))
          GROUP BY k.kind""",(start,now.isoformat(),*project_ids))
        for row in rows:
            result['knowledge_count'] += row['n']
            result['today_count'] += row['today'] or 0
            result['by_kind'][row['kind']] = row['n']
            latest = result['latest_knowledge_at']
            if latest is None or datetime.fromisoformat(row['latest']) > datetime.fromisoformat(latest):
                result['latest_knowledge_at'] = row['latest']
    return result


async def browse(projects, query=''):
    ids = memory.allowed_projects(projects)
    library_ids = list(ids)
    names = {p.id:p.name for p in projects.iter_projects() if p.id in ids}
    matching_projects = [pid for pid, name in names.items() if query.strip() and query.strip().casefold() in name.casefold()]
    if matching_projects:
        ids, query = matching_projects, ''
    # Bound source hydration independently of whole-library metadata counts.
    derived = await knowledge.search(projects, None, query, limit=50, project_ids=ids, candidate_limit=50)
    rows = await asyncio.to_thread(index.candidates, None, query, limit=50, project_ids=ids)
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
    return redact({'items':items, 'bounded':True, 'knowledge_limit':50, 'source_limit':50, 'stats':stats})


def _source(projects_ids, source_id):
    if not source_id.startswith('memory:') or not source_id[7:].isdigit():
        raise ValueError('Invalid source ID')
    with index.connect() as db:
        row = db.execute('SELECT * FROM memories WHERE id=? AND forgotten=0', (int(source_id[7:]),)).fetchone()
        return dict(row) if row and row['project_id'] in projects_ids else None


async def read(projects, source_id, *, offset=0, limit=2400):
    row = await asyncio.to_thread(_source, memory.allowed_projects(projects), source_id)
    if not row:
        raise LookupError('Source does not exist or is inaccessible')
    hits = await memory.read_projects(projects, [row])
    if not hits:
        raise LookupError('Source has been deleted, forgotten, or is inaccessible')
    content = await projects.run_db(row['project_id'], lambda _: memory.source_text(row))
    if content is None:
        raise LookupError('Source is no longer available')
    end = min(len(content), offset + limit)
    return redact({**hits[0], 'content':content[offset:end], 'offset':offset,
                   'next_offset':end if end < len(content) else None,
                   'has_more':end < len(content), 'total_chars':len(content)})
