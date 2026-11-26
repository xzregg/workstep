from tests.memory_turn_fixture import assessment_access
from tests.memory_turn_fixture import create_completed_user
import asyncio
import pytest
from tests.test_chat_session import chat_module


async def seed_pending(current):
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    sid = (await current.main_session())['id']
    await current.projects.run_db((await current.home()).id, lambda _: create_completed_user(
        id='pending-reflection', session=sid, role='user', status='completed',
        content='请解读本轮交流', created_at=utc_now()))


async def test_heartbeat_reads_existing_conversation_without_main_pointer(runtime):
    runtime, project, _ = runtime
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    def seed(_):
        row = runtime.chats.create_session(project.id, title='跟进部署')
        for mid, role, text in [('request', 'user', '帮我关注部署结果'), ('reply', 'assistant', '正在部署')]:
            message=ChatMessage.create(id=mid, session=row['id'], role=role, status='completed', content=text, created_at=utc_now())
            if role=='assistant':
                from services.digital_person_memory import capture_message
                capture_message(message,'local')
        return row['id']
    sid = await runtime.projects.run_db(project.id, seed)
    context = await runtime._collect()
    assert context['origin_session_id'] == sid
    assert [m['id'] for m in context['conversation']] == ['request', 'reply']


@pytest.mark.parametrize('reference_kind', ['message', 'memory'])
async def test_heartbeat_can_notify_conversation_source_once(runtime, monkeypatch, reference_kind):
    runtime, project, _ = runtime
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    sid = (await runtime.main_session())['id']
    await runtime.projects.run_db(project.id, lambda _: create_completed_user(id='watch', session=sid, role='user', status='completed', content='关注部署，有结果告诉我', created_at=utc_now()))
    async def decide(context):
        if context.get('_load'): await context['_load']()
        assert context['conversation'][0]['id'] == 'watch'
        reference = context['conversation'][0]['memory_ids'][0] if reference_kind == 'memory' else 'watch'
        return {'decision': 'notify', 'summary': '部署已完成，健康检查通过', 'source_ids': [reference]}
    monkeypatch.setattr(runtime, '_decide', decide)
    monkeypatch.setattr('services.digital_person_channels.get_bindings', lambda: [])
    first = await runtime.check()
    assert first['status'] == 'notified', first
    assert first['deliveries'][0]['session_id'] == sid
    second = await runtime.check()
    assert second['sources']['no_work'] is True, second
    assert second['deliveries'] == []
    assert (await runtime.activity_records())['reflection_count'] == 1


async def test_heartbeat_waits_for_foreground_turn(runtime, monkeypatch):
    runtime, project, _ = runtime
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    sid = (await runtime.main_session())['id']
    await runtime.projects.run_db(project.id, lambda _: ChatMessage.create(id='busy', session=sid, role='assistant', status='running', content='', created_at=utc_now()))
    async def decide(_):
        pytest.fail('foreground work must have priority')
    monkeypatch.setattr(runtime, '_decide', decide)
    run = await runtime.check()
    assert run['status'] == 'silent'
    assert run['deliveries'] == []


async def test_heartbeat_checker_has_tools_and_silence_marker(runtime, monkeypatch):
    runtime, _, _ = runtime
    await seed_pending(runtime)
    from services import digital_person
    profile = digital_person.DigitalPersonProfile(
        enabled=True, name='Ari', role='Developer', personality='Curious',
        duties='Follow up on work.', proactive_instruction='Check progress.',
    )
    monkeypatch.setattr(digital_person, 'get_profile', lambda: profile)
    calls = []
    async def invoke(*args, **kwargs):
        from services import memory_query
        token=await assessment_access(runtime)
        await memory_query.pending(runtime.projects,token)
        calls.append(kwargs)
        return 'NO_REPLY', [], 'heartbeat-engine'
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    run = await runtime.check()
    assert run['status'] == 'silent', run
    assert calls[0]['workstep_tools'] is True
    assert 'background assessment' in calls[0]['system_prompt']
    import re
    assert not re.search(r'[\u3400-\u9fff]', calls[0]['system_prompt'])


async def test_heartbeat_reset_does_not_revive_old_instructions(runtime):
    runtime, project, _ = runtime
    from datetime import timedelta
    from models.chat_session import ChatMessage, ChatSession
    from models.fields import utc_now
    sid = (await runtime.main_session())['id']
    def seed(_):
        now = utc_now()-timedelta(seconds=1)
        create_completed_user(id='old-watch', session=sid, role='user', status='completed', content='旧监控要求', created_at=now-timedelta(minutes=1))
        ChatSession.update(context_reset_at=now).where(ChatSession.id == sid).execute()
        create_completed_user(id='new-watch', session=sid, role='user', status='completed', content='新监控要求', created_at=now+timedelta(seconds=1))
    await runtime.projects.run_db(project.id, seed)
    context = await runtime._collect()
    assert [m['id'] for m in context['conversation']] == ['new-watch','fixture-reply-new-watch']
    assert [m['id'] for m in context['messages']] == ['new-watch']


async def test_heartbeat_conversation_delivery_preserves_channel_origin(runtime, monkeypatch):
    runtime, project, _ = runtime
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    await runtime.main_session()
    sid = await runtime.projects.run_db(project.id, lambda _: runtime.chats.create_session(project.id)['id'])
    await runtime.projects.run_db(project.id, lambda _: create_completed_user(id='channel-watch', session=sid, role='user', status='completed', content='帮我关注', created_at=utc_now()))
    class Bots:
        async def _load(self):
            return {'sessions': {'a:single:one': sid, 'a:single:two': 'other'}, 'session_sources': {sid: {'project_id': project.id}}}
    runtime.bots = Bots()
    monkeypatch.setattr('services.digital_person_channels.get_bindings', lambda: [
        {'id': peer, 'bot_id': 'a', 'conversation_type': 'single', 'conversation_id': peer, 'notify': True} for peer in ['one', 'two']])
    sent = []
    async def send(_, binding, text):
        sent.append(binding['id'])
        return {}
    async def decide(context):
        if context.get('_load'): await context['_load']()
        return {'decision': 'notify', 'summary': '已核实有新进展', 'source_ids': ['channel-watch']}
    monkeypatch.setattr('services.digital_person_channels.send_binding', send)
    monkeypatch.setattr(runtime, '_decide', decide)
    run = await runtime.check()
    assert run['status'] == 'notified', run
    assert run['deliveries'][0]['session_id'] == sid
    assert sent == ['one']

@pytest.fixture
async def runtime(chat_module, monkeypatch, tmp_path):
    from services.digital_person_runtime import DigitalPersonRuntime
    from services import customization_workspace
    from services import digital_person_memory_index
    monkeypatch.setattr(digital_person_memory_index, 'database_path', lambda: tmp_path / 'global' / 'memory.db')
    module, bus, manager, project, store = chat_module
    async def home(_): return project
    monkeypatch.setattr(customization_workspace, 'ensure_default_workspace', home)
    monkeypatch.setattr(customization_workspace, 'is_default_workspace', lambda p: p.id == project.id)
    monkeypatch.setattr('services.digital_person.config_store', store)
    store.set('digital_person', {'enabled': True})
    current = DigitalPersonRuntime(manager, module, None, bus)
    from datetime import timedelta
    from models.fields import utc_now
    # Most cases exercise an established instance; explicit bootstrap tests seed older history.
    await current.mutate(lambda s:s.update(assessment_live_since=(utc_now()-timedelta(days=1)).isoformat()))
    return current, project, store

async def test_main_session_stable_concurrent_and_recreated_after_archive(runtime):
    runtime, project, _ = runtime
    rows = await asyncio.gather(*(runtime.main_session() for _ in range(5)))
    assert len({row['id'] for row in rows}) == 1
    from models.chat_session import ChatSession
    await runtime.projects.run_db(project.id, lambda _: ChatSession.update(archived=True).where(ChatSession.id == rows[0]['id']).execute())
    assert (await runtime.main_session())['id'] != rows[0]['id']

async def test_overview_does_not_recommend_repeated_user_messages(runtime):
    runtime, project, _ = runtime
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    sid = (await runtime.main_session())['id']
    def seed(_):
        for index in range(3):
            ChatMessage.create(id=f'repeated-{index}', session=sid, role='user',
                               status='completed', content='今天几号?', created_at=utc_now())
    await runtime.projects.run_db(project.id, seed)
    assert (await runtime.overview())['suggestions'] == []

async def test_feedback_is_idempotent_and_negative_earns_no_experience(runtime):
    runtime, project, _ = runtime
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    row = await runtime.main_session()
    await runtime.projects.run_db(project.id, lambda _: ChatMessage.create(id='answer',session=row['id'],role='assistant',status='completed',content='done',created_at=utc_now()))
    assert (await runtime.overview())['experience'] == 1
    await runtime.feedback('answer', -1)
    await runtime.feedback('answer', -1)
    assert (await runtime.overview())['experience'] == 0
    await runtime.feedback('answer', 1)
    assert (await runtime.overview())['experience'] == 1

async def test_feedback_accepts_visible_check_reply_without_counting_internal_activity(runtime):
    runtime, project, _ = runtime
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    sid = (await runtime.main_session())['id']
    await runtime.mutate(lambda state: state.update(check_sessions=[sid]))
    await runtime.projects.run_db(project.id, lambda _: ChatMessage.create(
        id='check-answer', session=sid, role='assistant', status='completed',
        content='检查回复', created_at=utc_now()))
    result = await runtime.feedback('check-answer', 1)
    assert result['feedback']['check-answer'] == 1
    assert result['experience'] == 0
    with pytest.raises(ValueError, match='Digital\\ reply\\ not\\ found'):
        await runtime.feedback('missing-answer', 1)


async def test_proactive_silent_no_send_and_disabled_does_not_run(runtime, monkeypatch):
    runtime, _, store = runtime
    store.set('digital_person', {'enabled': False, 'proactive_enabled': True})
    with pytest.raises(ValueError):
        await runtime.check()
    store.set('digital_person', {'enabled': True, 'proactive_enabled': True})
    async def decide(context):
        if context.get('_load'): await context['_load']()
        return {'decision':'silent','summary':'没有新结果','source_ids':[]}
    monkeypatch.setattr(runtime, '_decide', decide)
    run = await runtime.check()
    assert run['status'] == 'silent'
    assert not run.get('deliveries')
    assert (await runtime.state())['runs'] == []


