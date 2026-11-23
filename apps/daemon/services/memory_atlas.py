"""Lightweight star coordinates and on-demand knowledge previews."""
import asyncio
from datetime import datetime, timezone

from services import digital_person_memory as memory
from services import digital_person_memory_index as index
from services import memory_knowledge

ATLAS_STAR_LIMIT = 500
ATLAS_LINK_BATCH = 50


def _markers(project_ids, cursor, limit, ids, focus=None):
    if not project_ids:
        return [], []
    memory_knowledge.ensure_schema()
    where = ["k.state IN ('active','conflict')", '(k.valid_until IS NULL OR k.valid_until>?)',
             memory_knowledge.catalog_evidence_condition(project_ids)]
    args = [datetime.now(timezone.utc).isoformat(), *project_ids]
    if cursor:
        where.append('k.id < ?')
        args.append(cursor)
    if ids:
        where.append('k.id IN (' + ','.join('?' for _ in ids) + ')')
        args.extend(ids)
    with index.connect() as db:
        rows = [dict(row) for row in db.execute(
            """SELECT k.id, k.kind, COALESCE(k.event_time,k.created_at) AS time,
              (SELECT MAX(m.importance) FROM memory_knowledge_sources s JOIN memories m ON m.id=s.memory_id
               WHERE s.knowledge_id=k.id) AS importance
               FROM memory_knowledge k WHERE """ + ' AND '.join(where) + ' ORDER BY k.id DESC LIMIT ?',
            (*args, limit + 1))]
        visible = [row['id'] for row in rows[:limit]]
        if focus is not None and focus not in visible:
            anchor = db.execute('SELECT k.id FROM memory_knowledge k WHERE ' + ' AND '.join(where)
                                + ' AND k.id=?', (*args, focus)).fetchone()
            if anchor:
                visible.append(focus)
        if len(visible) < 2:
            return rows, []
        if focus is not None:
            return rows, _focused_links(db, visible, focus)
        return rows, _links(db, visible) if limit <= ATLAS_LINK_BATCH else []


def _links(db, visible, focus=None):
    placeholders = ','.join('(?)' for _ in visible)
    compare = '!=' if focus is not None else '>'
    return db.execute(f"""
        WITH visible(id) AS (VALUES {placeholders}),
        anchors(id) AS (SELECT id FROM visible WHERE ? IS NULL OR id=?),
        links(a,b) AS (
            SELECT MIN(v.id,w.id), MAX(v.id,w.id)
            FROM anchors v JOIN memory_knowledge_sources s ON s.knowledge_id=v.id
            JOIN memory_knowledge_sources t ON t.memory_id=s.memory_id AND t.knowledge_id{compare}v.id
            JOIN visible w ON w.id=t.knowledge_id
            UNION
            SELECT MIN(v.id,w.id), MAX(v.id,w.id)
            FROM anchors v JOIN memory_entities e ON e.knowledge_id=v.id
            JOIN memory_entities f ON f.kind=e.kind AND f.alias=e.alias AND f.knowledge_id{compare}v.id
            JOIN visible w ON w.id=f.knowledge_id
            UNION
            SELECT MIN(v.id,w.id), MAX(v.id,w.id)
            FROM visible v JOIN memory_knowledge k ON k.id=v.id
            JOIN json_each(k.supersedes_json) old
            JOIN visible w ON w.id=old.value AND w.id!=v.id
            WHERE ? IS NULL OR v.id=? OR w.id=?
        )
        SELECT a,b FROM links ORDER BY a,b
    """, (*visible, focus, focus, focus, focus, focus)).fetchall()


def _encode_links(links):
    return [{'from': f'knowledge:{a}', 'to': f'knowledge:{b}'} for a, b in links]


def _focused_links(db, visible, focus):
    direct = _links(db, visible, focus)
    if not direct:
        return []

    neighbors = {}
    for left, right in _links(db, visible):
        neighbors.setdefault(left, []).append(right)
        neighbors.setdefault(right, []).append(left)

    # Keep a depth-first tree plus direct choices so even dense evidence
    # groups return at most two edges per visible star on average.
    edges = {(left, right) for left, right in direct}
    seen = {focus}
    path = [(focus, iter(neighbors.get(focus, ())))]
    while path:
        node, candidates = path[-1]
        neighbor = next(candidates, None)
        if neighbor is None:
            path.pop()
        elif neighbor not in seen:
            seen.add(neighbor)
            edges.add((min(node, neighbor), max(node, neighbor)))
            path.append((neighbor, iter(neighbors[neighbor])))
    return sorted(edges)


def _reflection_additions(project_ids, run_id):
    memory_knowledge.ensure_schema()
    # Keep the receipt when its target disappears, and apply atlas visibility
    # to the join so hidden targets contribute only to the unavailable count.
    visible = memory_knowledge.catalog_evidence_condition(project_ids) if project_ids else '0'
    with index.connect() as db:
        rows = db.execute(
            """SELECT k.id, k.summary, k.kind,
                 EXISTS (SELECT 1 FROM memory_changes c WHERE c.new_id=k.id AND c.operation='supersede') AS replaced
               FROM memory_reflection_additions a
               LEFT JOIN memory_knowledge k ON k.id=a.knowledge_id
                 AND k.state IN ('active','conflict') AND (k.valid_until IS NULL OR k.valid_until>?)
                 AND """ + visible + ' WHERE a.run_id=? ORDER BY a.id',
            (datetime.now(timezone.utc).isoformat(), *project_ids, run_id)).fetchall()
    items = [{'id': f"knowledge:{row['id']}", 'summary': row['summary'], 'kind':row['kind'],
              'operation':'updated' if row['replaced'] else 'added'}
             for row in rows if row['id'] is not None]
    return {'status': 'available' if rows else 'legacy', 'items': items, 'unavailable': len(rows) - len(items)}


async def reflection_additions(projects, run_id):
    return await asyncio.to_thread(_reflection_additions, memory.allowed_projects(projects), run_id)


async def page(projects, cursor, limit, ids=()):
    rows, links = await asyncio.to_thread(_markers, memory.allowed_projects(projects), cursor, limit, ids)
    return {
        'items': [{**row, 'id': f"knowledge:{row['id']}"} for row in rows[:limit]],
        'links': _encode_links(links),
        'next_cursor': rows[limit - 1]['id'] if len(rows) > limit else None,
    }


async def detail(projects, knowledge_id):
    rows = await memory_knowledge.search(projects, None, limit=1, knowledge_id=knowledge_id)
    if not rows:
        return None
    _, links = await asyncio.to_thread(_markers, memory.allowed_projects(projects), 0, ATLAS_STAR_LIMIT, (), knowledge_id)
    row = rows[0]
    names = {project.id: project.name for project in projects.iter_projects()}
    return {'summary': row['summary'], 'links': _encode_links(links), 'sources': [
        {**source, 'project_name': names.get(source['project_id'], source['project_id'])}
        for source in sorted(row['sources'], key=lambda source: source['source_time'], reverse=True)
    ]}
