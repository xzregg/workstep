import asyncio
import time

from fastapi.testclient import TestClient
from sqlalchemy import update

from gateway.app import create_app
from gateway.config import GatewaySettings
from gateway.models import Device, UserDevice
from starlette.websockets import WebSocketDisconnect
import pytest
from datetime import datetime, timezone


def test_cross_device_notifications_deduplicate_persist_and_check_current_access(tmp_path):
    settings = GatewaySettings(data_dir=tmp_path,public_origin='https://gateway.test')
    with TestClient(create_app(settings),base_url='https://gateway.test') as client:
        setup = client.post('/api/platform/setup', json=dict(username='owner', display_name='Owner',
            password='OwnerPassphrase-2026!', recovery_username='recovery',
            recovery_password='RecoveryPassphrase-2026!', registration_mode='open')).json()
        setup = client.post('/api/auth/register', json=dict(username='reader', display_name='Reader',
            password='ReaderPassphrase-2026!')).json()
        async def seed():
            async with client.app.state.database.session() as session:
                async with session.begin():
                    for id in ('one','two','hidden'):
                        session.add(Device(id=id,name=id,public_key='test',status='active',app_instance_id=id,version='1'))
                    for id in ('one','two'):
                        session.add(UserDevice(id=id,user_id=setup['user']['id'],device_id=id,access_level='edit'))
        client.portal.call(seed)
        event = dict(type='TEXT_MESSAGE_END',status='succeeded',project_id='project',
                     task_id='task',messageId='message',recorded_at=time.time())
        async def collect():
            for id in ('one','two','hidden'):
                await client.app.state.notifications.record(id, 'project', '演示项目', [event,event])
        client.portal.call(collect)
        monkeypatch = pytest.MonkeyPatch()
        monkeypatch.setattr(client.app.state.control_connections,'is_online',lambda id:True)
        data = client.get('/api/notifications').json()
        assert len(data['events']) == data['unread'] == 2
        assert {item['device_id'] for item in data['events']} == {'one','two'}
        assert all('message' not in item for item in data['events'])
        access=client.get('/api/notifications/'+str(data['events'][0]['sequence'])+'/access').json()
        assert access['next'].startswith('tasks?') and 'task=task' in access['next']
        assert access['url'].endswith('/workspace/'+data['events'][0]['device_id']+'/')
        redeem='/workspace/'+data['events'][0]['device_id']+'/api/remote/redeem'
        assert client.post(redeem,data={'ticket':access['ticket'],'next':'//other.test/'},follow_redirects=False).status_code==422
        entered=client.post(redeem,data={'ticket':access['ticket'],'next':access['next']},follow_redirects=False)
        assert entered.status_code==303
        assert entered.headers['location'].startswith('/workspace/'+data['events'][0]['device_id']+'/tasks?')
        assert client.post(redeem,data={'ticket':access['ticket'],'next':access['next']},follow_redirects=False).status_code==409
        assert client.get('/api/notifications/999/access').status_code == 404
        assert client.post('/api/notifications/read',json={'through':data['cursor']}).status_code == 403
        assert client.post('/api/notifications/read',headers={'X-CSRF-Token':setup['csrf_token']},json={'through':data['cursor']}).status_code == 200
        assert client.get('/api/notifications').json()['unread'] == 0
        async def revoke():
            async with client.app.state.database.session() as session:
                async with session.begin():
                    await session.execute(update(UserDevice).where(UserDevice.device_id=='two').values(revoked_at=datetime.now(timezone.utc)))
        client.portal.call(revoke)
        assert {e['device_id'] for e in client.get('/api/notifications').json()['events']} == {'one'}
        cookie = client.cookies.get('workstep_gateway_session')
        monkeypatch.undo()
    with TestClient(create_app(settings),base_url='https://gateway.test') as restarted:
        restarted.cookies.set('workstep_gateway_session',cookie)
        assert len(restarted.get('/api/notifications').json()['events']) == 1
        assert restarted.get('/api/notifications').json()['unread'] == 0


