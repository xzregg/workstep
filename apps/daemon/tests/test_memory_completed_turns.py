from datetime import timedelta

import pytest
from models.chat_session import ChatMessage
from models.fields import utc_now
from services import digital_person_memory as memory, digital_person_memory_index as index
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime


@pytest.mark.parametrize('status',['running','queued','stopped','error'])
async def test_incomplete_reply_never_indexes_user_or_partial_assistant(runtime,status):
    current,project,_=runtime
    sid=(await current.main_session())['id']
    now=utc_now()
    def seed(_):
        user=ChatMessage.create(id='u',session=sid,role='user',content='请执行',created_at=now)
        assistant=ChatMessage.create(id='a',session=sid,role='assistant',content='执行了一半',status=status,created_at=now+timedelta(microseconds=1))
        memory.capture_message(user,'local')
        memory.capture_message(assistant,'local')
    await current.projects.run_db(project.id,seed)
    with index.connect() as db:
        assert db.execute('SELECT count(*) FROM memories').fetchone()[0]==0


async def test_completion_captures_exact_turn_and_replay_is_idempotent(runtime):
    current,project,_=runtime
    sid=(await current.main_session())['id']
    now=utc_now()
    def seed(_):
        for i in range(2):
            ChatMessage.create(id=f'u{i}',session=sid,role='user',content=f'问题{i}',created_at=now+timedelta(seconds=i*2))
            ChatMessage.create(id=f'a{i}',session=sid,role='assistant',content=f'回复{i}',status='running',created_at=now+timedelta(seconds=i*2+1))
        ChatMessage.update(status='succeeded',ended_at=now+timedelta(seconds=5)).where(ChatMessage.id=='a0').execute()
        memory.capture_message(ChatMessage.get_by_id('a0'),'local')
        memory.capture_message(ChatMessage.get_by_id('a0'),'local')
    await current.projects.run_db(project.id,seed)
    with index.connect() as db:
        assert {r[0] for r in db.execute('SELECT source_message_id FROM memories')}=={'u0','a0'}
        times={r[0] for r in db.execute("SELECT json_extract(source_metadata_json,'$.activity_time') FROM memories")}
        assert times=={(now+timedelta(seconds=5)).isoformat()}


async def test_check_does_not_backfill_unindexed_project_messages(runtime,monkeypatch):
    current,project,_=runtime
    sid=(await current.main_session())['id']
    now=utc_now()
    def seed(_):
        ChatMessage.create(id='u',session=sid,role='user',content='早先的问题',created_at=now-timedelta(hours=1))
        ChatMessage.create(id='a',session=sid,role='assistant',content='完整回复',status='succeeded',created_at=now-timedelta(minutes=59))
    await current.projects.run_db(project.id,seed)
    async def forbidden(*args,**kwargs):raise AssertionError('no indexed work must not start model')
    monkeypatch.setattr(current,'_decide',forbidden)
    assert (await current.check())['sources']['no_work']
    with index.connect() as db:
        assert db.execute('SELECT count(*) FROM memories').fetchone()[0]==0


async def test_start_does_not_schedule_project_backfill(runtime):
    import asyncio
    current,project,_=runtime
    sid=(await current.main_session())['id']
    await current.projects.run_db(project.id,lambda _:ChatMessage.create(
        id='unindexed-complete',session=sid,role='assistant',content='旧回复',status='completed',created_at=utc_now()))
    try:
        await current.start()
        await asyncio.sleep(.05)
        with index.connect() as db:
            assert db.execute('SELECT count(*) FROM memories').fetchone()[0]==0
    finally:
        await current.shutdown()


async def test_task_index_failure_does_not_fail_business_completion(runtime,monkeypatch):
    from services.digital_person_memory import capture_task_completion
    current,project,_=runtime
    def broken(*args):raise OSError('simulated memory database failure')
    monkeypatch.setattr(memory,'capture_task_message',broken)
    await current.projects.run_db(project.id,lambda _:capture_task_completion(project.id,object()))


