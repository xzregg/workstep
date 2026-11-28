import asyncio
from datetime import datetime, timedelta, timezone
import time

import httpx
import pytest
from pydantic import ValidationError

from services import digital_person_memory_index as index
from tests.test_chat_session import chat_module
from tests.test_digital_person_runtime import runtime


@pytest.fixture
def calendar_store(tmp_path, monkeypatch):
    monkeypatch.setattr(index, 'database_path', lambda: tmp_path / 'calendar.db')
    from services import digital_calendar as calendar
    return calendar


def draft(calendar, **changes):
    return calendar.CalendarDraft(content='**开会**\n\n- 核对方案',
        starts_at=datetime.now(timezone.utc) + timedelta(hours=1), timezone_name='Asia/Shanghai', **changes)


def test_calendar_persists_markdown_idempotency_revisions_delete_and_restore(calendar_store):
    c = calendar_store
    body = draft(c)
    first = c.create(body, 'one-request')
    assert c.create(body, 'one-request')['id'] == first['id']
    with pytest.raises(ValueError):
        c.create(body.model_copy(update={'content': 'different'}), 'one-request')
    rows = c.list_events(since=body.starts_at-timedelta(days=1), before=body.starts_at+timedelta(days=1))
    assert [row['content'] for row in rows['items']] == [body.content]
    changed = c.update(first['id'], body.model_copy(update={'content': '新内容'}), first['revision'])
    with pytest.raises(ValueError):
        c.remove(first['id'], first['revision'])
    removed = c.remove(first['id'], changed['revision'])
    assert c.list_events()['items'] == []
    restored = c.restore(first['id'], removed['revision'])
    assert c.get(first['id'])['content'] == '新内容'
    assert restored['revision'] != removed['revision']


@pytest.mark.parametrize('changes', [{'content':' \n '}, {'starts_at':datetime(2026,1,1)}, {'timezone_name':'invalid/zone'}, {'reminder_minutes':-1}])
def test_calendar_rejects_invalid_content_clock_and_zone(calendar_store, changes):
    data = {'content':'会面','starts_at':'2026-11-25T15:00:00+08:00','timezone_name':'Asia/Shanghai', **changes}
    with pytest.raises((ValidationError, ValueError)):
        calendar_store.CalendarDraft(**data)


def test_calendar_create_and_update_normalize_to_minutes(calendar_store):
    c=calendar_store
    body=c.CalendarDraft(content='分钟日程',starts_at='2030-01-01T15:04:59.987+08:00')
    event=c.create(body)
    assert event['starts_at']=='2030-01-01T07:04:00Z'
    assert datetime.fromisoformat(event['reminder_at']).second==0
    updated=c.update(event['id'],c.CalendarDraft(content='修改',starts_at='2030-01-01T15:05:42+08:00'),event['revision'])
    assert updated['starts_at']=='2030-01-01T07:05:00Z'


async def test_calendar_loop_checks_once_per_minute(monkeypatch):
    from services.digital_calendar import CalendarRuntime
    calendar=CalendarRuntime(None)
    checks=[]
    async def tick():checks.append('tick')
    async def sleep(seconds):
        assert seconds==60
        raise asyncio.CancelledError
    monkeypatch.setattr(calendar,'tick',tick)
    monkeypatch.setattr(asyncio,'sleep',sleep)
    with pytest.raises(asyncio.CancelledError):await calendar.loop()
    assert checks==['tick']


def test_calendar_reflection_prompt_uses_advance_notice_receipts():
    from services.digital_person_assessment import instruction
    from services.digital_person import DigitalPersonProfile
    prompt=instruction(DigitalPersonProfile())
    for contract in ('+30 minutes','remind --early','early_reminder_status=notified','contact policy/quiet hours'):
        assert contract in prompt


