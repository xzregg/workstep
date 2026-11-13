import asyncio
import pytest
from tests.test_chat_session import chat_module

@pytest.fixture
async def runtime(chat_module, monkeypatch):
    from services.digital_person_runtime import DigitalPersonRuntime
    from services import customization_workspace
    module, bus, manager, project, store = chat_module
    async def home(_): return project
    monkeypatch.setattr(customization_workspace, 'ensure_default_workspace', home)
    monkeypatch.setattr(customization_workspace, 'is_default_workspace', lambda p: p.id == project.id)
    monkeypatch.setattr('services.digital_person.config_store', store)
    store.set('digital_person', {'enabled': True})
    return DigitalPersonRuntime(manager, module, None, bus), project, store

async def test_main_session_stable_concurrent_and_recreated_after_archive(runtime):
    runtime, project, _ = runtime
    rows = await asyncio.gather(*(runtime.main_session() for _ in range(5)))
    assert len({row['id'] for row in rows}) == 1
    from models.chat_session import ChatSession
    await runtime.projects.run_db(project.id, lambda _: ChatSession.update(archived=True).where(ChatSession.id == rows[0]['id']).execute())
    assert (await runtime.main_session())['id'] != rows[0]['id']

async def test_feedback_is_idempotent_and_negative_earns_no_experience(runtime):
    runtime, project, _ = runtime
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    row = await runtime.main_session()
    await runtime.projects.run_db(project.id, lambda _: ChatMessage.create(id='answer',session=row['id'],role='assistant',status='completed',content='done',created_at=utc_now()))
    assert (await runtime.overview())['experience'] == 1
    await runtime.feedback('answer', -1)
    await runtime.feedback('answer', -1)
    assert (await runtime.overview())['experience'] == 0
    await runtime.feedback('answer', 1)
    assert (await runtime.overview())['experience'] == 1

async def test_proactive_silent_no_send_and_disabled_does_not_run(runtime, monkeypatch):
    runtime, _, store = runtime
    store.set('digital_person', {'enabled': False, 'proactive_enabled': True})
    with pytest.raises(ValueError):
        await runtime.check()
    store.set('digital_person', {'enabled': True, 'proactive_enabled': True})
    async def decide(context): return {'decision':'silent','summary':'没有新结果','source_ids':[]}
    monkeypatch.setattr(runtime, '_decide', decide)
    run = await runtime.check()
    assert run['status'] == 'silent'
    assert not run.get('deliveries')
    assert (await runtime.state())['runs'][0]['id'] == run['id']

async def test_proactive_rejects_unknown_sources(runtime, monkeypatch):
    runtime, _, _ = runtime
    async def decide(context): return {'decision':'notify','summary':'伪造结果','source_ids':['unknown']}
    monkeypatch.setattr(runtime, '_decide', decide)
    run = await runtime.check()
    assert run['status'] == 'failed'
    assert not run.get('deliveries')

async def test_real_checker_uses_separate_archived_session_and_bounded_context(runtime, monkeypatch):
    runtime, project, _ = runtime
    main = await runtime.main_session()
    calls=[]
    async def invoke(engine, model, cwd, prompt, *args, **kwargs):
        calls.append((prompt,kwargs))
        return '{"decision":"silent","summary":"无新增结果","source_ids":[]}', [], 'check-thread'
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    run=await runtime.check()
    assert run['status']=='silent',run
    from models.chat_session import ChatSession
    sessions=await runtime.projects.run_db(project.id, lambda _: [(r.id,r.archived) for r in ChatSession.select()])
    assert (main['id'],False) in sessions
    assert len([sid for sid,archived in sessions if archived and sid!=main['id']])==1
    assert len(calls)==1
    assert len(calls[0][0])<20000
    assert (await runtime._collect())['messages']==[]

async def test_completed_delegation_notifies_once_and_preserves_source(runtime, monkeypatch):
    runtime, project, _ = runtime
    main=await runtime.main_session()
    item={'id':'work','project_id':project.id,'session_id':'worker','message_id':'result','origin_session_id':main['id'],'status':'running','notified':False}
    await runtime.mutate(lambda s:s['delegations'].append(item))
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    await runtime.projects.run_db(project.id,lambda _:ChatMessage.create(id='result',session=main['id'],role='assistant',status='completed',content='检查通过',created_at=utc_now()))
    async def decide(context):
        if context['delegations']: return {'decision':'notify','summary':'检查已完成','source_ids':['work']}
        return {'decision':'silent','summary':'无变化','source_ids':[]}
    monkeypatch.setattr(runtime,'_decide',decide)
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:[])
    run=await runtime.check()
    assert run['status']=='notified',run
    assert run['deliveries'][0]['session_id']==main['id']
    assert (await runtime.check())['status']=='silent'
    count=await runtime.projects.run_db(project.id,lambda _:ChatMessage.select().where(ChatMessage.content=='检查已完成').count())
    assert count==1