@pytest.mark.parametrize('path', ['/ws/notifications', '/api/notifications/ws'])
def test_notification_websocket_uses_one_authenticated_feed_and_survives_idle(tmp_path, path):
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)),base_url='https://gateway.test') as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('wss://gateway.test'+path):
                pass
        client.post('/api/platform/setup',json=dict(username='owner',display_name='Owner',password='OwnerPassphrase-2026!',
            recovery_username='recovery',recovery_password='RecoveryPassphrase-2026!',registration_mode='open'))
        with client.websocket_connect('wss://gateway.test'+path,headers={'origin':'https://gateway.test'}) as ws:
            data = ws.receive_json()
            assert data['type'] == 'notifications' and data['unread'] == 0
            ws.send_json({'type':'ping'})
            assert ws.receive_json()['type'] == 'pong'


def test_shared_device_collector_uses_existing_scoped_recent_api_and_keeps_loop_responsive(tmp_path,monkeypatch):
    from gateway.contracts import StreamPayload
    import json
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)),base_url='https://gateway.test') as client:
        setup=client.post('/api/platform/setup',json=dict(username='owner',display_name='Owner',password='OwnerPassphrase-2026!',
            recovery_username='recovery',recovery_password='RecoveryPassphrase-2026!',registration_mode='open')).json()
        async def seed():
            async with client.app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id='one',name='one',public_key='test',status='active',app_instance_id='one',version='1'))
                    session.add(UserDevice(id='one',user_id=setup['user']['id'],device_id='one',access_level='edit'))
        client.portal.call(seed)
        calls=[]
        started=__import__('threading').Event()
        class Data:
            async def proxy_http(self,call,**kwargs):
                assert kwargs['project_id']=='project' and kwargs['access_level']=='read'
                calls.append(call.target.path)
                async def chunks():
                    started.set()
                    await asyncio.sleep(0.15)
                    if call.target.path.endswith('/recent'):
                        yield json.dumps(dict(events=[dict(type='TEXT_MESSAGE_END',status='succeeded',project_id='project',
                            task_id='task',messageId='message',recorded_at=time.time())])).encode()
                    else: yield b'{"title":"Test task"}'
                return StreamPayload(chunks())
        async def catalog(id): return [dict(id='project',name='Demo')]
        async def data(id): return Data()
        controls=client.app.state.control_connections
        monkeypatch.setattr(controls,'request_project_catalog',catalog)
        monkeypatch.setattr(controls,'request_data',data)
        service=client.app.state.notifications
        future=client.portal.start_task_soon(service.collect_device,'one',setup['user']['id'])
        assert started.wait(1)
        start=time.monotonic()
        assert client.get('/api/health').status_code==200
        assert time.monotonic()-start<0.1
        future.result(2)
        assert client.get('/api/notifications').json()['events'][0]['scope_name']=='Test task'
        client.portal.call(service.collect_device,'one',setup['user']['id'])
        assert len(client.get('/api/notifications').json()['events'])==1
        assert calls.count('/api/task/task')==1


def test_project_group_permissions_and_slow_sql_canary(tmp_path):
    import sqlite3
    from gateway.models import UserGroup,GroupMembership,PlatformProject,ProjectAccessGrant
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path)),base_url='https://gateway.test') as client:
        owner=client.post('/api/platform/setup',json=dict(username='owner',display_name='Owner',password='OwnerPassphrase-2026!',
            recovery_username='recovery',recovery_password='RecoveryPassphrase-2026!',registration_mode='open')).json()['user']['id']
        reader=client.post('/api/auth/register',json=dict(username='reader',display_name='Reader',password='ReaderPassphrase-2026!')).json()['user']['id']
        async def seed():
            async with client.app.state.database.session() as session:
                async with session.begin():
                    session.add(Device(id='one',name='one',public_key='test',status='active',app_instance_id='one',version='1'))
                    session.add(UserGroup(id='g',slug='g',name='Group',created_by_user_id=owner))
                    session.add(GroupMembership(id='gm',group_id='g',user_id=reader))
                    session.add(PlatformProject(id='p',device_id='one',host_project_id='allowed',name='Allowed',access_mode='remote_published'))
                    session.add(ProjectAccessGrant(id='grant',project_id='p',subject_type='group',subject_id='g',access_level='read'))
        client.portal.call(seed)
        async def record(project,message='m'):
            await client.app.state.notifications.record('one',project,project,[dict(type='TEXT_MESSAGE_END',project_id=project,
                task_id='task',messageId=message,status='succeeded',recorded_at=time.time())])
        client.portal.call(record,'allowed')
        client.portal.call(record,'hidden')
        events=client.get('/api/notifications').json()['events']
        assert [e['host_project_id'] for e in events]==['allowed']
        with sqlite3.connect(tmp_path/'workstep_platform.db') as locked:
            locked.execute('BEGIN IMMEDIATE')
            future=client.portal.start_task_soon(record,'allowed','locked-write')
            time.sleep(0.05)
            assert not future.done()
            start=time.monotonic()
            assert client.get('/api/health').status_code==200
            assert time.monotonic()-start<0.2
            locked.rollback()
        future.result(2)
        async def revoke():
            async with client.app.state.database.session() as session:
                async with session.begin():
                    await session.execute(update(UserGroup).where(UserGroup.id=='g').values(status='deleted'))
        client.portal.call(revoke)
        assert client.get('/api/notifications').json()['events']==[]


