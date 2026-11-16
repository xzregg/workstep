import asyncio
import json

import httpx
import pytest

from cli import build_parser, dispatch
from services import memory_query
from services.conversation_context import conversation_context
from services.tool_registry import WorkstepClient
from tests.test_memory_query import runtime, chat_module, seed


async def test_cli_memory_uses_inherited_conversation_without_token():
    seen=[]
    async def handler(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200,json={'items':[],'has_more':False})
    with conversation_context('project-one','conversation-one'):
        result=await dispatch(build_parser().parse_args(['memory','search','--query','迁移']),
            WorkstepClient(transport=httpx.MockTransport(handler)))
    assert not result.get('ok') is False
    assert seen[0]['project_id']=='project-one'
    assert seen[0]['session_id']=='conversation-one'
    assert 'memory_token' not in seen[0]


async def test_api_resolves_scope_without_token_and_pending_is_bound(runtime,monkeypatch):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from api import memory
    current,project,sid=await seed(runtime,['迁移要求'])
    monkeypatch.setattr(memory,'projects',lambda:current.projects)
    app=FastAPI();app.include_router(memory.router)
    args={'project_id':project.id,'session_id':sid}
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        response=await client.post('/api/memory/search',json={**args,'query':'迁移'})
        assert response.status_code==200,response.text
        assert (await client.post('/api/memory/pending',json=args)).status_code==403
        assert (await client.post('/api/memory/search',json={**args,'session_id':'missing'})).status_code==200
        access=await memory_query.execution_access(current.projects,project.id,sid,fresh=True)
        calls=[]
        async def load():
            calls.append(1)
            return {'origin_project_id':project.id,'conversation':[{'content':'本轮完整正文'}]}
        memory_query.bind_assessment_loader(access,load)
        other_sid=await current.projects.run_db(project.id,lambda _:current.chats.create_session(project.id)['id'])
        # Another LLM cannot consume or mark observed the active thinking batch.
        wrong=await client.post('/api/memory/pending',json={'project_id':project.id,'session_id':other_sid})
        assert wrong.status_code==403
        assert not calls and not memory_query.assessment_observed(access)
        first=await client.post('/api/memory/pending',json=args)
        second=await client.post('/api/memory/pending',json=args)
        assert first.status_code==second.status_code==200
        assert first.json()==second.json()
        assert len(calls)==1
        memory_query.release_execution(project.id,sid,access)
        assert (await client.post('/api/memory/pending',json=args)).status_code==403


async def test_execution_context_does_not_generate_or_inject_memory_token(runtime,monkeypatch):
    from services import digital_person_memory as memory
    current,project,sid=await seed(runtime,['正常对话'])
    def forbidden(*args,**kwargs):
        pytest.fail('normal execution must not mint a memory capability')
    assert not hasattr(memory_query,'issue_access')
    monkeypatch.setattr(memory_query,'create_context',forbidden)
    assert await memory.context_prompt(current.projects,'local','',session_id=sid,issuer_project_id=project.id)==''
    access=await memory_query.execution_access(current.projects,project.id,sid)
    assert access.session_id==sid


async def test_local_query_needs_no_conversation_and_remains_cross_project(runtime,tmp_path,monkeypatch):
    from services import memory_knowledge as knowledge
    from tests.memory_turn_fixture import create_completed_user
    from models.fields import utc_now
    current,home,_=runtime
    other=await asyncio.to_thread(current.projects.init_project,tmp_path/'other-memory')
    sid=await current.projects.run_db(other.id,lambda _:current.chats.create_session(other.id)['id'])
    await current.projects.run_db(other.id,lambda _:create_completed_user(id='cross-source',session=sid,
        role='user',content='北辰项目发布前须演练迁移',created_at=utc_now()))
    from services import digital_person_memory_index as index
    rows=await asyncio.to_thread(index.candidates,'local',project_ids=[other.id])
    user=next(r for r in rows if r['role']=='user')
    await asyncio.to_thread(knowledge.store_extraction,{'memories':[{'summary':'北辰项目发布前须演练迁移',
        'kind':'preference','outcome':'stated','source_ids':['memory:'+str(user['id'])]}]},rows)
    access=await memory_query.execution_access(current.projects,'','')
    assert set(access.project_ids)=={home.id,other.id}
    hits=await memory_query.search(current.projects,access,query='北辰')
    assert hits['knowledge']
    source=hits['knowledge'][0]['sources'][0]['id']
    assert '演练迁移' in (await memory_query.read(current.projects,access,source))['content']
    from api import memory
    from fastapi import FastAPI
    monkeypatch.setattr(memory,'projects',lambda:current.projects)
    app=FastAPI();app.include_router(memory.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        response=await client.post('/api/memory/search',json={'query':'北辰'})
        assert response.status_code==200
        assert response.json()['knowledge']
    from services.remote_access import ActorSnapshot,actor_context
    with actor_context(ActorSnapshot('remote','Remote','device','Device','remote',home.id,'read')):
        restricted=await memory_query.execution_access(current.projects,'','')
        assert restricted.project_ids==(home.id,)
        assert not (await memory_query.search(current.projects,restricted,query='北辰'))['knowledge']


async def test_task_identity_available_without_a_connector():
    from services.connectors.runtime import scoped_task_stream
    from services.conversation_context import current_conversation
    before=current_conversation()
    async def engine():
        yield current_conversation()
    iterator=scoped_task_stream(engine(),'project','task-id')
    assert await anext(iterator)=={'project_id':'project','session_id':'task:task-id'}
    await iterator.aclose()
    assert current_conversation()==before


async def test_slow_scope_resolution_keeps_api_responsive(runtime,monkeypatch):
    import time
    from fastapi import FastAPI
    from httpx import ASGITransport,AsyncClient
    from api import memory
    from services import memory_knowledge
    current,project,sid=await seed(runtime,['慢查询'])
    monkeypatch.setattr(memory,'projects',lambda:current.projects)
    original=memory_knowledge._candidates
    def slow(*args,**kwargs):
        time.sleep(.15)
        return original(*args,**kwargs)
    monkeypatch.setattr(memory_knowledge,'_candidates',slow)
    app=FastAPI();app.include_router(memory.router)
    @app.get('/health')
    async def health():return {'ok':True}
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        task=asyncio.create_task(client.post('/api/memory/search',json={'project_id':project.id,'session_id':sid,'query':'慢查询'}))
        await asyncio.sleep(.03)
        assert not task.done()
        assert (await asyncio.wait_for(client.get('/health'),.1)).status_code==200
        assert (await task).status_code==200
