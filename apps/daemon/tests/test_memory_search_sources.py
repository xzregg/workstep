import pytest
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime
from tests.test_memory_query import seed, extract_seed_knowledge


async def test_search_optional_originals_and_paging(runtime, monkeypatch):
    from services import memory_query as query
    current, _, sid = await seed(runtime, ['迁移要求。' * 200])
    await extract_seed_knowledge()
    token=await query.issue_access(current.projects,'local',session_id=sid)
    plain=await query.search(current.projects,token,query='迁移')
    assert 'source_texts' not in plain
    result=await query.search(current.projects,token,query='迁移',include_sources=True,source_chars=200)
    assert len(result['source_texts'])==1  # overlapping chunks share one original
    source=result['source_texts'][0]
    assert len(source['content'])==200 and source['next_offset']==200 and source['has_more']
    assert source['source_message_id']=='query-0' and source['role']=='user'
    assert len(source['source_ids'])==1
    assert not result['source_coverage']['complete']
    dated=await query.search(current.projects,token,include_sources=True,source_chars=200)
    assert dated['source_texts'][0]['content']==source['content']


async def test_cli_preserves_requested_body_and_forwards_flag():
    from cli import build_parser, dispatch
    from cli_memory_output import render
    class Client:
        async def call(self,op,args):
            assert args['include_sources'] and args['source_chars']==300
            return {'items':[], 'source_texts':[{'id':'memory:1','content':'正文'*100,'source_ids':['memory:1'],
                'source_hash':'private','offset':0,'has_more':False}], 'source_coverage':{'complete':True}}
    args=build_parser().parse_args(['memory','search','--token','test','--with-sources','--source-chars','300','--json'])
    result=await dispatch(args,Client())
    assert result['source_texts'][0]['content']=='正文'*100
    assert 'source_hash' not in result['source_texts'][0]
    assert '正文' in render(result,'search')


async def test_knowledge_only_match_expands_original_and_budgets_are_visible(runtime):
    from services import memory_query as query, digital_person_memory_index as index, memory_knowledge as knowledge
    current, _, sid = await seed(runtime, ['张三负责审核。'])
    with index.connect() as db:
        rows=[dict(r) for r in db.execute('SELECT * FROM memories')]
    import asyncio
    await asyncio.to_thread(knowledge.store_extraction, {'memories':[{
        'summary':'上线负责人', 'kind':'fact','outcome':'stated','source_ids':['memory:'+str(rows[0]['id'])]
    }]}, rows)
    await extract_seed_knowledge()
    token=await query.issue_access(current.projects,'local',session_id=sid)
    result=await query.search(current.projects,token,query='上线',include_sources=True)
    assert result['items']==[] and result['knowledge']
    assert result['source_texts'][0]['content']=='张三负责审核。'
    assert result['source_coverage']['complete']


async def test_body_budget_and_http_validation(runtime,monkeypatch):
    from services import memory_query as query
    from api import memory
    from fastapi import FastAPI
    from httpx import AsyncClient, ASGITransport
    current, _, sid = await seed(runtime, ['部署'+str(i)+'长正文'*2000 for i in range(3)])
    await extract_seed_knowledge()
    token=await query.issue_access(current.projects,'local',session_id=sid)
    monkeypatch.setattr(memory,'projects',lambda:current.projects)
    app=FastAPI();app.include_router(memory.router)
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        result=await client.post('/api/memory/search',json={'memory_token':token,'include_sources':True,'source_chars':6000})
        assert result.status_code==200
        data=result.json()
        assert sum(len(s['content']) for s in data['source_texts'])==12000
        assert data['source_coverage']['deferred_ids'] and not data['source_coverage']['complete']
        assert (await client.post('/api/memory/search',json={'memory_token':token,'source_chars':6001})).status_code==422
        assert (await client.post('/api/memory/search',json={'memory_token':'invalid','include_sources':True})).status_code==403


async def test_slow_source_lookup_is_off_loop_and_unavailable_is_reported(runtime,monkeypatch):
    import asyncio
    import threading
    import time
    from services import memory_query as query
    current, _, sid=await seed(runtime,['原文要求'])
    await extract_seed_knowledge()
    token=await query.issue_access(current.projects,'local',session_id=sid)
    entered=threading.Event()
    def missing(*args):
        entered.set()
        time.sleep(.1)
        return None
    monkeypatch.setattr(query,'_find',missing)
    task=asyncio.create_task(query.search(current.projects,token,query='原文',include_sources=True))
    for _ in range(100):
        if entered.is_set():break
        await asyncio.sleep(.005)
    assert entered.is_set()
    await asyncio.sleep(.01)
    assert not task.done()
    result=await task
    assert result['source_texts']==[]
    assert result['source_coverage']['unavailable_ids'] and not result['source_coverage']['complete']
