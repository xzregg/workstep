"""Host memory browser: bounded results, verified sources, no extraction on read."""
import asyncio
from services import digital_person_memory as memory, digital_person_memory_index as index
from services import memory_knowledge as knowledge
from services.memory_secrets import redact


async def browse(projects, query=''):
    ids = memory.allowed_projects(projects)
    names = {p.id:p.name for p in projects.iter_projects() if p.id in ids}
    matching_projects = [pid for pid, name in names.items() if query.strip() and query.strip().casefold() in name.casefold()]
    if matching_projects:
        ids, query = matching_projects, ''
    # Keep work bounded. Counts describe this response, never the whole library.
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
    return redact({'items':items, 'bounded':True, 'knowledge_limit':50, 'source_limit':50})


def _source(projects_ids, source_id):
    if not source_id.startswith('memory:') or not source_id[7:].isdigit():
        raise ValueError('无效的来源 ID')
    with index.connect() as db:
        row = db.execute('SELECT * FROM memories WHERE id=? AND forgotten=0', (int(source_id[7:]),)).fetchone()
        return dict(row) if row and row['project_id'] in projects_ids else None


async def read(projects, source_id, *, offset=0, limit=2400):
    row = await asyncio.to_thread(_source, memory.allowed_projects(projects), source_id)
    if not row:
        raise LookupError('来源不存在或不可访问')
    hits = await memory.read_projects(projects, [row])
    if not hits:
        raise LookupError('来源已删除、遗忘或不可访问')
    content = await projects.run_db(row['project_id'], lambda _: memory.source_text(row))
    if content is None:
        raise LookupError('来源已不可用')
    end = min(len(content), offset + limit)
    return redact({**hits[0], 'content':content[offset:end], 'offset':offset,
                   'next_offset':end if end < len(content) else None,
                   'has_more':end < len(content), 'total_chars':len(content)})
