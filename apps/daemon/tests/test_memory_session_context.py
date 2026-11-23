import json
import pytest
from tests.test_memory_knowledge import knowledge, seed, payload
from services import digital_person_memory_index as index


def test_preferences_include_full_cross_session_records_and_only_valid_scope(knowledge):
    from services.memory_session_context import preferences
    mid=seed()
    knowledge.store_extraction(payload(mid),index.candidates('local'))
    other=seed('另一用户的偏好','channel:other')
    knowledge.store_extraction(payload(other),index.candidates('channel:other'))
    with index.connect() as db:
        db.execute("UPDATE memories SET session_id='old-archived-session' WHERE id=?",(mid,))
    result,versions=preferences([('p','new-session','local')],['p'])
    assert result['complete'] is True
    assert [item['id'] for item in result['items']]==['knowledge:1']
    item=result['items'][0]
    assert item['summary']=='用户喜欢清晨工作'
    assert item['scope']=='local' and item['entities'][0]['name']=='用户'
    assert item['source_ids']==[f'memory:{mid}']
    assert versions=={'knowledge:1':knowledge.read_record('local',['p'],'knowledge:1')['version']}
    assert preferences([('p','s','local')],['unrelated'])[0]['items']==[]
    index.forget(mid)
    assert preferences([('p','s','local')],['p'])[0]['items']==[]


def test_preferences_budget_never_truncates_or_authorizes_omitted_records(knowledge):
    from services.memory_session_context import preferences
    mid=seed()
    knowledge.store_extraction(payload(mid),index.candidates('local'))
    with index.connect() as db:
        for n in range(10):
            db.execute("INSERT INTO memory_knowledge SELECT ?,scope,?, ?,kind,outcome,event_time,valid_until,state,supersedes_json,entities_json,relations_json,created_at FROM memory_knowledge WHERE id=1",(n+2,str(n),'带适用条件的完整偏好'+str(n)+'。'*200))
            db.execute('INSERT INTO memory_knowledge_sources VALUES(?,?,?)',(n+2,mid,''))
    result,versions=preferences([('p','s','local')],['p'])
    assert result['complete'] is False
    assert result['estimated_tokens']<=result['token_budget']==2000
    assert 0<len(result['items'])<11
    assert set(versions)=={item['id'] for item in result['items']}
    for item in result['items']:
        assert item['summary']==json.loads(knowledge.read_record('local',['p'],item['id'])['content'])['summary']
    with index.connect() as db:
        assert db.execute('SELECT count(*) FROM memory_knowledge').fetchone()[0]==11


def test_preference_snapshot_cannot_replace_a_concurrently_changed_version(knowledge):
    from services.memory_session_context import preferences
    mid=seed()
    knowledge.store_extraction(payload(mid),index.candidates('local'))
    _,versions=preferences([('p','s','local')],['p'])
    with index.connect() as db:
        db.execute("UPDATE memory_knowledge SET summary='仅工作日清晨工作' WHERE id=1")
    new=seed('以后晚上工作')
    with pytest.raises(ValueError,match='changed'):
        knowledge.store_extraction(payload(new,supersedes=['knowledge:1']),index.candidates('local'),versions,strict=True)
    with index.connect() as db:
        assert db.execute("SELECT count(*) FROM memory_knowledge WHERE state='active'").fetchone()[0]==1


def test_preferences_cross_projects_but_not_people_expiry_or_superseded_records(knowledge):
    from services.memory_session_context import preferences
    mid=next(iter(index.capture('q','old-session','old-message','local','user','偏好清晨工作','2026-11-01T00:00:00+00:00').values()))
    knowledge.store_extraction(payload(mid),index.candidates('local'))
    result,_=preferences([('p','new-session','local')],['p','q'])
    assert [item['id'] for item in result['items']]==['knowledge:1']
    assert preferences([('p','s','channel:other')],['p','q'])[0]['items']==[]
    assert preferences([('p','s','local')],['p'])[0]['items']==[]
    with index.connect() as db:
        db.execute("UPDATE memory_knowledge SET valid_until='2000-01-01T00:00:00+00:00'")
    assert preferences([('p','s','local')],['p','q'])[0]['items']==[]
    with index.connect() as db:
        db.execute("UPDATE memory_knowledge SET valid_until=NULL,state='superseded'")
    assert preferences([('p','s','local')],['p','q'])[0]['items']==[]


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