async def test_calendar_reflection_early_notice_is_deduplicated_and_preserves_due_notice(runtime,monkeypatch):
    from services.digital_calendar import CalendarDraft
    from models.chat_session import ChatMessage
    rt,project,_=runtime
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:[])
    now=datetime.now(timezone.utc).replace(second=0,microsecond=0)
    body=CalendarDraft(content='提前准备会议',starts_at=now+timedelta(minutes=20))
    event=await rt.calendar.create(body)
    with pytest.raises(ValueError):
        await rt.calendar.remind(event['id'],event['revision'],early=True,now=now-timedelta(hours=1))
    first,second=await asyncio.gather(*(rt.calendar.remind(event['id'],event['revision'],early=True,now=now) for _ in range(2)))
    assert first['early_reminder_status']==second['early_reminder_status']=='notified'
    assert first['reminder_status']=='pending'
    await rt.calendar.tick(now=body.starts_at)
    await rt.calendar.remind(event['id'],event['revision'],early=True,now=body.starts_at)
    rows=await rt.projects.run_db(project.id,lambda _:list(ChatMessage.select().where(ChatMessage.content.contains('提前准备会议')).dicts()))
    assert len(rows)==2
    assert sum('提前提醒' in row['content'] for row in rows)==1
    assert (await rt.calendar.list_events())['items'][0]['reminder_status']=='notified'


async def test_calendar_due_delivery_is_shared_by_timer_manual_remind_and_restart(runtime, monkeypatch):
    rt, project, store = runtime
    events = []
    publish = rt.bus.publish
    async def capture(event):
        events.append(event)
        return await publish(event)
    monkeypatch.setattr(rt.bus,'publish',capture)
    from services.digital_calendar import CalendarDraft, CalendarRuntime
    monkeypatch.setattr('services.digital_person_channels.get_bindings', lambda: [])
    body = CalendarDraft(content='**到点开会**', starts_at=datetime.now(timezone.utc)+timedelta(minutes=2), reminder_minutes=5)
    event = await rt.calendar.create(body, 'due')
    await asyncio.gather(rt.calendar.tick(), rt.calendar.remind(event['id'], event['revision']))
    await CalendarRuntime(rt).tick()
    from models.chat_session import ChatMessage
    messages = await rt.projects.run_db(project.id, lambda _: list(ChatMessage.select().where(ChatMessage.content.contains('到点开会')).dicts()))
    assert len(messages) == 1
    listed = await rt.calendar.list_events()
    assert listed['items'][0]['reminder_status'] == 'notified'
    assert any(event.get('name') == 'digital_person.proactive_message' for event in events)


async def test_calendar_rejects_early_remind_and_does_not_revive_deleted_events(runtime):
    rt, _, _ = runtime
    from services.digital_calendar import CalendarDraft
    body = CalendarDraft(content='明天的安排', starts_at=datetime.now(timezone.utc)+timedelta(days=1))
    event = await rt.calendar.create(body)
    with pytest.raises(ValueError):
        await rt.calendar.remind(event['id'], event['revision'])
    await rt.calendar.remove(event['id'], event['revision'])
    await rt.calendar.tick(now=body.starts_at+timedelta(days=2))
    assert (await rt.calendar.list_events())['items'] == []


async def test_calendar_disabled_hub_defers_delivery_and_rescheduling_rearms_it(runtime,monkeypatch):
    from services.digital_calendar import CalendarDraft
    from models.chat_session import ChatMessage
    rt,project,store=runtime
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:[])
    body=CalendarDraft(content='日程状态验证',starts_at=datetime.now(timezone.utc)-timedelta(minutes=1))
    event=await rt.calendar.create(body)
    store.set('digital_person',{'enabled':False})
    await rt.calendar.tick()
    assert (await rt.calendar.list_events())['items'][0]['reminder_status']=='pending'
    store.set('digital_person',{'enabled':True})
    await rt.calendar.tick()
    changed=await rt.calendar.update(event['id'],body.model_copy(update={'content':'日程状态验证，补充资料'}),event['revision'])
    assert changed['reminder_status']=='notified'
    await rt.calendar.tick()
    assert await rt.projects.run_db(project.id,lambda _:ChatMessage.select().where(ChatMessage.content.contains('日程状态验证')).count())==1
    changed=await rt.calendar.update(event['id'],body.model_copy(update={'starts_at':body.starts_at-timedelta(minutes=1)}),changed['revision'])
    assert changed['reminder_status']=='pending'
    await rt.calendar.tick()
    assert await rt.projects.run_db(project.id,lambda _:ChatMessage.select().where(ChatMessage.content.contains('日程状态验证')).count())==2


