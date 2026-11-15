"""Durable per-source-version reflection receipts; call in a worker thread.

Separate from knowledge extraction and notification delivery. No LLM calls here.
"""
import hashlib
import json
import uuid
from datetime import datetime, timezone
from services import digital_person_memory_index as index

POLICY_KEY = 'digital_person_assessment_policy'


def cutoff(db=None):
    if db is None:
        with index.connect() as connection:
            return cutoff(connection)
    row = db.execute('SELECT value_json FROM state WHERE key=?',(POLICY_KEY,)).fetchone()
    return json.loads(row[0]).get('ignore_before') if row else None


def source_activity(row):
    metadata = json.loads(row.get('source_metadata_json') or '{}')
    value = metadata.get('activity_time') or row['source_time']
    parsed = datetime.fromisoformat(value)
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def eligible(row, before):
    return not before or source_activity(row) >= datetime.fromisoformat(before)


def _schema(db):
    db.execute("CREATE TABLE IF NOT EXISTS digital_reflection_ignored (project_id TEXT, message_id TEXT, PRIMARY KEY(project_id,message_id))")
    db.execute("""CREATE TABLE IF NOT EXISTS digital_reflections (
        memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        version TEXT NOT NULL, run_id TEXT NOT NULL, outcome TEXT NOT NULL)""")
    db.execute("""CREATE TRIGGER IF NOT EXISTS digital_reflection_source_changed
        AFTER UPDATE OF source_hash,scope,role,source_time,source_kind,source_metadata_json,forgotten ON memories
        WHEN old.source_hash!=new.source_hash OR old.scope!=new.scope OR old.role!=new.role
          OR old.source_time!=new.source_time OR old.source_kind!=new.source_kind
          OR old.source_metadata_json!=new.source_metadata_json OR new.forgotten=1
        BEGIN DELETE FROM digital_reflections WHERE memory_id=new.id; END""")


def ignore(project_id, message_id):
    with index.connect() as db:
        _schema(db)
        db.execute('INSERT OR IGNORE INTO digital_reflection_ignored VALUES(?,?)',(project_id,message_id))
        # Covers an old delivery retried after indexing or a racing source scan.
        # Derived knowledge is invalidated by the existing source-delete trigger.
        db.execute('DELETE FROM memories WHERE project_id=? AND source_message_id=?',(project_id,message_id))


def ignore_deliveries(project_id, runs):
    """Exclude legacy generated notices using durable delivery identity only."""
    ids = {(receipt.get('project_id') or project_id,str(uuid.uuid5(uuid.NAMESPACE_URL, run['id'] + receipt['session_id'])))
           for run in runs if run.get('id')
           for receipt in run.get('deliveries', [])
           if receipt.get('kind') == 'local' and receipt.get('session_id')}
    if not ids:
        return
    with index.connect() as db:
        _schema(db)
        db.executemany('INSERT OR IGNORE INTO digital_reflection_ignored VALUES(?,?)',
                       list(ids))
        db.executemany('DELETE FROM memories WHERE project_id=? AND source_message_id=?',
                       list(ids))


def version(row):
    return hashlib.sha256(json.dumps([row.get(k) for k in (
        'project_id','session_id','source_message_id','source_hash','scope','role',
        'source_time','source_kind','source_metadata_json')],ensure_ascii=False).encode()).hexdigest()


