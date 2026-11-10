"""Conversation schedules share scheduling, own delivery and follow session lifetime."""
import asyncio
from types import SimpleNamespace
import pytest
from tests.test_schedule_notifications import setup_notifications


def create(s, **extra):
    return s.module.create(s.project.id, name='检查进度', target_type='session', target_session_id='session',
                           instruction='检查最新进展', rule={'kind':'minutes','every':10,'timezone':'UTC'}, **extra)


def test_session_schedule_validation_and_lifetime(setup_notifications):
    from agent_assistants.chat_session import ChatSessionModule
    from streaming.bus import EventBus
    from services.schedule import ScheduleValidationError
    from models import Schedule
    s=setup_notifications
    rule=create(s)
    assert rule['target_session_id']=='session'
    assert s.module.list(s.project.id)[0]['target_session_title']=='项目会话'
    with pytest.raises(ScheduleValidationError):
        s.module.update(s.project.id,rule['id'],target_session_id='missing')
    chat=ChatSessionModule(EventBus(),s.manager)
    with s.manager.activate_project_by_id(s.project.id):
        chat.set_archived(s.project.id,'session',True)
        assert Schedule.get_by_id(rule['id']).status=='deleted'
        chat.set_archived(s.project.id,'session',False)
    assert not s.module.list(s.project.id)
    rule=create(s)
    chat.delete_session(s.project.id,'session')
    assert not s.module.list(s.project.id)
    with pytest.raises(ScheduleValidationError): create(s)


@pytest.mark.anyio
async def test_session_schedule_dispatches_existing_session_and_delivers_once(setup_notifications):
    from models import ChatMessage, ScheduleRun
    from models.fields import utc_now
    s=setup_notifications;calls=[]
    class Runtime:
        def submit_message(self,project_id,session_id,content,idempotency_key,**kwargs):
            calls.append((project_id,session_id,content,kwargs))
            ChatMessage.create(id='scheduled-user',session=session_id,role='user',content=content,created_at=utc_now())
            ChatMessage.create(id='scheduled-assistant',session=session_id,role='assistant',content='进展正常',status='succeeded',created_at=utc_now())
            return SimpleNamespace(turn_id='turn',user_message_id='scheduled-user',assistant_message_id='scheduled-assistant')
        def start_queued_turn(self,turn_id): pass
    sent=[]
    class Sender:
        async def send_schedule_notification(self,**kwargs): sent.append(kwargs);return {'sent':True}
    s.module._chat_sessions=Runtime();s.module._channel_sessions=s.module._chat_sessions
    s.module._notification_sender=Sender()
    rule=await s.manager.run_db(s.project.id,lambda _: create(s))
    def seed(_):
        ScheduleRun.create(id='run',schedule=rule['id'],scheduled_for=utc_now(),created_at=utc_now(),instruction='检查最新进展')
    await s.manager.run_db(s.project.id,seed)
    await s.module._execute_run(s.project.id,'run')
    assert calls[0][:3]==(s.project.id,'session','检查最新进展')
    assert calls[0][3]['schedule'] is False
    assert len(sent)==1 and sent[0]['session_id']=='session'
    assert '进展正常' in sent[0]['text']
    result=await s.manager.run_db(s.project.id,lambda _:s.module.list_runs(s.project.id,rule['id']))
    assert result[0]['status']=='succeeded' and result[0]['session_id']=='session'
    await s.module._execute_run(s.project.id,'run')
    assert len(calls)==1 and len(sent)==1


