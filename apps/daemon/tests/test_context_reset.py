"""Context reset keeps application identity and discards model history."""
from tests.prompt_xml import read_context
import pytest
import asyncio
import threading
import json

from tests.test_chat_session import chat_module, _wait_turn
from tests.test_coordinator import api_context, _create_task, _wait_for_reply, ResumeCoordinatorFakeEngine
from models.chat_session import ChatSession
from agent_assistants.context_commands import reset_command


@pytest.mark.parametrize('text,expected', [('/new', ''), (' /clear\nnext', 'next'),
    ('/newspaper', None), ('prefix /clear', None)])
def test_command_boundary(text, expected):
    assert reset_command(text) == expected


@pytest.mark.parametrize('command', ['/new', '/clear'])
async def test_chat_reset_survives_reload_without_replaying_history(chat_module, monkeypatch, command):
    module, bus, manager, project, _ = chat_module
    calls = []
    async def invoke(engine_id, model, cwd, prompt, session_id, on_event=None, **kwargs):
        calls.append((prompt, session_id, kwargs.get('message_history')))
        return 'answer', [], f'engine-{len(calls)}'
    monkeypatch.setattr(module, '_invoke', invoke)
    sid = module.create_session(project.id)['id']
    async def send(text, key):
        accepted = module.submit_message(project.id, sid, text, key)
        assert await _wait_turn(module, accepted.turn_id) == 'completed'
    await send('OLD-CONTEXT-SECRET', 'first')
    await send(command, 'reset')
    assert len(calls) == 1  # control commands never reach the model
    assert ChatSession.get_by_id(sid).engine_session_id is None
    assert any(m['content'] == 'OLD-CONTEXT-SECRET' for m in module.history(project.id, sid)['messages'])
    module._sessions.clear()  # simulate restart
    await send('fresh question', 'next')
    assert calls[-1][1:] == (None, None)
    assert 'OLD-CONTEXT-SECRET' not in calls[-1][0]
    assert 'fresh question' in calls[-1][0]
    assert ChatSession.get_by_id(sid).engine_session_id == 'engine-2'


async def test_reset_with_new_question_and_idempotent_replay(chat_module, monkeypatch):
    module, _, _, project, _ = chat_module
    calls = []
    async def invoke(engine_id, model, cwd, prompt, session_id, on_event=None, **kwargs):
        calls.append((prompt, session_id))
        return 'answer', [], 'fresh-engine'
    monkeypatch.setattr(module, '_invoke', invoke)
    sid = module.create_session(project.id)['id']
    accepted = module.submit_message(project.id, sid, '/new new question', 'reset')
    assert await _wait_turn(module, accepted.turn_id) == 'completed'
    assert calls[0][1] is None
    assert 'new question' in calls[0][0]
    assert '/new' not in calls[0][0]
    replay = module.submit_message(project.id, sid, '/new new question', 'reset')
    assert replay.turn_id == accepted.turn_id
    assert ChatSession.get_by_id(sid).engine_session_id == 'fresh-engine'
    assert len(calls) == 1


async def test_internal_event_content_is_not_a_user_command_and_replay_is_idempotent(chat_module,monkeypatch):
    module,_,manager,project,_=chat_module
    calls=[]
    async def invoke(*args,**kwargs):
        calls.append(args[3])
        return 'done',[],'native'
    monkeypatch.setattr(module,'_invoke',invoke)
    sid=await manager.run_db(project.id,lambda _:module.create_session(project.id)['id'])
    def submit(_):
        return module.submit_internal_event(project.id,sid,'digital_person.reflection','/new background evidence','internal-1',schedule=False)
    accepted=await manager.run_db(project.id,submit)
    module.start_queued_turn(accepted.turn_id)
    assert await _wait_turn(module,accepted.turn_id)=='completed'
    assert '/new background evidence' in calls[0]
    assert await manager.run_db(project.id,lambda _:ChatSession.get_by_id(sid).context_reset_at) is None
    replay=await manager.run_db(project.id,submit)
    assert replay.turn_id==accepted.turn_id and len(calls)==1