async def test_main_chat_injects_pending_reflections_and_only_changed_rules(runtime, monkeypatch):
    import threading
    import main
    from httpx import ASGITransport, AsyncClient
    from engines.codex_sdk import CodexSDKEngine
    from engines.core.events import InternalEvent
    from tests.test_chat_session import _wait_turn

    current, project, store = runtime
    module = current.chats
    calls = []
    failure = ''

    class Engine(CodexSDKEngine):
        async def spawn(self, prompt, cwd, model=None, session_id=None, **kwargs):
            calls.append((prompt, kwargs.get('system_prompt', '')))
            if failure and session_id:
                yield InternalEvent(type='error', data={'message': failure})
                return
            yield InternalEvent(type='session_started', data={'session_id': 'native-thread'})
            yield InternalEvent(type='agent_message_chunk', data={'content': {'type': 'text', 'text': '收到'}})
            yield InternalEvent(type='done', data={})

    monkeypatch.setattr('agent_assistants.chat_session.create_engine', lambda _: Engine())
    monkeypatch.setattr('agent_assistants.base.create_engine', lambda _: Engine())
    monkeypatch.setattr(main, 'project_manager', current.projects)
    monkeypatch.setattr(main, 'chat_session_module', module)
    store.set('digital_person', {'enabled': True, 'name': '测试数字人'})
    store.set('assistant_defaults', {'digital_person': {'engine': 'codex_sdk'}})
    sid = (await current.main_session())['id']
    original_execute = project.db.execute_sql
    entered, release = threading.Event(), threading.Event()

    def slow_context_read(sql, *args, **kwargs):
        if sql.startswith('SELECT') and 'digital_person_proactive' in repr(args) and not release.is_set():
            entered.set()
            assert release.wait(2)
        return original_execute(sql, *args, **kwargs)

    async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
        async def send(number):
            response = await client.post(f'/api/chat-sessions/{sid}/chat',
                                         headers={'Idempotency-Key': f'reflection-chat-{number}'},
                                         json={'project_id': project.id, 'content': f'问题 {number}'})
            assert response.status_code == 200, response.text
            return response.json()['turn_id']

        assert await _wait_turn(module, await send(1)) == 'completed'
        assert 'Name: 测试数字人' in calls[-1][1]
        assert '```workstep-ui' in calls[-1][1]
        assert '"action":"conversation.open"' in calls[-1][1]
        assert '"action":"window.close"' in calls[-1][1]
        await current._deliver_local(sid, '主动消息 0', 'voice-notice', proactive=True)
        await current.mutate(lambda state: state['runs'].append(
            {'id': 'non-voice-notice', 'trigger': 'manual', 'origin_session_id': sid, 'sources': {}}))
        monkeypatch.setattr('services.digital_person_channels.get_bindings', lambda: [])
        delivery = await current._notify('主动消息 1', [], 'non-voice-notice')
        assert delivery[0]['status'] == 'delivered' and not delivery[0]['proactive']
        await current._deliver_local(sid, '主动消息 2', 'legacy-notice')
        await current.mutate(lambda state: state['runs'].append({
            'id': 'legacy-notice', 'trigger': 'interval', 'deliveries': [
                {'kind': 'local', 'session_id': sid, 'status': 'delivered', 'proactive': False}],
        }))
        await current._deliver_local(sid, '普通通知', 'non-proactive')

        monkeypatch.setattr(project.db, 'execute_sql', slow_context_read)
        turn = await send(2)
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            assert (await asyncio.wait_for(client.get('/api/health'), .2)).status_code == 200
        finally:
            release.set()
        assert await _wait_turn(module, turn) == 'completed'
        instruction = calls[-1][1]
        history = instruction.split('[WorkStep conversation history]',1)[1]
        assert history.index('主动消息 2') < history.index('主动消息 1') < history.index('主动消息 0')
        assert 'project_id=' not in history and 'session_id=' not in history and 'message_id=' not in history
        assert '"role":' not in history
        assert '普通通知' not in instruction
        assert 'Name: 测试数字人' not in instruction

        module._sessions.clear()
        assert await _wait_turn(module, await send(3)) == 'completed'
        assert '主动消息' not in calls[-1][1] and 'Name: 测试数字人' not in calls[-1][1]

        await current._deliver_local(sid, '失败后重试', 'retry-notice', proactive=True)
        failure = 'test failure'
        assert await _wait_turn(module, await send(4)) == 'error'
        assert '失败后重试' in calls[-1][1]
        failure = ''
        store.set('digital_person', {'enabled': True, 'name': '更新后身份'})
        assert await _wait_turn(module, await send(5)) == 'completed'
        assert '失败后重试' in calls[-1][1] and 'Name: 更新后身份' in calls[-1][1]

        await current._deliver_local(sid, '仅在重建轮待补齐', 'rebuild-notice', proactive=True)
        failure = 'no rollout found for thread id native-thread'
        assert await _wait_turn(module, await send(6)) == 'completed'
        body, instruction = calls[-1]
        assert 'Name: 更新后身份' in instruction
        assert '仅在重建轮待补齐' in instruction and '仅在重建轮待补齐' not in body
        assert '失败后重试' in body and '失败后重试' not in instruction

        failure = ''

        def seed_legacy_receipt(_):
            import json
            from models.chat_session import ChatMessage
            reply = ChatMessage.select().where(ChatMessage.session == sid, ChatMessage.role == 'assistant').order_by(
                ChatMessage.created_at.desc(), ChatMessage.id.desc()).get()
            context = json.loads(reply.context_json)
            context['digital_person_injection']['parts'].update(statistics='old', affect='old')
            reply.context_json = json.dumps(context)
            reply.save(only=[ChatMessage.context_json])

        await current.projects.run_db(project.id, seed_legacy_receipt)
        module._sessions.clear()
        assert await _wait_turn(module, await send(7)) == 'completed'
        assert '[WorkStep context update]' not in calls[-1][1]
        assert 'Name: 更新后身份' in calls[-1][1]
        assert await _wait_turn(module, await send(8)) == 'completed'
        assert calls[-1][1] == ''

async def test_proactive_rejects_unknown_sources(runtime, monkeypatch):
    runtime, _, _ = runtime
    await seed_pending(runtime)
    async def decide(context):
        if context.get('_load'): await context['_load']()
        return {'decision':'notify','summary':'伪造结果','source_ids':['unknown']}
    monkeypatch.setattr(runtime, '_decide', decide)
    run = await runtime.check()
    assert run['status'] == 'failed'
    assert not run.get('deliveries')

async def test_real_checker_uses_separate_visible_session_and_bounded_context(runtime, monkeypatch):
    runtime, project, _ = runtime
    await seed_pending(runtime)
    main = await runtime.main_session()
    calls=[]
    events=[]
    publish = runtime.bus.publish
    async def record(event):
        events.append(event)
        await publish(event)
    monkeypatch.setattr(runtime.bus, 'publish', record)
    async def invoke(engine, model, cwd, prompt, *args, **kwargs):
        from services import memory_query
        token=await assessment_access(runtime)
        await memory_query.pending(runtime.projects,token)
        calls.append((prompt,kwargs))
        return '{"decision":"silent","summary":"无新增结果","source_ids":[]}', [], 'check-thread'
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    run=await runtime.check()
    assert run['status']=='silent',run
    from models.chat_session import ChatSession
    sessions=await runtime.projects.run_db(project.id, lambda _: [(r.id,r.archived) for r in ChatSession.select()])
    assert (main['id'],False) in sessions
    assert len([sid for sid,archived in sessions if not archived and sid!=main['id']])==1
    assert len(calls)==1
    assert len(calls[0][0])<20000
    assert (await runtime._collect())['messages']==[]
    changes = [e for e in events if e.get('name') == 'channel.session_changed']
    assert len(changes) == 2
    assert all(e['project_id'] == project.id for e in changes)
    assert any(e.get('channel') == 'session_chat' and e.get('type') == 'TEXT_MESSAGE_START' for e in events)

async def test_completed_delegation_notifies_once_and_preserves_source(runtime, monkeypatch):
    runtime, project, _ = runtime
    main=await runtime.main_session()
    item={'id':'work','project_id':project.id,'session_id':main['id'],'message_id':'result','origin_session_id':main['id'],'status':'running','notified':False}
    await runtime.mutate(lambda s:s['delegations'].append(item))
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    await runtime.projects.run_db(project.id,lambda _:ChatMessage.create(id='result',session=main['id'],role='assistant',status='completed',content='检查通过',created_at=utc_now()))
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:[])
    from services import digital_person
    profile=digital_person.get_profile().model_copy(update={'quiet_start':0,'quiet_end':0})
    await runtime.follow_delegations(profile)
    run=(await runtime.state())['runs'][0]
    assert run['status']=='notified',run
    assert run['deliveries'][0]['session_id']==main['id']
    await runtime.follow_delegations(profile)
    count=await runtime.projects.run_db(project.id,lambda _:ChatMessage.select().where(ChatMessage.session==main['id'],ChatMessage.content.contains('委派任务已完成')).count())
    assert count==1

async def test_quiet_time_defers_and_keeps_pending_work(runtime,monkeypatch):
    runtime, _, store=runtime
    from datetime import datetime
    hour=datetime.now().astimezone().hour
    store.set('digital_person',{'enabled':True,'proactive_enabled':True,'quiet_start':hour,'quiet_end':(hour+1)%24})
    monkeypatch.setattr('services.memory_pending_queue.has_pending',lambda _:True)
    async def collect(**kwargs):return {'origin_project_id':(await runtime.home()).id,'origin_session_id':(await runtime.main_session())['id'],'source_kind':'chat','messages':[],'delegations':[{'id':'work','status':'completed','result':'done'}]}
    async def decide(context):
        await context['_load']()
        return {'decision':'notify','summary':'done','source_ids':['work']}
    monkeypatch.setattr(runtime,'_collect',collect);monkeypatch.setattr(runtime,'_decide',decide)
    run=await runtime.check(manual=False)
    assert run['status']=='deferred'
    assert run['deliveries']==[]
    detail=await runtime.run_detail(run['id'])
    assert detail['notification_message']=='done'
    assert detail['summary']==''
    assert detail['outcome']['sent']==0

