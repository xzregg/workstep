import asyncio
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime
from tests.test_memory_knowledge import knowledge, seed


def test_gate_tracks_claim_release_and_completion(knowledge):
    from services import memory_pending_queue as queue, digital_person_assessment as assessment
    assert not queue.has_pending(['p'])

    seed()
    assert queue.has_pending(['p'])
    rows=assessment.pending(['p'],baseline='2026-01-01T00:00:00+00:00')
    assert assessment.claim(rows)
    assert not queue.has_pending(['p'])
    assessment.release(rows)
    assert queue.has_pending(['p'])
    assessment.claim(rows)
    assessment.commit(rows,[],'done')
    assert not queue.has_pending(['p'])


def test_crashed_batch_lease_expires_without_a_release(knowledge,monkeypatch):
    from services import memory_pending_queue as queue, digital_person_assessment as assessment
    from services import memory_query
    import time
    now=time.time()
    monkeypatch.setattr(time,'time',lambda:now)
    seed()
    rows=assessment.pending(['p'],baseline='2026-01-01T00:00:00+00:00')
    assert assessment.claim(rows)
    assert not queue.has_pending(['p'])
    # Process memory disappears on a crash; no finally/release is executed.
    memory_query._executions.clear()
    monkeypatch.setattr(time,'time',lambda:now+241)
    assert queue.has_pending(['p'])
    retry=assessment.pending(['p'],baseline='2026-01-01T00:00:00+00:00')
    assert [r['id'] for r in retry]==[r['id'] for r in rows]
    assert assessment.claim(retry)
    assessment.commit(retry,[],'recovered')
    assert not queue.has_pending(['p'])


def test_batch_selects_oldest_across_sessions_and_respects_limit(knowledge):
    from services import digital_person_memory_index as index, digital_person_assessment as assessment
    for i in range(120):
        index.capture('p', f's{i%10}', f'm{i}', 'local', 'user', '正文',
                      f'2026-11-01T00:{i//60:02d}:{i%60:02d}+00:00')
    rows=assessment.pending(['p'],baseline='2026-01-01T00:00:00+00:00',limit=100)
    assert len(rows)==100
    assert len({r['session_id'] for r in rows})==10
    assert [r['source_message_id'] for r in rows]==[f'm{i}' for i in range(100)]
    assessment.commit(rows,[],'batch')
    assert len(assessment.pending(['p'],baseline='2026-01-01T00:00:00+00:00'))==20
    with index.connect() as db:
        assert db.execute("SELECT 1 FROM sqlite_master WHERE name='memory_pending_queue'").fetchone() is None


async def test_automatic_empty_check_does_no_source_work_or_writes(runtime,monkeypatch):
    from services import memory_pending_queue as queue
    current,_,_=runtime
    monkeypatch.setattr(queue,'has_pending',lambda _:False)
    async def forbidden(*args,**kwargs):raise AssertionError('empty check must stop at gate')
    monkeypatch.setattr(current,'mutate',forbidden)
    monkeypatch.setattr(current,'_collect',forbidden)
    monkeypatch.setattr(current,'_decide',forbidden)
    result=await current.check(manual=False)
    assert result['sources']['no_work']


async def test_slow_gate_keeps_loop_responsive(runtime,monkeypatch):
    import time,threading
    from services import memory_pending_queue as queue
    current,_,_=runtime
    entered=threading.Event()
    def slow(_):
        entered.set();time.sleep(.15);return False
    monkeypatch.setattr(queue,'has_pending',slow)
    task=asyncio.create_task(current.check(manual=False))
    for _ in range(100):
        if entered.is_set():break
        await asyncio.sleep(.001)
    assert entered.is_set()
    await asyncio.wait_for(asyncio.sleep(.01),.05)
    assert not task.done()
    assert (await task)['sources']['no_work']


def test_gate_is_read_only_and_uses_readiness_index(knowledge,monkeypatch):
    import sqlite3
    from services import memory_pending_queue as queue
    original=sqlite3.connect
    statements=[]
    def connect(*args,**kwargs):
        assert 'mode=ro' in args[0]
        db=original(*args,**kwargs)
        db.set_trace_callback(statements.append)
        return db
    monkeypatch.setattr(queue.sqlite3,'connect',connect)
    assert not queue.has_pending(['p'])
    assert len(statements)==1 and statements[0].startswith('SELECT 1')
    monkeypatch.setattr(queue.sqlite3,'connect',original)
    from services import digital_person_memory_index as index
    with index.connect() as db:
        plan=[r[3] for r in db.execute('EXPLAIN QUERY PLAN '+statements[0])]
    assert any('memory_pending_ready' in row for row in plan)


def test_gate_missing_database_does_not_create_it(tmp_path,monkeypatch):
    from services import config, memory_pending_queue as queue, digital_person_memory_index as index
    monkeypatch.setattr(config,'CONFIG_DIR',tmp_path/'empty')
    assert not queue.has_pending(['p'])
    assert not index.database_path().exists()


async def test_concurrent_claimers_cannot_own_the_same_batch(knowledge):
    from services import digital_person_assessment as assessment
    seed()
    rows=assessment.pending(['p'],baseline='2026-01-01T00:00:00+00:00')
    results=await asyncio.gather(*(asyncio.to_thread(assessment.claim,rows) for _ in range(2)))
    assert sorted(results)==[False,True]


def test_legacy_queue_migrates_to_index_status_without_losing_completion(knowledge):
    from services import digital_person_memory_index as index, digital_person_assessment as assessment
    from services import memory_pending_queue as queue
    seed()
    rows=assessment.pending(['p'],baseline='2026-01-01T00:00:00+00:00')
    assessment.commit(rows,[],'completed-before-migration')
    seed('另一个待整理消息')
    with index.connect() as db:
        db.execute("DELETE FROM state WHERE key='pending_status_v2'")
        db.execute('DROP INDEX memory_pending_ready')
        db.execute('CREATE TABLE memory_pending_queue(memory_id INTEGER PRIMARY KEY,project_id TEXT,ready_at REAL)')
        db.execute('CREATE INDEX memory_pending_ready ON memory_pending_queue(project_id,ready_at)')
        queue.install(db)
        assert db.execute("SELECT count(*) FROM memories WHERE memory_status='done'").fetchone()[0]==1
        assert db.execute("SELECT count(*) FROM memories WHERE memory_status='pending'").fetchone()[0]==1
        assert not db.execute("SELECT 1 FROM sqlite_master WHERE name='memory_pending_queue'").fetchone()
    assert queue.has_pending(['p'])


async def test_locked_database_defers_gate_without_blocking_loop(knowledge):
    import sqlite3, threading, time
    from services import memory_pending_queue as queue, digital_person_memory_index as index
    entered=threading.Event();release=threading.Event()
    def lock():
        db=sqlite3.connect(index.database_path())
        try:
            db.execute('BEGIN EXCLUSIVE');entered.set();release.wait(2)
        finally:
            db.rollback();db.close()
    holder=asyncio.create_task(asyncio.to_thread(lock))
    try:
        assert await asyncio.to_thread(entered.wait,1)
        start=time.perf_counter()
        pending=asyncio.create_task(asyncio.to_thread(queue.has_pending,['p']))
        await asyncio.wait_for(asyncio.sleep(.01),.05)
        assert not await pending
        assert time.perf_counter()-start < .5
    finally:
        release.set();await holder