async def test_quiet_time_defers_and_keeps_pending_work(runtime,monkeypatch):
    runtime, _, store=runtime
    from datetime import datetime
    hour=datetime.now().astimezone().hour
    store.set('digital_person',{'enabled':True,'proactive_enabled':True,'quiet_start':hour,'quiet_end':(hour+1)%24})
    async def collect():return {'messages':[],'delegations':[{'id':'work','status':'completed','result':'done'}]}
    async def decide(_):return {'decision':'notify','summary':'done','source_ids':['work']}
    monkeypatch.setattr(runtime,'_collect',collect);monkeypatch.setattr(runtime,'_decide',decide)
    run=await runtime.check(manual=False)
    assert run['status']=='deferred'
    assert run['deliveries']==[]

async def test_runtime_api_stays_responsive_under_slow_database(runtime,monkeypatch):
    import threading
    import main
    from fastapi import FastAPI
    from api.digital_person import router
    from httpx import AsyncClient,ASGITransport
    from services import digital_person_runtime as service
    runtime, _, _=runtime
    monkeypatch.setattr(main,'digital_person_runtime',runtime)
    entered,release=threading.Event(),threading.Event()
    original=service.read_state
    def slow(pid):
        entered.set();assert release.wait(3);return original(pid)
    monkeypatch.setattr(service,'read_state',slow)
    app=FastAPI();app.include_router(router)
    @app.get('/health')
    async def health():return {'ok':True}
    async with AsyncClient(transport=ASGITransport(app),base_url='http://test') as client:
        pending=asyncio.create_task(client.get('/api/digital-person/activity'))
        try:
            assert await asyncio.to_thread(entered.wait,2)
            assert (await asyncio.wait_for(client.get('/health'),.3)).status_code==200
        finally:release.set()
        assert (await pending).status_code==200

async def test_runtime_api_host_scope_rejects_project_identity(runtime,monkeypatch):
    import main
    from fastapi import FastAPI
    from api.digital_person import router
    from httpx import AsyncClient,ASGITransport
    from services.remote_access import ActorSnapshot,actor_context
    runtime, _, _=runtime;monkeypatch.setattr(main,'digital_person_runtime',runtime)
    app=FastAPI();app.include_router(router)
    actor=ActorSnapshot(actor_id='u',user_name='u',device_id='d',device_name='d',source='remote_project',project_id='other',access_level='edit')
    with actor_context(actor):
        async with AsyncClient(transport=ASGITransport(app),base_url='http://test') as client:
            assert (await client.get('/api/digital-person/activity')).status_code==403
            assert (await client.post('/api/digital-person/check')).status_code==403

async def test_delegate_returns_before_work_finishes_and_deduplicates(runtime,monkeypatch,tmp_path):
    runtime, home, _=runtime
    target=await asyncio.to_thread(runtime.projects.init_project,tmp_path/'execution')
    release=asyncio.Event()
    async def invoke(*args,**kwargs):
        await release.wait()
        return '任务完成',[], 'worker-thread'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    first=await asyncio.wait_for(runtime.delegate(target.id,'修改演示文件',request_id='same-request'),1)
    again=await runtime.delegate(target.id,'修改演示文件',request_id='same-request')
    assert again['session_id']==first['session_id']
    assert first['status']=='running'
    assert first['session_id']!=(await runtime.main_session())['id']
    release.set()
    from models.chat_session import ChatMessage
    async with asyncio.timeout(2):
        while True:
            status=await runtime.projects.run_db(target.id,lambda _:ChatMessage.get_by_id(first['message_id']).status)
            if status in ('completed','succeeded'):break
            if status in ('error','failed','stopped'):
                detail=await runtime.projects.run_db(target.id,lambda _:ChatMessage.get_by_id(first['message_id']).content)
                pytest.fail(f'{status}: {detail}')
            await asyncio.sleep(.01)
    await runtime._collect()
    assert (await runtime.state())['delegations'][0]['status']=='completed'

