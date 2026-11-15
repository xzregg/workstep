"""One-time, transactional conversion of source fragments to message identities."""


def migrate(db):
    if db.execute("SELECT 1 FROM state WHERE key='message_index_v1'").fetchone():
        return
    db.execute('SAVEPOINT message_index_migration')
    tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    triggers=list(db.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='memories'"))
    for name,_ in triggers:
        db.execute('DROP TRIGGER "'+name.replace('"','""')+'"')
    db.execute('CREATE TABLE IF NOT EXISTS memory_source_aliases(old_id INTEGER PRIMARY KEY, memory_id INTEGER NOT NULL)')
    groups=list(db.execute('SELECT project_id,source_message_id,MIN(id) AS keep_id,MAX(forgotten) AS forgotten FROM memories GROUP BY project_id,source_message_id'))
    for group in groups:
        rows=list(db.execute('SELECT * FROM memories WHERE project_id=? AND source_message_id=? ORDER BY id',tuple(group[:2])))
        keep=group['keep_id']; ids=[r['id'] for r in rows]
        marks=','.join('?' for _ in ids)
        if 'memory_knowledge_sources' in tables:
            db.execute("INSERT OR IGNORE INTO memory_knowledge_sources(knowledge_id,memory_id,source_hash) SELECT knowledge_id,?,'' FROM memory_knowledge_sources WHERE memory_id IN ("+marks+')',(keep,*ids))
            db.execute('DELETE FROM memory_knowledge_sources WHERE memory_id IN ('+marks+') AND memory_id!=?',(*ids,keep))
            db.execute("UPDATE memory_knowledge_sources SET source_hash='' WHERE memory_id=?",(keep,))
        completed=False
        if 'memory_extraction_jobs' in tables:
            completed=all(db.execute("SELECT 1 FROM memory_extraction_jobs WHERE memory_id=? AND source_hash=? AND status='done'",(r['id'],r['source_hash'])).fetchone() for r in rows)
            db.execute('DELETE FROM memory_extraction_jobs WHERE memory_id IN ('+marks+')',ids)
            db.execute("INSERT INTO memory_extraction_jobs VALUES(?,'',?,0,0)",(keep,'done' if completed else 'pending'))
        receipt=None
        if 'digital_reflections' in tables:
            receipts=[db.execute('SELECT * FROM digital_reflections WHERE memory_id=?',(mid,)).fetchone() for mid in ids]
            if completed and all(receipts):
                receipt=receipts[0]
            db.execute('DELETE FROM digital_reflections WHERE memory_id IN ('+marks+')',ids)
        for mid in ids:
            if mid!=keep:
                db.execute('INSERT OR REPLACE INTO memory_source_aliases VALUES(?,?)',(mid,keep))
                db.execute('INSERT OR IGNORE INTO activations SELECT ?,event_key FROM activations WHERE memory_id=?',(keep,mid))
                db.execute('DELETE FROM memories WHERE id=?',(mid,))
        db.execute("UPDATE memories SET offset=0,summary='',source_hash='',forgotten=? WHERE id=?",(group['forgotten'],keep))
        if receipt:
            from services.digital_person_reflection import version
            row=dict(db.execute('SELECT * FROM memories WHERE id=?',(keep,)).fetchone())
            db.execute('INSERT INTO digital_reflections VALUES(?,?,?,?)',(keep,version(row),receipt['run_id'],receipt['outcome']))
    db.execute('DELETE FROM memory_search')
    db.execute('CREATE UNIQUE INDEX IF NOT EXISTS memories_message_identity ON memories(project_id,source_message_id)')
    # Avoid reusing a retired fragment ID for a different message.
    db.execute('CREATE TABLE IF NOT EXISTS memory_identity_sequence(id INTEGER PRIMARY KEY CHECK(id=1), next_id INTEGER NOT NULL)')
    maximum=db.execute('SELECT MAX(id) FROM (SELECT id FROM memories UNION ALL SELECT old_id AS id FROM memory_source_aliases)').fetchone()[0] or 0
    db.execute('INSERT OR IGNORE INTO memory_identity_sequence VALUES(1,?)',(maximum+1,))
    db.execute('UPDATE memory_identity_sequence SET next_id=MAX(next_id,?) WHERE id=1',(maximum+1,))
    for _,sql in triggers:
        db.execute(sql)
    # Reapply forgetting after references have been folded to the surviving ID.
    db.execute('UPDATE memories SET forgotten=1 WHERE forgotten=1')
    db.execute("INSERT INTO state VALUES('message_index_v1','true')")
    db.execute('RELEASE message_index_migration')
