import pytest
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime
from models.chat_session import ChatMessage
from tests.memory_turn_fixture import create_completed_user, create_completed_reply

async def test_owner_proactive_uses_main_and_selected_channels_once(runtime,monkeypatch):
    current,project,_=runtime
    main=(await current.main_session())['id']
    origin=await current.projects.run_db(project.id,lambda _:current.chats.create_session(project.id)['id'])
    await current.mutate(lambda state:state['runs'].append({'id':'run','trigger':'interval','kind':'social',
        'origin_session_id':origin,'sources':{'companion':{'scope':'local'}}}))
    bindings=[{'id':x,'bot_id':'b','conversation_type':'single','conversation_id':x,'notify':x!='off'} for x in ['one','two','off']]
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:bindings)
    sent=[];events=[]
    async def send(bots,binding,text):sent.append(binding['id']);return {}
    async def publish(event):events.append(event)
    monkeypatch.setattr('services.digital_person_channels.send_binding',send)
    monkeypatch.setattr(current.bus,'publish',publish)
    receipts=await current._notify('想跟你说句话',['source'],'run')
    assert receipts[0]['session_id']==main
    assert sent==['one','two']
    assert await current.projects.run_db(project.id,lambda _:ChatMessage.select().where(ChatMessage.session==origin).count())==0
    live=[e for e in events if e.get('name')=='digital_person.proactive_message']
    assert len(live)==1 and live[0]['session_id']==main
    events.clear()
    await current._deliver_local(main,'想跟你说句话','run',proactive=True)
    assert events==[]


def test_proactive_event_is_host_only_and_independent_of_open_project():
    from streaming.ws import WsSubscription,_make_subscription_predicate
    event={'type':'CUSTOM','name':'digital_person.proactive_message','channel':'digital_person','project_id':'home','session_id':'main'}
    host=WsSubscription(active=True,selected_project_id='other',channels={'digital_person'})
    assert _make_subscription_predicate(host)(event)
    scoped=WsSubscription(active=True,project_id='home',channels={'digital_person'})
    assert not _make_subscription_predicate(scoped)(event)


async def test_automatic_reflection_does_not_backfill_unregistered_history(runtime,monkeypatch):
    from datetime import timedelta
    from models.fields import utc_now
    current,project,_=runtime
    sid=(await current.main_session())['id']
    def seed(_):
        now=utc_now()
        ChatMessage.create(id='old',session=sid,role='user',status='completed',content='两周前的事',created_at=now-timedelta(days=14))
        ChatMessage.create(id='recent',session=sid,role='user',status='completed',content='刚才的新变化',created_at=now-timedelta(minutes=1))
    await current.projects.run_db(project.id,seed)
    async def forbidden(*args,**kwargs):pytest.fail('no automatic historical recall')
    monkeypatch.setattr('services.digital_person_memory.recall_projects',forbidden)
    context=await current._collect()
    assert context['no_work'] is True
    assert (await current._collect())['no_work'] is True


async def test_recent_completion_of_long_running_message_is_included(runtime):
    from datetime import timedelta
    from models.fields import utc_now
    current,project,_=runtime
    sid=(await current.main_session())['id']
    now=utc_now()
    await current.projects.run_db(project.id,lambda _:create_completed_reply(id='long-result',session=sid,role='assistant',status='completed',content='刚完成',created_at=now-timedelta(hours=2),ended_at=now-timedelta(seconds=10)))
    assert [m['id'] for m in (await current._collect())['conversation']]==['long-result']


async def test_one_schedule_drains_multiple_pending_source_sessions(runtime,monkeypatch):
    from models.fields import utc_now
    from datetime import timedelta
    current,project,store=runtime
    store.set('digital_person',{'enabled':True,'proactive_enabled':True,'proactive_interval_minutes':5})
    def seed(_):
        for i in range(2):
            sid=current.chats.create_session(project.id)['id']
            create_completed_user(id=f'session-{i}',session=sid,role='user',status='completed',content=f'最近发生的事{i}',created_at=utc_now()-timedelta(seconds=30))
    await current.projects.run_db(project.id,seed)
    seen=[]
    async def decide(ctx):
        if ctx.get('_load'): await ctx['_load']()
        seen.extend(m['id'] for group in ctx.get('_groups',[ctx]) for m in group['conversation'] if m['role']=='user')
        return {'decision':'silent','summary':'已看过','source_ids':[]}
    monkeypatch.setattr(current,'_decide',decide)
    await current._tick()
    assert set(seen)=={'session-0','session-1'} and len(seen)==2