@pytest.mark.parametrize('endpoint', ['activity', 'activity/records', 'runs/canary-run', 'runs/canary-run/knowledge', 'check', 'feedback'])
async def test_runtime_api_stays_responsive_under_slow_database(runtime,monkeypatch,endpoint):
    import threading
    import main
    from fastapi import FastAPI
    from api.digital_person import router
    from httpx import AsyncClient,ASGITransport
    from services import digital_person_runtime as service
    runtime, project, _=runtime
    if endpoint.startswith('runs/canary-run'):
        await runtime.mutate(lambda state: state['runs'].append({'id': 'canary-run', 'summary': 'done'}))
    if endpoint == 'feedback':
        from models.chat_session import ChatMessage
        from models.fields import utc_now
        sid = (await runtime.main_session())['id']
        await runtime.projects.run_db(project.id, lambda _: ChatMessage.create(
            id='canary-feedback', session=sid, role='assistant', status='completed',
            content='测试回复', created_at=utc_now()))
    async def decide(_):
        return {'decision': 'silent', 'summary': '无变化', 'source_ids': []}
    monkeypatch.setattr(runtime, '_decide', decide)
    monkeypatch.setattr(main,'digital_person_runtime',runtime)
    entered,release=threading.Event(),threading.Event()
    original=service.read_state
    def slow(pid):
        entered.set();assert release.wait(3);return original(pid)
    monkeypatch.setattr(service,'read_state',slow)
    app=FastAPI();app.include_router(router)
    @app.get('/health')
    async def health():return {'ok':True}
    async with AsyncClient(transport=ASGITransport(app),base_url='http://test') as client:
        pending=asyncio.create_task(client.request('PUT' if endpoint == 'feedback' else 'POST' if endpoint == 'check' else 'GET', '/api/digital-person/' + endpoint, **({'json': {'message_id': 'canary-feedback', 'value': 1}} if endpoint == 'feedback' else {})))
        try:
            assert await asyncio.to_thread(entered.wait,2)
            assert (await asyncio.wait_for(client.get('/health'),.3)).status_code==200
        finally:release.set()
        assert (await pending).status_code==200

async def test_runtime_api_host_scope_rejects_project_identity(runtime,monkeypatch):
    import main
    from fastapi import FastAPI
    from api.digital_person import router
    from httpx import AsyncClient,ASGITransport
    from services.remote_access import ActorSnapshot,actor_context
    runtime, _, _=runtime;monkeypatch.setattr(main,'digital_person_runtime',runtime)
    app=FastAPI();app.include_router(router)
    actor=ActorSnapshot(actor_id='u',user_name='u',device_id='d',device_name='d',source='remote_project',project_id='other',access_level='edit')
    with actor_context(actor):
        async with AsyncClient(transport=ASGITransport(app),base_url='http://test') as client:
            assert (await client.get('/api/digital-person/info')).status_code==403
            assert (await client.get('/api/digital-person/activity')).status_code==403
            assert (await client.get('/api/digital-person/activity/records')).status_code==403
            assert (await client.get('/api/digital-person/delegations', params={'project_id': 'other', 'origin_session_id': 'source'})).status_code==403
            assert (await client.get('/api/digital-person/delegations', params={'delegation_id': 'prior', 'origin_session_id': 'source'})).status_code==403
            assert (await client.get('/api/digital-person/delegations', params={'project_id': 'other'})).status_code==403
            assert (await client.get('/api/digital-person/delegations', params={'delegation_id': 'prior'})).status_code==403
            assert (await client.get('/api/digital-person/delegations')).status_code==403
            assert (await client.post('/api/digital-person/delegate', json={'project_id': 'other', 'instruction': 'follow up', 'request_id': 'denied', 'continuation_of': 'prior'})).status_code==403
            assert (await client.get('/api/digital-person/runs/private')).status_code==403
            assert (await client.get('/api/digital-person/runs/private/knowledge')).status_code==403
            assert (await client.post('/api/digital-person/check')).status_code==403
            assert (await client.post('/api/digital-person/check?background=true')).status_code==403

async def test_cli_check_calls_real_runtime_without_enabling_settings(runtime, monkeypatch):
    import main
    from fastapi import FastAPI
    from api.digital_person import router
    from cli import build_parser, dispatch
    from services.tool_registry import WorkstepClient
    from httpx import ASGITransport

    current, _, store = runtime
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    app = FastAPI()
    app.include_router(router)
    client = WorkstepClient(base_url='http://test', transport=ASGITransport(app))
    args = build_parser().parse_args(['digital-person', 'check', '--json'])
    result = await dispatch(args, client)
    assert result == {'status': 'accepted'}
    assert await current._cycle_task == {'status': 'silent', 'sources': {'no_work': True}, 'deliveries': []}
    assert store.get('digital_person') == {'enabled': True}

    store.set('digital_person', {'enabled': False})
    result = await dispatch(args, client)
    assert result['ok'] is False and 'not enabled' in result['error']


async def test_cli_check_returns_before_reflection_and_rejects_duplicates(runtime, monkeypatch):
    import main
    from fastapi import FastAPI
    from api.digital_person import router
    from cli import build_parser, dispatch
    from services.tool_registry import WorkstepClient
    from httpx import ASGITransport

    current, _, _ = runtime
    started, release = asyncio.Event(), asyncio.Event()
    calls = []
    async def check(manual=True):
        calls.append(manual)
        started.set()
        await release.wait()
        return {'status': 'silent'}
    monkeypatch.setattr(current, 'check', check)
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    app = FastAPI()
    app.include_router(router)
    client = WorkstepClient(base_url='http://test', transport=ASGITransport(app))
    args = build_parser().parse_args(['digital-person', 'check', '--json'])
    try:
        assert await asyncio.wait_for(dispatch(args, client), 1) == {'status': 'accepted'}
        await asyncio.wait_for(started.wait(), 1)
        assert not current._cycle_task.done()
        duplicate = await dispatch(args, client)
        assert duplicate['ok'] is False and 'in progress' in duplicate['error']
        assert calls == [True]
        stop = build_parser().parse_args(['digital-person', 'stop', '--json'])
        assert await dispatch(stop, client) == {'stopped': True}
        assert current._cycle_task.cancelled()
    finally:
        release.set()
        await current.shutdown()


async def test_background_check_keeps_health_responsive_during_slow_profile_read(runtime, monkeypatch):
    import threading
    import main
    from fastapi import FastAPI
    from api.digital_person import router
    from services import digital_person
    from httpx import AsyncClient, ASGITransport

    current, _, _ = runtime
    profile = digital_person.get_profile()
    entered, release = threading.Event(), threading.Event()
    def slow_profile():
        entered.set()
        assert release.wait(3)
        return profile
    async def check(manual=True):
        return {'status': 'silent'}
    monkeypatch.setattr(digital_person, 'get_profile', slow_profile)
    monkeypatch.setattr(current, 'check', check)
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    app = FastAPI()
    app.include_router(router)
    @app.get('/health')
    async def health():
        return {'ok': True}
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        pending = asyncio.create_task(client.post('/api/digital-person/check?background=true'))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            assert (await asyncio.wait_for(client.get('/health'), .3)).status_code == 200
        finally:
            release.set()
        assert (await pending).json() == {'status': 'accepted'}
        await current._cycle_task


async def test_delegate_returns_before_work_finishes_and_deduplicates(runtime,monkeypatch,tmp_path):
    runtime, home, _=runtime
    target=await asyncio.to_thread(runtime.projects.init_project,tmp_path/'execution')
    release=asyncio.Event()
    async def invoke(*args,**kwargs):
        await release.wait()
        return '任务完成',[], 'worker-thread'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    first=await asyncio.wait_for(runtime.delegate(target.id,'修改演示文件',request_id='same-request'),1)
    again=await runtime.delegate(target.id,'修改演示文件',request_id='same-request')
    assert again['session_id']==first['session_id']
    assert first['status']=='running'
    assert first['session_id']!=(await runtime.main_session())['id']
    release.set()
    from models.chat_session import ChatMessage
    async with asyncio.timeout(2):
        while True:
            status=await runtime.projects.run_db(target.id,lambda _:ChatMessage.get_by_id(first['message_id']).status)
            if status in ('completed','succeeded'):break
            if status in ('error','failed','stopped'):
                detail=await runtime.projects.run_db(target.id,lambda _:ChatMessage.get_by_id(first['message_id']).content)
                pytest.fail(f'{status}: {detail}')
            await asyncio.sleep(.01)
    await runtime.follow_delegations()
    assert (await runtime.state())['delegations'][0]['status']=='completed'


async def test_delegate_continuation_reuses_session_and_queues_in_order(runtime, monkeypatch, tmp_path):
    current, home, _ = runtime
    target = await asyncio.to_thread(current.projects.init_project, tmp_path / 'continuation')
    origin = (await current.main_session())['id']
    other_origin = await current.projects.run_db(home.id, lambda _: current.chats.create_session(home.id))
    entered = asyncio.Event()
    release = asyncio.Event()
    inputs = []
    prepare = current.chats._prepare_turn_context

    async def pause_first(session):
        if not entered.is_set():
            entered.set()
            await release.wait()
        await prepare(session)

    async def invoke(engine, model, cwd, prompt, session_id, *args, **kwargs):
        inputs.append((prompt, session_id))
        return '完成', [], 'worker-thread'

    monkeypatch.setattr(current.chats, '_prepare_turn_context', pause_first)
    monkeypatch.setattr(current.chats, '_invoke', invoke)
    first = await current.delegate(target.id, '初始需求', origin, 'first', title='完善登录')
    await asyncio.wait_for(entered.wait(), 1)
    try:
        assert (await current.list_delegations(target.id, origin))['items'][0]['id'] == first['id']
        assert (await current.list_delegations(target.id, other_origin['id']))['items'] == []
        with pytest.raises(ValueError):
            await current.delegate(target.id, '不能跨来源复用', other_origin['id'], 'wrong-origin', first['id'])
        second = await current.delegate(target.id, '追加验证码', origin, 'second', first['id'])
        third = await current.delegate(target.id, '追加找回密码', origin, 'third', first['id'])
        assert second['status'] == third['status'] == 'queued'
        assert second['session_id'] == third['session_id'] == first['session_id']
        assert second['title'] == third['title'] == '完善登录'
        assert second['message_id'] != first['message_id']
        replay = await current.delegate(target.id, '追加验证码', origin, 'second', first['id'])
        assert (replay['id'], replay['message_id']) == (second['id'], second['message_id'])
        with pytest.raises(ValueError):
            await current.delegate(target.id, '追加验证码', origin, 'second')
        assert not inputs
        await current.follow_delegations()
        state = await current.state()
        assert state['delegations'][0]['status'] == 'queued'
        assert len(state['delegation_executions']) == 2
    finally:
        release.set()
    for item in (first, second, third):
        await current.chats.await_turn(item['turn_id'], timeout=2)
    assert len(inputs) == 3
    assert '初始需求' in inputs[0][0] and '追加验证码' not in inputs[0][0]
    assert '追加验证码' in inputs[1][0] and '追加找回密码' not in inputs[1][0]
    assert '追加找回密码' in inputs[2][0]
    fourth = await current.delegate(target.id, '继续优化', origin, 'fourth', first['id'])
    assert fourth['session_id'] == first['session_id'] and fourth['status'] == 'running'
    await current.chats.await_turn(fourth['turn_id'], timeout=2)
    from models.chat_session import ChatSession
    await current.projects.run_db(target.id, lambda _: ChatSession.update(archived=True).where(ChatSession.id == first['session_id']).execute())
    with pytest.raises(ValueError, match='archived'):
        await current.delegate(target.id, '不能继续', origin, 'archived', first['id'])
    assert await current.projects.run_db(target.id, lambda _: ChatSession.select().count()) == 1

    other_target = await asyncio.to_thread(current.projects.init_project, tmp_path / 'other-delegation-project')
    other = await current.delegate(other_target.id, '另一会话的任务', other_origin['id'], 'other')
    await current.chats.await_turn(other['turn_id'], timeout=2)
    assert [item['id'] for item in (await current.list_delegations())['items']] == [
        item['id'] for item in (other, fourth)
    ]
    assert (await current.list_delegations(origin_session_id=other_origin['id']))['items'][0]['id'] == other['id']
    assert (await current.list_delegations(target.id, other_origin['id']))['items'] == []


