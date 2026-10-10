import asyncio
import json
import time

import httpx
import pytest
from fastapi import FastAPI


@pytest.fixture
def notification_app(tmp_path, monkeypatch):
    from api import notification_hooks
    from services.project import ProjectManager
    from services.notification_hooks import NotificationHookService
    from streaming.bus import EventBus
    manager = ProjectManager()
    project = manager.init_project(tmp_path / 'project', name='演示项目')
    with manager.activate_project_by_id(project.id):
        flow = manager.create_workflow(project, name='研发流程', steps={'steps': [{'key': 'test', 'name': '测试', 'prompt': '测试'}]})
        from models import Task
        from models.fields import utc_now
        Task.create(id='task', title='修复登录校验', cwd=str(project.path), workflow_id=flow['id'], created_at=utc_now(), updated_at=utc_now())
    sent = []
    async def sender(hook, payload):
        sent.append((hook, payload))
    service = NotificationHookService(manager, EventBus(), sender=sender)
    monkeypatch.setattr(notification_hooks, 'service', service)
    app = FastAPI()
    app.include_router(notification_hooks.router)
    @app.get('/health')
    async def health(): return {'ok': True}
    yield app, manager, project, flow, service, sent
    manager.close_all()


async def save(client, project, flow, hooks):
    response = await client.put(f'/api/workflow/{flow["id"]}/notification-hooks', params={'project_id':project.id}, json={'hooks':hooks})
    assert response.status_code == 200, response.text
    return response.json()['hooks']


@pytest.mark.asyncio
async def test_crud_preview_events_dedupe_and_delivery(notification_app):
    app, manager, project, flow, service, sent = notification_app
    path = f'/api/workflow/{flow["id"]}/notification-hooks'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        hooks = await save(client, project, flow, [{'name':'研发群','platform':'generic','url':'https://receiver.example/hook','events':['completed','failed']}])
        hook = hooks[0]
        preview = await client.post(path+'/preview', params={'project_id':project.id}, json={'hook':hook,'event':'completed','title':'示例任务','step':'测试'})
        assert preview.status_code == 200 and preview.json()['payload']['event'] == 'completed'
        assert not sent
        event = {'type':'CUSTOM','name':'workstep.task_lifecycle','project_id':project.id,'task_id':'task','value':{'event':'completed','event_id':'run:completed'}}
        await service.capture(event)
        await service.capture(event)
        await service.capture({**event,'value':{'event':'started','event_id':'run:started'}})
        await service.deliver_due()
        assert len(sent) == 1 and sent[0][1]['task']['title'] == '修复登录校验'
        records = await client.get(path+f'/{hook["id"]}/deliveries', params={'project_id':project.id})
        assert records.status_code == 200 and len(records.json()['deliveries']) == 1
        assert records.json()['deliveries'][0]['status'] == 'sent'
        assert 'receiver.example' not in records.text
        await save(client, project, flow, [{**hook,'enabled':False}])
        await service.capture({**event,'value':{'event':'failed','event_id':'run:failed'}})
        await service.deliver_due()
        assert len(sent) == 1
        await save(client, project, flow, [])
        assert (await client.get(path+f'/{hook["id"]}/deliveries',params={'project_id':project.id})).status_code == 404


@pytest.mark.asyncio
async def test_restart_retry_platform_rejection_and_slow_io(notification_app, monkeypatch):
    from services.notification_hooks import NotificationHookService, DeliveryError
    from streaming.bus import EventBus
    app, manager, project, flow, service, sent = notification_app
    path = f'/api/workflow/{flow["id"]}/notification-hooks'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        hook = (await save(client, project, flow, [{'name':'群','platform':'generic','url':'https://receiver.example/hook','events':['failed']}]))[0]
        async def fail(hook, payload):
            await asyncio.sleep(.15)
            raise DeliveryError('连接超时', retryable=True)
        service.sender = fail
        await service.capture({'type':'CUSTOM','name':'workstep.task_lifecycle','project_id':project.id,'task_id':'task','value':{'event':'failed','event_id':'failure'}})
        pending = asyncio.create_task(service.deliver_due())
        await asyncio.sleep(.02)
        assert (await asyncio.wait_for(client.get('/health'), .1)).status_code == 200
        await pending
        rows = await service.records(project.id, flow['id'], hook['id'])
        assert rows[0]['status'] == 'pending' and rows[0]['attempts'] == 1
        from models.notification_hook import NotificationDelivery
        await manager.run_db(project.id, lambda _: NotificationDelivery.update(next_at=0).execute())
        restarted = NotificationHookService(manager, EventBus())
        restarted.sender = lambda h,p: asyncio.sleep(0)
        await restarted.deliver_due()
        assert (await restarted.records(project.id, flow['id'], hook['id']))[0]['status'] == 'sent'
        await service.capture({'type':'CUSTOM','name':'workstep.task_lifecycle','project_id':project.id,'task_id':'task','value':{'event':'failed','event_id':'retry-limit'}})
        for _ in range(4):
            await manager.run_db(project.id, lambda _: NotificationDelivery.update(next_at=0).where(NotificationDelivery.event_id=='retry-limit').execute())
            await service.deliver_due()
        exhausted=next(row for row in await service.records(project.id,flow['id'],hook['id']) if row['status']=='failed')
        assert exhausted['attempts']==4 and exhausted['result']=='连接超时'
        original = service.load_configuration
        def slow(*args):
            time.sleep(.15)
            return original(*args)
        monkeypatch.setattr(service,'load_configuration',slow)
        pending = asyncio.create_task(client.get(path,params={'project_id':project.id}))
        await asyncio.sleep(.02)
        assert (await asyncio.wait_for(client.get('/health'), .1)).status_code == 200
        assert (await pending).status_code == 200


