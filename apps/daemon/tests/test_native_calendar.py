import asyncio
from datetime import datetime,timezone
import pytest
from tests.test_digital_calendar import calendar_store
from tests.test_digital_person_runtime import runtime
from tests.test_chat_session import chat_module


def register(app):
    return app.register({'device_id':'phone','key':'k'*40,'name':'Phone','platform':'android','permission':'granted',
                         'calendars':[{'id':'cal','name':'Personal'}]})['targets'][0]


def test_native_batch_deletion_waits_for_verified_system_receipt(calendar_store):
    from services.native_calendar import CalendarApplication
    app=CalendarApplication('owner')
    target=register(app)
    draft={'action':'create','target_id':target['id'],'request_id':'create-30','content':'**运动**',
           'schedule':{'start_date':'2030-01-01','end_date':'2030-01-30','time':'08:00','timezone_name':'Asia/Shanghai'}}
    op=app.submit(draft)
    assert len(op['items'])==30
    assert app.submit(draft)['id']==op['id']
    claimed=app.claim(op['id'],'phone','k'*40)
    for item in claimed['items']:
        app.receipt(op['id'],'phone','k'*40,claimed['token'],{'item_id':item['id'],'status':'succeeded','verification':'present','system_id':item['id'],'event':item['draft']})
    rows=calendar_store.list_events(since=datetime(2030,1,1,tzinfo=timezone.utc),before=datetime(2030,2,1,tzinfo=timezone.utc))['items']
    assert len(rows)==30
    with pytest.raises(ValueError):
        app.submit({'action':'delete','target_id':'internal','event_id':rows[0]['id'],'revision':rows[0]['revision'],'request_id':'wrong-destination'})
    delete=app.submit({'action':'delete','target_id':target['id'],'request_id':'delete-days','plan_id':op['plan_id'],'dates':['2030-01-05','2030-01-12']})
    assert len(delete['items'])==2
    failed=app.claim(delete['id'],'phone','k'*40)
    app.receipt(delete['id'],'phone','k'*40,failed['token'],{'item_id':failed['items'][0]['id'],'status':'failed','error_code':'provider_error'})
    assert len(calendar_store.list_events(since=datetime(2030,1,1,tzinfo=timezone.utc),before=datetime(2030,2,1,tzinfo=timezone.utc))['items'])==30
    item=failed['items'][1]
    app.receipt(delete['id'],'phone','k'*40,failed['token'],{'item_id':item['id'],'status':'succeeded','verification':'absent','system_id':item['system_id']})
    assert len(calendar_store.list_events(since=datetime(2030,1,1,tzinfo=timezone.utc),before=datetime(2030,2,1,tzinfo=timezone.utc))['items'])==29
    assert app.operation(delete['id'])['status']=='partial'


def test_native_credentials_ownership_and_unverified_results_are_rejected(calendar_store):
    from services.native_calendar import CalendarApplication
    app=CalendarApplication('owner');target=register(app)
    op=app.submit({'action':'create','target_id':target['id'],'request_id':'x','content':'运动','starts_at':'2030-01-01T08:00:00+08:00'})
    with pytest.raises(PermissionError):app.claim(op['id'],'phone','wrong')
    with pytest.raises(KeyError):CalendarApplication('other').operation(op['id'])
    claim=app.claim(op['id'],'phone','k'*40)
    with pytest.raises(ValueError):app.receipt(op['id'],'phone','k'*40,claim['token'],{'item_id':claim['items'][0]['id'],'status':'succeeded'})
    assert calendar_store.list_events()['items']==[]


async def test_native_api_cli_and_directed_websocket_complete_real_receipts(runtime,monkeypatch):
    import main
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from api import digital_person,native_calendar
    from services.native_calendar import CalendarApplication
    from services.tool_registry import WorkstepClient
    from cli import build_parser,dispatch
    import httpx
    rt,project,_=runtime
    monkeypatch.setattr(main,'digital_person_runtime',rt)
    monkeypatch.setattr(main,'project_manager',rt.projects)
    source=(await rt.main_session())['id']
    app=FastAPI();app.include_router(digital_person.router);app.websocket('/ws')(native_calendar.device_socket)
    app.dependency_overrides[digital_person.authorize]=lambda:None
    application=CalendarApplication('test-owner')
    monkeypatch.setattr(native_calendar,'application',lambda:application)
    monkeypatch.setattr('api.desktop_security.desktop_websocket_allowed',lambda _:asyncio.sleep(0,result=True))
    monkeypatch.setattr('api.remote_access_guard.websocket_access_allowed',lambda *_:True)
    transport=WorkstepClient(transport=httpx.ASGITransport(app=app))
    async def cli(*args):return await dispatch(build_parser().parse_args(['digital-hub','calendar',*args,'--json']),transport)
    with TestClient(app) as client:
        device=client.post('/api/digital-person/calendar/devices',json={'device_id':'phone','key':'k'*40,'name':'Phone','platform':'android','permission':'granted','calendars':[{'id':'cal','name':'Calendar'}]}).json()
        target=device['targets'][0]['id']
        with client.websocket_connect('/ws?calendar_device=1') as ws:
            ws.send_json({'device_id':'phone','key':'k'*40,'owner':'test-owner'})
            assert ws.receive_json()['type']=='ready'
            operation=await cli('create-batch','--target',target,'--start-date','2030-01-01','--end-date','2030-01-30','--time','08:00','--timezone','Asia/Shanghai','--content','运动','--request-id','api-batch','--project',project.id,'--session',source)
            assert operation['status']=='queued'
            assert ws.receive_json()=={'type':'operation_available','operation_id':operation['id']}
            endpoint='/api/digital-person/calendar/devices/phone/operations/'+operation['id']
            assert client.post(endpoint+'/claim',headers={'X-Calendar-Key':'wrong'}).status_code==403
            claimed=client.post(endpoint+'/claim',headers={'X-Calendar-Key':'k'*40}).json()
            for item in claimed['items']:
                response=client.post(endpoint+'/receipts',headers={'X-Calendar-Key':'k'*40},json={'token':claimed['token'],'receipt':{'item_id':item['id'],'status':'succeeded','verification':'present','system_id':item['id'],'system_revision':'native-version'}})
                assert response.status_code==200,response.text
            assert (await cli('operation','get','--id',operation['id']))['status']=='succeeded'
            from models.chat_session import ChatMessage
            assert await rt.projects.run_db(project.id,lambda _:ChatMessage.select().where(ChatMessage.content.contains('日程操作结果')).count())==1
            from services import digital_calendar
            assert digital_calendar.due(datetime(2030,2,1,tzinfo=timezone.utc))==[]
            deleted=await cli('delete-occurrences','--target',target,'--plan',operation['plan_id'],'--dates','2030-01-05,2030-01-12','--request-id','delete-api')
            assert len(deleted['items'])==2
        # Offline operations wait for explicit continuation instead of silently executing later.
        offline=await cli('create','--target',target,'--content','离线测试','--at','2030-01-01T08:00:00+08:00')
        assert offline['status']=='needs_device'