async def test_delegate_existing_conversation_registers_and_follows_it(runtime, monkeypatch, tmp_path):
    import threading

    import httpx
    import main
    from cli import build_parser, dispatch
    from models.chat_session import ChatSession
    from services.remote_access import ActorSnapshot, actor_context
    from services.tool_registry import WorkstepClient

    current, _, _ = runtime
    target = await asyncio.to_thread(current.projects.init_project, tmp_path / 'adopt-chat')
    origin = (await current.main_session())['id']
    session = await current.projects.run_db(target.id, lambda _: current.chats.create_session(target.id, title='已有会话'))
    sid = session['id']
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    monkeypatch.setattr(main, 'project_manager', current.projects)
    monkeypatch.setattr(main, 'chat_session_module', current.chats)
    started, finish = asyncio.Event(), asyncio.Event()
    prompts = []

    async def invoke(engine, model, cwd, prompt, session_id, *args, **kwargs):
        prompts.append(prompt)
        if len(prompts) == 1:
            started.set()
            await finish.wait()
            return '已有对话结果', [], None
        return '委派执行完成', [], None

    monkeypatch.setattr(current.chats, '_invoke', invoke)
    previous = await current.projects.run_db(target.id, lambda _: current.chats.submit_message(
        target.id, sid, '原先任务', 'original', schedule=False,
    ))
    current.chats.start_queued_turn(previous.turn_id)
    entered, release = threading.Event(), threading.Event()
    execute_sql = target.db.execute_sql

    def slow_sql(sql, *args, **kwargs):
        if 'FROM "chat_sessions"' in sql and not entered.is_set():
            entered.set()
            release.wait(2)
        return execute_sql(sql, *args, **kwargs)

    monkeypatch.setattr(target.db, 'execute_sql', slow_sql)
    transport = httpx.ASGITransport(app=main.app)
    client = WorkstepClient(base_url='http://test', transport=transport)
    payload = {'project_id': target.id, 'origin_session_id': origin, 'target_session_id': sid,
               'instruction': '接着执行', 'request_id': 'adopt'}
    with actor_context(ActorSnapshot('editor', '编辑者', 'device', '设备', 'managed',
                                     project_id=target.id, access_level='edit')):
        denied = await client.call('workstep_delegate_digital_person', {**payload, 'confirm': 'yes'})
        assert denied == {'ok': False, 'error': 'Project scope denied'}
        async with httpx.AsyncClient(base_url='http://test', transport=transport) as http:
            denied = await http.post('/api/digital-person/delegate/existing', json=payload)
        assert denied.status_code == 403
    argv = ['digital-person', 'delegate', '--project', target.id, '--session', origin,
            '--target-session', sid, '--title', '核对现有结果', '--instruction', '接着执行', '--idempotency-key', 'adopt']
    try:
        await asyncio.wait_for(started.wait(), 2)
        args = build_parser().parse_args(argv)
        pending = asyncio.create_task(dispatch(args, client))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            async with httpx.AsyncClient(base_url='http://test', transport=transport) as http:
                assert (await asyncio.wait_for(http.get('/api/health'), .5)).status_code == 200
        finally:
            release.set()
            adopted = await pending
        assert adopted['session_id'] == sid and adopted['status'] == 'queued'
        assert adopted['followup_state'] == 'pending'
        replay = await dispatch(args, client)
        assert (replay['id'], replay['message_id']) == (adopted['id'], adopted['message_id'])
        archive = build_parser().parse_args(['session', 'archive', '--project', target.id, '--session', sid])
        assert await dispatch(archive, client) == {'ok': False, 'error': 'Chat session is running'}
        assert len(prompts) == 1
    finally:
        finish.set()
    await current.chats.await_turn(adopted['turn_id'], timeout=2)
    await current.delegation_management.refresh()
    state = await current.state()
    assert [item['id'] for item in state['delegations']] == [adopted['id']]
    eligible = await current.delegation_management.eligible(state)
    assert [item['id'] for item in eligible] == [adopted['id']]
    result, = (await current.list_delegations(target.id, origin, adopted['id']))['items']
    assert result['status'] == 'completed' and result['result'] == '委派执行完成'
    assert result['title'] == '核对现有结果'
    assert await current.projects.run_db(target.id, lambda _: ChatSession.get_by_id(sid).title) == '已有会话'
    activity, = (await current.activity_records())['delegations']
    assert (activity['id'], activity['session_id']) == (adopted['id'], sid)
    assert '已有对话结果' in prompts[1] and '接着执行' in prompts[1]

    second = await current.delegate(target.id, '再做一次', origin, 'adopt-again', target_session_id=sid)
    assert second['continuation_of'] == adopted['id']
    assert second['session_id'] == sid
    await current.chats.await_turn(second['turn_id'], timeout=2)
    assert await current.projects.run_db(target.id, lambda _: ChatSession.select().count()) == 1
    assert (await current.state())['delegations'][0]['followup_state'] == 'pending'
    assert (await current.state())['delegation_executions'][0]['followup_state'] == 'continued'
    with pytest.raises(ValueError, match='identifier'):
        await current.delegate(target.id, '接着执行', origin, 'adopt', target_session_id='missing')
    with pytest.raises(ValueError, match='deleted|not found'):
        await current.delegate(target.id, '不能发送', origin, 'wrong-project', target_session_id=origin)
    with pytest.raises(ValueError, match='source session'):
        await current.delegate(target.id, '不能发送', sid, 'invalid-origin', target_session_id=sid)
    before_archive = (await current.state())['delegations']
    result = await dispatch(archive, client)
    assert result['id'] == sid and result['archived'] is True
    assert (await current.state())['delegations'] == before_archive
    with pytest.raises(ValueError, match='archived'):
        await current.delegate(target.id, '不能发送', origin, 'archived', target_session_id=sid)
    with pytest.raises(ValueError, match='archived'):
        await current.delegate(target.id, '不能续办', origin, 'archived-continuation', second['id'])
    assert len((await current.state())['delegations']) == 1


async def test_delegate_continuation_api_does_not_block_health(runtime, monkeypatch, tmp_path):
    import threading
    import main
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from api.digital_person import router
    from models.chat_session import ChatMessage, ChatSession

    current, _, _ = runtime
    target = await asyncio.to_thread(current.projects.init_project, tmp_path / 'continuation-canary')
    origin = (await current.main_session())['id']
    monkeypatch.setattr(main, 'digital_person_runtime', current)

    async def invoke(*args, **kwargs):
        return '完成', [], 'worker-thread'

    monkeypatch.setattr(current.chats, '_invoke', invoke)
    entered, release = threading.Event(), threading.Event()
    submit = current.chats.submit_message

    def slow_submit(*args, **kwargs):
        entered.set()
        assert release.wait(2)
        return submit(*args, **kwargs)

    app = FastAPI()
    app.include_router(router)

    @app.get('/health')
    async def health():
        return {'ok': True}

    scope = {'project_id': target.id, 'origin_session_id': origin}
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        instruction = '核对登录流程并记录测试结论。' * 20
        payload = {**scope, 'instruction': instruction, 'title': '  核对登录流程  ', 'request_id': 'first'}
        for invalid in ('   ', '第一行\n第二行', '长' * 61):
            assert (await client.post('/api/digital-person/delegate', json={**payload, 'title': invalid})).status_code == 400
        created = await client.post('/api/digital-person/delegate', json=payload)
        assert created.status_code == 200, created.text
        first = created.json()
        await current.chats.await_turn(first['turn_id'], timeout=2)
        assert first['title'] == '核对登录流程' and first['instruction'] == instruction
        assert (await current.state())['delegations'][0]['title'] == first['title']
        assert await current.projects.run_db(target.id, lambda _: ChatSession.get_by_id(first['session_id']).title) == first['title']
        assert await current.projects.run_db(target.id, lambda _: ChatMessage.select(ChatMessage.content).where(
            ChatMessage.session == first['session_id'], ChatMessage.role == 'user',
        ).scalar()) == instruction
        replay = await client.post('/api/digital-person/delegate', json={**payload, 'title': first['title']})
        assert replay.json()['id'] == first['id']
        assert (await client.post('/api/digital-person/delegate', json={**payload, 'title': '另一标题'})).status_code == 400
        listed = await client.get('/api/digital-person/delegations', params=scope)
        assert listed.json()['items'][0]['id'] == first['id']
        assert listed.json()['items'][0]['title'] == first['title']
        path = '/api/digital-person/delegations'
        assert (await client.get(path, params={'project_id': target.id, 'origin_session_id': ''})).status_code == 422
        for params in ({}, {'project_id': target.id}, {'origin_session_id': origin}):
            listed = await client.get(path, params=params)
            assert listed.status_code == 200
            assert [(item['id'], item['project_id']) for item in listed.json()['items']] == [(first['id'], target.id)]
        details = await client.get(path, params={'delegation_id': first['id']})
        assert details.status_code == 200
        assert details.json()['items'][0]['result'] == '完成'
        filtered = await client.get(path, params={'delegation_id': first['id'], 'origin_session_id': first['session_id']})
        assert filtered.json() == {'items': []}
        activity, = (await current.activity_records())['delegations']
        assert activity['title'] == first['title'] and activity['instruction'] == instruction[:120]
        monkeypatch.setattr(current.chats, 'submit_message', slow_submit)
        pending = asyncio.create_task(client.post('/api/digital-person/delegate', json={
            **scope, 'instruction': '追加需求', 'title': '补查权限', 'request_id': 'continue', 'continuation_of': first['id'],
        }))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            assert (await asyncio.wait_for(client.get('/health'), .3)).status_code == 200
        finally:
            release.set()
        response = await pending
    assert response.status_code == 200, response.text
    assert response.json()['session_id'] == first['session_id']
    assert response.json()['title'] == '补查权限'
    await current.chats.await_turn(response.json()['turn_id'], timeout=2)
    assert await current.projects.run_db(target.id, lambda _: ChatSession.get_by_id(first['session_id']).title) == first['title']

