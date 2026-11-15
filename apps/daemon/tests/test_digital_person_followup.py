import asyncio
from datetime import timedelta
import pytest
from tests.test_digital_person_runtime import runtime, chat_module
from models.chat_session import ChatMessage
from models.fields import utc_now


async def seed(runtime, status='completed'):
    service, home, store = runtime
    store.set('digital_person', {'enabled': True, 'proactive_enabled': False, 'quiet_start': 0, 'quiet_end': 0})
    origin=(await service.main_session())['id']
    def create(_):
        sid=service.chats.create_session(home.id, title='执行会话')['id']
        ChatMessage.create(id='result', session=sid, role='assistant', status=status, content='真实执行结果', created_at=utc_now(), ended_at=utc_now() if status=='completed' else None)
        return sid
    sid=await service.projects.run_db(home.id, create)
    await service.mutate(lambda state: state['delegations'].append({'id':'work','project_id':home.id,'session_id':sid,'message_id':'result','origin_session_id':origin,'instruction':'核对构建','status':'running','notified':False}))
    return service,home,store,sid,origin


async def test_completion_followup_never_calls_llm_and_notifies_once(runtime,monkeypatch):
    service,home,_,sid,origin=await seed(runtime)
    async def forbidden(*args,**kwargs):pytest.fail('delegation follow-up must not invoke LLM')
    monkeypatch.setattr(service,'_decide',forbidden)
    monkeypatch.setattr('agent_assistants.base.invoke_engine',forbidden)
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:[])
    await service.follow_delegations()
    await service.follow_delegations()
    state=await service.state()
    assert state['delegations'][0]['notified'] is True
    assert state['delegations'][0]['status']=='completed'
    runs=[r for r in state['runs'] if r.get('trigger')=='delegation']
    assert len(runs)==1 and runs[0]['status']=='notified'
    assert runs[0]['deliveries'][0]['session_id']==origin
    messages=await service.projects.run_db(home.id,lambda _:list(ChatMessage.select().where(ChatMessage.session==origin)))
    assert len(messages)==1 and '真实执行结果' in messages[0].content
    assert not state.get('check_sessions')
    assert not state.get('last_check')


async def test_viewed_result_suppresses_followup(runtime,monkeypatch):
    service,home,_,sid,_=await seed(runtime)
    from services.chat_read_state import mark_read
    await service.projects.run_db(home.id,lambda _:mark_read(home.id,sid,'result'))
    async def forbidden(*args,**kwargs):pytest.fail('read result must not notify')
    monkeypatch.setattr(service,'_notify',forbidden)
    await service.follow_delegations()
    item=(await service.state())['delegations'][0]
    assert item['notified'] is True and item['notification_state']=='read'


async def test_quiet_delivery_waits_without_llm_and_rechecks_read_state(runtime,monkeypatch):
    service,home,store,sid,_=await seed(runtime)
    hour=utc_now().astimezone().hour
    store.set('digital_person',{'enabled':True,'quiet_start':hour,'quiet_end':(hour+1)%24})
    async def forbidden(*args,**kwargs):pytest.fail('quiet waiting must not send or invoke LLM')
    monkeypatch.setattr(service,'_notify',forbidden)
    monkeypatch.setattr(service,'_decide',forbidden)
    await service.follow_delegations();await service.follow_delegations()
    state=await service.state()
    assert len(state['runs'])==1 and state['runs'][0]['status']=='deferred'
    assert not state['delegations'][0]['notified']
    from services.chat_read_state import mark_read
    await service.projects.run_db(home.id,lambda _:mark_read(home.id,sid,'result'))
    store.set('digital_person',{'enabled':True,'quiet_start':0,'quiet_end':0})
    await service.follow_delegations()
    assert (await service.state())['delegations'][0]['notification_state']=='read'


async def test_running_delegation_does_not_accelerate_proactive_interval(runtime,monkeypatch):
    service,_,store,_,_=await seed(runtime,'running')
    store.set('digital_person',{'enabled':True,'proactive_enabled':True,'proactive_interval_minutes':30})
    now=utc_now()
    await service.mutate(lambda s:s.update(last_check=now.isoformat()))
    calls=[]
    async def check(**kwargs):calls.append(kwargs)
    monkeypatch.setattr(service,'check',check)
    await service._tick(now+timedelta(minutes=2))
    assert not calls
    await service._tick(now+timedelta(minutes=31))
    assert calls==[{'manual':False}]


