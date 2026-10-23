"""Schedule notification defaults, isolation, delivery and retry."""
import asyncio
import json
from types import SimpleNamespace
import pytest

@pytest.fixture
def setup_notifications(tmp_path, monkeypatch):
    from services.project import ProjectManager
    from services.config import config_store
    from services.schedule import ScheduleModule
    from models import Task, ChatSession
    from models.fields import utc_now
    manager = ProjectManager()
    project = manager.init_project(tmp_path / 'project')
    other = manager.init_project(tmp_path / 'other')
    workflow = manager.create_workflow(project, name='测试', steps={'nodes': []})
    data = {'bots': [{'id':'bot','name':'机器人','platform':'dingtalk','enabled':True}],
            'groups': [{'bot_id':'bot','group_id':'group','group_name':'绑定群','project_id':project.id,'task_id':'bound'}],
            'sessions': {'bot:group:session-group':'session'}, 'session_sources': {}}
    original = config_store.get
    monkeypatch.setattr(config_store, 'get', lambda key, default=None: data if key=='channel_bots' else original(key, default))
    with manager.activate_project_by_id(project.id):
        for tid in ['bound','unbound']:
            Task.create(id=tid,title=tid,cwd=str(project.path),created_at=utc_now(),updated_at=utc_now())
        ChatSession.create(id='session',project_id=project.id,workflow_id=workflow['id'],engine='codex',cwd=str(project.path),title='项目会话',created_at=utc_now(),updated_at=utc_now())
    module = ScheduleModule(manager,None,None)
    def create(tid='bound', **kwargs):
        return module.create(project.id,name='通知',target_type='task',target_task_id=tid,instruction='汇报',
            rule={'kind':'minutes','every':10,'timezone':'UTC'}, **kwargs)
    yield SimpleNamespace(manager=manager,project=project,other=other,workflow=workflow,data=data,module=module,create=create)
    manager.close_all()

def test_notification_defaults_and_explicit_override(setup_notifications):
    s=setup_notifications
    bound=s.create()
    assert bound['notification']=={'enabled':True,'target':{'bot_id':'bot','group_id':'group'}}
    assert s.create('unbound')['notification']=={'enabled':False}
    assert s.create(notification={'enabled':False})['notification']=={'enabled':False}
    project=s.module.create(s.project.id,name='创建',workflow_id=s.workflow['id'],task_template={'title':'新任务'},rule={'kind':'daily','time':'09:00','timezone':'UTC'})
    assert project['notification']=={'enabled':False}
    changed=s.module.update(s.project.id,bound['id'],notification={'enabled':True,'target':{'session_id':'session'}})
    assert changed['notification']['target']=={'session_id':'session'}
    assert s.module.update(s.project.id,bound['id'],instruction='新指令')['notification']==changed['notification']

@pytest.mark.parametrize('target', [{'session_id':'missing'},{'bot_id':'bot','group_id':'foreign'},{'session_id':'session','bot_id':'bot'}])
def test_notification_rejects_unknown_or_ambiguous_destination(setup_notifications,target):
    from services.schedule import ScheduleValidationError
    with pytest.raises(ScheduleValidationError):
        setup_notifications.create(notification={'enabled':True,'target':target})

