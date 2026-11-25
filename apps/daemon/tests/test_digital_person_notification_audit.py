import pytest
import asyncio

from models.chat_session import ChatMessage
from models.fields import utc_now
from tests.test_digital_person_followup import seed
from tests.test_digital_person_runtime import chat_module, runtime


async def test_blocker_quiet_notice_is_audited_and_resumes_once(runtime, monkeypatch):
    service, home, store, _, origin = await seed(runtime)
    await service.mutate(lambda state: state['delegations'][0].update(followup_state='pending'))
    await service.follow_delegations()
    monkeypatch.setattr('services.memory_pending_queue.has_pending', lambda _: False)
    hour = utc_now().astimezone().hour
    store.set('digital_person', {'enabled': True, 'quiet_start': hour, 'quiet_end': (hour+1)%24})
    text = 'Android 验收受阻，请连接并授权目标手机。'
    async def decide(context):
        await context['_load']()
        return {'decision': 'silent', 'summary': '真机验收受阻', 'source_ids': ['result'],
                'delegation_actions': [{'id': 'work', 'action': 'needs_user', 'summary': text}]}
    monkeypatch.setattr(service, '_decide', decide)
    monkeypatch.setattr('services.digital_person_channels.get_bindings', lambda: [])
    run = await service.check(manual=False)
    detail = await service.run_detail(run['id'])
    assert detail['notification'] == {'state': 'silent', 'reason': 'model_silent'}
    assert detail['delegation_notifications'] == [{'state': 'deferred', 'reason': 'quiet_hours'}]
    await service.check(manual=False)
    state = await service.state()
    notices = [r for r in state['runs'] if r.get('managed_followup')]
    assert len(notices) == 1 and notices[0]['status'] == 'deferred'
    assert not await service.projects.run_db(home.id, lambda _: ChatMessage.select().where(ChatMessage.session == origin).exists())
    store.set('digital_person', {'enabled': True, 'quiet_start': 0, 'quiet_end': 0})
    monkeypatch.setattr(service, '_decide', lambda _: pytest.fail('saved decision must not be reassessed'))
    await service.check(manual=False)
    await service.check(manual=False)
    messages = await service.projects.run_db(home.id, lambda _: list(ChatMessage.select().where(ChatMessage.session == origin)))
    assert [m.content for m in messages] == [text]
    assert (await service.run_detail(run['id']))['delegation_notifications'] == [{'state': 'notified', 'reason': 'delivered'}]


def test_notification_projection_does_not_invent_legacy_reason_or_expose_data():
    from services.digital_person_notifications import notification_projection
    assert notification_projection({'status': 'silent', 'summary': '免打扰', 'deliveries': []}) == {'state': 'silent', 'reason': 'unknown'}
    assert notification_projection({'status': 'deferred'}) == {'state': 'deferred', 'reason': 'unknown'}
    assert notification_projection({'status': 'notified', 'deliveries': []}) == {'state': 'unknown', 'reason': 'unknown'}
    assert notification_projection({'status':'interrupted','notification':{'state':'notifying','reason':'unknown'}}) == {'state':'unknown','reason':'unknown'}
    assert notification_projection({'status':'notified','notification':{'state':'notified','reason':'delivered'}}) == {'state':'unknown','reason':'unknown'}
    assert notification_projection({'status': 'silent', 'notification': {'state': 'silent', 'reason': 'secret@example.com', 'recipient': 'private'}}) == {'state': 'silent', 'reason': 'unknown'}
    assert notification_projection({'status': 'delivery_failed', 'deliveries': [{'status': 'failed', 'error': 'secret@example.com'}]}) == {'state': 'delivery_failed', 'reason': 'delivery_failed'}


@pytest.mark.parametrize('case,reason', [('archived','target_missing'), ('busy','source_busy')])
async def test_target_gate_is_audited_without_sending(runtime, monkeypatch, case, reason):
    from models.chat_session import ChatSession
    from services.digital_person import get_profile
    service, home, _, _, origin = await seed(runtime)
    await service.mutate(lambda state: state['delegations'][0].update(followup_state='pending'))
    if case == 'archived':
        await service.projects.run_db(home.id, lambda _: ChatSession.update(archived=True).where(ChatSession.id==origin).execute())
    else:
        await service.projects.run_db(home.id, lambda _: ChatMessage.create(id='busy', session=origin, role='assistant', status='running', content='', created_at=utc_now()))
    item, = await service.delegation_management.read((await service.state())['delegations'])
    monkeypatch.setattr(service, '_notify', lambda *args: pytest.fail('blocked target must not receive notice'))
    audit = []
    await service.delegation_management.apply([{'id':'work','action':'needs_user','summary':'需要连接手机'}], [item], get_profile(), audit=audit)
    assert audit == [{'state':'suppressed','reason':reason}]