async def test_failed_local_delivery_does_not_block_channels_and_retry_skips_success(runtime,monkeypatch):
    runtime, project, _=runtime
    main=await runtime.main_session()
    from models.chat_session import ChatSession
    await runtime.projects.run_db(project.id,lambda _:ChatSession.update(archived=True).where(ChatSession.id==main['id']).execute())
    await runtime.mutate(lambda s:s['delegations'].append({'id':'work','origin_session_id':main['id']}))
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:[{
        'id':'peer','notify':True,'use_main_session':True,
        'bot_id':'bot','conversation_type':'single','conversation_id':'owner'}])
    sent=[]
    async def send(*args):sent.append(args);return {'message_id':'remote'}
    monkeypatch.setattr('services.digital_person_channels.send_binding',send)
    receipts=await runtime._notify('done',['work'],'run')
    assert [r['status'] for r in receipts]==['failed','delivered']
    await runtime.mutate(lambda s:s['runs'].append({'id':'run','status':'delivery_failed','summary':'done','deliveries':receipts}))
    await runtime.projects.run_db(project.id,lambda _:ChatSession.update(archived=False).where(ChatSession.id==main['id']).execute())
    run=await runtime.retry_delivery('run')
    assert run['status']=='notified'
    assert len(sent)==1

async def test_retry_only_failed_channel(runtime,monkeypatch):
    runtime, _, _=runtime
    await runtime.mutate(lambda s:s['runs'].append({'id':'run','status':'delivery_failed','summary':'done','deliveries':[
        {'kind':'channel','binding_id':'ok','status':'delivered'}, {'kind':'channel','binding_id':'retry','status':'failed'}]}))
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:[{'id':'retry','notify':True}])
    sent=[]
    async def send(_,binding,text):sent.append(binding['id']);return {'message_id':'result'}
    monkeypatch.setattr('services.digital_person_channels.send_binding',send)
    assert (await runtime.retry_delivery('run'))['status']=='notified'
    assert sent==['retry']
    with pytest.raises(ValueError):await runtime.retry_delivery('run')

async def test_channel_result_only_notifies_its_origin_peer(runtime,monkeypatch):
    runtime, _, _=runtime
    origin=(await runtime.main_session())['id']
    await runtime.mutate(lambda s:s['delegations'].append({'id':'work','origin_session_id':origin}))
    class Bots:
        async def _load(self):return {'sessions':{'a:single:one':origin,'b:single:two':'other'},'session_sources':{origin:{'project_id':'home'}}}
    runtime.bots=Bots()
    monkeypatch.setattr('services.digital_person_channels.get_bindings',lambda:[
        {'id':'old','bot_id':'a','conversation_type':'single','conversation_id':'one','notify':True},
        {'id':'other','bot_id':'b','conversation_type':'single','conversation_id':'two','notify':True}])
    sent=[]
    async def send(_,binding,text):sent.append(binding['bot_id']);return {}
    monkeypatch.setattr('services.digital_person_channels.send_binding',send)
    await runtime._notify('仅给发起人',['work'],'run')
    assert sent==['a']

async def test_check_sources_are_isolated_and_rotate_between_initiators(runtime):
    runtime, project, _=runtime
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    first=(await runtime.main_session())['id']
    second=await runtime.projects.run_db(project.id,lambda _:runtime.chats.create_session(project.id))
    def seed(_):
        for sid,text in ((first,'甲的私有要求'),(second['id'],'乙的私有要求')):
            create_completed_user(id=sid+'-user',session=sid,role='user',status='completed',content=text,created_at=utc_now())
            ChatMessage.create(id=sid+'-answer',session=sid,role='assistant',status='completed',content=text+'已完成',created_at=utc_now())
    await runtime.projects.run_db(project.id,seed)
    await runtime.mutate(lambda s:s['delegations'].extend([
        {'id':sid,'project_id':project.id,'session_id':sid,'origin_session_id':sid,'message_id':sid+'-answer','notified':False}
        for sid in (first,second['id'])]))
    context=await runtime._collect()
    assert len(context['_groups'])==2
    assert {g['origin_session_id'] for g in context['_groups']}=={first,second['id']}
    for group in context['_groups']:
        expected='甲的私有要求' if group['origin_session_id']==first else '乙的私有要求'
        assert [m['content'] for m in group['messages']]==[expected]



@pytest.mark.parametrize("reply,expected", [
    ("", 'did not return results'),
    ("   ", 'did not return results'),
    ("暂时没有需要通知的事项。", 'not valid JSON'),
    ("[]", 'result structure is invalid'),
    ("null", 'result structure is invalid'),
    ('{"decision":"silent","summary":"无变化","source_ids":[{}]}', 'result structure is invalid'),
])
async def test_checker_rejects_empty_or_invalid_model_output_with_actionable_error(runtime, monkeypatch, reply, expected):
    runtime, _, _ = runtime
    await seed_pending(runtime)
    async def invoke(*args, **kwargs):
        return reply, [], "check-thread"
    monkeypatch.setattr("agent_assistants.base.invoke_engine", invoke)
    run=await runtime.check()
    assert run["status"]=="failed"
    assert expected in run["error"]
    assert "Expecting value" not in run["error"]
    assert run["deliveries"]==[]
    assert (await runtime.state())["cursor"]==""
    assert runtime._active_check is None


@pytest.mark.parametrize("fence", ["json", "JSON", ""])
async def test_checker_accepts_fenced_json_without_changing_notification_policy(runtime, monkeypatch, fence):
    runtime, _, _ = runtime
    await seed_pending(runtime)
    async def invoke(*args, **kwargs):
        from services import memory_query
        token=await assessment_access(runtime)
        await memory_query.pending(runtime.projects,token)
        return '```'+fence+'\n{"decision":"silent","summary":"无变化","source_ids":[]}\n```', [], "check-thread"
    monkeypatch.setattr("agent_assistants.base.invoke_engine", invoke)
    run=await runtime.check()
    assert run["status"]=="silent",run
    assert run["deliveries"]==[]


async def test_overview_statistics_exclude_check_sessions(runtime, monkeypatch):
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    from types import SimpleNamespace
    runtime, project, _=runtime
    main=await runtime.main_session()
    def seed(_):
        second=runtime.chats.create_session(project.id,title="第二个会话")
        checker=runtime.chats.create_session(project.id,title="检查器")
        for mid,sid,role in [("u-main",main['id'],"user"),("u-second",second['id'],"user"),("u-check",checker['id'],"user"),
                ("a-main",main['id'],"assistant"),("a-voted",main['id'],"assistant"),("a-second",second['id'],"assistant"),("a-check",checker['id'],"assistant")]:
            ChatMessage.create(id=mid,session=sid,role=role,status="completed",content="测试",created_at=utc_now())
        return checker['id']
    checker=await runtime.projects.run_db(project.id,seed)
    await runtime.mutate(lambda state:state.update(check_sessions=[checker],feedback={"a-voted":-1},delegations=[{"id":"done","status":"completed"},{"id":"busy","status":"running"}]))
    monkeypatch.setattr("services.digital_person_statistics.skill_center.runtime_selection",lambda _:SimpleNamespace(enabled=[SimpleNamespace(skill_id="skill-a",name="代码评审",valid=True,conflict=False,sync_error=None)]))
    snapshot=await runtime.overview()
    assert snapshot['session_count']==2
    assert snapshot['reply_count']==3
    assert snapshot['task_count']==2
    assert snapshot['completed_task_count']==1
    assert snapshot['experience']==3  # 3 replies - 1 negative + 1 completed task
    assert snapshot['skills']==[{"id":"skill-a","name":"代码评审"}]


@pytest.mark.parametrize("channel",[False,True])
async def test_digital_chat_skips_statistics_and_relationship_reads(runtime, monkeypatch,channel):
    runtime, project, _=runtime
    if channel:
        from agent_assistants.channel_chat import ChannelChatModule
        runtime.chats=ChannelChatModule(runtime.bus,runtime.projects,register=False)
    main=await runtime.main_session()
    reads = []
    monkeypatch.setattr("services.digital_person_statistics.read_statistics", lambda _: reads.append('statistics'))
    monkeypatch.setattr("services.digital_person_affect.read", lambda _: reads.append('affect'))
    calls=[]
    async def invoke(*args, **kwargs):
        calls.append(kwargs.get('system_prompt',''))
        return "收到", [], "native-digital"
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    for index in range(2):
        accepted=await runtime.projects.run_db(project.id,lambda _:runtime.chats.submit_message(project.id,main['id'],"你的状态是什么？",f"status-{index}",schedule=False))
        runtime.chats.start_queued_turn(accepted.turn_id)
        await runtime.chats.await_turn(accepted.turn_id,timeout=5)
    assert len(calls) == 2 and '## Memory retrieval' in calls[0]
    assert reads == []
    for prompt in calls:
        assert 'Level:' not in prompt and 'Experience:' not in prompt
        assert 'runtime statistics' not in prompt and 'Relationship tone reference' not in prompt