@pytest.mark.anyio
async def test_notification_delivers_once_and_retry_does_not_rerun_task(setup_notifications):
    from models import ScheduleRun, CoordinatorTurn, Message
    from models.fields import utc_now
    from services.schedule_notifications import deliver_notification
    s=setup_notifications;rule=s.create();calls=[]
    class Sender:
        async def send_message(self, **kwargs):
            calls.append(kwargs)
            await asyncio.sleep(.03)
            if len(calls)==1: raise RuntimeError('发送失败')
            return {'sent':True}
    s.module._notification_sender=Sender()
    with s.manager.activate_project_by_id(s.project.id):
        user=Message.create(id='user',task='bound',role='user',step_key='coordinator',position=0,content='汇报',created_at=utc_now())
        assistant=Message.create(id='assistant',task='bound',role='assistant',step_key='coordinator',position=1,content='进度50%',created_at=utc_now())
        turn=CoordinatorTurn.create(id='turn',task='bound',user_message=user,assistant_message=assistant,idempotency_key='key',status='succeeded',created_at=utc_now())
        ScheduleRun.create(id='run',schedule=rule['id'],task_id='bound',coordinator_turn_id=turn.id,status='succeeded',scheduled_for=utc_now(),created_at=utc_now(),notification_json=json.dumps(rule['notification']))
    await asyncio.gather(deliver_notification(s.module,s.project.id,'run'),deliver_notification(s.module,s.project.id,'run'))
    assert len(calls)==1
    assert '进度50%' in calls[0]['text']
    with s.manager.activate_project_by_id(s.project.id):
        row=ScheduleRun.get_by_id('run');assert row.status=='succeeded';assert row.notification_status=='failed'
    s.module.update(s.project.id,rule['id'],notification={'enabled':False})
    await deliver_notification(s.module,s.project.id,'run',retry=True)
    assert calls[-1]['bot_id']=='bot' and calls[-1]['group_id']=='group'
    await deliver_notification(s.module,s.project.id,'run',retry=True)
    assert len(calls)==2
    with s.manager.activate_project_by_id(s.project.id):
        assert ScheduleRun.get_by_id('run').notification_status=='sent'
        assert CoordinatorTurn.select().count()==1


@pytest.mark.anyio
async def test_real_project_creation_sends_immediately_without_workflow_completion(setup_notifications):
    from models import ScheduleRun
    from models.fields import utc_now
    from services.task import TaskService
    from services.channels.sender import ChannelMessageSender
    s=setup_notifications;sent=[]
    class Adapter:
        async def send_text(self, recipient, text): sent.append((recipient,text))
    async def load(): return s.data
    sender=ChannelMessageSender(s.manager,load,{'bot':Adapter()})
    s.module._notification_sender=SimpleNamespace(send_message=sender.send)
    s.module._tasks=TaskService(None)
    rule=s.module.create(s.project.id,name='创建后立即通知',workflow_id=s.workflow['id'],task_template={'title':'通知测试任务'},
        execution_mode='manual',rule={'kind':'daily','time':'09:00','timezone':'UTC'},notification={'enabled':True,'target':{'session_id':'session'}})
    with s.manager.activate_project_by_id(s.project.id):
        ScheduleRun.create(id='creation',schedule=rule['id'],scheduled_for=utc_now(),created_at=utc_now())
    await s.module._execute_run(s.project.id,'creation')
    assert len(sent)==1 and '通知测试任务' in sent[0][1] and '任务入口：http' in sent[0][1]
    with s.manager.activate_project_by_id(s.project.id):
        run=ScheduleRun.get_by_id('creation')
        assert run.status=='created' and run.notification_status=='sent'
        assert run.workflow_run_id is None


@pytest.mark.anyio
async def test_notification_api_defaults_validation_and_slow_sql_canary(setup_notifications,monkeypatch):
    import main, threading, time
    from fastapi import FastAPI
    from httpx import AsyncClient,ASGITransport
    from api.schedule import router
    s=setup_notifications
    monkeypatch.setattr(main,'project_manager',s.manager)
    monkeypatch.setattr(main,'schedule_module',s.module)
    app=FastAPI();app.include_router(router)
    @app.get('/health')
    async def health(): return {'ok':True}
    started=threading.Event();real=s.project.db.execute_sql
    def slow(sql,*args,**kwargs):
        if sql.upper().startswith('SELECT') and 'chat_sessions' in sql and not started.is_set():
            started.set();time.sleep(.3)
        return real(sql,*args,**kwargs)
    monkeypatch.setattr(s.project.db,'execute_sql',slow)
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        request=asyncio.create_task(client.get('/api/schedule/notification-options',params={'project_id':s.project.id,'task_id':'bound'}))
        assert await asyncio.to_thread(started.wait,1)
        assert (await asyncio.wait_for(client.get('/health'),timeout=.15)).status_code==200
        options=(await request).json();assert options['default']['enabled'] is True
        payload={'name':'默认通知','target_type':'task','target_task_id':'bound','instruction':'汇报','rule':{'kind':'minutes','every':10,'timezone':'UTC'}}
        created=await client.post('/api/schedule/create',params={'project_id':s.project.id},json=payload)
        assert created.status_code==200 and created.json()['notification']['enabled'] is True
        bad=await client.patch('/api/schedule/'+created.json()['id'],params={'project_id':s.project.id},json={'notification':{'enabled':True,'target':{'session_id':'foreign'}}})
        assert bad.status_code==422