@pytest.mark.parametrize('receipts,reason', [([], 'no_targets'), ([{'status':'failed','error':'https://private.invalid/?token=secret'}], 'delivery_failed'),
    ([{'status':'delivered'}, {'status':'failed','error':'owner@example.com'}], 'delivery_failed')])
async def test_delegation_receipts_and_private_errors(runtime, monkeypatch, receipts, reason):
    from services.digital_person import get_profile
    service, home, _, _, _ = await seed(runtime)
    await service.mutate(lambda state: state['delegations'][0].update(followup_state='pending'))
    item, = await service.delegation_management.read((await service.state())['delegations'])
    async def notify(*args): return receipts
    monkeypatch.setattr(service, '_notify', notify)
    result = await service.delegation_management._report(item, {'action':'needs_user','summary':'请连接手机'}, profile=get_profile())
    detail = await service.run_detail(result['run_id'])
    assert detail['notification'] == {'state':'delivery_failed','reason':reason}
    assert detail['status']=='delivery_failed'
    assert 'secret' not in str(detail) and 'owner@example.com' not in str(detail)


def test_history_only_follows_exact_recorded_links():
    from services.digital_person_notifications import notification_audit
    child = {'id':'child','status':'notified','deliveries':[{'status':'delivered'}]}
    old = {'id':'old','status':'silent','sources':{'delegations':[{'id':'same-task'}]}}
    assert notification_audit(old, [child])['delegation_notifications'] == []
    new = {**old, 'delegation_notifications':[{'run_id':'child','state':'deferred','reason':'quiet_hours'}]}
    assert notification_audit(new, [child])['delegation_notifications']==[{'state':'notified','reason':'delivered'}]
    assert notification_audit(new, [])['delegation_notifications']==[{'state':'unknown','reason':'receipt_unavailable'}]


def test_model_silent_reason_is_explicit_and_safe_not_guessed_from_summary():
    from services.digital_person_notifications import notification_projection
    old = {'status':'silent','summary':'请连接手机','notification':{'state':'silent','reason':'model_silent'}}
    assert 'model_reason' not in notification_projection(old)
    new = {**old, 'notification':{**old['notification'], 'model_reason':'用户已明确暂停，等待回复。联系 owner@example.com，token=private-secret https://private.invalid/path'}}
    result = notification_projection(new)
    assert '用户已明确暂停，等待回复。' in result['model_reason']
    assert all(secret not in result['model_reason'] for secret in ['owner@example.com','private-secret','private.invalid'])


@pytest.mark.parametrize('quiet,with_summary', [(False,False),(True,False),(False,True),(True,True)])
async def test_automatic_continuation_always_notifies_main_once(runtime, monkeypatch, tmp_path, quiet, with_summary):
    from services.digital_person import get_profile
    from tests.test_digital_person_delegation_management import wait_for_status
    service, home, store = runtime
    hour = utc_now().astimezone().hour
    store.set('digital_person', {'enabled':True,'quiet_start':hour if quiet else 0,'quiet_end':(hour+1)%24 if quiet else 0})
    target = await asyncio.to_thread(service.projects.init_project, tmp_path/'execution')
    calls = []
    async def invoke(*args, **kwargs):
        calls.append('invoke')
        return f'受控执行结果 {len(calls)}', [], 'execution-thread'
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    monkeypatch.setattr('services.digital_person_channels.get_bindings', lambda: [])
    initial = await service.delegate(target.id, '核对构建', request_id='initial')
    await wait_for_status(service,target.id,initial['message_id'])
    await service.delegation_management.refresh()
    candidates = await service.delegation_management.eligible(await service.state())
    action = {'id':initial['id'],'action':'continue','instruction':'请补验失败路径'}
    if with_summary: action['summary'] = '构建已核对，已安排补验失败路径。'
    audits = []
    await service.delegation_management.apply([action], candidates, get_profile(), audit=audits)
    await service.delegation_management.apply([action], candidates, get_profile())
    state = await service.state()
    await wait_for_status(service,target.id,state['delegations'][0]['message_id'])
    assert len(calls)==2
    notices = [row for row in state['runs'] if row.get('model_delegation_notice')]
    assert len(notices)==1, state['runs']
    assert notices[0]['status']==('deferred' if quiet else 'notified')
    assert audits[0]['run_id']==notices[0]['id']
    store.set('digital_person', {'enabled':True,'quiet_start':0,'quiet_end':0})
    await service.follow_delegations(); await service.follow_delegations()
    messages = await service.projects.run_db(home.id, lambda _: list(ChatMessage.select().where(ChatMessage.session==initial['origin_session_id'])))
    assert len(messages)==1
    assert messages[0].content==(action['summary'] if with_summary else '委派「核对构建」已提交自动跟进，等待执行结果。')