def pending(project_id, excluded=(), limit=20, previous="", since=None, before=None):
    with index.connect() as db:
        _schema(db)
        # Indexed raw evidence only; derived knowledge/thoughts never re-enter.
        excluded=list(excluded)
        skip=' AND m.session_id NOT IN ('+','.join('?' for _ in excluded)+')' if excluded else ''
        where = """ FROM memories m LEFT JOIN digital_reflections r ON r.memory_id=m.id
            WHERE m.project_id=? AND m.source_kind='chat' AND m.forgotten=0 AND r.memory_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM digital_reflection_ignored x WHERE x.project_id=m.project_id AND x.message_id=m.source_message_id)
            AND NOT EXISTS (SELECT 1 FROM memories f WHERE f.project_id=m.project_id
              AND f.source_message_id=m.source_message_id AND f.forgotten=1)""" + skip
        args = (project_id, *excluded)
        activity = "COALESCE(json_extract(m.source_metadata_json,'$.activity_time'),m.source_time)"
        boundary = cutoff(db)
        if boundary:
            where += ' AND julianday('+activity+')>=julianday(?)'; args += (boundary,)
        if since:
            where += ' AND '+activity+'>=?'; args += (since,)
        if before:
            where += ' AND '+activity+'<?'; args += (before,)
        first = db.execute('SELECT m.session_id' + where +
                           ' ORDER BY CASE WHEN m.session_id=? THEN 1 ELSE 0 END,m.source_time,m.id LIMIT 1',
                           (*args, previous)).fetchone()
        if first is None:
            return []
        return [dict(row) for row in db.execute('SELECT m.*' + where +
                ' AND m.session_id=? ORDER BY m.source_time,m.id LIMIT ?',
                (*args, first['session_id'], max(1,min(limit,20))))]


def finish(rows, run_id, outcome='processed'):
    with index.connect() as db:
        _schema(db)
        for row in rows:
            current=db.execute('SELECT * FROM memories WHERE id=? AND forgotten=0',(row['id'],)).fetchone()
            if current and version(dict(current))==version(row):
                db.execute('INSERT OR REPLACE INTO digital_reflections VALUES(?,?,?,?)',
                           (row['id'],version(row),run_id,outcome))


def current(rows):
    """Reject a stale model result before applying semantic side effects."""
    with index.connect() as db:
        boundary = cutoff(db)
        for row in rows:
            if not eligible(row,boundary):
                return False
            actual = db.execute('SELECT * FROM memories WHERE id=? AND forgotten=0',(row['id'],)).fetchone()
            if actual is None or version(dict(actual)) != version(row):
                return False
            if db.execute('SELECT 1 FROM memories WHERE project_id=? AND source_message_id=? AND forgotten=1',
                          (row['project_id'], row['source_message_id'])).fetchone():
                return False
    return True


def model_context(context, project_id):
    """A compact, attributed view; persisted evidence/receipts remain complete.

    Do not send the same user text as both messages and conversation, or recall
    a chunk already in this batch. Other projects' assistant explanations are
    not companion facts or independent corroboration.
    """
    if context.get('_groups'):
        return {'origin_project_id':context['origin_project_id'],
                'conversations':[dict(model_context(group,project_id),project_id=group['origin_project_id'],
                                      session_id=group['origin_session_id']) for group in context['_groups']]}
    result = {key:value for key,value in context.items() if not key.startswith('_') and key not in (
        'messages','reflection_batch','conversation','memory','indexed','busy','archived_source','no_work')}
    if 'previous_notifications' in context:
        # Preserve timing and delivery state without repeating old prose.
        result['previous_notifications'] = [
            {'source_ids': item.get('source_ids', []), **{k:item[k] for k in
                ('status','created_at','attempted_at','notified_at') if k in item}}
            for item in context['previous_notifications']]
    fields = ('id','project_id','session_id','scope','role','author_id','author_name','content','created_at','memory_ids','read_ids')
    # Repeated words in different turns remain distinct chronological messages.
    result['conversation'] = [{key:message[key] for key in fields if key in message}
                              for message in context.get('conversation', [])]
    represented = {message['id'] for message in context.get('conversation', [])}
    memories = []
    for memory in context.get('memory', []):
        if memory.get('project_id') == project_id and memory.get('source_message_id') in represented:
            continue
        if memory.get('role') == 'assistant' and memory.get('project_id') != project_id:
            continue
        memories.append({key:memory[key] for key in (
            'id','project_id','source_message_id','role','author_id','author_name',
            'content','created_at','category') if key in memory})
    result['memory'] = memories
    return result