async def test_failed_local_delivery_does_not_block_channels_and_retry_skips_success(runtime,monkeypatch):
    runtime, project, _=runtime
    main=await runtime.main_session()
    from models.chat_session import ChatSession
    await runtime.projects.run_db(project.id,lambda _:ChatSession.update(archived=True).where(ChatSession.id==main['id']).execute())
    await runtime.mutate(lambda s:s['delegations'].append({'id':'work','origin_session_id':main['id']}))
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:[{'id':'peer','notify':True}])
    sent=[]
    async def send(*args):sent.append(args);return {'message_id':'remote'}
    monkeypatch.setattr('services.digital_person_channels.send_binding',send)
    receipts=await runtime._notify('done',['work'],'run')
    assert [r['status'] for r in receipts]==['failed','delivered']
    await runtime.mutate(lambda s:s['runs'].append({'id':'run','status':'delivery_failed','summary':'done','deliveries':receipts}))
    await runtime.projects.run_db(project.id,lambda _:ChatSession.update(archived=False).where(ChatSession.id==main['id']).execute())
    run=await runtime.retry_delivery('run')
    assert run['status']=='notified'
    assert len(sent)==1

async def test_retry_only_failed_channel(runtime,monkeypatch):
    runtime, _, _=runtime
    await runtime.mutate(lambda s:s['runs'].append({'id':'run','status':'delivery_failed','summary':'done','deliveries':[
        {'kind':'channel','binding_id':'ok','status':'delivered'}, {'kind':'channel','binding_id':'retry','status':'failed'}]}))
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:[{'id':'retry','notify':True}])
    sent=[]
    async def send(_,binding,text):sent.append(binding['id']);return {'message_id':'result'}
    monkeypatch.setattr('services.digital_person_channels.send_binding',send)
    assert (await runtime.retry_delivery('run'))['status']=='notified'
    assert sent==['retry']
    with pytest.raises(ValueError):await runtime.retry_delivery('run')

async def test_channel_result_only_notifies_its_origin_peer(runtime,monkeypatch):
    runtime, _, _=runtime
    origin=(await runtime.main_session())['id']
    await runtime.mutate(lambda s:s['delegations'].append({'id':'work','origin_session_id':origin}))
    class Bots:
        async def _load(self):return {'sessions':{'a:single:one':origin,'b:single:two':'other'},'session_sources':{origin:{'project_id':'home'}}}
    runtime.bots=Bots()
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:[
        {'id':'old','bot_id':'a','conversation_type':'single','conversation_id':'one','notify':True},
        {'id':'other','bot_id':'b','conversation_type':'single','conversation_id':'two','notify':True}])
    sent=[]
    async def send(_,binding,text):sent.append(binding['bot_id']);return {}
    monkeypatch.setattr('services.digital_person_channels.send_binding',send)
    await runtime._notify('仅给发起人',['work'],'run')
    assert sent==['a']

async def test_check_sources_are_isolated_and_rotate_between_initiators(runtime):
    runtime, project, _=runtime
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    first=(await runtime.main_session())['id']
    second=await runtime.projects.run_db(project.id,lambda _:runtime.chats.create_session(project.id))
    def seed(_):
        for sid,text in ((first,'甲的私有要求'),(second['id'],'乙的私有要求')):
            ChatMessage.create(id=sid+'-user',session=sid,role='user',status='completed',content=text,created_at=utc_now())
            ChatMessage.create(id=sid+'-answer',session=sid,role='assistant',status='completed',content=text+'已完成',created_at=utc_now())
    await runtime.projects.run_db(project.id,seed)
    await runtime.mutate(lambda s:s['delegations'].extend([
        {'id':sid,'project_id':project.id,'session_id':sid,'origin_session_id':sid,'message_id':sid+'-answer','notified':False}
        for sid in (first,second['id'])]))
    a=await runtime._collect();b=await runtime._collect()
    assert [d['id'] for d in a['delegations']]==[first]
    assert [d['id'] for d in b['delegations']]==[second['id']]
    assert [m['content'] for m in a['messages']]==['甲的私有要求']
    assert [m['content'] for m in b['messages']]==['乙的私有要求']