@pytest.mark.asyncio
async def test_sender_signing_and_business_error():
    import base64
    import hashlib
    import hmac
    from urllib.parse import parse_qs
    from services.notification_hooks import send_notification, DeliveryError
    seen = []
    def receiver(request):
        seen.append(request)
        return httpx.Response(200,json={'errcode':310000,'errmsg':'secret echoed https://private/token'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(receiver)) as client:
        hook={'platform':'dingtalk','url':'https://oapi.dingtalk.com/robot/send?access_token=secret','secret':'SECtest'}
        with pytest.raises(DeliveryError) as error:
            await send_notification(hook, {'msgtype':'markdown','markdown':{'title':'通知','text':'测试'}}, client=client, now=123)
        assert 'private' not in str(error.value) and '310000' in str(error.value)
        query=parse_qs(seen[0].url.query.decode())
        expected=base64.b64encode(hmac.new(b'SECtest',b'123000\nSECtest',hashlib.sha256).digest()).decode()
        assert query['sign']==[expected] and query['timestamp']==['123000']

    from services.notification_delivery import notification_payload
    snapshot={'event':'completed','project':{'name':'演示项目'},'workflow':{'name':'研发流程'},'task':{'title':'字'*500},'step':None,'occurred_at':'2026-10-10','task_url':'https://gateway.example/workspace/device/tasks?task=task'}
    hook={'platform':'wecom','prefix':'通知','include_link':True,'url':'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo'}
    payload=notification_payload(hook,snapshot)
    assert len(payload['markdown']['content'].encode())<=4096
    assert '/workspace/device/' in payload['markdown']['content']
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _:httpx.Response(200,json={'errcode':0,'errmsg':'ok'}))) as client:
        await send_notification(hook,payload,client=client)
    generic=notification_payload({**hook,'platform':'generic','include_link':False},snapshot)
    assert generic['notification_title']=='通知 · 任务完成' and generic['task_url'] is None


@pytest.mark.asyncio
async def test_validation_scope_test_and_manual_retry(notification_app):
    from services.remote_access import ActorSnapshot, replayed_actor_context
    from services.notification_hooks import DeliveryError
    app, _, project, flow, service, _ = notification_app
    path=f'/api/workflow/{flow["id"]}/notification-hooks'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        response=await client.put(path,params={'project_id':project.id},json={'hooks':[{'name':'bad','platform':'dingtalk','url':'https://other.example/hook'}]})
        assert response.status_code==422
        hook=(await save(client,project,flow,[{'name':'通用','platform':'generic','url':'https://receiver.example/hook'}]))[0]
        result=await client.post(path+f'/{hook["id"]}/test',params={'project_id':project.id})
        assert result.status_code==202
        async def deny(hook,payload):raise DeliveryError('平台拒绝',retryable=False)
        service.sender=deny
        await service.deliver_due()
        rows=await service.records(project.id,flow['id'],hook['id'])
        assert rows[0]['status']=='failed' and rows[0]['event']=='test'
        retry=await client.post(path+f'/{hook["id"]}/deliveries/{rows[0]["id"]}/retry',params={'project_id':project.id})
        assert retry.status_code==202
        # Read-only published workspaces cannot read credentials or send messages.
        actor=ActorSnapshot(actor_id='viewer',user_name='viewer',device_id='device',device_name='device',project_id=project.id,access_level='read',source='managed')
        with replayed_actor_context(actor):
            assert (await client.get(path,params={'project_id':project.id})).status_code==403
            assert (await client.post(path+f'/{hook["id"]}/test',params={'project_id':project.id})).status_code==403


@pytest.mark.asyncio
async def test_real_workflow_lifecycle_and_step_events_reach_selected_targets(notification_app):
    from engines.core.registry import ENGINE_REGISTRY
    from services.workflow_runtime import WorkflowRuntime
    from services.remote_access import ActorSnapshot, replayed_actor_context
    from tests.test_workflow_runtime import RuntimeFakeEngine
    app, manager, project, flow, service, sent = notification_app
    original=ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY['notification-fake']=RuntimeFakeEngine
    runtime=WorkflowRuntime(service.bus,manager)
    try:
        await manager.run_db(project.id,lambda p:manager.update_workflow(p,flow['id'],steps={'steps':[{'key':'test','name':'测试','engine':'notification-fake','prompt':'测试','review':{'mode':'skip'}}]}))
        from models import Task
        await manager.run_db(project.id,lambda _:Task.update(engine='notification-fake').where(Task.id=='task').execute())
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            await save(client,project,flow,[{'name':'任务通知','platform':'generic','url':'https://receiver.example/one','events':['started','completed','failed']},
                                           {'name':'步骤通知','platform':'generic','url':'https://receiver.example/two','events':['step_completed','step_failed']}])
        await service.start()
        actor=ActorSnapshot(actor_id='test-user',user_name='测试',device_id='test-device',device_name='测试设备',source='browser')
        with replayed_actor_context(actor):
            handle=await runtime.start(project.id,'task','')
            await runtime.wait(handle)
        for _ in range(200):
            if len(sent)==3:break
            await asyncio.sleep(.01)
        assert sorted(payload['event'] for _,payload in sent)==['completed','started','step_completed']
        assert len({payload['event_id'] for _,payload in sent})==3
    finally:
        await service.shutdown()
        await runtime.shutdown()
        ENGINE_REGISTRY.clear();ENGINE_REGISTRY.update(original)
