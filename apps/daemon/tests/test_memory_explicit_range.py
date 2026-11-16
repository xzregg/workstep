import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI

from cli import build_parser,dispatch
from services import memory_knowledge as knowledge, digital_person_memory_index as index
from services.conversation_context import conversation_context
from services.tool_registry import WorkstepClient
from tests.memory_turn_fixture import create_completed_user
from tests.test_memory_query import runtime,chat_module
from models.fields import utc_now


async def test_model_selects_range_and_caller_never_implicitly_narrows_it(runtime,tmp_path,monkeypatch):
    from api import memory
    current,first,store=runtime
    second=await asyncio.to_thread(current.projects.init_project,tmp_path/'second')
    sessions=[]
    for project in (first,second):
        sessions.append(await current.projects.run_db(project.id,lambda _:current.chats.create_session(project.id)['id']))
    store.set('channel_bots',{'sessions':{'bot:single:peer':sessions[1]},'session_sources':{sessions[1]:{}}})
    for number,(project,sid) in enumerate(zip((first,second),sessions)):
        await current.projects.run_db(project.id,lambda _:create_completed_user(id='range-'+str(number),session=sid,
            role='user',content='共同主题：项目'+str(number)+'发布要求',created_at=utc_now()))
        scope='local' if number==0 else 'channel:bot:single:peer'
        rows=await asyncio.to_thread(index.candidates,scope,project_ids=[project.id])
        user=next(r for r in rows if r['role']=='user')
        await asyncio.to_thread(knowledge.store_extraction,{'memories':[{'summary':'共同主题：项目'+str(number)+'发布要求',
            'kind':'preference','outcome':'stated','source_ids':['memory:'+str(user['id'])]}]},rows)
    monkeypatch.setattr(memory,'projects',lambda:current.projects)
    app=FastAPI();app.include_router(memory.router)
    # Caller is the channel conversation: still searches both projects/scopes.
    caller={'project_id':second.id,'session_id':sessions[1]}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        broad=await client.post('/api/memory/search',json={**caller,'query':'共同主题'})
        assert broad.status_code==200,broad.text
        assert len(broad.json()['knowledge'])==2
        limited=await client.post('/api/memory/search',json={**caller,'query':'共同主题','filter_project_id':first.id})
        assert len(limited.json()['knowledge'])==1
        assert all(s['project_id']==first.id for k in limited.json()['knowledge'] for s in k['sources'])
        by_session=await client.post('/api/memory/search',json={**caller,'query':'共同主题','filter_session_id':sessions[1]})
        assert len(by_session.json()['knowledge'])==1
        for hit in broad.json()['knowledge']:
            response=await client.post('/api/memory/read',json={**caller,'memory_id':hit['sources'][0]['id']})
            assert response.status_code==200,response.text
        history=await client.post('/api/memory/search',json={**caller,'filter_project_id':first.id,'filter_session_id':sessions[0]})
        assert history.status_code==200,history.text
        assert history.json()['items'] and all(r['session_id']==sessions[0] for r in history.json()['items'])
        # No token compatibility branch remains.
        assert (await client.post('/api/memory/search',json={'memory_token':'old'})).status_code==422


async def test_cli_explicit_range_is_separate_from_inherited_caller():
    seen=[]
    async def handler(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200,json={'items':[]})
    with conversation_context('caller-project','caller-session'):
        args=build_parser().parse_args(['memory','search','--project','target-project','--session','target-session','--query','经验'])
        await dispatch(args,WorkstepClient(transport=httpx.MockTransport(handler)))
    assert seen[0]['project_id']=='caller-project'
    assert seen[0]['filter_project_id']=='target-project'
    assert seen[0]['filter_session_id']=='target-session'
    with pytest.raises(SystemExit):
        build_parser().parse_args(['memory','search','--token','old'])