def test_notification_columns_migrate_without_enabling_old_rules(tmp_path):
    from models import init_db,Schedule,ScheduleRun
    from models.fields import utc_now
    db=init_db(str(tmp_path/'legacy.db'))
    old=Schedule.create(id='old',name='旧规则',workflow_id='flow',task_template_json='{}',rule_json='{}',timezone='UTC',created_at=utc_now(),updated_at=utc_now())
    ScheduleRun.create(id='old-run',schedule=old,scheduled_for=utc_now(),created_at=utc_now())
    for table,columns in {'schedules':['notification_json'],'schedule_runs':['notification_json','notification_status','notification_error']}.items():
        for column in columns:db.execute_sql(f'ALTER TABLE {table} DROP COLUMN {column}')
    db.close();db=init_db(str(tmp_path/'legacy.db'))
    assert json.loads(Schedule.get_by_id('old').notification_json)=={'enabled':False}
    assert ScheduleRun.get_by_id('old-run').notification_json is None
    db.close()


@pytest.mark.parametrize('origin,device,external,expected', [
    ('https://gateway.example/','device-1','https://external.example','https://gateway.example/workspace/device-1'),
    ('https://gateway.example','device/1','https://external.example','https://gateway.example/workspace/device%2F1'),
    (None,None,'https://external.example/','https://external.example'),
    (None,None,'','http://192.0.2.10:8765'),
])
def test_notification_link_prefers_active_managed_gateway(monkeypatch,origin,device,external,expected):
    import main
    from services.config import config_store
    from services.notification_hooks import base_addresses
    monkeypatch.setattr(main,'gateway_client',SimpleNamespace(managed_config=SimpleNamespace(gateway_origin=origin) if origin else None,device_id=device))
    monkeypatch.setattr(main,'remote_access_service',SimpleNamespace(settings=lambda:{'external_base_url':external,'internal_base_url':'http://192.0.2.10:8765/'}))
    original=config_store.get
    monkeypatch.setattr(config_store,'get',lambda key,default=None: {} if key=='gateway_platform' else original(key,default))
    assert next(b['task_base_url'] for b in base_addresses() if b.get('task_base_url'))==expected


@pytest.mark.anyio
@pytest.mark.parametrize('terminal_status', ['created', 'failed'])
async def test_batch_notification_waits_for_completion_and_lists_all_created_tasks(setup_notifications, terminal_status):
    from models import ScheduleRun
    from models.fields import utc_now
    from services.schedule_notifications import deliver_notification

    s = setup_notifications
    calls = []

    class Sender:
        async def send_message(self, **kwargs):
            calls.append(kwargs)
            return {'sent': True}

    s.module._notification_sender = Sender()
    rule = s.module.create(s.project.id, name='批量创建', workflow_id=s.workflow['id'], task_template={'title': '批量'},
                           rule={'kind': 'daily', 'time': '09:00', 'timezone': 'UTC'},
                           notification={'enabled': True, 'target': {'session_id': 'session'}})
    def seed(_):
        ScheduleRun.create(id='batch', schedule=rule['id'], status='running', task_id='bound',
                           created_tasks_json=json.dumps([{'id': 'bound', 'title': '任务一'}, {'id': 'unbound', 'title': '任务二'}]),
                           notification_json=json.dumps(rule['notification']), scheduled_for=utc_now(), created_at=utc_now())
    await s.manager.run_db(s.project.id, seed)
    await deliver_notification(s.module, s.project.id, 'batch')
    assert calls == []
    await s.manager.run_db(s.project.id, lambda _: ScheduleRun.update(status=terminal_status).where(ScheduleRun.id == 'batch').execute())
    await asyncio.gather(deliver_notification(s.module, s.project.id, 'batch'), deliver_notification(s.module, s.project.id, 'batch'))
    assert len(calls) == 1
    assert '任务一' in calls[0]['text'] and '任务二' in calls[0]['text']
