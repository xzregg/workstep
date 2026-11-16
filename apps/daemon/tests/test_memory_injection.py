from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime

async def test_ordinary_project_chat_gets_tools_without_automatic_history_each_turn(runtime,tmp_path,monkeypatch):
    import asyncio
    from services import digital_person_memory as memory
    current, home, _ = runtime
    project = await asyncio.to_thread(current.projects.init_project,tmp_path/'ordinary')
    sid = await current.projects.run_db(project.id,lambda _:current.chats.create_session(project.id)['id'])
    calls = []
    async def invoke(*args,**kwargs):
        calls.append(kwargs)
        return '收到',[],'thread'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    for i,text in enumerate(['北辰项目发布必须检查数据库迁移。','北辰发布注意什么？']):
        turn = await current.projects.run_db(project.id,lambda _:current.chats.submit_message(project.id,sid,text,str(i),schedule=False))
        current.chats.start_queued_turn(turn.turn_id)
        await current.chats.await_turn(turn.turn_id,timeout=5)
    assert '数据库迁移' not in calls[-1].get('system_prompt','')
    assert 'Relevant memories' not in calls[-1].get('system_prompt','')
    assert 'memory_token=' not in calls[-1].get('system_prompt','')
    assert not calls[-1].get('system_prompt_each_turn')

async def test_task_context_uses_shared_memory_and_task_bound_scope(runtime,monkeypatch):
    from services import digital_person_memory as memory
    from tests.test_memory_workflow_sources import seed_task
    from models import Task
    current,project,_ = runtime
    await seed_task(current,project)
    calls = []
    async def context(projects,scope,query,**kwargs):
        calls.append((scope,kwargs))
        return 'memory prompt'
    monkeypatch.setattr(memory,'context_prompt',context)
    assert await memory.task_context_prompt(current.projects,project.id,'task-memory','发布') == 'memory prompt'
    assert calls[-1][0] == 'local'
    await current.projects.run_db(project.id,lambda _:Task.update(creator_id='channel:telegram:peer').execute())
    await memory.task_context_prompt(current.projects,project.id,'task-memory','发布')
    assert calls[-1][0] == 'task:task-memory'
    assert calls[-1][1]['project_ids'] == [project.id]


from tests.test_api_contracts import api_context
from tests.test_task_workflow_execution import scenario

async def test_real_task_runner_injects_shared_memory_on_initial_and_resume(scenario,monkeypatch):
    from types import SimpleNamespace
    from services import digital_person_memory as memory
    from models import Message
    from models.fields import utc_now
    s = scenario
    monkeypatch.setattr('services.digital_person.get_profile',lambda:SimpleNamespace(enabled=True))
    def seed(project):
        message = Message.create(id='prior-memory',task=s.task_id,step_key='requirements',role='assistant',
            content='REQUIREMENT_CONTEXT release requires migration rehearsal.',run_status='succeeded',
            position=1,created_at=utc_now(),ended_at=utc_now())
        memory.capture_task_message(project.id,message)
    await s.db(seed)
    assert await s.start() == 'completed'
    calls = s.script.select(channel='execution')
    assert calls and all('memory_token=' not in call['prompt'] for call in calls)
    assert 'Relevant memories' not in calls[0]['prompt']
    await s.start('requirements')
    resumed = [call for call in s.script.select(channel='execution') if call['resumed']]
    assert resumed and all('memory_token=' not in call['prompt'] for call in resumed)


async def test_memory_sqlite_contention_degrades_chat_without_blocking_loop(runtime,monkeypatch):
    import asyncio
    import sqlite3
    from services import digital_person_memory as memory, digital_person_memory_index as index
    current,project,_ = runtime
    sid = (await current.main_session())['id']
    await asyncio.to_thread(index.read_state,'initialize')
    def acquire():
        connection = sqlite3.connect(index.database_path(),check_same_thread=False)
        connection.execute('BEGIN EXCLUSIVE')
        return connection
    connection = await asyncio.to_thread(acquire)
    monkeypatch.setattr(memory,'MEMORY_CONTEXT_TIMEOUT',.02)
    calls=[]
    async def invoke(*args,**kwargs):
        calls.append(kwargs.get('system_prompt',''))
        return 'continued',[],'thread'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    async def release():
        await asyncio.sleep(.12)
        await asyncio.to_thread(connection.rollback)
        await asyncio.to_thread(connection.close)
    release_task=asyncio.create_task(release())
    try:
        turn=await current.projects.run_db(project.id,lambda _:current.chats.submit_message(project.id,sid,'北辰发布','lock-test',schedule=False))
        current.chats.start_queued_turn(turn.turn_id)
        started=asyncio.get_running_loop().time()
        await asyncio.sleep(.01)
        assert asyncio.get_running_loop().time()-started < .08
        await current.chats.await_turn(turn.turn_id,timeout=5)
        assert calls and 'memory_token=' not in calls[0]
        assert 'Relevant memories' not in calls[0]
    finally:
        await release_task


async def test_chat_and_task_preparation_never_search_raw_or_derived_history(runtime,monkeypatch):
    import pytest
    from services import digital_person_memory as memory, memory_knowledge
    from tests.test_memory_workflow_sources import seed_task
    current,project,_=runtime
    sid=(await current.main_session())['id']
    await seed_task(current,project)
    async def forbidden(*args,**kwargs):pytest.fail('history must be searched explicitly by a tool')
    def forbidden_scan(*args,**kwargs):pytest.fail('no foreground history rescan')
    monkeypatch.setattr(memory,'recall_projects',forbidden)
    monkeypatch.setattr(memory_knowledge,'recall_prompt',forbidden)
    monkeypatch.setattr(memory,'capture_session',forbidden_scan)
    scope,hits,prompt=await memory.prepare_chat_context(current.projects,project.id,sid,'以前说过什么','message')
    assert scope=='local' and hits==[] and 'memory_token=' not in prompt
    assert 'memory_token=' not in await memory.task_context_prompt(current.projects,project.id,'task-memory','以前说过什么')
