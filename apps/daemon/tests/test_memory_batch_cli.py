from tests.memory_turn_fixture import create_completed_user
import asyncio
import json
from datetime import timedelta

from models.chat_session import ChatMessage
from models.fields import utc_now
from services import digital_person_memory as memory, digital_person_memory_index as index
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime


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
        token=kwargs['system_prompt'].split('Pass memory_token=',1)[1].split(' ',1)[0]
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
    async def invoke(*args,**kwargs):
        from services import memory_query
        token=kwargs['system_prompt'].split('Pass memory_token=',1)[1].split(' ',1)[0]
        await memory_query.pending(current.projects,token)
        return 'INVALID_RESULT',[],'native'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    assert (await current.check())['status']=='failed'
    with index.connect() as db:
        assert db.execute('SELECT memory_status,pending_ready_at FROM memories').fetchone()[:]==('pending',0)


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
        token=kwargs['system_prompt'].split('Pass memory_token=',1)[1].split(' ',1)[0]
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
        token=kwargs['system_prompt'].split('Pass memory_token=',1)[1].split(' ',1)[0]
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
