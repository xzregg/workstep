from services import config, digital_person_memory_index as index
from tests.test_memory_knowledge import knowledge, seed, payload


def test_capture_is_metadata_only_and_idempotent(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'CONFIG_DIR', tmp_path)
    text='不能复制到全局的原文'*10000
    first=index.capture('p','s','m','local','user',text,'2026-11-01T00:00:00+00:00')
    second=index.capture('p','s','m','local','user',text+'尾部','2026-11-01T00:00:00+00:00')
    other=index.capture('p','s','m2','local','user',text,'2026-11-01T00:00:00+00:00')
    assert first==second and len(first)==1 and first!=other
    with index.connect() as db:
        assert db.execute('SELECT count(*) FROM memories').fetchone()[0]==2
        assert not db.execute("SELECT 1 FROM memories WHERE summary!='' OR source_hash!='' OR offset!=0").fetchone()
        assert db.execute('SELECT count(*) FROM memory_search').fetchone()[0]==0


async def test_knowledge_search_never_reads_project_text(knowledge, monkeypatch):
    from services import digital_person_memory as memory
    mid=seed()
    knowledge.store_extraction(payload(mid),index.candidates('local'))
    monkeypatch.setattr(memory,'allowed_projects',lambda _:['p'])
    async def forbidden(*args,**kwargs):
        raise AssertionError('summary search must not read original messages')
    monkeypatch.setattr(memory,'read_projects',forbidden)
    results=await knowledge.search(object(),'local','清晨')
    assert len(results)==1


def test_migration_preserves_knowledge_receipts_and_old_source_ids(knowledge):
    from services import digital_person_reflection as reflection
    from services.memory_message_migration import migrate
    mid=seed()
    knowledge.store_extraction(payload(mid),index.candidates('local'))
    with index.connect() as db:
        reflection._schema(db)
        db.execute('DROP INDEX memories_message_identity')
        db.execute("DELETE FROM state WHERE key='message_index_v1'")
        db.execute("INSERT INTO memories SELECT 100,project_id,session_id,source_message_id,640,scope,'legacy preview','legacy hash',role,source_time,category,importance,reinforcements,activated_at,forgotten,source_kind,source_metadata_json,memory_status,pending_ready_at FROM memories WHERE id=?",(mid,))
        kid=db.execute('SELECT id FROM memory_knowledge').fetchone()[0]
        db.execute("INSERT INTO memory_knowledge_sources VALUES(?,100,'legacy hash')",(kid,))
        for row in db.execute('SELECT * FROM memories').fetchall():
            db.execute("INSERT INTO memory_extraction_jobs VALUES(?,?,'done',1,0)",(row['id'],row['source_hash']))
            db.execute("INSERT INTO digital_reflections VALUES(?,?, 'run','processed')",(row['id'],reflection.version(dict(row))))
        migrate(db)
        assert db.execute('SELECT count(*) FROM memories').fetchone()[0]==1
        assert db.execute('SELECT state FROM memory_knowledge').fetchone()[0]=='active'
        assert db.execute('SELECT count(*) FROM memory_knowledge_sources').fetchone()[0]==1
        assert db.execute('SELECT status FROM memory_extraction_jobs').fetchone()[0]=='done'
        assert db.execute('SELECT count(*) FROM digital_reflections').fetchone()[0]==1
        assert db.execute('SELECT memory_id FROM memory_source_aliases WHERE old_id=100').fetchone()[0]==mid
    newer=index.capture('p','s','new-message','local','user','正文','2026-11-01T00:00:00+00:00')
    assert newer[0]>100


def test_message_receipt_prevents_reclaim_after_success(knowledge):
    from services import digital_person_assessment as assessment
    seed()
    rows=assessment.pending(['p'],baseline='2026-01-01T00:00:00+00:00')
    assert assessment.claim(rows)
    assert not assessment.claim(rows)
    assessment.release(rows)
    assert assessment.claim(rows)
    assessment.commit(rows,[],'test-run')
    assert assessment.pending(['p'],baseline='2026-01-01T00:00:00+00:00')==[]
    assert not assessment.claim(rows)
