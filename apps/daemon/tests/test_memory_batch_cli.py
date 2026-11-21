from tests.memory_turn_fixture import assessment_access
from tests.memory_turn_fixture import create_completed_user
import asyncio
import json
import pytest
from datetime import timedelta

from models.chat_session import ChatMessage
from models.fields import utc_now
from services import digital_person_memory as memory, digital_person_memory_index as index
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime


@pytest.mark.parametrize('failure', ['missing', 'changed'])
async def test_unreadable_sources_are_skipped_without_blocking_valid_batch(runtime, monkeypatch, failure):
    current, project, _ = runtime
    sid = (await current.main_session())['id']
    def seed(_):
        for name in ('bad', 'good'):
            create_completed_user(id=name, session=sid, role='user', status='completed',
                                  content=f'{name}独立记录', created_at=utc_now())
    await current.projects.run_db(project.id, seed)
    original = memory.read_projects
    async def read(*args, **kwargs):
        hits = await original(*args, **kwargs)
        if failure == 'missing':
            return [h for h in hits if 'bad' not in h['source_message_id']]
        return [{**h, 'source_hash':'changed'} if 'bad' in h['source_message_id'] else h for h in hits]
    monkeypatch.setattr(memory, 'read_projects', read)
    async def decide(context):
        await context['_load']()
        assert {m['id'] for m in context['conversation']} == {'good', 'fixture-reply-good'}
        return dict(decision='silent', summary='已处理有效来源', source_ids=[])
    monkeypatch.setattr(current, '_decide', decide)
    result = await current.check()
    assert result['status'] == 'silent', result
    assert result['memory_processing']['knowledge']['processed'] == 2
    with index.connect() as db:
        rows = list(db.execute('SELECT source_message_id,memory_status,pending_ready_at FROM memories'))
        assert all(r['memory_status']=='done' for r in rows if 'good' in r['source_message_id'])
        bad = [r for r in rows if 'bad' in r['source_message_id']]
        assert all(r['memory_status']=='pending' and r['pending_ready_at']>0 for r in bad)
        assert db.execute('SELECT count(*) FROM digital_reflections').fetchone()[0] == 2
    assert (await current._collect())['no_work'] is True


async def test_all_unavailable_sources_are_deferred_without_completion(runtime, monkeypatch):
    current, project, _ = runtime
    sid = (await current.main_session())['id']
    await current.projects.run_db(project.id, lambda _: create_completed_user(
        id='offline', session=sid, role='user', status='completed', content='暂时不可读', created_at=utc_now()))
    original = memory.read_projects
    async def read(*args, **kwargs):
        return []
    monkeypatch.setattr(memory, 'read_projects', read)
    assert (await current._collect())['no_work'] is True
    with index.connect() as db:
        assert db.execute('SELECT count(*) FROM digital_reflections').fetchone()[0] == 0
        assert db.execute("SELECT count(*) FROM memories WHERE memory_status='pending' AND pending_ready_at>0").fetchone()[0] == 2
    from services.memory_pending_queue import has_pending
    assert not await asyncio.to_thread(has_pending, [project.id])
    # Simulate expiration of the retry delay, then restore the source reader.
    with index.connect() as db:
        db.execute('UPDATE memories SET pending_ready_at=0')
    monkeypatch.setattr(memory, 'read_projects', original)
    recovered = await current._collect()
    assert {m['id'] for m in recovered['conversation']} == {'offline', 'fixture-reply-offline'}
    assert await asyncio.to_thread(has_pending, [project.id])