@pytest.mark.anyio
async def test_session_schedule_api_relative_time_and_slow_db(setup_notifications,monkeypatch):
    import main, threading, time
    from fastapi import FastAPI
    from httpx import AsyncClient,ASGITransport
    from api.schedule import router
    from datetime import datetime,timedelta,timezone
    s=setup_notifications
    monkeypatch.setattr(main,'project_manager',s.manager);monkeypatch.setattr(main,'schedule_module',s.module)
    app=FastAPI();app.include_router(router)
    @app.get('/health')
    async def health():return {'ok':True}
    entered=threading.Event();real=s.project.db.execute_sql
    def slow(sql,*args,**kwargs):
        if 'chat_sessions' in sql and not entered.is_set():entered.set();time.sleep(.3)
        return real(sql,*args,**kwargs)
    monkeypatch.setattr(s.project.db,'execute_sql',slow)
    payload={'name':'两小时后检查','target_type':'session','target_session_id':'session','instruction':'检查最新情况','rule':{'kind':'after','delay':'2h','timezone':'Asia/Shanghai'},'idempotency_key':'source-message-1'}
    async with AsyncClient(transport=ASGITransport(app=app),base_url='http://test') as client:
        before=datetime.now(timezone.utc)
        pending=asyncio.create_task(client.post('/api/schedule/create',params={'project_id':s.project.id},json=payload))
        assert await asyncio.to_thread(entered.wait,1)
        assert (await asyncio.wait_for(client.get('/health'),.15)).status_code==200
        response=await pending
        assert response.status_code==200,response.text
        rule=response.json();assert rule['rule']['kind']=='once'
        assert timedelta(hours=2)<=datetime.fromisoformat(rule['next_run_at'])-before<timedelta(hours=2,seconds=3)
        duplicate=await client.post('/api/schedule/create',params={'project_id':s.project.id},json=payload)
        assert duplicate.json()['id']==rule['id']
        wrong=await client.post('/api/schedule/create',params={'project_id':s.other.id},json={**payload,'idempotency_key':'other'})
        assert wrong.status_code==422


@pytest.mark.anyio
async def test_cli_session_target_and_relative_delay():
    from cli import build_parser, dispatch
    calls=[]
    class Client:
        async def call(self,name,args):calls.append((name,args));return {'id':'scheduled'}
    args=build_parser().parse_args(['schedule','create','--project','p','--target','session','--session','s','--name','检查',
                                   '--instruction','检查最新进展','--after','2h','--idempotency-key','message-1','--json'])
    await dispatch(args,Client())
    name,payload=calls[0]
    assert name=='workstep_create_schedule'
    assert payload['target_session_id']=='s'
    assert payload['rule']=={'kind':'after','delay':'2h','timezone':'UTC'}
    assert payload['idempotency_key']=='message-1'
    assert 'task_template' not in payload and 'notification' not in payload


from tests.test_chat_session import chat_module


@pytest.mark.anyio
async def test_real_chat_runtime_preserves_context_and_marks_scheduled_message(chat_module, monkeypatch):
    from services.schedule import ScheduleModule
    from models import ChatMessage, ScheduleRun
    from models.fields import utc_now
    from services import session_schedule_runtime
    chat, bus, manager, project, config = chat_module
    monkeypatch.setattr(session_schedule_runtime, 'config_store', config)
    observed = []
    async def invoke(*args, **kwargs):
        observed.append(args[3])
        return '当前工作正常', [], 'engine-thread'
    monkeypatch.setattr(chat, '_invoke', invoke)
    scheduler = ScheduleModule(manager, None, None, chat_sessions=chat)
    def seed(_):
        session = chat.create_session(project.id, title='普通对话', engine='claude')
        ChatMessage.create(id='earlier', session=session['id'], role='user', content='检查订单服务', created_at=utc_now())
        rule = scheduler.create(project.id, name='稍后检查', target_type='session', target_session_id=session['id'],
            instruction='看看情况怎么样', rule={'kind':'after', 'delay':'2h'})
        ScheduleRun.create(id='real-run', schedule=rule['id'], scheduled_for=utc_now(), created_at=utc_now())
        return session, rule
    session, rule = await manager.run_db(project.id, seed)
    await asyncio.wait_for(scheduler._execute_run(project.id, 'real-run'), 5)
    def inspect(_):
        run = scheduler.list_runs(project.id, rule['id'])[0]
        messages = list(ChatMessage.select().where(ChatMessage.session == session['id']).dicts())
        return run, messages
    run, messages = await manager.run_db(project.id, inspect)
    assert run['status'] == 'succeeded'
    assert run['notification_status'] == 'disabled'
    assert '检查订单服务' in observed[0] and '看看情况怎么样' in observed[0]
    assert session['id'] in observed[0] and project.id in observed[0]
    assert any(m['content'] == '看看情况怎么样' and m['author_name'] == '定时任务：稍后检查' for m in messages)
    assert any(m['content'] == '当前工作正常' for m in messages)