async def test_bound_channel_injects_only_changed_digital_person_context(runtime, monkeypatch):
    import threading

    import main
    from httpx import ASGITransport, AsyncClient
    from agent_assistants.channel_chat import ChannelChatModule
    from engines.codex_sdk import CodexSDKEngine
    from engines.core.events import InternalEvent
    from services.channels.bots import BotManager, IncomingMessage
    from services.channels.responder import ChatSessionResponder
    from tests.test_channel_bots import FakeAdapter

    current, project, store = runtime
    module = ChannelChatModule(current.bus, current.projects, register=False)
    calls = []

    class Engine(CodexSDKEngine):
        async def spawn(self, prompt, cwd, model=None, session_id=None, **kwargs):
            calls.append((prompt, session_id, kwargs.get('system_prompt', '')))
            yield InternalEvent(type='session_started', data={'session_id': 'channel-thread'})
            yield InternalEvent(type='agent_message_chunk', data={'content': {'type': 'text', 'text': '收到'}})
            yield InternalEvent(type='done', data={})

    for path in ('agent_assistants.chat_session.create_engine', 'agent_assistants.base.create_engine'):
        monkeypatch.setattr(path, lambda _: Engine())
    for path in ('agent_assistants.channel_chat.config_store', 'services.channels.responder.config_store',
                 'services.digital_person_channels.config_store'):
        monkeypatch.setattr(path, store)
    store.set('assistant_defaults', {'digital_person': {'engine': 'codex_sdk'}})
    store.set('digital_person', {'enabled': True, 'name': '渠道数字人'})
    manager = BotManager(store, current.projects, current.bus, None,
                         ChatSessionResponder(current.bus, current.projects, module), {'dingtalk': FakeAdapter})
    bot = await manager.create_bot({'platform': 'dingtalk', 'name': '机器人', 'app_id': 'bot',
                                    'secret': 'secret', 'enabled': True})
    store.set('digital_person_channels', [{'bot_id': bot['id'], 'conversation_type': 'group',
                                           'conversation_id': 'room'}])

    async def send(number, sender):
        await manager.handle_message(IncomingMessage(bot['id'], str(number), 'group', 'room',
                                                     sender, '你好', conversation_name='研发群'))

    try:
        await send(1, 'alice')
        assert calls[-1][1] is None and 'Name: 渠道数字人' in calls[-1][2]
        assert 'workstep-ui' not in calls[-1][2]
        assert calls[-1][0] == '你好'
        assert '"sender_id": "alice"' in calls[-1][2]
        module._sessions.clear()
        await send(2, 'bob')
        assert calls[-1][:2] == ('你好', 'channel-thread')
        assert '"sender_id": "bob"' in calls[-1][2]
        assert 'Name: 渠道数字人' not in calls[-1][2]

        original_execute = project.db.execute_sql
        entered, release = threading.Event(), threading.Event()

        def slow_receipt_read(sql, params=None, *args, **kwargs):
            if sql.startswith('SELECT') and '"digital_person_injection"' in (params or ()):
                entered.set()
                assert release.wait(3)
            return original_execute(sql, params, *args, **kwargs)

        monkeypatch.setattr(project.db, 'execute_sql', slow_receipt_read)
        pending = asyncio.create_task(send(3, 'bob'))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            async with AsyncClient(transport=ASGITransport(app=main.app), base_url='http://test') as client:
                assert (await asyncio.wait_for(client.get('/api/health'), .3)).status_code == 200
        finally:
            release.set()
            await pending
        assert calls[-1][2] == ''

        from services import digital_person
        monkeypatch.setattr(digital_person, 'PROJECT_DELEGATION_PROMPT', 'Updated delegation instructions')
        await send(4, 'bob')
        assert calls[-1][2] == 'Updated delegation instructions'

        store.set('digital_person', {'enabled': True, 'name': '新人设'})
        await send(5, 'bob')
        assert 'Name: 新人设' in calls[-1][2]
        assert 'Updated delegation instructions' not in calls[-1][2]
        await send(6, 'bob')
        assert calls[-1] == ('你好', 'channel-thread', '')
        assert len(calls) == 6

        from models.chat_session import ChatMessage
        rows = await current.projects.run_db(project.id, lambda _: list(
            ChatMessage.select(ChatMessage.role, ChatMessage.content, ChatMessage.prompt).dicts()
        ))
        assert len(rows) == 12
        assert all(row['content'] == ('你好' if row['role'] == 'user' else '收到') for row in rows)
        source_updates = [row['prompt'] for row in rows if 'Current channel source' in (row['prompt'] or '')]
        assert len(source_updates) == 2
        for snapshot in source_updates:
            instructions, body = snapshot.split('### 正文（user）', 1)
            assert '### 独立指令（developer）' in instructions
            assert body.strip() == '```text\n你好\n```'
        assert manager._adapters[bot['id']].sent == [('room', '收到')] * 6
    finally:
        await manager.shutdown()


async def test_slow_skill_discovery_does_not_block_activity_api(runtime,monkeypatch):
    import main,threading
    from fastapi import FastAPI
    from api.digital_person import router
    from httpx import AsyncClient,ASGITransport
    runtime, _, _=runtime
    monkeypatch.setattr(main,'digital_person_runtime',runtime)
    entered,release=threading.Event(),threading.Event()
    def slow(_):
        entered.set();assert release.wait(3);return []
    monkeypatch.setattr('services.digital_person_statistics.enabled_skills',slow)
    app=FastAPI();app.include_router(router)
    @app.get('/health')
    async def health():return {'ok':True}
    async with AsyncClient(transport=ASGITransport(app),base_url='http://test') as client:
        pending=asyncio.create_task(client.get('/api/digital-person/activity'))
        try:
            assert await asyncio.to_thread(entered.wait,2)
            assert (await asyncio.wait_for(client.get('/health'),.3)).status_code==200
        finally:release.set()
        assert (await pending).status_code==200

@pytest.mark.parametrize('shared', [True, False])
async def test_checker_reuses_workstep_session_with_configured_context(runtime, monkeypatch, shared):
    runtime, project, store = runtime
    store.set('digital_person', {'enabled': True, 'proactive_shared_context': shared})
    from models.chat_session import ChatSession, ChatMessage
    calls = []
    async def invoke(engine, model, cwd, prompt, session_id, *args, **kwargs):
        calls.append((prompt, session_id, kwargs.get('message_history')))
        return '{"decision":"silent","summary":"done","source_ids":[]}', [], f'engine-{len(calls)}'
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    await runtime._decide({'first_only_secret': 'first'})
    first = (await runtime.state())['check_sessions'][-1]
    await runtime._decide({'second_only': 'second'})
    state = await runtime.state()
    assert state['check_sessions'] == [first]
    assert state['check_session_id'] == first
    assert len(calls) == 2
    assert calls[0][1:] == (None, None)
    assert calls[1][1] == ('engine-1' if shared else None)
    assert 'first_only_secret' not in calls[1][0]
    if not shared:
        assert calls[1][2] is None
    assert 'second_only' not in calls[1][0]
    assert 'Start this background assessment' in calls[1][0]
    assert '/new' not in calls[1][0]
    def inspect(_):
        assert ChatSession.select().count() == 1
        assert ChatMessage.select().where(ChatMessage.session == first).count() == 4
        assert all(not m.content.lstrip().startswith(('/new','/clear')) for m in ChatMessage.select().where(ChatMessage.session==first,ChatMessage.role=='user'))
        assert ChatSession.get_by_id(first).engine_session_id == 'engine-2'
        assert ChatSession.get_by_id(first).title == '主动思考'
        assert ChatSession.get_by_id(first).archived is False
        assert [r['id'] for r in runtime.chats.list_sessions(project.id)] == [first]
        assert runtime.chats.list_sessions(project.id, archived=True) == []
    await runtime.projects.run_db(project.id, inspect)


async def test_checker_replaces_archived_legacy_session_and_preserves_history(runtime, monkeypatch):
    runtime, project, _ = runtime
    from models.chat_session import ChatSession
    def seed(_):
        old = [runtime.chats.create_session(project.id, title='主动检查')['id'] for _ in range(2)]
        user = runtime.chats.create_session(project.id, title='主动检查')['id']
        ChatSession.update(archived=True).execute()
        return old, user
    old, user = await runtime.projects.run_db(project.id, seed)
    await runtime.mutate(lambda state: state.update(check_sessions=old))
    async def invoke(*args, **kwargs):
        return '{"decision":"silent","summary":"done","source_ids":[]}', [], 'fresh'
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    await runtime._decide({})
    state = await runtime.state()
    assert state['check_session_id'] not in old
    assert state['check_sessions'] == old + [state['check_session_id']]
    rows = await runtime.projects.run_db(project.id, lambda _: runtime.chats.list_sessions(project.id, archived=True))
    assert {row['id'] for row in rows} == {*old, user}

async def test_check_session_listing_keeps_api_responsive_during_slow_database(runtime, monkeypatch):
    import threading
    import main
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    from api.chat_session import router
    runtime, project, _ = runtime
    monkeypatch.setattr(main, 'chat_session_module', runtime.chats)
    monkeypatch.setattr(main, 'project_manager', runtime.projects)
    sid = await runtime.projects.run_db(project.id, lambda _: runtime.chats.create_session(project.id, title='主动检查')['id'])
    await runtime.mutate(lambda state: state.update(check_sessions=[sid]))
    entered, release = threading.Event(), threading.Event()
    original = runtime.chats._session_summary
    def slow(*args):
        entered.set()
        assert release.wait(3)
        return original(*args)
    monkeypatch.setattr(runtime.chats, '_session_summary', slow)
    app = FastAPI()
    app.include_router(router)
    @app.get('/health')
    async def health():
        return {'ok': True}
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        pending = asyncio.create_task(client.get('/api/chat-sessions', params={'project_id': project.id}))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            assert (await asyncio.wait_for(client.get('/health'), .3)).status_code == 200
        finally:
            release.set()
        response = await pending
        assert response.status_code == 200
        assert [r['id'] for r in response.json()['sessions']] == [sid]


@pytest.mark.parametrize('shared', [True, False])
async def test_checker_recovers_empty_final_once_in_same_context(runtime, monkeypatch, shared):
    runtime, _, store = runtime
    store.set('digital_person', {'enabled': True, 'proactive_shared_context': shared})
    calls = []
    async def invoke(engine, model, cwd, prompt, session_id, *args, **kwargs):
        calls.append((prompt, session_id))
        if len(calls) == 1:
            return '', [], 'retained-engine'
        return '{"decision":"silent","summary":"","source_ids":[]}', [], 'retained-engine'
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    result = await runtime._decide({})
    assert result['decision'] == 'silent'
    assert len(calls) == 2
    assert calls[1][1] == 'retained-engine'
    assert 'JSON' in calls[1][0]
    assert '<json>{"decision":"silent","summary":"","source_ids":[]}</json>' in calls[1][0]
    assert result['summary'] == ''


async def test_checker_shares_one_conversation_without_cross_contact_engine_history(runtime, monkeypatch):
    runtime, _, _ = runtime
    calls=[]
    async def invoke(engine, model, cwd, prompt, session_id, *args, **kwargs):
        calls.append((prompt,session_id))
        return '{"decision":"silent","summary":"无变化","source_ids":[]}', [], 'engine-'+str(len(calls))
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    await runtime._decide({'companion':{'scope':'channel:a'},'secret_a':'甲'})
    await runtime._decide({'companion':{'scope':'channel:b'},'secret_b':'乙'})
    await runtime._decide({'companion':{'scope':'channel:a'},'next':'甲'})
    assert calls[1][1] is None
    assert 'secret_a' not in calls[1][0]
    assert calls[2][1] is None
    assert 'secret_b' not in calls[2][0]
    await runtime._decide({'local_note':'本机所有者'})
    assert calls[3][1] is None
    assert 'secret_a' not in calls[3][0]
    assert 'secret_b' not in calls[3][0]

    state = await runtime.state()
    assert len(state['check_sessions']) == 1
    assert 'check_sessions_by_scope' not in state
    await runtime._decide({'local_followup': '继续本机检查'})
    assert calls[4][1] == 'engine-4'
    assert (await runtime.state())['check_session_id'] == state['check_session_id']


