import json
from tests.test_memory_knowledge import knowledge, seed, payload
from services import digital_person_memory_index as index


def test_session_catalog_is_bounded_scoped_and_does_not_write(knowledge):
    from services.memory_session_context import catalog
    mid=seed()
    knowledge.store_extraction(payload(mid),index.candidates('local'))
    with index.connect() as db:
        for n in range(40):
            db.execute("INSERT INTO memory_knowledge SELECT ?,scope,?, ?,kind,outcome,event_time,valid_until,state,supersedes_json,entities_json,relations_json,created_at FROM memory_knowledge WHERE id=1",(n+2,str(n), '长摘要😀'*10000))
            db.execute('INSERT INTO memory_knowledge_sources VALUES(?,?,?)',(n+2,mid,''))
    result=catalog([('p','s','local'),('other','s','local')],['p'])
    assert len(result['items'])<=4
    assert len(json.dumps(result,ensure_ascii=False).encode())<=12000
    assert result['complete'] is False
    assert all(x['project_id']=='p' and len(x['summary'])<=160 for x in result['items'])
    assert catalog([('p','different','local')],['p'])['items']==[]
    assert catalog([('p','s','other-contact')],['p'])['items']==[]
    with index.connect() as db:
        assert db.execute('SELECT count(*) FROM memory_knowledge').fetchone()[0]==41


from tests.test_digital_person_unified import runtime, chat_module, seed as seed_turn


async def test_pending_catalog_is_cached_and_slow_database_does_not_block(runtime,monkeypatch):
    import asyncio
    import threading
    from services import memory_query, memory_session_context
    from tests.memory_turn_fixture import assessment_access
    current,project,_=runtime
    sid=await seed_turn(current,project)
    entered=threading.Event();release=threading.Event();calls=[]
    def slow(sessions,ids):
        calls.append(sessions)
        entered.set()
        assert release.wait(3)
        return {'items':[], 'complete':False}
    monkeypatch.setattr(memory_session_context,'catalog',slow)
    async def invoke(*args,**kwargs):
        access=await assessment_access(current)
        tasks=[asyncio.create_task(memory_query.pending(current.projects,access)) for _ in range(2)]
        try:
            for _ in range(100):
                if entered.is_set():break
                await asyncio.sleep(.01)
            assert entered.is_set()
            # This coroutine must advance while the synchronous catalog is held.
            await asyncio.sleep(.01)
            assert not tasks[0].done()
        finally:
            release.set()
        first,second=await asyncio.gather(*tasks)
        assert first==second
        assert calls==[[(project.id,sid,'local')]]
        assert first['session_knowledge']=={'items':[], 'complete':False}
        assert memory_query.observed_knowledge_versions(access)=={}
        return '{"decision":"silent","summary":"完成","source_ids":[]}',[],'native'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    assert (await current.check())['status']=='silent'


def test_catalog_large_knowledge_fanout_stays_bounded(knowledge):
    import time
    import statistics
    from services.memory_session_context import catalog
    mid=seed()
    knowledge.store_extraction(payload(mid),index.candidates('local'))
    with index.connect() as db:
        db.executemany("INSERT INTO memory_knowledge SELECT ?,scope,?, ?,kind,outcome,event_time,valid_until,state,supersedes_json,entities_json,relations_json,created_at FROM memory_knowledge WHERE id=1",[(n+2,str(n),'长知识'*400) for n in range(10000)])
        db.executemany('INSERT INTO memory_knowledge_sources VALUES(?,?,?)',[(n+2,mid,'') for n in range(10000)])
    durations=[]
    for _ in range(20):
        started=time.perf_counter();result=catalog([('p','s','local')],['p']);durations.append((time.perf_counter()-started)*1000)
        assert len(result['items'])==4
    print('catalog_10001_knowledge_median_ms=',round(statistics.median(durations),3))