@pytest.mark.parametrize("reply,expected", [
    ("", "未返回检查结果"),
    ("   ", "未返回检查结果"),
    ("暂时没有需要通知的事项。", "不是有效的 JSON"),
    ("[]", "结果结构无效"),
    ("null", "结果结构无效"),
    ('{"decision":"silent","summary":"无变化","source_ids":[{}]}', "结果结构无效"),
])
async def test_checker_rejects_empty_or_invalid_model_output_with_actionable_error(runtime, monkeypatch, reply, expected):
    runtime, _, _ = runtime
    async def invoke(*args, **kwargs):
        return reply, [], "check-thread"
    monkeypatch.setattr("agent_assistants.base.invoke_engine", invoke)
    run=await runtime.check()
    assert run["status"]=="failed"
    assert expected in run["error"]
    assert "Expecting value" not in run["error"]
    assert run["deliveries"]==[]
    assert (await runtime.state())["cursor"]==""
    assert runtime._active_check is None


@pytest.mark.parametrize("fence", ["json", "JSON", ""])
async def test_checker_accepts_fenced_json_without_changing_notification_policy(runtime, monkeypatch, fence):
    runtime, _, _ = runtime
    async def invoke(*args, **kwargs):
        return '```'+fence+'\n{"decision":"silent","summary":"无变化","source_ids":[]}\n```', [], "check-thread"
    monkeypatch.setattr("agent_assistants.base.invoke_engine", invoke)
    run=await runtime.check()
    assert run["status"]=="silent",run
    assert run["deliveries"]==[]


async def test_identity_snapshot_matches_overview_and_excludes_check_sessions(runtime, monkeypatch):
    from services.digital_person_statistics import load_identity_snapshot
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    from types import SimpleNamespace
    runtime, project, _=runtime
    main=await runtime.main_session()
    def seed(_):
        second=runtime.chats.create_session(project.id,title="第二个会话")
        checker=runtime.chats.create_session(project.id,title="检查器")
        for mid,sid,role in [("u-main",main['id'],"user"),("u-second",second['id'],"user"),("u-check",checker['id'],"user"),
                ("a-main",main['id'],"assistant"),("a-voted",main['id'],"assistant"),("a-second",second['id'],"assistant"),("a-check",checker['id'],"assistant")]:
            ChatMessage.create(id=mid,session=sid,role=role,status="completed",content="测试",created_at=utc_now())
        return checker['id']
    checker=await runtime.projects.run_db(project.id,seed)
    await runtime.mutate(lambda state:state.update(check_sessions=[checker],feedback={"a-voted":-1},delegations=[{"status":"completed"},{"status":"running"}]))
    monkeypatch.setattr("services.digital_person_statistics.skill_center.runtime_selection",lambda _:SimpleNamespace(enabled=[SimpleNamespace(skill_id="skill-a",name="代码评审",valid=True,conflict=False,sync_error=None)]))
    snapshot=await load_identity_snapshot(runtime.projects,project)
    assert snapshot['session_count']==2
    assert snapshot['reply_count']==3
    assert snapshot['task_count']==2
    assert snapshot['completed_task_count']==1
    assert snapshot['experience']==3  # 3 replies - 1 negative + 1 completed task
    assert snapshot['skills']==[{"id":"skill-a","name":"代码评审"}]
    overview=await runtime.overview()
    assert all(overview[key]==value for key,value in snapshot.items())


@pytest.mark.parametrize("channel",[False,True])
async def test_digital_status_is_refreshed_in_system_prompt_on_each_turn(runtime, monkeypatch,channel):
    runtime, project, _=runtime
    if channel:
        from agent_assistants.channel_chat import ChannelChatModule
        runtime.chats=ChannelChatModule(runtime.bus,runtime.projects,register=False)
    main=await runtime.main_session()
    monkeypatch.setattr("services.digital_person_statistics.enabled_skills",lambda _:[{"id":"review","name":"代码评审"}])
    calls=[]
    async def invoke(*args, **kwargs):
        calls.append(kwargs.get('system_prompt',''))
        return "收到", [], "native-digital"
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    for index in range(2):
        accepted=await runtime.projects.run_db(project.id,lambda _:runtime.chats.submit_message(project.id,main['id'],"你的状态是什么？",f"status-{index}",schedule=False))
        runtime.chats.start_queued_turn(accepted.turn_id)
        await runtime.chats.await_turn(accepted.turn_id,timeout=5)
    assert '等级：Lv.1；经验：0' in calls[0]
    assert '等级：Lv.1；经验：1' in calls[1]
    assert all('接待会话：1' in prompt and '代码评审' in prompt for prompt in calls)