async def test_calendar_api_is_host_scoped_and_slow_storage_does_not_block_loop(runtime, monkeypatch):
    from fastapi import FastAPI
    from api import digital_person as api
    from services import digital_calendar as c
    rt, _, _ = runtime
    app = FastAPI();app.include_router(api.router)
    app.dependency_overrides[api.authorize] = lambda: None
    monkeypatch.setattr(api, 'runtime', lambda: rt)
    original = c.list_events
    def slow(**kwargs):
        time.sleep(.12)
        return original(**kwargs)
    monkeypatch.setattr(c, 'list_events', slow)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        request = asyncio.create_task(client.get('/api/digital-person/calendar'))
        await asyncio.sleep(.025)
        assert not request.done()
        assert (await asyncio.wait_for(client.get('/api/digital-person/identity'), .1)).status_code == 200
        assert (await request).status_code == 200
        created = await client.post('/api/digital-person/calendar',json={'content':'**日程**','starts_at':'2030-01-01T10:00:00+08:00','timezone_name':'Asia/Shanghai','duration_minutes':95})
        assert created.status_code == 200
        event = created.json()
        endpoint='/api/digital-person/calendar/'+event['id']
        assert (await client.get(endpoint)).json()['duration_minutes']==95
        changed=await client.put(endpoint,json={'content':'修改结束时间','starts_at':event['starts_at'],'duration_minutes':125,'revision':event['revision']})
        assert changed.status_code==200
        event=changed.json()
        assert (await client.get(endpoint)).json()['duration_minutes']==125
        for duration in (0,-1,1.5,10081):
            assert (await client.put(endpoint,json={'content':'无效时长','starts_at':event['starts_at'],'duration_minutes':duration,'revision':event['revision']})).status_code==422
        assert (await client.get(endpoint)).json()['duration_minutes']==125
        assert (await client.delete('/api/digital-person/calendar/'+event['id'],params={'revision':event['revision']})).status_code == 200
    app.dependency_overrides.clear()
    from api.project_scope import require_catalog_project
    from fastapi import HTTPException
    def denied(_): raise HTTPException(403, 'Project identity cannot manage host resources')
    monkeypatch.setattr(api, 'require_catalog_project', denied)
    with pytest.raises(HTTPException) as error: api.authorize()
    assert error.value.status_code == 403


async def test_calendar_timer_slow_query_does_not_block_lightweight_api(runtime,monkeypatch):
    import threading
    from fastapi import FastAPI
    from api import digital_person as api
    from services import digital_calendar as c
    rt,_,_=runtime
    app=FastAPI();app.include_router(api.router)
    app.dependency_overrides[api.authorize]=lambda:None
    monkeypatch.setattr(api,'runtime',lambda:rt)
    entered=threading.Event()
    original=c.due
    def slow(now):
        entered.set()
        time.sleep(.2)
        return original(now)
    monkeypatch.setattr(c,'due',slow)
    task=asyncio.create_task(rt.calendar.tick())
    try:
        while not entered.is_set():await asyncio.sleep(.005)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/api/digital-person/identity'),.1)).status_code==200
        assert not task.done()
    finally:
        await task


def test_calendar_cli_and_native_tools_share_api(tmp_path, capsys):
    from cli import main
    from services.tool_registry import WorkstepClient
    body = tmp_path / 'entry.md';body.write_text('**出发**\n\n带上资料')
    seen = []
    async def handle(request):
        import json
        seen.append((request.method, request.url.path))
        if request.method == 'POST':
            payload = json.loads(request.content)
            assert payload['content'] == body.read_text()
            assert payload['starts_at'] == '2030-01-01T10:00:00+08:00'
        return httpx.Response(200,json={'id':'event','revision':'rev','content':'出发'})
    client = WorkstepClient(transport=httpx.MockTransport(handle))
    assert main(['digital-hub','calendar','create','--content-file',str(body),'--at','2030-01-01T10:00:00+08:00','--timezone','Asia/Shanghai','--json'],client=client) == 0
    assert main(['digital-hub','calendar','delete','--id','event','--revision','rev','--json'],client=client) == 0
    assert seen == [('POST','/api/digital-person/calendar'),('DELETE','/api/digital-person/calendar/event')]