@pytest.mark.parametrize('action', ['archive', 'delete'])
async def test_checker_recreates_unavailable_conversation(runtime, monkeypatch, action):
    runtime, project, _ = runtime
    calls = []
    async def invoke(engine, model, cwd, prompt, session_id, *args, **kwargs):
        calls.append(session_id)
        return '{"decision":"silent","summary":"done","source_ids":[]}', [], 'retained-engine'
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    await runtime._decide({})
    previous = (await runtime.state())['check_session_id']
    def change(_):
        # Simulate historical/external data damage; normal lifecycle APIs reject this now.
        from models.chat_session import ChatSession
        if action == 'archive':
            ChatSession.update(archived=True).where(ChatSession.id == previous).execute()
        else:
            from models.chat_session import ChatMessage
            ChatMessage.delete().where(ChatMessage.session == previous).execute()
            ChatSession.delete().where(ChatSession.id == previous).execute()
    await runtime.projects.run_db(project.id, change)
    await runtime._decide({})
    current = (await runtime.state())['check_session_id']
    assert current != previous
    assert calls == [None, None]
    await runtime._decide({})
    assert (await runtime.state())['check_session_id'] == current
    assert calls[-1] == 'retained-engine'
    rows = await runtime.projects.run_db(project.id, lambda _: runtime.chats.list_sessions(project.id))
    assert [r['id'] for r in rows] == [current]


async def test_checker_context_toggle_resets_once_then_resumes_new_context(runtime, monkeypatch):
    runtime, project, store = runtime
    calls = []
    async def invoke(engine, model, cwd, prompt, session_id, *args, **kwargs):
        calls.append((session_id, prompt))
        return '{"decision":"silent","summary":"done","source_ids":[]}', [], f'engine-{len(calls)}'
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    await runtime._decide({'old_secret': 'old'})
    sid = (await runtime.state())['check_session_id']
    store.set('digital_person', {'enabled': True, 'proactive_shared_context': False})
    await runtime._decide({'new_only': 'new'})
    store.set('digital_person', {'enabled': True, 'proactive_shared_context': True})
    await runtime._decide({'third': 'third'})
    assert [c[0] for c in calls] == [None, None, 'engine-2']
    assert 'old_secret' not in calls[1][1] + calls[2][1]
    assert 'new_only' not in calls[2][1]
    assert 'Start this background assessment' in calls[2][1]
    detail = await runtime.projects.run_db(project.id, lambda _: runtime.chats.get_session(project.id, sid))
    assert len(detail['messages']) == 6
    assert 'old_secret' not in detail['messages'][0]['content']
    assert 'Start this background assessment' in detail['messages'][0]['content']


async def test_activity_records_api_paginates_previews_and_loads_detail_on_demand(runtime, monkeypatch):
    import main
    from fastapi import FastAPI
    from api.digital_person import router
    from httpx import AsyncClient, ASGITransport
    runtime, _, _ = runtime
    monkeypatch.setattr(main, 'digital_person_runtime', runtime)
    def seed(state):
        state['runs'] = [{'id': f'run-{i}', 'status': 'silent', 'summary': '结果' * 1000,
                          'created_at': f'2026-11-14T01:{20-i:02}:00', 'sources': {'secret': 'large context'},
                          'deliveries': []} for i in range(12)]
        state['delegations'] = [{'id': f'work-{i}', 'project_id': 'p', 'session_id': f's{i}',
                                 'instruction': '执行要求' * 1000, 'status': 'running' if i == 0 else 'completed',
                                 'created_at': f'2026-11-14T01:{i:02}:00', 'request_id': 'private'} for i in range(12)]
        state['runs'][0]['activity_summary'] = '整理 4 条消息（2 个会话），新增 1 条记忆'
    await runtime.mutate(seed)
    app = FastAPI(); app.include_router(router)
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        first = (await client.get('/api/digital-person/activity/records')).json()
        assert len(first['runs']) == 5
        assert first['run_total'] == 12
        assert len(first['delegations']) == 5 and first['delegation_total'] == 12
        assert first['delegations'][0]['created_at'] == '2026-11-14T01:11:00'
        assert 'sources' not in first['runs'][0] and 'deliveries' not in first['runs'][0]
        assert len(first['runs'][0]['summary']) <= 120
        assert 'answers' not in first
        second = (await client.get('/api/digital-person/activity/records?run_offset=5&delegation_offset=5')).json()
        assert {r['id'] for r in second['runs']}.isdisjoint(r['id'] for r in first['runs'])
        detail = (await client.get('/api/digital-person/runs/run-0')).json()
        assert detail['summary'] == '结果' * 1000
        preview = await client.get('/api/digital-person/runs/run-0/knowledge')
        assert preview.headers['cache-control'] == 'no-store'
        assert preview.json() == {'status':'legacy','items':[],'unavailable':0}
        assert (await client.get('/api/digital-person/runs/missing/knowledge')).status_code == 404
        assert (await client.get('/api/digital-person/runs/missing')).status_code == 404
        assert (await client.get('/api/digital-person/activity/records?limit=101')).status_code == 422
        assert (await client.get('/api/digital-person/activity/records?run_offset=-1')).status_code == 422


async def test_checker_migrates_scoped_duplicates_without_losing_history(runtime, monkeypatch):
    from models.chat_session import ChatSession, ChatMessage
    from models.fields import utc_now
    runtime, project, _ = runtime
    def seed(_):
        ids = [runtime.chats.create_session(project.id, title='主动检查')['id'] for _ in range(3)]
        for i, sid in enumerate(ids):
            create_completed_user(id=f'old-{i}', session=sid, role='user', status='completed', content='保留的历史', created_at=utc_now())
        return ids
    local, channel, user = await runtime.projects.run_db(project.id, seed)
    await runtime.mutate(lambda state: state.update(check_sessions=[local,channel], check_session_id=local,
        check_sessions_by_scope={'local':local,'channel:a':channel}))
    calls=[]
    async def invoke(engine, model, cwd, prompt, session_id, *args, **kwargs):
        calls.append(session_id)
        return '{"decision":"silent","summary":"done","source_ids":[]}', [], 'engine'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    await runtime._decide({'companion':{'scope':'channel:a'}})
    state=await runtime.state()
    assert state['check_session_id'] == local
    assert state['check_sessions'] == [local,channel]
    assert state['check_context_scope'] == 'channel:a'
    def inspect(_):
        assert {r['id'] for r in runtime.chats.list_sessions(project.id)} == {local,user}
        assert ChatSession.get_by_id(local).title == '主动思考'
        assert ChatSession.get_by_id(local).archived is False
        assert ChatSession.get_by_id(user).title == '主动检查'
        assert ChatSession.get_by_id(channel).archived is True
        assert ChatMessage.get_by_id('old-1').content == '保留的历史'
    await runtime.projects.run_db(project.id,inspect)
    await runtime._decide({'companion':{'scope':'channel:a'}})
    assert calls == [None,'engine']


async def test_activity_separates_thoughts_from_delegation_notifications(runtime):
    runtime,_,_=runtime
    def seed(state):
        state['runs']=[{'id':f'thought-{i}','status':'silent','trigger':'interval','summary':'思考摘要','created_at':'2026-11-14'} for i in range(8)]
        state['runs'] += [{'id':f'delivery-{i}','status':'notified','trigger':'delegation','summary':'委派结果','created_at':'2026-11-14'} for i in range(6)]
        state['runs'].append({'id':'failed-delivery','trigger':'delegation','status':'delivery_failed'})
        state['delegations']=[
            {'id':'sent','project_id':'p','session_id':'sent','status':'completed','instruction':'已经通知','notified':True,'notification_state':'notified'},
            {'id':'seen','project_id':'p','session_id':'seen','status':'completed','instruction':'已经查看','notified':True,'notification_state':'read'},
            {'id':'failed','project_id':'p','session_id':'failed','status':'completed','instruction':'投递失败','notified':True,'notification_run_id':'failed-delivery'},
            {'id':'pending','project_id':'p','session_id':'s','status':'running','instruction':'还未通知','notified':False},
        ]
    await runtime.mutate(seed)
    first=await runtime.activity_records()
    second=await runtime.activity_records(run_offset=5)
    assert first['reflection_count']==8
    assert first['reflection_count_lower_bound'] is False
    assert first['run_total']==8
    assert len(first['runs'])==5 and len(second['runs'])==3
    assert all(row['id'].startswith('thought-') for row in first['runs']+second['runs'])
    assert first['delegation_total']==4
    items={row['id']:row for row in first['delegations']}
    assert items['sent']['notification_state']=='notified'
    assert items['seen']['notification_state']=='read'
    assert items['failed']['notification_state']=='delivery_failed'
    assert items['pending']['notification_state']=='pending'


async def test_start_renames_only_current_registered_thought_session_without_archiving(runtime):
    from models.chat_session import ChatSession
    runtime,project,_=runtime
    def seed(_):
        current=runtime.chats.create_session(project.id,title='主动检查')['id']
        unrelated=runtime.chats.create_session(project.id,title='主动检查')['id']
        return current,unrelated
    current,unrelated=await runtime.projects.run_db(project.id,seed)
    await runtime.mutate(lambda state:state.update(check_session_id=current,check_sessions=[current]))
    await runtime.start()
    try:
        def inspect(_):
            assert ChatSession.get_by_id(current).title=='主动思考'
            assert ChatSession.get_by_id(current).archived is False
            assert ChatSession.get_by_id(unrelated).title=='主动检查'
        await runtime.projects.run_db(project.id,inspect)
    finally:await runtime.shutdown()


async def test_start_title_migration_slow_sql_does_not_block_event_loop(runtime,monkeypatch):
    import threading
    from services import digital_person_runtime as service
    runtime,_,_=runtime
    entered,release=threading.Event(),threading.Event()
    original=service._rename_check_session
    def slow(sid):
        entered.set()
        assert release.wait(3)
        return original(sid)
    monkeypatch.setattr(service,'_rename_check_session',slow)
    task=asyncio.create_task(runtime.start())
    try:
        assert await asyncio.to_thread(entered.wait,2)
        await asyncio.wait_for(asyncio.sleep(.01),.3)
    finally:release.set()
    await task
    await runtime.shutdown()


async def test_reflection_prompt_centers_companion_life_and_keeps_preferences_additive(runtime,monkeypatch):
    current,_,store=runtime
    store.set('digital_person',{'enabled':True,'name':'小研','personality':'好奇、克制',
        'proactive_instruction':'多关注我最近的学习感受'})
    calls=[]
    async def invoke(*args,**kwargs):
        calls.append((args,kwargs))
        return '{"decision":"silent","summary":"理解了学习感受，暂时不联系","source_ids":[]}',[],'companion-thread'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    await current._decide({'conversation':[],'companion':{'scope':'local'}})
    prompt=calls[0][0][3]
    system=calls[0][1]['system_prompt']
    assert 'background assessment' in system
    assert 'Step 2: Extract useful durable memories' in system
    assert 'summary must be empty when silent' in system
    assert 'Additional preferences' in prompt and '多关注我最近的学习感受' in prompt
    assert 'Start this background assessment' in prompt
    assert 'Begin with CLI' not in prompt
    assert 'assess affinity changes' not in prompt
    assert 'Verify progress according to' not in system