@pytest.mark.anyio
async def test_busy_conversation_waits_and_deletion_cancels_waiting_run(setup_notifications):
    from models import ChatMessage, ScheduleRun
    from models.fields import utc_now
    from services.session_schedule_runtime import clear_session_schedules
    s = setup_notifications
    class Runtime:
        def submit_message(self, *args, **kwargs):
            raise AssertionError('Must not interrupt an active user turn')
    s.module._channel_sessions = Runtime()
    def seed(_):
        rule = create(s)
        ChatMessage.create(id='busy', session='session', role='assistant', content='', status='running', created_at=utc_now())
        ScheduleRun.create(id='waiting', schedule=rule['id'], scheduled_for=utc_now(), created_at=utc_now())
        return rule
    rule = await s.manager.run_db(s.project.id, seed)
    pending = asyncio.create_task(s.module._execute_run(s.project.id, 'waiting'))
    await asyncio.sleep(.1)
    assert not pending.done()
    await s.manager.run_db(s.project.id, lambda _: clear_session_schedules('session'))
    await asyncio.wait_for(pending, 1)
    result = await s.manager.run_db(s.project.id, lambda _: s.module.list_runs(s.project.id, rule['id']))
    assert result[0]['status'] == 'stopped'


def test_restart_and_lost_session_do_not_replay(setup_notifications):
    from models import Schedule, ScheduleRun, ChatSession
    from models.fields import utc_now
    from services.session_schedule_runtime import reconcile_session_schedules
    s = setup_notifications
    rule = create(s)
    with s.manager.activate_project_by_id(s.project.id):
        ScheduleRun.create(id='interrupted', schedule=rule['id'], status='running', scheduled_for=utc_now(), created_at=utc_now())
        reconcile_session_schedules(startup=True, current=utc_now())
        assert ScheduleRun.get_by_id('interrupted').status == 'failed'
        ChatSession.delete().where(ChatSession.id == 'session').execute()
        reconcile_session_schedules(startup=False, current=utc_now())
        assert Schedule.get_by_id(rule['id']).status == 'deleted'


@pytest.mark.parametrize('delay', ['0h', '-2h', '2', '367d', 'abc'])
def test_invalid_relative_delay_rejected(delay):
    from services.session_schedule_runtime import resolve_relative_rule
    from services.schedule_rules import ScheduleValidationError
    with pytest.raises(ScheduleValidationError):
        resolve_relative_rule({'kind':'after', 'delay':delay})


@pytest.mark.anyio
async def test_channel_route_change_invalidates_schedule_without_dispatch(setup_notifications):
    from models import Schedule, ScheduleRun
    from models.fields import utc_now
    from services.session_schedule_runtime import config_store
    s = setup_notifications
    def seed(_):
        rule = create(s)
        ScheduleRun.create(id='changed-route', schedule=rule['id'], scheduled_for=utc_now(), created_at=utc_now())
        data = config_store.get('channel_bots', {})
        original = next(key for key, sid in data['sessions'].items() if sid == 'session')
        data['sessions'].pop(original)
        data['sessions']['bot:group:another-group'] = 'session'
        config_store.set('channel_bots', data)
        return rule
    rule = await s.manager.run_db(s.project.id, seed)
    await s.module._execute_run(s.project.id, 'changed-route')
    def inspect(_):
        return Schedule.get_by_id(rule['id']).status, ScheduleRun.get_by_id('changed-route').status
    assert await s.manager.run_db(s.project.id, inspect) == ('invalid', 'failed')