@pytest.mark.parametrize('change', ['synonym','condition','replacement'])
async def test_pending_preferences_enable_version_bound_updates_without_extra_read(runtime,monkeypatch,change):
    from services import memory_query
    from tests.memory_turn_fixture import assessment_access,create_completed_user
    from models.fields import utc_now
    current,project,_=runtime
    sid=(await current.main_session())['id']
    texts=['日常回答简短一点。',{'synonym':'平时别说太长。','condition':'但技术分析需要详细。','replacement':'以后日常回答也详细一点。'}[change]]
    summaries=['日常回答简短。',{'condition':'日常回答简短；技术分析提供详细解释。','replacement':'日常回答提供详细解释。'}.get(change,'')]
    calls=[]
    async def invoke(*args,**kwargs):
        access=await assessment_access(current)
        ctx=await memory_query.pending(current.projects,access)
        assert await memory_query.pending(current.projects,access)==ctx
        snapshot=ctx['user_preferences']
        assert snapshot['complete'] is True
        if calls:
            assert [item['id'] for item in snapshot['items']]==['knowledge:1']
            assert snapshot['items'][0]['summary']==summaries[0]
            assert set(memory_query.observed_knowledge_versions(access))=={'knowledge:1'}
        else:
            assert snapshot['items']==[]
        group=ctx.get('conversations',[ctx])[0]
        user=next(m for m in group['conversation'] if m['role']=='user')
        number=len(calls)
        calls.append(ctx)
        memories=[] if number and change=='synonym' else [dict(summary=summaries[number],kind='preference',
            outcome='stated',source_ids=user['memory_ids'],**({'supersedes':['knowledge:1']} if number else {}))]
        return '<json>'+json.dumps(dict(decision='silent',summary='Preferences reviewed',source_ids=[],memories=memories))+'</json>',[],'native'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    for n,text in enumerate(texts):
        await current.projects.run_db(project.id,lambda _,n=n,text=text:create_completed_user(
            id=f'preference-{n}',session=sid,role='user',author_id='owner',content=text,status='completed',created_at=utc_now()))
        result=await current.check()
        assert result['status']=='silent',result
    with index.connect() as db:
        rows=list(db.execute('SELECT id,summary,state FROM memory_knowledge ORDER BY id'))
        if change=='synonym':
            assert len(rows)==1 and rows[0]['state']=='active'
        else:
            assert [(r['state'],r['summary']) for r in rows]==[('superseded',summaries[0]),('active',summaries[1])]
            assert db.execute('SELECT count(*) FROM memory_knowledge_sources WHERE knowledge_id=2').fetchone()[0]==2


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


async def test_pending_preferences_are_cached_and_loaded_off_event_loop(runtime,monkeypatch):
    import asyncio
    import threading
    from services import memory_query,memory_session_context
    from tests.memory_turn_fixture import assessment_access
    current,project,_=runtime
    await seed_turn(current,project)
    entered=threading.Event();release=threading.Event();calls=[]
    def slow(sessions,ids):
        calls.append(sessions)
        entered.set()
        assert release.wait(3)
        return {'items':[], 'complete':True},{}
    monkeypatch.setattr(memory_session_context,'preferences',slow)
    async def invoke(*args,**kwargs):
        access=await assessment_access(current)
        tasks=[asyncio.create_task(memory_query.pending(current.projects,access)) for _ in range(2)]
        try:
            for _ in range(100):
                if entered.is_set():break
                await asyncio.sleep(.01)
            assert entered.is_set()
            await asyncio.sleep(.01)
            assert not tasks[0].done()
        finally:
            release.set()
        first,second=await asyncio.gather(*tasks)
        assert first==second and len(calls)==1
        assert first['user_preferences']=={'items':[],'complete':True}
        return '{"decision":"silent","summary":"Reviewed","source_ids":[]}',[],'native'
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