async def test_calendar_channel_retry_skips_delivered_recipients(runtime,monkeypatch):
    from types import SimpleNamespace
    from services.digital_calendar import CalendarDraft
    rt,project,_ = runtime
    async def routes(): return {'sessions':{},'session_sources':{}}
    rt.bots=SimpleNamespace(_load=routes)
    bindings=[{'id':name,'notify':True,'use_main_session':True,'conversation_type':'single','bot_id':'bot','conversation_id':name} for name in ('a','b')]
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:bindings)
    sent=[]
    async def send(_bots,binding,_text):
        sent.append(binding['id'])
        if sent.count('b')==1 and binding['id']=='b':raise OSError('temporary delivery failure')
        return {'message_id':binding['id']}
    monkeypatch.setattr('services.digital_person_channels.send_binding',send)
    now=datetime.now(timezone.utc)
    event=await rt.calendar.create(CalendarDraft(content='只提醒一次',starts_at=now-timedelta(seconds=1)))
    first=await rt.calendar.remind(event['id'],event['revision'])
    assert first['reminder_status']=='retry'
    await rt.calendar.tick(now=now+timedelta(minutes=2))
    assert sent==['a','b','b']
    from models.chat_session import ChatMessage
    assert await rt.projects.run_db(project.id,lambda _:ChatMessage.select().where(ChatMessage.content.contains('只提醒一次')).count())==1


@pytest.mark.parametrize('policy_state',['missing','denied'])
async def test_calendar_managed_host_operations_do_not_require_retired_capabilities(runtime,monkeypatch,policy_state):
    import main
    from types import SimpleNamespace
    from fastapi import FastAPI
    from api.digital_person import router
    from services.gateway_client.policy import ManagedPolicyCache,verify_policy_snapshot
    from services.remote_access import ActorSnapshot,actor_context
    from tests.test_gateway_policy import _signed_policy
    current,_,_=runtime
    cache=ManagedPolicyCache()
    if policy_state=='denied':
        token,pem,fingerprint=_signed_policy(engine_install=False,allow_local_providers=False)
        cache.apply(verify_policy_snapshot(token,pem,fingerprint,'gateway-test','device-1','user-1'))
    monkeypatch.setattr(main,'digital_person_runtime',current)
    monkeypatch.setattr(main,'gateway_client',SimpleNamespace(managed_config=object(),policy_cache=cache))
    app=FastAPI();app.include_router(router)
    with actor_context(ActorSnapshot('user-1','Alice','device-1','PC','managed')):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            response=await client.post('/api/digital-person/calendar',json={'content':'合法宿主日程','starts_at':'2030-01-01T10:00:00+08:00'})
            assert response.status_code==200,response.text
            event=response.json()
            assert (await client.delete('/api/digital-person/calendar/'+event['id'],params={'revision':event['revision']})).status_code==200


async def test_calendar_project_identity_cannot_read_or_mutate_host_calendar(runtime,monkeypatch):
    import main
    from fastapi import FastAPI
    from api.digital_person import router
    from services.remote_access import ActorSnapshot,actor_context
    rt,project,_=runtime
    monkeypatch.setattr(main,'digital_person_runtime',rt)
    app=FastAPI();app.include_router(router)
    with actor_context(ActorSnapshot('user','User','device','PC','remote',project_id=project.id,access_level='edit')):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            for method,path,kwargs in [
                ('GET','/api/digital-person/calendar',{}),
                ('POST','/api/digital-person/calendar',{'json':{'content':'越权','starts_at':'2030-01-01T10:00:00+08:00'}}),
                ('DELETE','/api/digital-person/calendar/missing',{'params':{'revision':'r'}}),
                ('POST','/api/digital-person/calendar/missing/remind',{'json':{'revision':'r'}}),
            ]:
                assert (await client.request(method,path,**kwargs)).status_code==403


async def test_calendar_cli_uses_real_api_and_storage(runtime,monkeypatch):
    import main
    from fastapi import FastAPI
    from api.digital_person import router
    from cli import build_parser,dispatch
    from services.tool_registry import WorkstepClient
    rt,_,_=runtime
    monkeypatch.setattr(main,'digital_person_runtime',rt)
    app=FastAPI();app.include_router(router)
    client=WorkstepClient(transport=httpx.ASGITransport(app=app))
    async def run(*args):return await dispatch(build_parser().parse_args(['digital-hub','calendar',*args,'--json']),client)
    created=await run('create','--content','**聊天新增日程**','--at','2030-01-01T15:00:00+08:00','--timezone','Asia/Shanghai','--idempotency-key','one')
    assert created['content']=='**聊天新增日程**'
    listed=await run('list','--since','2030-01-01T00:00:00+08:00','--before','2030-01-02T00:00:00+08:00')
    assert [row['id'] for row in listed['items']]==[created['id']]
    upcoming=await run('create','--content','提前提醒 CLI','--at',(datetime.now(timezone.utc)+timedelta(minutes=20)).isoformat())
    early=await run('remind','--id',upcoming['id'],'--revision',upcoming['revision'],'--early')
    assert early['early_reminder_status']=='notified'
    assert early['reminder_status']=='pending'
    await run('delete','--id',created['id'],'--revision',created['revision'])
    assert (await run('list','--since','2030-01-01T00:00:00+08:00','--before','2030-01-02T00:00:00+08:00'))['items']==[]