async def test_legacy_default_is_not_sent_as_the_purpose_of_reflection(runtime,monkeypatch):
    current,_,store=runtime
    old='跟进明确交办的事项，完成或需要用户介入时才通知，无变化保持静默。'
    store.set('digital_person',{'enabled':True,'proactive_instruction':old})
    calls=[]
    async def invoke(*args,**kwargs):
        calls.append(args[3])
        return 'NO_REPLY',[],'reflection-thread'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    await current._decide({})
    assert old not in calls[0]
    assert 'Start this background assessment' in calls[0]
    # Compatibility interpretation does not overwrite saved user configuration.
    assert store.get('digital_person')['proactive_instruction']==old


async def test_failed_scope_switch_never_resumes_previous_contacts_engine(runtime,monkeypatch):
    from agent_assistants.chat_session import ChatSessionModule
    current,_,_=runtime
    calls=[]
    async def invoke(engine,model,cwd,prompt,session_id,*args,**kwargs):
        calls.append((prompt,session_id))
        return '{"decision":"silent","summary":"done","source_ids":[]}',[],f'engine-{len(calls)}'
    monkeypatch.setattr('agent_assistants.base.invoke_engine',invoke)
    await current._decide({'companion':{'scope':'channel:a'},'private_a':'private-first-contact'})
    original=ChatSessionModule.start_queued_turn
    def fail_start(*args,**kwargs):raise RuntimeError('interrupted before engine reset')
    monkeypatch.setattr(ChatSessionModule,'start_queued_turn',fail_start)
    with pytest.raises(RuntimeError,match='before engine reset'):
        await current._decide({'companion':{'scope':'channel:b'},'second':'second-contact'})
    monkeypatch.setattr(ChatSessionModule,'start_queued_turn',original)
    await current._decide({'companion':{'scope':'channel:b'},'retry':'retry-contact'})
    assert calls[-1][1] is None
    assert 'private-first-contact' not in calls[-1][0]


async def test_activity_outcomes_report_actual_delivery_and_affinity_changes(runtime):
    runtime, _, _ = runtime
    await runtime.mutate(lambda state: state.update(runs=[
        {'id':'outcome','status':'delivery_failed','summary':'不应显示的通知正文','created_at':'2026-11-17',
         'activity_summary':'整理 2 条消息（1 个会话），新增 1 条记忆；好感度上升 2、下降 1',
         'deliveries':[{'status':'delivered'},{'status':'failed','error':'来源会话已归档'},
                       {'status':'failed','error':'来源会话已归档'}],
         'relationship_updates':[{'affinity_delta':2},{'affinity_delta':-1}]},
        {'id':'legacy-notice','status':'notified','summary':'历史通知正文',
         'deliveries':[{'status':'delivered'}]},
        {'id':'silent','status':'silent','deliveries':[],'relationship_updates':[]},
        {'id':'running','status':'running','deliveries':[],'relationship_updates':[]},
        {'id':'old','status':'silent'},
    ]))
    records = await runtime.activity_records()
    items = {row['id']:row for row in records['runs']}
    expected = {'sent':1,'failed':2,'affinity_increased':2,'affinity_decreased':1,
                'delivery_failure_reasons':['来源会话已归档']}
    assert items['outcome']['outcome'] == expected
    detail = await runtime.run_detail('outcome')
    assert detail['outcome'] == expected
    assert items['outcome']['processing'] == detail['processing'] == {'messages':2,'sessions':1,'memories':1}
    assert items['outcome']['summary'] == detail['summary'] == ''
    assert 'notification_message' not in items['outcome']
    assert detail['notification_message'] == '不应显示的通知正文'
    assert items['legacy-notice']['summary'] == (await runtime.run_detail('legacy-notice'))['summary'] == ''
    assert items['silent']['outcome'] == {'sent':0,'failed':0,'affinity_increased':0,'affinity_decreased':0}
    assert items['running']['outcome'] is None
    assert items['old']['outcome'] is None


async def test_reflection_counter_survives_record_trimming_and_runtime_reload(runtime, monkeypatch):
    runtime, _, _ = runtime
    await seed_pending(runtime)
    await runtime.mutate(lambda state: state.update(runs=[{'id':f'old-{i}','status':'silent','trigger':'interval'} for i in range(100)]))
    async def fail(_):
        raise ValueError('测试失败记录也属于一次实际运行')
    monkeypatch.setattr(runtime, '_decide', fail)
    for expected in (101,102):
        await runtime.check()
        records = await runtime.activity_records()
        assert records['run_total'] == 100
        assert records['reflection_count'] == expected
        assert records['reflection_count_lower_bound'] is True
    from services.digital_person_runtime import DigitalPersonRuntime
    restored = DigitalPersonRuntime(runtime.projects, runtime.chats, runtime.bots, runtime.bus)
    assert (await restored.activity_records())['reflection_count'] == 102


async def test_failed_reflection_preserves_generated_content_and_separates_failure_reason(runtime, monkeypatch):
    current, _, _ = runtime
    await seed_pending(current)
    async def decide(context):
        await context['_load']()
        return {'decision':'notify','summary':'我想跟进昨天的安排。','source_ids':['not-a-source']}
    monkeypatch.setattr(current, '_decide', decide)
    run = await current.check()
    assert run['status'] == 'failed'
    detail = await current.run_detail(run['id'])
    assert detail['draft_summary'] == '我想跟进昨天的安排。'
    assert detail['failure_reason'] == 'Of the 1 sources cited in this round, 1 could not be matched to the current batch of messages, so the results were not adopted.'
    assert detail['outcome']['affinity_increased'] == 0
    records = await current.activity_records()
    assert records['runs'][0]['status'] == 'failed'
    assert not records['runs'][0]['summary']
    await current.mutate(lambda state: state['runs'].append({'id':'legacy-failure','status':'failed','error':'检查结果来源无效'}))
    legacy = await current.run_detail('legacy-failure')
    assert not legacy.get('draft_summary')
    assert legacy['failure_reason'] == 'Could not match the reflection to its source messages. The result was discarded.'


def test_reflection_source_references_resolve_only_unique_current_batch_aliases():
    from services.digital_person_runtime import resolve_check_sources
    context={'origin_project_id':'p','origin_session_id':'s','conversation':[{'id':'msg1','memory_ids':['memory:1'],'read_ids':['memory:1']} ]}
    assert resolve_check_sources(context,['memory:1','msg1']) == ['msg1']
    with pytest.raises(ValueError,match='could not be matched'):
        resolve_check_sources(context,['memory:other'])
    with pytest.raises(ValueError,match='format'):
        resolve_check_sources(context,[123])
    other={'origin_project_id':'other','origin_session_id':'other','conversation':[{'id':'msg1','memory_ids':['memory:2']} ]}
    with pytest.raises(ValueError,match='multiple sessions'):
        resolve_check_sources({'_groups':[context,other]},['msg1'])
    assert resolve_check_sources({'_groups':[context,other]},['memory:2']) == ['msg1']


def test_reflection_sources_include_root_delegation_results_with_conversation_groups():
    from services.digital_person_runtime import resolve_check_sources
    group={'origin_project_id':'p','origin_session_id':'s','conversation':[{'id':'chat'}]}
    context={'origin_project_id':'home','origin_session_id':'origin','_groups':[group],
             'delegations':[{'id':'work','project_id':'execution','session_id':'target','message_id':'result'}],
             'delegation_messages':[{'id':'result','project_id':'execution','session_id':'target'}]}
    assert resolve_check_sources(context,['result','work','chat'])==['result','work','chat']
    with pytest.raises(ValueError,match='could not be matched'):
        resolve_check_sources(context,['unrelated-result'])
    context['delegation_messages'].append({'id':'chat','project_id':'other','session_id':'elsewhere'})
    with pytest.raises(ValueError,match='multiple sessions'):
        resolve_check_sources(context,['chat'])


def test_reflection_delegation_message_already_in_conversation_is_not_ambiguous():
    from services.digital_person_runtime import resolve_check_sources
    row={'id':'result','project_id':'execution','session_id':'target'}
    group={'origin_project_id':'execution','origin_session_id':'target','conversation':[row]}
    context={'_groups':[group],'delegation_messages':[row]}
    assert resolve_check_sources(context,['result'])==['result']


@pytest.mark.parametrize('terminal,expected', [('completed','completed'), ('failed','failed'), ('stopped','stopped')])
async def test_delegation_records_follow_result_independently_of_notification(runtime, terminal, expected):
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    from services.chat_read_state import mark_read
    runtime, project, _ = runtime
    def seed(_):
        sid = runtime.chats.create_session(project.id, title='Delegated')['id']
        ChatMessage.create(id='target-result', session=sid, role='assistant', status='running', content='', created_at=utc_now())
        return sid
    sid = await runtime.projects.run_db(project.id, seed)
    await runtime.mutate(lambda state: state['delegations'].append(dict(id='work', project_id=project.id,
        session_id=sid, message_id='target-result', status='running', notified=True, notification_state='notified')))
    async def row():
        return (await runtime.activity_records())['delegations'][0]
    assert (await row())['result_viewed'] is None
    await runtime.projects.run_db(project.id, lambda _: ChatMessage.update(status=terminal).where(ChatMessage.id=='target-result').execute())
    result = await row()
    assert (result['status'], result['result_viewed'], result['message_id']) == (expected, False, 'target-result')
    await runtime.projects.run_db(project.id, lambda _: mark_read(project.id, sid, 'target-result'))
    result = await row()
    assert result['result_viewed'] is True and result['notification_state'] == 'notified'


async def test_delegation_result_lookup_yields_event_loop_for_slow_project_db(runtime, monkeypatch):
    import threading
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    from services import chat_read_state
    runtime, project, _ = runtime
    def seed(_):
        sid = runtime.chats.create_session(project.id, title='Delegated')['id']
        ChatMessage.create(id='slow-result', session=sid, role='assistant', status='completed', content='result', created_at=utc_now())
        return sid
    sid = await runtime.projects.run_db(project.id, seed)
    await runtime.mutate(lambda state: state['delegations'].append(dict(id='work', project_id=project.id,
        session_id=sid, message_id='slow-result', status='running')))
    entered, release = threading.Event(), threading.Event()
    original = chat_read_state.is_read
    def slow_read(*args):
        entered.set()
        assert release.wait(3)
        return original(*args)
    monkeypatch.setattr(chat_read_state, 'is_read', slow_read)
    pending = asyncio.create_task(runtime.activity_records())
    try:
        assert await asyncio.wait_for(asyncio.to_thread(entered.wait, 2), .5)
        assert not pending.done()
    finally:
        release.set()
        result = await pending
    assert result['delegations'][0]['status'] == 'completed'