async def test_assessment_recovers_old_pending_versions_once(runtime):
    import asyncio
    from datetime import timedelta
    from models.fields import utc_now
    from services import digital_person_memory as memory, digital_person_assessment as assessment
    current,project,_=runtime
    sid=(await current.main_session())['id']
    now=utc_now()
    def seed(_):
        for mid,when in [('cold',now-timedelta(days=20)),('new',now-timedelta(minutes=1))]:
            row=create_completed_user(id=mid,session=sid,role='user',status='completed',content='真实来源'+mid,created_at=when)
            memory.capture_message(row,'local')
    await current.projects.run_db(project.id,seed)
    rows=await asyncio.to_thread(assessment.pending,[project.id],baseline=now.isoformat(),limit=8)
    assert {row['source_message_id'] for row in rows}=={'cold','new','fixture-reply-cold','fixture-reply-new'}
    assert await asyncio.to_thread(assessment.claim,rows)
    result=await asyncio.to_thread(assessment.commit,rows,[],'recovered')
    assert result['processed']==4
    assert await asyncio.to_thread(assessment.pending,[project.id],baseline=now.isoformat(),limit=8)==[]


async def test_check_persists_owner_route_before_delivering(runtime,monkeypatch):
    from datetime import timedelta
    from models.fields import utc_now
    current,project,_=runtime
    main=(await current.main_session())['id']
    def seed(_):
        sid=current.chats.create_session(project.id)['id']
        create_completed_user(id='personal-news',session=sid,role='user',status='completed',content='最近在准备面试',created_at=utc_now()-timedelta(minutes=2))
        return sid
    origin=await current.projects.run_db(project.id,seed)
    async def decide(context):
        if context.get('_load'): await context['_load']()
        assert context['origin_session_id']==origin
        return {'decision':'notify','kind':'social','summary':'想聊聊最近的准备吗？','source_ids':['personal-news']}
    monkeypatch.setattr(current,'_decide',decide)
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:[])
    run=await current.check()
    assert run['status']=='notified',run
    assert run['deliveries'][0]['session_id']==main
    assert run['deliveries'][0]['proactive'] is True


async def test_live_bus_delivers_owner_notice_without_exposing_it_to_project_clients(runtime):
    import asyncio
    from streaming.ws import WsSubscription,_make_subscription_predicate
    current,project,_=runtime
    sid=(await current.main_session())['id']
    host=current.bus.subscribe(_make_subscription_predicate(WsSubscription(active=True,selected_project_id='different-project',channels={'digital_person'})))
    scoped=current.bus.subscribe(_make_subscription_predicate(WsSubscription(active=True,project_id=project.id,channels={'digital_person'})))
    try:
        await current._deliver_local(sid,'主动消息正文','bus-notice',proactive=True)
        event=await asyncio.wait_for(host.get(),.2)
        assert event['name']=='digital_person.proactive_message'
        assert event['value']['text']=='主动消息正文'
        assert scoped.empty()
    finally:
        current.bus.unsubscribe(host);current.bus.unsubscribe(scoped)


async def test_stop_check_cancels_unified_assessment(runtime,monkeypatch):
    import asyncio
    current,project,_=runtime
    from models.fields import utc_now
    sid=(await current.main_session())['id']
    await current.projects.run_db(project.id,lambda _:create_completed_user(
        id='stop-source',session=sid,role='user',status='completed',content='待整理',created_at=utc_now()))
    entered=asyncio.Event()
    async def collect():return {'no_work':False,'messages':[],'conversation':[],'delegations':[],'reflection_batch':[]}
    async def consolidate(context):
        entered.set()
        await asyncio.Event().wait()
    monkeypatch.setattr(current,'_collect',collect)
    monkeypatch.setattr(current,'_decide',consolidate)
    task=asyncio.create_task(current.check())
    await asyncio.wait_for(entered.wait(),1)
    await current.stop_check()
    assert (await asyncio.wait_for(task,1))['status']=='cancelled'
    assert current._active_assessment_task is None


@pytest.mark.parametrize('archived',[False,True])
async def test_outage_retry_and_restart_use_durable_event_receipts(runtime,monkeypatch,archived):
    from datetime import timedelta
    from models.fields import utc_now
    from services.digital_person_runtime import DigitalPersonRuntime
    current,project,_=runtime
    sid=(await current.main_session())['id']
    await current.projects.run_db(project.id,lambda _:create_completed_user(id='outage',session=sid,role='user',status='completed',content='停机期间未处理',created_at=utc_now()-timedelta(days=2)))
    if archived:
        from models.chat_session import ChatSession
        await current.projects.run_db(project.id,lambda _:ChatSession.update(archived=True).where(ChatSession.id==sid).execute())
    calls=[]
    async def decide(ctx):
        if ctx.get('_load'): await ctx['_load']()
        calls.append([m['id'] for m in ctx['conversation'] if m['role']=='user'])
        if len(calls)==1:raise RuntimeError('simulated outage')
        return {'decision':'silent','summary':'已整理','source_ids':[]}
    monkeypatch.setattr(current,'_decide',decide)
    assert (await current.check())['status']=='failed'
    fresh=DigitalPersonRuntime(current.projects,current.chats,None,current.bus)
    monkeypatch.setattr(fresh,'_decide',decide)
    assert (await fresh.check())['status']=='silent'
    await fresh.check()
    assert calls==[['outage'],['outage']]
    await fresh.projects.run_db(project.id,lambda _:create_completed_user(id='later',session=sid,role='user',status='completed',content='同一会话的新事件',created_at=utc_now()-timedelta(seconds=1)))
    await fresh.check()
    assert calls[-1]==['later'] and len(calls)==3