async def test_digital_hub_messages_expose_calendar_tools_and_persist_create_delete(runtime,monkeypatch):
    """Controlled engine, real chat submission, native tool client, API and storage."""
    import main
    from engines.codex_sdk import CodexSDKEngine
    from engines.core.events import InternalEvent
    from services.tool_registry import WorkstepClient
    from tests.test_chat_session import _wait_turn
    rt,project,store=runtime
    monkeypatch.setattr(main,'project_manager',rt.projects)
    monkeypatch.setattr(main,'chat_session_module',rt.chats)
    monkeypatch.setattr(main,'digital_person_runtime',rt)
    store.set('assistant_defaults',{'digital_person':{'engine':'codex_sdk'}})
    calls=[]
    created={}
    client=WorkstepClient(transport=httpx.ASGITransport(app=main.app))
    class Engine(CodexSDKEngine):
        @property
        def supports_workstep_tools(self):
            return True

        async def spawn(self,prompt,cwd,model=None,session_id=None,**kwargs):
            if not calls:
                assert 'Calendar:' in kwargs.get('system_prompt','')
            assert kwargs.get('workstep_tools') is True
            calls.append(prompt)
            if not created:
                created.update(await client.call('workstep_create_digital_hub_calendar_event',{
                    'content':'**发送消息创建**','starts_at':'2030-01-01T15:00:00+08:00','timezone_name':'Asia/Shanghai','confirm':'yes'}))
                assert created.get('id'),created
            else:
                result=await client.call('workstep_delete_digital_hub_calendar_event',{'event_id':created['id'],'revision':created['revision'],'confirm':'yes'})
                assert result.get('deleted_at'),result
            yield InternalEvent(type='session_started',data={'session_id':'calendar-thread'})
            yield InternalEvent(type='agent_message_chunk',data={'content':{'type':'text','text':'已处理日程'}})
            yield InternalEvent(type='done',data={})
    monkeypatch.setattr('agent_assistants.chat_session.create_engine',lambda _:Engine())
    monkeypatch.setattr('agent_assistants.base.create_engine',lambda _:Engine())
    sid=(await rt.main_session())['id']
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),base_url='http://test') as http:
        for i,text in enumerate(['请在 2030 年 1 月 1 日下午三点提醒我发送消息创建','删除刚才的日程']):
            response=await http.post(f'/api/chat-sessions/{sid}/chat',headers={'Idempotency-Key':f'calendar-chat-{i}'},json={'project_id':project.id,'content':text})
            assert response.status_code==200,response.text
            assert await _wait_turn(rt.chats,response.json()['turn_id'])=='completed'
    assert len(calls)==2


def test_calendar_duration_persists_and_legacy_edits_preserve_it(calendar_store):
    c=calendar_store
    body=c.CalendarDraft(content='跨日',starts_at='2030-01-01T23:45:00+08:00',duration_minutes=95)
    event=c.create(body,'duration')
    assert c.get(event['id'])['duration_minutes']==95
    key=event['notification_key']
    edited=c.update(event['id'],body.model_copy(update={'duration_minutes':120}),event['revision'])
    assert edited['duration_minutes']==120
    assert edited['notification_key']==key
    legacy=c.CalendarDraft(content='旧客户端',starts_at=body.starts_at)
    assert c.update(event['id'],legacy,edited['revision'])['duration_minutes']==120
    assert c.create(legacy).get('duration_minutes',30)==30


@pytest.mark.parametrize('duration',[0,-1,1.5,10081])
def test_calendar_rejects_invalid_duration(calendar_store,duration):
    with pytest.raises(ValidationError):
        draft(calendar_store,duration_minutes=duration)
