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
async def test_step_notification_uses_task_custom_stage_title(notification_app):
    from models import Task
    from services.task_workflow import build_overrides, canonical_workflow

    app, manager, project, flow, service, sent = notification_app

    def customize(_project):
        edited = canonical_workflow(flow['steps'])
        edited['nodes'][0]['title'] = '任务专用测试'
        Task.update(workflow_overrides_json=json.dumps(build_overrides(flow['steps'], edited))).where(Task.id == 'task').execute()

    await manager.run_db(project.id, customize)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        await save(client, project, flow, [{'name':'步骤通知','url':'https://receiver.example/hook','events':['step_completed']}])
    await service.capture({'type':'CUSTOM','name':'workstep.status','project_id':project.id,'task_id':'task','step_key':'test','value':{'status':'passed'}})
    await service.deliver_due()
    assert sent[0][1]['step'] == {'key':'test','name':'任务专用测试'}


@pytest.mark.asyncio
async def test_templates_persist_per_target_preview_and_delivery_share_renderer(notification_app):
    app, manager, project, flow, service, sent = notification_app
    path = f'/api/workflow/{flow["id"]}/notification-hooks'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        first, second = await save(client,project,flow,[
            {'name':'钉钉','platform':'dingtalk','url':'https://oapi.dingtalk.com/robot/send?access_token=demo','include_link':False,
             'markdown_template':'**{event_name}**\n\n{task_title}'},
            {'name':'企业微信','platform':'wecom','url':'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=demo',
             'markdown_template':'{project_name} · {event_name}'},
        ])
        configuration = (await client.get(path,params={'project_id':project.id})).json()
        assert '{notification_title}' in configuration['default_markdown_template']
        assert 'time' in configuration['template_variables']
        assert first['markdown_template'] != second['markdown_template']
        preview = await client.post(path+'/preview',params={'project_id':project.id},json={'hook':first,'event':'completed','title':'修复登录校验'})
        assert preview.status_code == 200 and not sent
        await service.capture({'type':'CUSTOM','name':'workstep.task_lifecycle','project_id':project.id,'task_id':'task','value':{'event':'completed','event_id':'templated'}})
        await service.deliver_due()
        first_payload = next(payload for hook,payload in sent if hook['id']==first['id'])
        assert first_payload == preview.json()['payload']
        assert next(payload for hook,payload in sent if hook['id']==second['id'])['markdown']['content'] == '演示项目 · 任务完成'
        # A pending test/retry uses the template saved at send time.
        await service.test(project.id,flow['id'],first['id'])
        first,second = await save(client,project,flow,[{**first,'markdown_template':'新版：{event_name}'},second])
        await service.deliver_due()
        assert sent[-1][1]['markdown']['text'] == '新版：测试通知'
        restored = await save(client,project,flow,[{**first,'markdown_template':None},second])
        assert restored[0]['markdown_template'] is None
        await service.test(project.id,flow['id'],first['id'])
        await service.deliver_due()
        assert '**事件：测试通知**' in sent[-1][1]['markdown']['text']
        assert await manager.run_db(project.id,lambda _: __import__('models').Task.select().count()) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('template', ['', '   ', '{unknown}', '{task.title}', '{time.__class__}', 'x'*8001])
async def test_invalid_templates_fail_before_saving_or_previewing(notification_app, template):
    app, _, project, flow, _, sent = notification_app
    hook = {'name':'钉钉','platform':'dingtalk','url':'https://oapi.dingtalk.com/robot/send?access_token=demo','markdown_template':template}
    path = f'/api/workflow/{flow["id"]}/notification-hooks'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        assert (await client.put(path,params={'project_id':project.id},json={'hooks':[hook]})).status_code == 422
        assert (await client.post(path+'/preview',params={'project_id':project.id},json={'hook':hook})).status_code == 422
    assert not sent


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
        service.sender = lambda h,p: asyncio.sleep(0)
        await service.deliver_due()
        delivered = (await service.records(project.id,flow['id'],hook['id']))[0]
        assert delivered['status'] == 'sent' and delivered['attempts'] == 2
        assert (await client.post(path+f'/{hook["id"]}/deliveries/{rows[0]["id"]}/retry',params={'project_id':project.id})).status_code == 409
        from models import Task
        assert await service.manager.run_db(project.id, lambda _: Task.select().count()) == 1
        await save(client, project, flow, [{**hook,'enabled':False}])
        assert (await client.post(path+f'/{hook["id"]}/test',params={'project_id':project.id})).status_code == 409
        # Read-only published workspaces cannot read credentials or send messages.
        actor=ActorSnapshot(actor_id='viewer',user_name='viewer',device_id='device',device_name='device',project_id=project.id,access_level='read',source='managed')
        with replayed_actor_context(actor):
            assert (await client.get(path,params={'project_id':project.id})).status_code==403
            assert (await client.post(path+f'/{hook["id"]}/test',params={'project_id':project.id})).status_code==403


