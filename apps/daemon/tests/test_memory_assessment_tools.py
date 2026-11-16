from tests.memory_turn_fixture import create_completed_user
import asyncio
import pytest
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime


async def test_pending_requires_internal_assignment_and_preserves_context(runtime):
    from services import memory_query as query
    current, project, _ = runtime
    token = await query.create_context(current.projects, 'local', project_ids=[project.id])
    with pytest.raises(PermissionError):
        await query.pending(current.projects, token)
    payload = {'origin_project_id': project.id, 'conversation': [{'id':'m1','content':'证据'}]}
    query.bind_assessment(token, payload)
    assert not query.assessment_observed(token)
    result = await query.pending(current.projects, token)
    assert result == payload
    assert query.assessment_observed(token)
    result['conversation'].clear()
    assert (await query.pending(current.projects, token))['conversation']
    query.clear_assessment(token)
    with pytest.raises(PermissionError):
        await query.pending(current.projects, token)


async def test_pending_does_not_block_event_loop(runtime, monkeypatch):
    import time
    from services import memory_query as query
    current, project, _ = runtime
    token = await query.create_context(current.projects, 'local')
    query.bind_assessment(token, {'origin_project_id':project.id})
    from services import digital_person
    original = digital_person.get_profile
    def slow():
        time.sleep(.1)
        return original()
    monkeypatch.setattr(digital_person, 'get_profile', slow)
    task = asyncio.create_task(query.pending(current.projects, token))
    await asyncio.sleep(.02)
    assert not task.done()
    await task


def test_assessment_contract_and_cli():
    from services.digital_person_assessment import instruction
    from services.digital_person import DigitalPersonProfile
    from cli import build_parser
    from cli_memory_output import compact, render
    prompt = instruction(DigitalPersonProfile())
    for text in ('memory pending', 'entities', 'relations', 'event_time', 'Step 1', 'Step 2', 'Step 3'):
        assert text in prompt
    args=build_parser().parse_args(['memory','pending','--json'])
    assert args.subcommand=='pending'
    payload={'conversation':[{'id':'m1','read_ranges':[{'id':'memory:1','offset':0,'length':100}]}]}
    assert compact(payload,'pending')==payload
    assert 'read_ranges' in render(payload,'pending')


async def test_pending_http_capability_and_cli_transport(runtime, monkeypatch):
    from fastapi import FastAPI
    from httpx import AsyncClient, ASGITransport
    from api import memory
    from services import memory_query as query
    from cli import build_parser, dispatch
    current, project, _ = runtime
    sid=(await current.main_session())['id']
    token = await query.execution_access(current.projects,project.id,sid,fresh=True)
    monkeypatch.setattr(memory, 'projects', lambda: current.projects)
    app=FastAPI()
    app.include_router(memory.router)
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        assert (await client.post('/api/memory/pending',json={'project_id':project.id,'session_id':sid})).status_code==403
        query.bind_assessment(token,{'origin_project_id':project.id,'conversation':[]})
        assert (await client.post('/api/memory/pending',json={'project_id':project.id,'session_id':sid})).status_code==200
    class Client:
        async def call(self, operation, arguments):
            assert operation=='workstep_memory_pending' and arguments=={}
            return await query.pending(current.projects, token)
    args=build_parser().parse_args(['memory','pending','--json'])
    assert (await dispatch(args,Client()))['conversation']==[]


async def test_model_cannot_skip_fetch_and_mark_batch_done(runtime, monkeypatch):
    import json
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    from services import digital_person_memory_index as index
    current, project, _ = runtime
    sid=(await current.main_session())['id']
    await current.projects.run_db(project.id,lambda _:create_completed_user(
        id='unseen',session=sid,role='user',content='DO_NOT_INJECT_THIS_MESSAGE',created_at=utc_now()))
    async def invoke(*args,**kwargs):
        assert 'DO_NOT_INJECT_THIS_MESSAGE' not in args[3]
        assert 'memory pending' in kwargs['system_prompt']
        assert 'workstep_memory_' not in kwargs['system_prompt']
        return json.dumps({'decision':'silent','summary':'done','source_ids':[]}),[], 'native'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    result=await current.check()
    assert result['status']=='failed'
    with index.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM digital_reflections').fetchone()[0]==0
        assert db.execute("SELECT COUNT(*) FROM memory_extraction_jobs WHERE status='done'").fetchone()[0]==0