async def test_slow_skill_discovery_does_not_block_activity_api(runtime,monkeypatch):
    import main,threading
    from fastapi import FastAPI
    from api.digital_person import router
    from httpx import AsyncClient,ASGITransport
    runtime, _, _=runtime
    monkeypatch.setattr(main,'digital_person_runtime',runtime)
    entered,release=threading.Event(),threading.Event()
    def slow(_):
        entered.set();assert release.wait(3);return []
    monkeypatch.setattr('services.digital_person_statistics.enabled_skills',slow)
    app=FastAPI();app.include_router(router)
    @app.get('/health')
    async def health():return {'ok':True}
    async with AsyncClient(transport=ASGITransport(app),base_url='http://test') as client:
        pending=asyncio.create_task(client.get('/api/digital-person/activity'))
        try:
            assert await asyncio.to_thread(entered.wait,2)
            assert (await asyncio.wait_for(client.get('/health'),.3)).status_code==200
        finally:release.set()
        assert (await pending).status_code==200

async def test_checker_reuses_workstep_session_but_resets_engine_context_each_time(runtime, monkeypatch):
    runtime, project, _ = runtime
    from models.chat_session import ChatSession, ChatMessage
    calls = []
    async def invoke(engine, model, cwd, prompt, session_id, *args, **kwargs):
        calls.append((prompt, session_id, kwargs.get('message_history')))
        return '{"decision":"silent","summary":"done","source_ids":[]}', [], f'engine-{len(calls)}'
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    await runtime._decide({'first_only_secret': 'first'})
    first = (await runtime.state())['check_sessions'][-1]
    await runtime._decide({'second_only': 'second'})
    state = await runtime.state()
    assert state['check_sessions'] == [first]
    assert state['check_session_id'] == first
    assert len(calls) == 2
    assert calls[0][1:] == (None, None)
    assert calls[1][1:] == (None, None)
    assert 'first_only_secret' not in calls[1][0]
    assert 'second_only' in calls[1][0]
    assert '/new' not in calls[1][0]
    def inspect(_):
        assert ChatSession.select().count() == 1
        assert ChatMessage.select().where(ChatMessage.session == first).count() == 4
        assert ChatSession.get_by_id(first).engine_session_id == 'engine-2'
        assert runtime.chats.list_sessions(project.id, archived=True) == []
    await runtime.projects.run_db(project.id, inspect)


async def test_checker_adopts_legacy_session_and_archive_keeps_user_conversations(runtime, monkeypatch):
    runtime, project, _ = runtime
    from models.chat_session import ChatSession
    def seed(_):
        old = [runtime.chats.create_session(project.id, title='主动检查')['id'] for _ in range(2)]
        user = runtime.chats.create_session(project.id, title='主动检查')['id']
        ChatSession.update(archived=True).execute()
        return old, user
    old, user = await runtime.projects.run_db(project.id, seed)
    await runtime.mutate(lambda state: state.update(check_sessions=old))
    async def invoke(*args, **kwargs):
        return '{"decision":"silent","summary":"done","source_ids":[]}', [], 'fresh'
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    await runtime._decide({})
    state = await runtime.state()
    assert state['check_session_id'] == old[-1]
    assert state['check_sessions'] == old
    rows = await runtime.projects.run_db(project.id, lambda _: runtime.chats.list_sessions(project.id, archived=True))
    assert [row['id'] for row in rows] == [user]

async def test_archive_internal_session_filter_keeps_api_responsive_during_slow_state_read(runtime, monkeypatch):
    import threading
    import main
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from api.chat_session import router
    from services import digital_person_runtime as service
    runtime, project, _ = runtime
    monkeypatch.setattr(main, 'chat_session_module', runtime.chats)
    monkeypatch.setattr(main, 'project_manager', runtime.projects)
    entered, release = threading.Event(), threading.Event()
    original = service.read_state
    def slow(project_id):
        entered.set()
        assert release.wait(3)
        return original(project_id)
    monkeypatch.setattr(service, 'read_state', slow)
    app = FastAPI()
    app.include_router(router)
    @app.get('/health')
    async def health():
        return {'ok': True}
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        pending = asyncio.create_task(client.get('/api/chat-sessions', params={'project_id': project.id, 'archived': True}))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            assert (await asyncio.wait_for(client.get('/health'), .3)).status_code == 200
        finally:
            release.set()
        response = await pending
        assert response.status_code == 200
        assert response.json()['sessions'] == []