@pytest.mark.parametrize('archived', [False,True])
@pytest.mark.parametrize('busy', [False,True])
async def test_automatic_followup_uses_its_actual_origin_and_never_copies_to_main(runtime, monkeypatch, archived, busy):
    from models.chat_session import ChatSession
    from services.digital_person import get_profile
    service, home, _, _, main = await seed(runtime)
    other = await service.projects.run_db(home.id,lambda _: service.chats.create_session(home.id,title='另一个发起会话')['id'])
    await service.mutate(lambda state: state['delegations'][0].update(origin_session_id=other,followup_state='continued'))
    if archived:
        await service.projects.run_db(home.id,lambda _: ChatSession.update(archived=True).where(ChatSession.id==other).execute())
    item, = await service.delegation_management.read((await service.state())['delegations'])
    monkeypatch.setattr('services.digital_person_channels.get_bindings', lambda: [])
    await service.projects.run_db(home.id,lambda _:ChatMessage.create(id='main-busy',session=main,role='assistant',content='',status='running',created_at=utc_now()))
    if busy:
        await service.projects.run_db(home.id,lambda _:ChatMessage.create(id='origin-busy',session=other,role='assistant',content='',status='running',created_at=utc_now()))
    await service.delegation_management._report(item,{'action':'continue','summary':'已提交跟进，等待结果。'},progress=True,profile=get_profile())
    if busy or archived:
        notice = next(row for row in (await service.state())['runs'] if row.get('automatic_followup'))
        assert notice['notification']=={'state':'deferred','reason':'target_missing' if archived else 'source_busy'}
        await service.projects.run_db(home.id,lambda _:ChatMessage.update(status='completed').where(ChatMessage.id=='origin-busy').execute())
        await service.projects.run_db(home.id,lambda _:ChatSession.update(archived=False).where(ChatSession.id==other).execute())
        await service.follow_delegations(); await service.follow_delegations()
    messages = await service.projects.run_db(home.id,lambda _:list(ChatMessage.select().where(ChatMessage.session==other,ChatMessage.id!='origin-busy')))
    assert [row.content for row in messages]==['已提交跟进，等待结果。']
    assert not await service.projects.run_db(home.id,lambda _:ChatMessage.select().where(ChatMessage.session==main,ChatMessage.id!='main-busy').exists())


async def test_silent_model_reason_survives_actual_assessment_and_api_projection(runtime, monkeypatch):
    service, _, _, _, _ = await seed(runtime)
    await service.mutate(lambda state:state['delegations'][0].update(followup_state='pending'))
    reason = '这项阻塞已向用户报告，等待授权后再继续。'
    async def decide(context):
        await context['_load']()
        return {'decision':'silent','summary':'内部结论','notification_reason':reason,'source_ids':['result']}
    monkeypatch.setattr(service,'_decide',decide)
    run=await service.check()
    detail=await service.run_detail(run['id'])
    assert detail['notification']['model_reason']==reason
    assert (await service.activity_records())['runs'][0]['notification']['model_reason']==reason


@pytest.mark.parametrize('action', ['notify','needs_user','complete'])
async def test_followup_status_without_another_worker_message_reaches_main(runtime, monkeypatch, action):
    service, home, _, worker, main = await seed(runtime)
    await service.mutate(lambda state: state['delegations'][0].update(followup_state='pending'))
    async def decide(context):
        await context['_load']()
        return {'decision':'silent','summary':'已核对','notification_reason':'本轮使用独立委派通知。','source_ids':['result'],
                'delegation_actions':[{'id':'work','action':action,'summary':'已核对当前状态，需确认后续安排。','evidence':'真实执行结果'}]}
    monkeypatch.setattr(service,'_decide',decide)
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:[])
    await service.check()
    messages=await service.projects.run_db(home.id,lambda _:list(ChatMessage.select().where(ChatMessage.session==main)))
    assert [m.content for m in messages]==['已核对当前状态，需确认后续安排。']
    assert await service.projects.run_db(home.id,lambda _:ChatMessage.select().where(ChatMessage.session==worker).count())==1