async def test_cli_lazily_reads_100_across_ten_conversations_once(runtime,monkeypatch):
    current,project,_=runtime
    base=utc_now()-timedelta(minutes=10)
    await current.mutate(lambda s:s.update(assessment_live_since=(base-timedelta(days=1)).isoformat()))
    def seed(_):
        sessions=[current.chats.create_session(project.id)['id'] for _ in range(10)]
        for number in range(1000):
            sid=sessions[(number//2)%10]
            row=ChatMessage.create(id=f'batch-{number}',session=sid,role='user' if number%2==0 else 'assistant',status='completed',
                content=f'第{number}条用户记录，独立证据。',created_at=base+timedelta(milliseconds=number))
            memory.capture_message(row,'local')
    await current.projects.run_db(project.id,seed)
    reads=[]
    original=memory.read_projects
    async def read(*args,**kwargs):
        reads.append(len(args[1]))
        return await original(*args,**kwargs)
    monkeypatch.setattr(memory,'read_projects',read)
    async def invoke(*args,**kwargs):
        from services import memory_query
        assert reads==[], 'source bodies must not be read before CLI pending'
        token=await assessment_access(current)
        first,again=await asyncio.gather(memory_query.pending(current.projects,token),memory_query.pending(current.projects,token))
        assert first==again
        assert len(first['conversations'])==10
        messages=[m for group in first['conversations'] for m in group['conversation']]
        assert len(messages)==100
        assert {m['id'] for m in messages}=={f'batch-{i}' for i in range(100)}
        assert sum(reads)==100
        mids=[messages[0]['memory_ids'][0],messages[-1]['memory_ids'][0]]
        return json.dumps({'decision':'silent','summary':'本批整理完成','source_ids':[],
            'memories':[{'summary':'跨会话的关联记录','kind':'fact','outcome':'stated','source_ids':mids}]}),[],'native'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    result=await current.check()
    assert result['status']=='silent',result
    assert result['memory_processing']['knowledge']['processed']==100
    with index.connect() as db:
        statuses=dict(db.execute('SELECT memory_status,count(*) FROM memories GROUP BY memory_status'))
    assert statuses=={'done':100,'pending':900}
    saved=(await current.state())['runs'][0]
    assert '条用户记录' not in json.dumps(saved,ensure_ascii=False)


async def test_failed_cli_assessment_releases_all_claimed_messages(runtime,monkeypatch):
    current,project,_=runtime
    sid=(await current.main_session())['id']
    def seed(_):
        row=create_completed_user(id='retry',session=sid,role='user',status='completed',content='待整理',created_at=utc_now())
        memory.capture_message(row,'local')
    await current.projects.run_db(project.id,seed)
    attempts=[]
    async def invoke(*args,**kwargs):
        from services import memory_query
        token=await assessment_access(current)
        payload=await memory_query.pending(current.projects,token)
        attempts.append((token,payload))
        return ('INVALID_RESULT' if len(attempts)<=2 else '{"decision":"silent","summary":"重试完成","source_ids":[]}'),[],'native'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    assert (await current.check())['status']=='failed'
    with index.connect() as db:
        assert db.execute('SELECT memory_status,pending_ready_at FROM memories').fetchone()[:]==('pending',0)
    assert (await current.check())['status']=='silent'
    assert len(attempts)==3
    assert attempts[0][0] is attempts[1][0]
    assert attempts[2][0] is not attempts[0][0]
    assert attempts[0][1]['conversation']==attempts[2][1]['conversation']
    with index.connect() as db:
        assert all(r[0]=='done' for r in db.execute('SELECT memory_status FROM memories'))


async def test_manual_run_during_automatic_run_keeps_active_batch(runtime,monkeypatch):
    import pytest
    from services import memory_query
    current,project,_=runtime
    sid=(await current.main_session())['id']
    await current.projects.run_db(project.id,lambda _:create_completed_user(id='single-run',session=sid,
        role='user',content='单例检查',created_at=utc_now()))
    entered=asyncio.Event();finish=asyncio.Event();calls=[]
    async def invoke(*args,**kwargs):
        context=await assessment_access(current)
        payload=await memory_query.pending(current.projects,context)
        calls.append((context,payload))
        entered.set()
        await finish.wait()
        return '{"decision":"silent","summary":"完成","source_ids":[]}',[],'native'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    active=asyncio.create_task(current.check(manual=False))
    try:
        await asyncio.wait_for(entered.wait(),3)
        with pytest.raises(ValueError,match='An\\ existing\\ check\\ is\\ in\\ progress'):
            await current.check(manual=True)
        assert len(calls)==1
        assert memory_query.assessment_observed(calls[0][0])
    finally:
        finish.set()
        result=await asyncio.wait_for(active,5)
    assert result['status']=='silent',result
    assert not current._check_lock.locked()


async def test_pending_excludes_current_and_old_thinking_sessions_even_if_indexed(runtime,monkeypatch):
    from services import memory_query
    from tests.test_digital_person_unified import seed
    current,project,_=runtime
    normal=await seed(current,project)
    checks=await current.projects.run_db(project.id,lambda _:[current.chats.create_session(project.id)['id'] for _ in range(2)])
    await current.mutate(lambda s:s.update(check_sessions=checks,check_session_id=checks[0]))
    def indexed_outputs(_):
        for number,sid in enumerate(checks):
            reply=ChatMessage.create(id='thinking-output-'+str(number),session=sid,role='assistant',
                status='completed',content='THINKING_OUTPUT_MUST_NOT_BE_REPROCESSED',created_at=utc_now())
            memory.capture_message(reply,'local')
    await current.projects.run_db(project.id,indexed_outputs)
    calls=[]
    async def invoke(*args,**kwargs):
        context=await assessment_access(current)
        payload=await memory_query.pending(current.projects,context)
        assert 'THINKING_OUTPUT_MUST_NOT_BE_REPROCESSED' not in json.dumps(payload)
        assert kwargs['system_prompt'].count('memory pending')==1
        calls.append(payload)
        return '{"decision":"silent","summary":"已整理真实消息","source_ids":[]}',[],'native'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    first=await current.check()
    assert first['status']=='silent',first
    assert {row['session_id'] for row in first['sources']['reflection_batch']}=={normal}
    again=await current.check()
    assert again['sources']['no_work']
    assert len(calls)==1


async def test_running_source_is_consolidated_without_work_reminder(runtime,monkeypatch):
    current,project,_=runtime
    sid=(await current.main_session())['id']
    base=utc_now()-timedelta(minutes=2)
    await current.mutate(lambda s:s.update(assessment_live_since=(base-timedelta(days=1)).isoformat()))
    def seed(_):
        row=ChatMessage.create(id='finished',session=sid,role='assistant',status='completed',content='等待用户确认',created_at=base)
        memory.capture_message(row,'local')
        ChatMessage.create(id='active',session=sid,role='assistant',status='running',content='',created_at=utc_now())
    await current.projects.run_db(project.id,seed)
    async def invoke(*args,**kwargs):
        from services import memory_query
        token=await assessment_access(current)
        await memory_query.pending(current.projects,token)
        return json.dumps({'decision':'notify','kind':'work','summary':'请确认','source_ids':['finished']}),[],'native'
    async def forbidden(*args,**kwargs):raise AssertionError('running work must not be reminded')
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    monkeypatch.setattr(current,'_notify',forbidden)
    result=await current.check()
    assert result['status']=='silent',result
    assert result['memory_processing']['knowledge']['processed']==1


async def test_lazy_source_read_does_not_block_event_loop(runtime,monkeypatch):
    import threading
    current,project,_=runtime
    sid=(await current.main_session())['id']
    await current.projects.run_db(project.id,lambda _:create_completed_user(
        id='slow-source',session=sid,role='user',status='completed',content='慢盘测试',created_at=utc_now()))
    entered=threading.Event();release=threading.Event()
    original=memory._hydrate
    def slow(*args,**kwargs):
        entered.set()
        assert release.wait(3)
        return original(*args,**kwargs)
    monkeypatch.setattr(memory,'_hydrate',slow)
    async def invoke(*args,**kwargs):
        from services import memory_query
        token=await assessment_access(current)
        await memory_query.pending(current.projects,token)
        return json.dumps({'decision':'silent','summary':'完成','source_ids':[]}),[],'native'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    task=asyncio.create_task(current.check())
    try:
        assert await asyncio.to_thread(entered.wait,2)
        await asyncio.wait_for(asyncio.sleep(.01),.05)
        assert not task.done()
    finally:
        release.set()
    assert (await task)['status']=='silent'