@pytest.mark.parametrize('index_failure',[False,True])
async def test_execution_finish_indexes_directly_in_worker_without_blocking_loop(runtime,monkeypatch,index_failure):
    import asyncio
    import threading
    from types import SimpleNamespace
    from models import Message,Task
    from services.messages import StepEventProgress
    from services.step_execution_messages import StepExecutionMessages
    current,project,_=runtime
    def seed(_):
        Task.create(id='work',title='任务',cwd=str(project.path),created_at=utc_now(),updated_at=utc_now())
        Message.create(id='result',task='work',step_key='build',role='assistant',position=1,
                       run_status='running',content='',created_at=utc_now())
    await current.projects.run_db(project.id,seed)
    async def run_db(operation):return await current.projects.run_db(project.id,lambda _:operation())
    entered=threading.Event();release=threading.Event()
    original=memory.capture_task_message
    def capture(*args):
        entered.set()
        assert release.wait(3)
        if index_failure:raise OSError('simulated indexing failure')
        return original(*args)
    monkeypatch.setattr(memory,'capture_task_message',capture)
    snapshot={'content':'完整任务结果','events_json':'[]','event_summary_json':'{}','event_count':0,'last_event_seq':0}
    service=StepExecutionMessages(SimpleNamespace(finish=lambda _:None),run_db,None,lambda _:snapshot,None,
                                  {},{},None,{},project_id=project.id)
    task=asyncio.create_task(service.finish(message_id='result',journal_ref=None,event_progress=StepEventProgress(),
                                          succeeded=True,cancelled=False,ended_at=utc_now()))
    try:
        assert await asyncio.to_thread(entered.wait,2)
        await asyncio.wait_for(asyncio.sleep(.01),.05)
        assert not task.done()
    finally:
        release.set()
    assert (await task).status=='succeeded'
    with index.connect() as db:
        assert db.execute('SELECT count(*) FROM memories').fetchone()[0]==(0 if index_failure else 1)


async def test_real_chat_persistence_indexes_only_after_engine_finishes(runtime,monkeypatch):
    import asyncio
    current,project,_=runtime
    entered=asyncio.Event();release=asyncio.Event()
    async def invoke(*args,**kwargs):
        entered.set()
        await release.wait()
        return '完整回复',[],'native'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    sid=(await current.main_session())['id']
    accepted=await current.projects.run_db(project.id,lambda _:current.chats.submit_message(
        project.id,sid,'用户问题','completed-turn-test',schedule=False))
    current.chats.start_queued_turn(accepted.turn_id)
    await asyncio.wait_for(entered.wait(),2)
    with index.connect() as db:
        assert db.execute('SELECT count(*) FROM memories').fetchone()[0]==0
    release.set()
    for _ in range(200):
        status=await current.projects.run_db(project.id,lambda _:ChatMessage.get_by_id(accepted.assistant_message_id).status)
        if status=='succeeded':
            break
        await asyncio.sleep(.01)
    assert status=='succeeded'
    with index.connect() as db:
        assert {r[0] for r in db.execute('SELECT source_message_id FROM memories')}=={
            await current.projects.run_db(project.id,lambda _:ChatMessage.select().where(ChatMessage.session==sid,ChatMessage.role=='user').get().id),accepted.assistant_message_id}


async def test_equal_timestamps_use_insertion_order_to_pair_messages(runtime):
    current,project,_=runtime
    sid=(await current.main_session())['id']
    now=utc_now()
    def seed(_):
        for mid,role in [('z-user','user'),('a-reply','assistant'),('y-user','user'),('b-reply','assistant')]:
            ChatMessage.create(id=mid,session=sid,role=role,content=mid,status='completed' if mid=='a-reply' else 'running' if role=='assistant' else None,created_at=now)
        memory.capture_message(ChatMessage.get_by_id('a-reply'),'local')
    await current.projects.run_db(project.id,seed)
    with index.connect() as db:
        assert {r[0] for r in db.execute('SELECT source_message_id FROM memories')}=={'z-user','a-reply'}
