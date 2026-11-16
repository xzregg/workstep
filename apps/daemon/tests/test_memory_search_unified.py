import pytest
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime
from tests.test_memory_query import seed, extract_seed_knowledge


async def test_search_without_text_reads_unindexed_history_and_pages(runtime):
    from services import memory_query as query, digital_person_memory_index as index
    current, project, sid = await seed(runtime, ['发布计划', '发布失败', '修复完成'])
    with index.connect() as db:
        db.execute('DELETE FROM memories')
    token=await query.create_context(current.projects,'local',session_id=sid)
    args=dict(since='2026-10-01T00:00:00Z',before='2026-11-01T00:00:00Z',limit=1)
    page=await query.search(current.projects,token,**args)
    assert page['coverage']['basis']=='authoritative_terminal_messages'
    ids=[r['source_message_id'] for r in page['items']]
    while page['has_more']:
        page=await query.search(current.projects,token,**args,cursor=page['next_cursor'],snapshot=page['snapshot'])
        ids.extend(r['source_message_id'] for r in page['items'])
    assert set(ids)=={'query-0','query-1','query-2',
                      'fixture-reply-query-0','fixture-reply-query-1','fixture-reply-query-2'}
    assert page['coverage']['complete_source_history']


async def test_search_text_keeps_relevance_and_snapshot_cannot_switch_routes(runtime):
    from services import memory_query as query
    current, _, sid = await seed(runtime, ['发布计划', '迁移失败'])
    token=await query.create_context(current.projects,'local',session_id=sid)
    await extract_seed_knowledge()
    result=await query.search(current.projects,token,query='迁移')
    assert result['coverage']['basis']=='knowledge_index'
    assert [r['summary'] for r in result['knowledge']]==['迁移失败']
    with pytest.raises(ValueError):
        await query.search(current.projects,token,query='迁移',snapshot='history-snapshot')


def test_only_one_search_tool_and_intent_guidance():
    from services.tool_registry import WORKSTEP_TOOLS, TOOL_BY_NAME
    from services.memory_query import instruction
    names={t.name for t in WORKSTEP_TOOLS}
    assert not any(name.startswith('workstep_memory_') for name in names)
    assert 'workstep_memory_search' in TOOL_BY_NAME
    assert 'workstep_memory_history' not in names
    assert 'workstep_memory_history' in TOOL_BY_NAME  # legacy callers only
    prompt=instruction()
    assert prompt == ''


async def test_unified_search_http_and_scope(runtime, monkeypatch):
    from fastapi import FastAPI
    from httpx import AsyncClient, ASGITransport
    from api import memory
    from services import memory_query as query
    current, project, sid = await seed(runtime, ['部署完成'])
    monkeypatch.setattr(memory,'projects',lambda:current.projects)
    app=FastAPI()
    app.include_router(memory.router)
    token=await query.create_context(current.projects,'local',session_id=sid)
    empty=await query.create_context(current.projects,'local',project_ids=[])
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        for path in ('search','history'):
            result=await client.post('/api/memory/'+path,json={'since':'2026-10-01T00:00:00Z','before':'2026-11-01T00:00:00Z'})
            assert result.status_code==200
            assert result.json()['items'][0]['source_message_id']=='query-0'
        result=await client.post('/api/memory/search',json={'filter_project_id':'missing'})
        assert result.status_code==403
        assert (await client.post('/api/memory/search',json={'filter_project_id':'bad'})).status_code==403


async def test_date_review_filters_keywords_and_binds_them_to_cursor(runtime):
    from services import memory_query as query
    current, _, sid = await seed(runtime, ['发布计划', '迁移失败', '部署完成'])
    token=await query.create_context(current.projects,'local',session_id=sid)
    args=dict(query='迁移 部署',since='2026-10-03T00:00:00Z',before='2026-11-01T00:00:00Z',limit=1)
    page=await query.search(current.projects,token,**args)
    results=list(page['items'])
    snapshot=page['snapshot']
    while page['has_more']:
        page=await query.search(current.projects,token,**args,cursor=page['next_cursor'],snapshot=snapshot)
        results.extend(page['items'])
    assert {r['source_message_id'] for r in results}=={'query-1','query-2'}
    assert page['coverage']['query']=='迁移 部署'
    assert page['coverage']['complete_filtered_history']
    assert not page['coverage']['complete_source_history']
    with pytest.raises(ValueError):
        await query.search(current.projects,token,**{**args,'query':'发布'},snapshot=snapshot,cursor=1)


async def test_date_keywords_advance_through_empty_pages(runtime):
    from services import memory_query as query
    current, _, sid=await seed(runtime,['无关内容','迁移完成'])
    token=await query.create_context(current.projects,'local',session_id=sid)
    args=dict(query='迁移',period='',since='2026-10-01T00:00:00Z',limit=1)
    first=await query.search(current.projects,token,**args)
    assert first['items']==[] and first['has_more']
    second=await query.search(current.projects,token,**args,snapshot=first['snapshot'],cursor=first['next_cursor'])
    assert second['items']==[] and second['has_more']
    third=await query.search(current.projects,token,**args,snapshot=second['snapshot'],cursor=second['next_cursor'])
    assert third['items'][0]['source_message_id']=='query-1'


def test_compact_history_keeps_keyword_coverage():
    from cli_memory_output import compact
    result=compact({'items':[], 'coverage':{'query':'部署 发布','complete_filtered_history':True,
        'complete_source_history':False,'keyword_match':'any'}},'search')
    assert result['coverage']['query']=='部署 发布'
    assert result['coverage']['complete_filtered_history']