async def test_reset_database_wait_does_not_block_health(chat_module, monkeypatch):
    import main
    from httpx import AsyncClient, ASGITransport
    module, _, manager, project, _ = chat_module
    sid = await manager.run_db(project.id, lambda _: module.create_session(project.id)['id'])
    entered, release = threading.Event(), threading.Event()
    original = ChatSession.update
    def slow_update(cls, *args, **kwargs):
        if kwargs.get('context_reset_at') is not None:
            entered.set()
            assert release.wait(2)
        return original(*args, **kwargs)
    monkeypatch.setattr(ChatSession, 'update', classmethod(slow_update))
    accepted = await manager.run_db(project.id, lambda _: module.submit_message(project.id, sid, '/clear', 'reset', schedule=False))
    module.start_queued_turn(accepted.turn_id)
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/health'), .5)).status_code == 200
    finally:
        release.set()
    assert await _wait_turn(module, accepted.turn_id) == 'completed'


@pytest.mark.parametrize('resumes', [True, False])
async def test_task_reset_command_keeps_task_and_starts_fresh_engine(api_context, monkeypatch, resumes):
    from engines.core.registry import ENGINE_REGISTRY
    client, tmp_path = api_context
    ResumeCoordinatorFakeEngine.calls.clear()
    monkeypatch.setattr(ResumeCoordinatorFakeEngine, 'supports_resume', resumes)
    monkeypatch.setitem(ENGINE_REGISTRY, 'claude', ResumeCoordinatorFakeEngine)
    pid, tid = await _create_task(client, tmp_path)
    async def send(content, key):
        response = await client.post(f'/api/task/{tid}/chat?project_id={pid}',
                                     headers={'Idempotency-Key': key}, json={'content': content})
        assert response.status_code == 200, response.text
        await _wait_for_reply(client, pid, tid, assistant_message_id=response.json()['assistant_message_id'])
    await send('old question', 'first')
    await send('/clear', 'reset')
    assert len(ResumeCoordinatorFakeEngine.calls) == 1
    await send('fresh question', 'next')
    assert ResumeCoordinatorFakeEngine.calls[-1]['session_id'] is None
    assert ResumeCoordinatorFakeEngine.calls[-1]['message_history'] is None
    context = read_context(ResumeCoordinatorFakeEngine.calls[-1]['prompt'])
    assert 'old question' not in json.dumps(context['recent_coordinator_messages'])
    assert context['coordinator_summary'] is None
    assert context['task']['id'] == tid


async def test_internal_reset_parameter_is_per_turn_and_never_enters_transcript(chat_module,monkeypatch):
    from models.chat_session import ChatMessage
    module,_,manager,project,_=chat_module
    calls=[]
    async def invoke(engine,model,cwd,prompt,session_id,on_event=None,**kwargs):
        calls.append((prompt,session_id,kwargs.get('message_history')))
        return 'answer',[],f'engine-{len(calls)}'
    monkeypatch.setattr(module,'_invoke',invoke)
    sid=await manager.run_db(project.id,lambda _:module.create_session(project.id)['id'])
    async def send(text,key,reset=False):
        accepted=await manager.run_db(project.id,lambda _:module.submit_message(project.id,sid,text,key,schedule=False,reset_context=reset))
        module.start_queued_turn(accepted.turn_id)
        assert await _wait_turn(module,accepted.turn_id)=='completed'
        return accepted
    await send('OLD-PRIVATE-HISTORY','old')
    accepted=await send('fresh reflection','new',True)
    assert calls[-1][1:]==(None,None)
    assert 'OLD-PRIVATE-HISTORY' not in calls[-1][0]
    assert await manager.run_db(project.id,lambda _:ChatMessage.get_by_id(accepted.turn_id).content)=='fresh reflection'
    replay=await manager.run_db(project.id,lambda _:module.submit_message(project.id,sid,'fresh reflection','new',schedule=False,reset_context=True))
    assert replay.turn_id==accepted.turn_id
    assert await manager.run_db(project.id,lambda _:ChatSession.get_by_id(sid).engine_session_id)=='engine-2'
    module._sessions.clear()
    await send('next reflection','next')
    assert calls[-1][1]=='engine-2' and len(calls)==3
    assert 'OLD-PRIVATE-HISTORY' not in calls[-1][0]
