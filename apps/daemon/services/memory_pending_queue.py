"""Indexed source processing status; heartbeat gate uses a separate read-only connection."""
import sqlite3
import time
from services import digital_person_memory_index as index


def install(db):
    if db.execute("SELECT 1 FROM state WHERE key='pending_status_v2'").fetchone():
        return
    db.execute('SAVEPOINT install_pending_status')
    from services.digital_person_reflection import _schema
    _schema(db)
    for table in ('memories','memory_extraction_jobs','digital_reflections'):
        for event in ('insert','update','delete'):
            db.execute(f'DROP TRIGGER IF EXISTS pending_{table}_{event}')
    columns={r[1] for r in db.execute('PRAGMA table_info(memories)')}
    if 'memory_status' not in columns:
        db.execute("ALTER TABLE memories ADD COLUMN memory_status TEXT NOT NULL DEFAULT 'pending'")
        db.execute("ALTER TABLE memories ADD COLUMN pending_ready_at REAL NOT NULL DEFAULT 0")
    def refresh(mid):
        return f"""UPDATE memories SET
          memory_status=CASE
            WHEN EXISTS(SELECT 1 FROM memory_extraction_jobs j WHERE j.memory_id=memories.id AND j.source_hash=memories.source_hash AND j.status='done')
             AND EXISTS(SELECT 1 FROM digital_reflections r WHERE r.memory_id=memories.id) THEN 'done'
            WHEN EXISTS(SELECT 1 FROM memory_extraction_jobs j WHERE j.memory_id=memories.id AND j.source_hash=memories.source_hash AND j.status='running') THEN 'running'
            ELSE 'pending' END,
          pending_ready_at=COALESCE((SELECT retry_at FROM memory_extraction_jobs j WHERE j.memory_id=memories.id AND j.source_hash=memories.source_hash AND j.status='running'),0)
          WHERE id={mid};"""
    for table in ('memory_extraction_jobs','digital_reflections'):
        for event in ('INSERT','UPDATE','DELETE'):
            ref='old' if event=='DELETE' else 'new'
            db.execute(f'CREATE TRIGGER pending_{table}_{event.lower()} AFTER {event} ON {table} BEGIN '+refresh(f'{ref}.memory_id')+' END')
    db.execute(refresh('memories.id'))
    # Retire the old duplicate queue after importing state from durable receipts.
    db.execute('DROP TABLE IF EXISTS memory_pending_queue')
    # The old table owned an index with the same name.
    db.execute("CREATE INDEX IF NOT EXISTS memory_pending_ready ON memories(project_id,pending_ready_at) WHERE memory_status!='done' AND forgotten=0")
    db.execute("INSERT INTO state VALUES('pending_status_v2','true')")
    db.execute('RELEASE install_pending_status')


def has_pending(project_ids):
    if not project_ids:
        return False
    path=index.database_path()
    if not path.is_file():
        return False
    db=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=.1)
    try:
        return db.execute("""SELECT 1 FROM memories m
          WHERE m.project_id IN ("""+','.join('?' for _ in project_ids)+""") AND m.pending_ready_at<=? AND m.memory_status!='done' AND m.forgotten=0
          AND m.source_kind IN ('chat','task')
          AND NOT EXISTS(SELECT 1 FROM digital_reflection_ignored i WHERE i.project_id=m.project_id AND i.message_id=m.source_message_id)
          AND m.session_id NOT IN (SELECT value FROM json_each(COALESCE((SELECT json_extract(value_json,'$.check_sessions') FROM state WHERE key='digital_person_runtime'),'[]')))
          AND julianday(COALESCE(json_extract(m.source_metadata_json,'$.activity_time'),m.source_time)) >= julianday(COALESCE((SELECT json_extract(value_json,'$.ignore_before') FROM state WHERE key='digital_person_assessment_policy'),'0001-01-01'))
          LIMIT 1""",(*project_ids,time.time())).fetchone() is not None
    except sqlite3.OperationalError as exc:
        if 'no such table' in str(exc) or 'locked' in str(exc):
            return False
        raise
    finally:
        db.close()