@pytest.mark.asyncio
@pytest.mark.parametrize('scenario,expected', [
    ('completed', ['completed', 'started', 'step_completed']),
    ('failed', ['failed', 'started', 'step_failed']),
    ('paused', ['paused', 'started']),
    ('stopped', ['started', 'stopped']),
    ('manual', ['paused', 'started', 'waiting']),
    ('complete_task', ['completed', 'paused', 'started', 'step_completed', 'waiting']),
    ('terminate', ['paused', 'started', 'stopped', 'waiting']),
])
async def test_real_workflow_lifecycle_and_step_events_reach_selected_targets(notification_app, scenario, expected):
    from engines.core.registry import ENGINE_REGISTRY
    from services.workflow_runtime import WorkflowRuntime
    from services.remote_access import ActorSnapshot, replayed_actor_context
    from tests.test_workflow_runtime import RuntimeFakeEngine
    app, manager, project, flow, service, sent = notification_app
    entered = asyncio.Event()
    released = asyncio.Event()
    class ScenarioEngine(RuntimeFakeEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            entered.set()
            if scenario == 'failed':
                raise RuntimeError('simulated engine failure')
            if scenario in {'paused', 'stopped'}:
                await released.wait()
            async for event in super().spawn(prompt, cwd, **kwargs):
                yield event

        async def stop(self):
            released.set()

    original=ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY['notification-fake']=ScenarioEngine
    runtime=WorkflowRuntime(service.bus,manager)
    try:
        review_mode = 'manual' if scenario in {'manual', 'complete_task', 'terminate'} else 'skip'
        await manager.run_db(project.id,lambda p:manager.update_workflow(p,flow['id'],steps={'steps':[{'key':'test','name':'测试','engine':'notification-fake','prompt':'测试','review':{'mode':review_mode}}]}))
        from models import Task
        await manager.run_db(project.id,lambda _:Task.update(engine='notification-fake').where(Task.id=='task').execute())
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            await save(client,project,flow,[{'name':'任务通知','platform':'generic','url':'https://receiver.example/one','events':['started','completed','failed','paused','stopped']},
                                           {'name':'步骤通知','platform':'generic','url':'https://receiver.example/two','events':['step_completed','step_failed','waiting']}])
        await service.start()
        actor=ActorSnapshot(actor_id='test-user',user_name='测试',device_id='test-device',device_name='测试设备',source='browser')
        with replayed_actor_context(actor):
            handle=await runtime.start(project.id,'task','')
            if scenario in {'paused', 'stopped'}:
                await asyncio.wait_for(entered.wait(), 2)
                assert await runtime.cancel('task', action='task.pause' if scenario == 'paused' else 'task.cancel')
            await asyncio.wait_for(runtime.wait(handle), 3)
            if scenario in {'complete_task', 'terminate'}:
                from models import ReviewRun
                review_id = await manager.run_db(project.id, lambda _: ReviewRun.select().get().id)
                await runtime.decide_review(project.id, 'task', 'test', review_id, scenario)
        for _ in range(200):
            if len(sent)==len(expected):break
            await asyncio.sleep(.01)
        assert sorted(payload['event'] for _,payload in sent)==expected
        assert len({payload['event_id'] for _,payload in sent})==len(expected)
        for hook, payload in sent:
            assert payload['event'] in hook['events']
            assert hook['url'].endswith('/two' if payload['step'] else '/one')
            if payload['step']:
                assert payload['step']['name'] == '测试'
    finally:
        await service.shutdown()
        await runtime.shutdown()
        ENGINE_REGISTRY.clear();ENGINE_REGISTRY.update(original)


@pytest.mark.asyncio
@pytest.mark.parametrize('change', ['disable', 'unsubscribe', 'delete_workflow', 'change_url'])
async def test_queued_delivery_rechecks_configuration_before_sending(notification_app, change):
    from models.notification_hook import NotificationDelivery
    app, manager, project, flow, service, sent = notification_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        hook = (await save(client, project, flow, [{'name':'目标','url':'https://receiver.example/old'}]))[0]
        await service.capture({'type':'CUSTOM','name':'workstep.task_lifecycle','project_id':project.id,'task_id':'task','value':{'event':'completed','event_id':'queued'}})
        service.send_slots = asyncio.Semaphore(0)
        delivery = asyncio.create_task(service.deliver_due())
        try:
            for _ in range(100):
                rows = await service.records(project.id, flow['id'], hook['id'])
                if rows[0]['status'] == 'sending': break
                await asyncio.sleep(.01)
            assert rows[0]['status'] == 'sending'
            if change == 'delete_workflow':
                await manager.run_db(project.id, lambda p: manager.create_workflow(p, name='保留流程'))
                deleted = await manager.run_db(project.id, lambda p: manager.delete_workflow(p, flow['id']))
                assert deleted['deleted']
            else:
                patch = {'enabled':False} if change == 'disable' else {'events':['failed']} if change == 'unsubscribe' else {'url':'https://receiver.example/new'}
                await save(client, project, flow, [{**hook, **patch}])
            service.send_slots.release()
            await asyncio.wait_for(delivery, 2)
            record = await manager.run_db(project.id, lambda _: dict(NotificationDelivery.get().__data__))
            if change == 'change_url':
                assert len(sent) == 1 and sent[0][0]['url'] == 'https://receiver.example/new'
                assert record['status'] == 'sent'
            else:
                assert not sent
                assert record['status'] == 'skipped' and record['claim_id'] is None
        finally:
            delivery.cancel()
            await asyncio.gather(delivery, return_exceptions=True)


@pytest.mark.asyncio
async def test_expired_send_lease_recovers_without_duplicate_concurrent_claims(notification_app):
    from models.notification_hook import NotificationDelivery
    from services.notification_hooks import NotificationHookService
    app, manager, project, flow, service, sent = notification_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        hook = (await save(client, project, flow, [{'name':'目标','url':'https://receiver.example/hook'}]))[0]
        await service.test(project.id, flow['id'], hook['id'])
    await manager.run_db(project.id, lambda _: NotificationDelivery.update(status='sending',attempts=1,cycle_attempts=1,claim_id='crashed-worker',next_at=time.time()+120).execute())
    restarted = NotificationHookService(manager, service.bus, sender=service.sender)
    await restarted.deliver_due()
    assert not sent  # A still-valid claim must not be stolen.
    await manager.run_db(project.id, lambda _: NotificationDelivery.update(next_at=0).execute())
    await asyncio.gather(service.deliver_due(), restarted.deliver_due())
    assert len(sent) == 1
    records = await restarted.records(project.id, flow['id'], hook['id'])
    assert records[0]['status'] == 'sent' and records[0]['attempts'] == 2


@pytest.mark.asyncio
async def test_interaction_waiting_events_dedupe_and_ignore_other_channels(notification_app):
    app, _, project, flow, service, sent = notification_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        await save(client, project, flow, [{'name':'等待通知','url':'https://receiver.example/hook','events':['waiting','step_completed']}])
    event = {'type':'CUSTOM','name':'workstep.interaction_request','channel':'execution','project_id':project.id,'task_id':'task','step_key':'test','value':{'interaction_id':'question-1'}}
    await service.capture(event)
    await service.capture(event)
    await service.capture({**event,'value':{'interaction_id':'question-2'}})
    await service.capture({**event,'channel':'coordinator','value':{'interaction_id':'question-3'}})
    await service.capture({**event,'name':'workstep.status','value':{'status':'done'}})
    await service.capture({**event,'name':'workstep.status','value':{'status':'skipped'}})
    await service.deliver_due()
    assert len(sent) == 2
    assert all(payload['event'] == 'waiting' and payload['step'] == {'key':'test','name':'测试'} for _,payload in sent)


@pytest.mark.asyncio
async def test_workflow_scope_and_atomic_save_reject_foreign_hook(notification_app):
    app, manager, project, flow, service, _ = notification_app
    other = await manager.run_db(project.id, lambda p: manager.create_workflow(p, name='另一流程'))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        first = (await save(client, project, flow, [{'name':'原目标','url':'https://receiver.example/one'}]))[0]
        second = (await save(client, project, other, [{'name':'另一目标','url':'https://receiver.example/two'}]))[0]
        path = f'/api/workflow/{flow["id"]}/notification-hooks'
        response = await client.put(path, params={'project_id':project.id}, json={'hooks':[{**first,'name':'不应保存'},second]})
        assert response.status_code == 422
        assert (await service.configuration(project.id,flow['id']))['hooks'][0]['name'] == '原目标'
        response = await client.put(path, params={'project_id':project.id}, json={'hooks':[first, first]})
        assert response.status_code == 422
        assert (await client.get(path+f'/{second["id"]}/deliveries',params={'project_id':project.id})).status_code == 404
        assert (await client.post(path+f'/{second["id"]}/test',params={'project_id':project.id})).status_code == 404


@pytest.mark.asyncio
async def test_delivery_database_work_does_not_block_health(notification_app, monkeypatch):
    import threading
    app, manager, project, flow, service, sent = notification_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        hook = (await save(client, project, flow, [{'name':'目标','url':'https://receiver.example/hook'}]))[0]
        await service.test(project.id, flow['id'], hook['id'])
        started = threading.Event()
        original = project.db.execute_sql
        def slow(sql, *args, **kwargs):
            if 'notification_hooks' in sql and not started.is_set():
                started.set()
                time.sleep(.2)
            return original(sql, *args, **kwargs)
        monkeypatch.setattr(project.db, 'execute_sql', slow)
        pending = asyncio.create_task(service.deliver_due())
        assert await asyncio.to_thread(started.wait, 1)
        assert (await asyncio.wait_for(client.get('/health'), .1)).status_code == 200
        await asyncio.wait_for(pending, 2)
        assert len(sent) == 1