def test_two_hundred_device_sources_are_collected_once_with_bounded_parallelism():
    from gateway.services.notifications import NotificationService
    async def verify():
        service=NotificationService(None,None,None)
        completed=[]
        active=peak=0
        async def collect(device_id,user_id):
            nonlocal active,peak
            active+=1
            peak=max(peak,active)
            await asyncio.sleep(0.002)
            completed.append(device_id)
            active-=1
        service._collect_device=collect
        queue=asyncio.Queue(maxsize=1)
        service.listeners.add(queue)
        for _ in range(1000): service.wake()
        assert queue.qsize()==1
        await asyncio.gather(*(service.collect_device(str(i),'owner') for i in range(200)))
        assert len(set(completed))==200
        assert peak==8
    asyncio.run(verify())


def test_old_android_root_websocket_and_recent_keep_terminal_event_protocol(tmp_path,monkeypatch):
    with TestClient(create_app(GatewaySettings(data_dir=tmp_path,public_origin='https://gateway.test')),base_url='https://gateway.test') as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('wss://gateway.test/ws'): pass
        owner=client.post('/api/platform/setup',json=dict(username='owner',display_name='Owner',password='OwnerPassphrase-2026!',
            recovery_username='recovery',recovery_password='RecoveryPassphrase-2026!',registration_mode='open')).json()['user']['id']
        owner=client.post('/api/auth/register',json=dict(username='reader',display_name='Reader',
            password='ReaderPassphrase-2026!')).json()['user']['id']
        async def seed():
            async with client.app.state.database.session() as session:
                async with session.begin():
                    for device in ('one','two','hidden'):
                        session.add(Device(id=device,name=device,public_key='test',status='active',app_instance_id=device,version='1'))
                    for device in ('one','two'):
                        session.add(UserDevice(id=device,user_id=owner,device_id=device,access_level='edit'))
        client.portal.call(seed)
        async def record(device,message):
            await client.app.state.notifications.record(device,'project','Demo',[dict(type='TEXT_MESSAGE_END',status='succeeded',
                project_id='project',task_id='task',messageId=message,sequence=7,recorded_at=time.time())])
        client.portal.call(record,'one','old')
        client.portal.call(record,'hidden','private')
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('wss://gateway.test/ws',headers={'origin':'https://other.test'}): pass
        with client.websocket_connect('wss://gateway.test/ws') as ws:
            ws.send_json(dict(type='subscribe',project_id='gateway/one/project',task_ids=['task'],session_ids=[]))
            ws.send_json({'type':'ping'})
            assert ws.receive_json()['type']=='pong'
            client.portal.call(record,'two','wrong-device')
            client.portal.call(record,'one','new')
            event=ws.receive_json()
            assert event['type']=='TEXT_MESSAGE_END' and event['messageId']=='new'
            assert event['project_id']=='gateway/one/project' and event['sequence']==7
            assert event['device_id']=='one' and 'recorded_at' in event and 'events' not in event
        recent=client.get('/api/completion-notifications/recent',params={'project_id':'gateway/one/project'}).json()['events']
        assert {event['messageId'] for event in recent}=={'old','new'}
        assert client.get('/api/completion-notifications/recent',params={'project_id':'gateway/hidden/project'}).json()['events']==[]
        monkeypatch.setattr(client.app.state.control_connections,'is_online',lambda id:True)
        access=client.get('/api/completion-notifications/access',params={'project_id':'gateway/one/project','task_id':'task'}).json()
        assert access['url'].endswith('/workspace/one/') and 'task=task' in access['next']
        assert client.get('/api/completion-notifications/access',params={'project_id':'gateway/hidden/project','task_id':'task'}).status_code==404
