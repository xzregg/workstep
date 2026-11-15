"""Typed memory lookup through the real CLI/query/storage path."""
import asyncio
import time

import pytest

from cli import build_parser, dispatch
from services import memory_knowledge as knowledge, memory_query as query
from services import digital_person_memory_index as index
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime


async def setup(current, project):
    def seed():
        knowledge.ensure_schema()
        mid=next(iter(index.capture(project.id,'s','dim-source','local','user','原始职责说明','2026-11-01T00:00:00+00:00').values()))
        entities=[{'kind':kind,'name':name,'aliases':aliases} for kind,name,aliases in [
            ('person','小林',['Lin']),('person','小舟',[]),('object','发布清单',[]),
            ('object','任务',[]),('place','杭州',[]),('event','版本发布',[]),('time','十一月',[])]]
        values=[]
        for summary,relations in [
            ('小林负责审核发布清单，小舟负责执行任务。',[
                {'from':'小林','relation':'负责审核','to':'发布清单'},
                {'from':'小舟','relation':'负责执行','to':'任务'}]),
            ('小林旁观，小舟负责执行任务。',[
                {'from':'小舟','relation':'负责执行','to':'任务'}])]:
            values.append(dict(summary=summary,kind='fact',outcome='stated',source_ids=[f'memory:{mid}'],
                entities=entities,relations=relations,event_time='2026-11-01T00:00:00+00:00'))
        assert knowledge.store_extraction({'memories':values},index.candidates('local'),strict=True)==2
    await asyncio.to_thread(seed)
    return await query.issue_access(current.projects,'local',project_ids=[project.id])


async def cli(current,token,*flags):
    class Client:
        async def call(self,operation,arguments):
            return await query.search(current.projects,**arguments)
    args=build_parser().parse_args(['memory','search','--token',token,*flags,'--json'])
    return await dispatch(args,Client())


async def test_person_then_anchored_relationship_and_alias(runtime):
    current,project,_=runtime
    token=await setup(current,project)
    first=await cli(current,token,'--person','Lin')
    assert len(first['knowledge'])==2
    assert first['knowledge'][0]['matched_entities']==[{'kind':'person','name':'小林'}]
    second=await cli(current,token,'--person','Lin','--relation','负责')
    assert len(second['knowledge'])==1
    assert second['knowledge'][0]['matched_relations']==[{'from':'小林','relation':'负责审核','to':'发布清单'}]
    assert not (await cli(current,token,'--person','小林','--relation','负责','--object','任务'))['knowledge']
    assert len((await cli(current,token,'--person','小舟','--relation','负责','--object','任务'))['knowledge'])==2
    assert not (await cli(current,token,'--person','不存在','--query','负责'))['knowledge']
    assert not (await cli(current,token,'--person','发布清单'))['knowledge']


async def test_dimensions_and_time_bounds_permissions(runtime):
    current,project,_=runtime
    token=await setup(current,project)
    flags=['--person','小林','--event','版本发布','--object','发布清单','--place','杭州','--time','十一月']
    result=await cli(current,token,*flags,'--period','this_month')
    assert len(result['knowledge'])==2
    assert result['coverage']['basis']=='knowledge_index'
    assert not (await cli(current,token,*flags,'--before','2026-10-01T00:00:00Z'))['knowledge']
    assert not (await cli(current,token,'--person','小林','--place','上海'))['knowledge']
    foreign=await query.issue_access(current.projects,'channel:other',project_ids=[project.id])
    assert not (await cli(current,foreign,'--person','小林'))['knowledge']
    empty=await query.issue_access(current.projects,'local',project_ids=[])
    assert not (await cli(current,empty,'--person','小林'))['knowledge']
    for bad in [' '*3,'x'*121]:
        with pytest.raises(ValueError):
            await query.search(current.projects,token,person=bad)


async def test_dimension_search_io_stays_off_loop(runtime,monkeypatch):
    current,project,_=runtime
    token=await setup(current,project)
    original=knowledge._candidates
    def slow(*args,**kwargs):
        time.sleep(.1)
        return original(*args,**kwargs)
    monkeypatch.setattr(knowledge,'_candidates',slow)
    ticks=[]
    async def canary():
        for _ in range(20):
            ticks.append(time.monotonic())
            await asyncio.sleep(.01)
    result,_=await asyncio.gather(cli(current,token,'--person','小林','--relation','负责'),canary())
    assert len(result['knowledge'])==1
    assert max(b-a for a,b in zip(ticks,ticks[1:]))<.075


async def test_http_and_dispatch_contract(runtime,monkeypatch):
    from api import memory
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from services.tool_registry import TOOL_BY_NAME
    current,project,_=runtime
    token=await setup(current,project)
    tool=TOOL_BY_NAME['workstep_memory_search']
    assert set(('person','event','object','place','time','relation')) <= set(tool.body_params)
    assert set(('person','event','object','place','time','relation')) <= set(tool.parameters)
    monkeypatch.setattr(memory,'projects',lambda:current.projects)
    app=FastAPI();app.include_router(memory.router)
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        response=await client.post('/api/memory/search',json={'memory_token':token,'person':'Lin','relation':'负责'})
        assert response.status_code==200
        assert len(response.json()['knowledge'])==1
        assert (await client.post('/api/memory/search',json={'memory_token':token,'person':'x'*121})).status_code==422
        assert (await client.post('/api/memory/search',json={'memory_token':'invalid','person':'小林'})).status_code==403


def test_cli_guidance_covers_dimension_progression():
    from pathlib import Path
    source=Path(__file__).resolve().parents[1]/'data/skills/workstep-cli'
    text=(source/'references/memory.md').read_text()
    assert '--person 小林 --relation 负责' in text
    assert 'Different dimensions are AND' in text
    assert '--time 十一月' in text
    assert 'not implemented' not in text
    assert 'typed CLI filters' in query.instruction('test-private-token')


async def test_filters_apply_before_limit_and_forgotten_sources(runtime):
    current,project,_=runtime
    token=await setup(current,project)
    def distractors():
        # Many newer records with the wrong person must not hide the older hit.
        rows=index.candidates('local')
        mid=rows[0]['id']
        values=[dict(summary=f'小舟负责执行任务 {n}',kind='fact',outcome='stated',
            source_ids=[f'memory:{mid}'],entities=[{'kind':'person','name':'小舟','aliases':[]}],
            relations=[]) for n in range(100)]
        for start in range(0,len(values),20):
            knowledge.store_extraction({'memories':values[start:start+20]},rows,strict=True)
    await asyncio.to_thread(distractors)
    found=await cli(current,token,'--person','小林','--relation','负责','--query','负责','--limit','1')
    assert len(found['knowledge'])==1
    assert found['knowledge'][0]['matched_relations'][0]['from']=='小林'
    def forget():
        row=index.candidates('local')[0]
        index.forget(row['id'])
    await asyncio.to_thread(forget)
    assert not (await cli(current,token,'--person','小林','--relation','负责'))['knowledge']