async def test_native_slow_storage_does_not_block_api(runtime,monkeypatch):
    import time
    import threading
    import httpx
    from fastapi import FastAPI
    from api import digital_person,native_calendar
    from services.native_calendar import CalendarApplication
    current,_,_=runtime
    monkeypatch.setattr(digital_person,'runtime',lambda:current)
    original=CalendarApplication.targets
    active=0;maximum=0;lock=threading.Lock()
    def slow(self):
        nonlocal active,maximum
        with lock:active+=1;maximum=max(maximum,active)
        try:time.sleep(.2);return original(self)
        finally:
            with lock:active-=1
    monkeypatch.setattr(CalendarApplication,'targets',slow)
    app=FastAPI();app.include_router(digital_person.router);app.dependency_overrides[digital_person.authorize]=lambda:None
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        tasks=[asyncio.create_task(client.get('/api/digital-person/calendar/targets')) for _ in range(8)]
        await asyncio.sleep(.02)
        assert (await asyncio.wait_for(client.get('/api/digital-person/identity'),.1)).status_code==200
        assert not all(task.done() for task in tasks)
        assert all(response.status_code==200 for response in await asyncio.gather(*tasks))
        assert maximum==2


async def test_native_host_endpoints_reject_project_identity(runtime,monkeypatch):
    from fastapi import FastAPI
    from api.digital_person import router
    from services.remote_access import ActorSnapshot,actor_context
    import httpx
    app=FastAPI();app.include_router(router)
    with actor_context(ActorSnapshot('user','User','device','Phone','remote',project_id='project',access_level='edit')):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            assert (await client.get('/api/digital-person/calendar/targets')).status_code==403
            assert (await client.post('/api/digital-person/calendar/devices',json={})).status_code==403
            assert (await client.post('/api/digital-person/calendar/operations',json={})).status_code==403


async def test_native_cancelled_request_keeps_io_slot_until_worker_stops():
    import threading
    from api.native_calendar import run
    active=0;maximum=0;lock=threading.Lock();release=threading.Event()
    def blocked():
        nonlocal active,maximum
        with lock:active+=1;maximum=max(maximum,active)
        try:release.wait(1)
        finally:
            with lock:active-=1
    tasks=[asyncio.create_task(run(blocked)) for _ in range(2)]
    try:
        async def entered():
            while active<2:await asyncio.sleep(.005)
        await asyncio.wait_for(entered(),.5)
        tasks[0].cancel()
        tasks.append(asyncio.create_task(run(blocked)))
        await asyncio.sleep(.03)
        assert maximum==2
    finally:
        release.set();await asyncio.gather(*tasks,return_exceptions=True)


def test_native_duration_reaches_device_and_verified_mirror(calendar_store):
    from services.native_calendar import CalendarApplication
    app=CalendarApplication('owner');target=register(app)
    op=app.submit({'action':'create','target_id':target['id'],'request_id':'duration-create','content':'跨日',
                   'starts_at':'2030-01-01T23:45:00+08:00','duration_minutes':95})
    def complete(op):
        claimed=app.claim(op['id'],'phone','k'*40);item=claimed['items'][0]
        app.receipt(op['id'],'phone','k'*40,claimed['token'],{'item_id':item['id'],'status':'succeeded',
                    'verification':'present','system_id':item.get('system_id','native-id')})
        return calendar_store.get(item['event_id'])
    assert op['items'][0]['duration_minutes']==95
    event=complete(op)
    assert event['duration_minutes']==95
    changed=app.submit({'action':'update','target_id':target['id'],'request_id':'duration-update',
                       'event_id':event['id'],'revision':event['revision'],
                       'draft':{'content':'修改结束','starts_at':event['starts_at'],'duration_minutes':125},'duration_minutes':125})
    assert changed['items'][0]['duration_minutes']==125
    event=complete(changed)
    assert event['duration_minutes']==125
    # Old clients omit the nested duration; the explicit operation duration still wins.
    changed=app.submit({'action':'update','target_id':target['id'],'request_id':'duration-legacy',
                       'event_id':event['id'],'revision':event['revision'],
                       'draft':{'content':'旧客户端','starts_at':event['starts_at']},'duration_minutes':180})
    assert complete(changed)['duration_minutes']==180