@pytest.mark.parametrize('error', [ValueError, RuntimeError])
async def test_followup_submission_exception_reports_uncertainty_without_retrying_worker(runtime, monkeypatch, error):
    from services.digital_person import get_profile
    service, home, _, _, main = await seed(runtime)
    await service.mutate(lambda state:state['delegations'][0].update(followup_state='pending'))
    item, = await service.delegation_management.read((await service.state())['delegations'])
    calls=[]
    async def fail(*args,**kwargs):
        calls.append('submit')
        raise error('private implementation detail')
    monkeypatch.setattr(service,'delegate',fail)
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:[])
    action=[{'id':'work','action':'continue','instruction':'补验'}]
    await service.delegation_management.apply(action,[item],get_profile())
    await service.delegation_management.apply(action,[item],get_profile())
    messages=await service.projects.run_db(home.id,lambda _:list(ChatMessage.select().where(ChatMessage.session==main)))
    assert calls==['submit']
    assert len(messages)==1 and '尚未确认' in messages[0].content
    assert '核对构建' in messages[0].content
    assert item['session_id'] in messages[0].content
    assert 'private implementation detail' not in messages[0].content


@pytest.mark.parametrize('phase', ['eligible', 'apply', 'submit', 'report', 'deferred', 'completion'])
async def test_archived_execution_never_receives_followup_or_sends_notice(runtime, monkeypatch, phase):
    from models.chat_session import ChatSession
    from services.digital_person import get_profile
    service, home, _, worker, main = await seed(runtime)
    management = service.delegation_management
    if phase != 'completion':
        await service.mutate(lambda state: state['delegations'][0].update(status='completed', followup_state='pending'))
    item, = await management.read((await service.state())['delegations'])
    async def archive():
        await service.projects.run_db(home.id, lambda _: ChatSession.update(archived=True).where(ChatSession.id==worker).execute())
    async def forbidden(*args, **kwargs):
        pytest.fail('archived execution must not submit or notify')
    monkeypatch.setattr(service, '_notify', forbidden)
    monkeypatch.setattr(service, 'delegate', forbidden)
    action = {'id':'work', 'action':'continue', 'instruction':'补验'}
    if phase == 'submit':
        async def archive_during_submit(*args, **kwargs):
            await archive()
            raise ValueError('execution archived during submission')
        monkeypatch.setattr(service, 'delegate', archive_during_submit)
    elif phase == 'deferred':
        profile = get_profile().model_copy(update={'quiet_start':utc_now().astimezone().hour,
            'quiet_end':(utc_now().astimezone().hour+1)%24})
        await management._report(item, {'action':'notify','summary':'等待结果'}, progress=True, profile=profile)
        await archive()
    else:
        await archive()
    if phase == 'eligible':
        assert await management.eligible(await service.state()) == []
    elif phase in ('apply', 'submit'):
        await management.apply([action], [item], get_profile())
    elif phase == 'report':
        await management._report(item, {'action':'notify','summary':'等待结果'}, progress=True, profile=get_profile())
    else:
        await service.follow_delegations()
    assert not await service.projects.run_db(home.id, lambda _: ChatMessage.select().where(ChatMessage.session==main).exists())
    assert await service.projects.run_db(home.id, lambda _: ChatMessage.select().where(ChatMessage.session==worker).count()) == 1
    if phase != 'deferred':
        assert not (await service.state())['runs']


async def test_execution_archive_gate_keeps_health_responsive_with_slow_sql(runtime, monkeypatch):
    import threading
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from models.chat_session import ChatSession
    service, _, _, _, _ = await seed(runtime)
    item, = await service.delegation_management.read((await service.state())['delegations'])
    entered, release = threading.Event(), threading.Event()
    original = ChatSession.select
    def slow_select(*fields):
        if len(fields) == 1 and fields[0] is ChatSession.archived:
            entered.set()
            assert release.wait(3)
        return original(*fields)
    monkeypatch.setattr(ChatSession, 'select', slow_select)
    app = FastAPI()
    @app.get('/health')
    async def health():
        return {'ok': True}
    reading = asyncio.create_task(service.delegation_management._execution_archived(item))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/health'), .3)).status_code == 200
    finally:
        release.set()
        assert await reading is False