async def test_failed_delivery_is_not_replayed_by_polling(runtime,monkeypatch):
    service,_,_,_,_=await seed(runtime)
    calls=[]
    async def notify(*args):calls.append(args);return [{'kind':'channel','binding_id':'peer','status':'failed','error':'offline'}]
    monkeypatch.setattr(service,'_notify',notify)
    await asyncio.gather(service.follow_delegations(),service.follow_delegations())
    await service.follow_delegations()
    assert len(calls)==1
    assert (await service.state())['runs'][0]['status']=='delivery_failed'


async def test_unread_completion_only_delivers_to_its_bound_source_peer(runtime,monkeypatch):
    service,_,_,_,origin=await seed(runtime)
    class Bots:
        async def _load(self):return {'sessions':{'bot:single:origin':origin,'bot:single:other':'unrelated'},'session_sources':{origin:{}}}
    service.bots=Bots()
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:[
        {'id':peer,'bot_id':'bot','conversation_type':'single','conversation_id':peer,'notify':True} for peer in ['origin','other']])
    sent=[]
    async def send(_,binding,text):sent.append((binding['id'],text));return {'message_id':'sent'}
    monkeypatch.setattr('services.digital_person_channels.send_binding',send)
    await service.follow_delegations();await service.follow_delegations()
    assert len(sent)==1 and sent[0][0]=='origin'
    assert '真实执行结果' in sent[0][1]


async def test_slow_delegation_sql_does_not_block_health(runtime,monkeypatch):
    import threading
    from fastapi import FastAPI
    from httpx import AsyncClient,ASGITransport
    service,_,_,_,_=await seed(runtime,'running')
    entered,release=threading.Event(),threading.Event()
    original=ChatMessage.get_or_none
    def slow(*args,**kwargs):entered.set();assert release.wait(3);return original(*args,**kwargs)
    monkeypatch.setattr(ChatMessage,'get_or_none',slow)
    app=FastAPI()
    @app.get('/health')
    async def health():return {'ok':True}
    task=asyncio.create_task(service.follow_delegations())
    try:
        assert await asyncio.to_thread(entered.wait,2)
        async with AsyncClient(transport=ASGITransport(app),base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/health'),.3)).status_code==200
    finally:release.set()
    await task


async def test_legacy_delegation_interval_does_not_schedule_independent_checks(runtime,monkeypatch):
    service,_,store,_,_=await seed(runtime,'running')
    store.set('digital_person',{'enabled':True,'reflection_enabled':True,'delegation_interval_seconds':3})
    calls=[]
    async def follow(profile):calls.append('delegation')
    async def check(**kwargs):calls.append('assessment');return {'status':'silent','sources':{}}
    monkeypatch.setattr(service,'follow_delegations',follow)
    monkeypatch.setattr(service,'check',check)
    now=utc_now()
    await service._tick(now)
    await service._tick(now+timedelta(seconds=3))
    assert calls==[]
    await service._tick(now+timedelta(minutes=5))
    assert calls==['delegation','assessment']
    store.set('digital_person',{'enabled':True,'reflection_enabled':False,'delegation_interval_seconds':1})
    await service._tick(now+timedelta(minutes=6))
    assert calls==['delegation','assessment']


async def test_background_loop_uses_one_scheduler_wakeup(runtime,monkeypatch):
    service,_,store=runtime
    store.set('digital_person',{'enabled':True,'delegation_interval_seconds':3})
    sleeps=[]
    async def sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps)==3:raise asyncio.CancelledError
    async def follow(profile):pass
    monkeypatch.setattr(service,'follow_delegations',follow)
    monkeypatch.setattr('services.digital_person_runtime.asyncio.sleep',sleep)
    with pytest.raises(asyncio.CancelledError):await service._loop()
    assert sleeps==[15,15,15]
