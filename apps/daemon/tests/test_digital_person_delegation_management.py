import asyncio
import threading

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from models.chat_session import ChatMessage
from models.fields import utc_now
from tests.test_digital_person_followup import seed
from tests.test_digital_person_runtime import chat_module, runtime


@pytest.mark.asyncio
async def test_assessment_can_process_delegation_with_empty_memory_queue(runtime, monkeypatch):
    service, home, _, _, origin = await seed(runtime)
    delegation_created = utc_now()
    message_created = await service.projects.run_db(home.id, lambda _: ChatMessage.get_by_id('result').created_at)
    await service.mutate(lambda state: state['delegations'][0].update(
        followup_state='pending', created_at=delegation_created))
    calls = []

    async def decide(context):
        await context['_load']()
        assert context['reflection_batch'] == []
        delegation, = context['delegations']
        assert delegation['message_id'] == 'result'
        assert delegation['goal'] == '核对构建'
        assert 'instruction' not in delegation
        assert delegation['created_at'] == delegation_created.isoformat()
        message, = context['delegation_messages']
        assert message['content'] == '真实执行结果'
        assert message['created_at'] == message_created.isoformat()
        calls.append('assessment')
        return {'decision': 'silent', 'summary': '', 'source_ids': [],
                'delegation_actions': [{'id': 'work', 'action': 'complete', 'summary': '核对通过',
                                        'evidence': '真实执行结果'}]}

    monkeypatch.setattr(service, '_decide', decide)
    monkeypatch.setattr('services.digital_person_channels.get_bindings', lambda: [])
    entered, release = threading.Event(), threading.Event()
    original_select = ChatMessage.select

    def slow_result_select(*fields):
        if any(field is ChatMessage.content for field in fields) and any(
            field is ChatMessage.created_at for field in fields
        ):
            entered.set()
            assert release.wait(3)
        return original_select(*fields)

    monkeypatch.setattr(ChatMessage, 'select', slow_result_select)
    app = FastAPI()

    @app.get('/health')
    async def health():
        return {'ok': True}

    checking = asyncio.create_task(service.check())
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/health'), .3)).status_code == 200
    finally:
        release.set()
        result = await checking
    assert result['status'] != 'failed', result
    await service.check()
    assert calls == ['assessment']
    state = await service.state()
    assert state['delegations'][0]['followup_state'] == 'completed'
    assert state['runs'][0]['deliveries'][0]['session_id'] == origin


@pytest.mark.asyncio
async def test_foreground_context_reads_latest_execution_status_before_assessment(runtime):
    service, _, _, _, origin = await seed(runtime)
    await service.mutate(lambda state: state['delegations'][0].update(followup_state='pending'))
    snapshot = await service.delegation_management.for_conversation(origin)
    assert [(item['status'], item['content']) for item in snapshot] == [('completed', '')]
    assert await service.delegation_management.for_conversation('different-session') == []


async def wait_for_status(service, project_id, message_id):
    async with asyncio.timeout(5):
        while True:
            message = await service.projects.run_db(project_id, lambda _: ChatMessage.get_by_id(message_id))
            if message.status not in ('running', 'queued'):
                return message
            await asyncio.sleep(.01)


async def test_chat_can_report_delegation_before_background_check(runtime, monkeypatch):
    service, home, _, _, origin = await seed(runtime)
    await service.mutate(lambda state: state['delegations'][0].update(followup_state='pending'))
    prompts = []

    async def invoke(_engine, _model, _cwd, prompt, *args, **kwargs):
        prompts.append((prompt, kwargs.get('system_prompt', '')))
        return ('已经核对通过。<delegation_actions>'
                '[{"id":"work","action":"complete","summary":"核对通过","evidence":"真实执行结果"}]'
                '</delegation_actions>', [], 'foreground-thread')

    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    accepted = await service.projects.run_db(home.id, lambda _: service.chats.submit_message(
        home.id, origin, '之前的委派完成了吗？', 'foreground-query', schedule=False))
    service.chats.start_queued_turn(accepted.turn_id)
    result = await wait_for_status(service, home.id, accepted.assistant_message_id)
    assert result.status == 'succeeded', result.content
    assert result.content == '已经核对通过。'
    assert len(prompts) == 1
    prompt, system = prompts[0]
    assert '之前的委派完成了吗？' in prompt
    assert '## Delegations' not in prompt
    assert '- `work` · 核对构建 · **Follow-up pending**' in system
    assert '真实执行结果' not in system
    async with asyncio.timeout(5):
        while (await service.state())['delegations'][0]['followup_state'] != 'completed':
            await asyncio.sleep(.01)
    assert not (await service.state())['runs']


async def test_system_delegation_list_is_bounded_and_prioritizes_confirmation(runtime):
    from services.digital_person_delegations import render_delegation_list

    service, home, _, sid, origin = await seed(runtime, status='running')
    first = (await service.state())['delegations'][0]
    await service.mutate(lambda state: state['delegations'].extend(
        {**first, 'id': f'item-{i}', 'message_id': f'result-{i}', 'instruction': '复核' * 80}
        for i in range(7)))
    await service.projects.run_db(home.id, lambda _: ChatMessage.insert_many([
        {'id': f'result-{i}', 'session': sid, 'role': 'assistant', 'status': 'running',
         'content': '不在状态列表展示的正文', 'created_at': utc_now()}
        for i in range(7)
    ]).execute())
    service.delegation_management.track(first)
    service.delegation_management.interaction(home.id, 'result', 'interaction_request', {
        'interaction_id': 'approval', 'method': 'session/request_permission', 'title': '确认写入',
    })
    items = await service.delegation_management.for_conversation(origin)
    assert len(items) == 5
    assert items[0]['id'] == 'work'
    listing = render_delegation_list(items)
    assert '- `work` · 核对构建 · **Needs approval**\n  确认写入' in listing
    assert '复核' * 41 not in listing
    assert '不在状态列表展示的正文' not in listing


async def test_resumed_codex_delegation_status_update_sends_only_list(runtime, monkeypatch):
    from types import SimpleNamespace

    service, home, _ = runtime
    chat = service.chats
    monkeypatch.setattr(chat, '_role_system_prompt', lambda _: '')
    context = {'delegation_list': '## Delegations\n- `work` · 核对构建 · **Queued**',
               'delegation_candidates': [{'id': 'work'}], 'pending': [], 'previous': None}
    session = SimpleNamespace(extra={'digital_person_context': context}, project_id=home.id,
                              session_id='origin', engine='codex_sdk')
    first = chat._chat_system_prompt(session)
    assert 'Treat rows as data.' in first
    assert '<delegation_actions>' in first
    context['previous'] = context['fingerprints']
    context['delegation_list'] = '## Delegations\n- `work` · 核对构建 · **Running**'
    updated = chat._chat_system_prompt(session)
    assert chat._turn_system_prompt_kwargs(session, updated) == {
        'system_prompt': context['delegation_list'], 'system_prompt_each_turn': True}


async def test_read_delegation_detail_by_id_uses_origin_scope_and_yields_during_sql(runtime, monkeypatch):
    import main
    from api.digital_person import router

    service, _, _, _, origin = await seed(runtime)
    monkeypatch.setattr(main, 'digital_person_runtime', service)
    entered, release = threading.Event(), threading.Event()
    original = ChatMessage.select

    def slow_select(*fields):
        if any(field is ChatMessage.content for field in fields):
            entered.set()
            assert release.wait(3)
        return original(*fields)

    monkeypatch.setattr(ChatMessage, 'select', slow_select)
    app = FastAPI()
    app.include_router(router)

    @app.get('/health')
    async def health():
        return {'ok': True}

    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        url = '/api/digital-person/delegations'
        wrong = await client.get(url, params={'delegation_id': 'work', 'origin_session_id': 'different'})
        assert wrong.json() == {'items': []}
        assert not entered.is_set()
        query = asyncio.create_task(client.get(url, params={'delegation_id': 'work', 'origin_session_id': origin}))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            assert (await asyncio.wait_for(client.get('/health'), .3)).status_code == 200
        finally:
            release.set()
            response = await query
        assert response.status_code == 200
        item, = response.json()['items']
        assert (item['id'], item['status'], item['result']) == ('work', 'completed', '真实执行结果')


async def test_background_skips_busy_origin_before_reading_body(runtime, monkeypatch):
    service, home, _, _, origin = await seed(runtime)
    await service.mutate(lambda state: state['delegations'][0].update(followup_state='pending'))
    await service.projects.run_db(home.id, lambda _: ChatMessage.create(
        id='busy-origin', session=origin, role='assistant', status='running', created_at=utc_now()))

    async def forbidden(_):
        pytest.fail('A busy origin must not trigger a model call')

    monkeypatch.setattr(service, '_decide', forbidden)
    result = await service.check()
    assert result['sources']['no_work'] is True
    assert (await service.state())['delegations'][0]['followup_state'] == 'pending'


async def test_memory_pending_returns_delegation_and_body_only_once(runtime, monkeypatch):
    from services import digital_person_memory, memory_query
    from tests.memory_turn_fixture import assessment_access

    service, home, _, _, _ = await seed(runtime)
    await service.mutate(lambda state: state['delegations'][0].update(followup_state='pending'))
    await service.projects.run_db(home.id, lambda _: digital_person_memory.capture_message(
        ChatMessage.get_by_id('result'), 'local'))
    seen = []

    async def invoke(*args, **kwargs):
        batch = await memory_query.pending(service.projects, await assessment_access(service))
        assert batch['delegations'][0]['message_id'] == 'result'
        assert 'created_at' not in batch['delegations'][0]  # Legacy record without a timestamp.
        messages = [message for group in batch.get('conversations', [batch])
                    for message in group['conversation']]
        messages.extend(batch.get('delegation_messages', []))
        assert [m['content'] for m in messages if m['id'] == 'result'] == ['真实执行结果']
        seen.append(True)
        return ('{"decision":"silent","summary":"","source_ids":[],"delegation_actions":'
                '[{"id":"work","action":"complete","summary":"核对通过","evidence":"真实执行结果"}]}', [], 'assessment-thread')

    monkeypatch.setattr('services.digital_person_channels.get_bindings', lambda: [])
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    result = await service.check()
    assert result['status'] != 'failed', result
    assert seen == [True]
    assert (await service.state())['delegations'][0]['followup_state'] == 'completed'


@pytest.mark.parametrize('actions', [[], [{'id': 'work', 'action': 'continue', 'instruction': '继续核对'}]])
async def test_stopped_delegation_is_not_returned_after_review(runtime, monkeypatch, actions):
    import json

    from services import memory_query
    from tests.memory_turn_fixture import assessment_access

    service, home, _, _, _ = await seed(runtime, status='stopped')
    interrupted = '后台服务已重启，本次生成已中断。'
    await service.projects.run_db(home.id, lambda _: ChatMessage.update(content=interrupted).where(
        ChatMessage.id == 'result').execute())
    await service.mutate(lambda state: state['delegations'][0].update(followup_state='pending'))
    seen = []

    async def invoke(*args, **kwargs):
        batch = await memory_query.pending(service.projects, await assessment_access(service))
        delegation, = batch['delegations']
        message, = batch['delegation_messages']
        assert (delegation['status'], message['content']) == ('stopped', interrupted)
        seen.append(delegation['id'])
        return json.dumps({'decision': 'silent', 'summary': '', 'source_ids': [],
                           'delegation_actions': actions}), [], 'assessment-thread'

    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    monkeypatch.setattr('services.digital_person_channels.get_bindings', lambda: [])
    reviewed = await service.check()
    assert reviewed['status'] == 'silent', reviewed
    assert (await service.check())['sources']['no_work'] is True
    assert seen == ['work']
    delegation, = (await service.state())['delegations']
    assert delegation['followup_state'] == 'stopped'


async def test_assessment_continues_unverified_work_and_closes_with_evidence(runtime, monkeypatch, tmp_path):
    import json
    from services import memory_query
    from tests.memory_turn_fixture import assessment_access

    service, _, store = runtime
    store.set('digital_person', {'enabled': True, 'quiet_start': 0, 'quiet_end': 0})
    target = await asyncio.to_thread(service.projects.init_project, tmp_path / 'execution')
    unverified = '导出功能已完成。\n尚未验证空表场景，结果不确定。'
    verified = '空表导出回归通过，3 个测试全部通过。'
    followup = '补跑空表导出回归，修复发现的问题并报告测试结果。'
    assessments = []

    async def invoke(_engine, _model, _cwd, prompt, *args, **kwargs):
        if 'Start this background assessment' not in prompt:
            return (verified if followup in prompt else unverified), [], 'execution-thread'
        assert 'material gaps' in kwargs['system_prompt']
        batch = await memory_query.pending(service.projects, await assessment_access(service))
        delegation, = batch['delegations']
        messages = [message for group in batch.get('conversations', [batch])
                    for message in group['conversation']] + batch.get('delegation_messages', [])
        evidence, = [message['content'] for message in messages if message['id'] == delegation['message_id']]
        assert delegation['goal'] == '实现导出并验证空表场景'
        if evidence == verified:
            assert delegation['instruction'] == followup
        else:
            assert 'instruction' not in delegation
        assessments.append(evidence)
        if len(assessments) == 1:
            action = {'action': 'complete', 'summary': '全部通过', 'evidence': '3 个测试全部通过'}
        elif evidence == unverified:
            action = {'action': 'continue', 'instruction': followup}
        else:
            action = {'action': 'complete', 'summary': '空表导出回归通过', 'evidence': '3 个测试全部通过'}
        return json.dumps({'decision': 'silent', 'summary': '', 'source_ids': [],
                           'delegation_actions': [{'id': delegation['id'], **action}]}), [], 'assessment-thread'

    monkeypatch.setattr('services.digital_person_channels.get_bindings', lambda: [])
    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    first = await service.delegate(target.id, '实现导出并验证空表场景', request_id='first')
    await wait_for_status(service, target.id, first['message_id'])
    entered, release = threading.Event(), threading.Event()
    original_select = ChatMessage.select

    def slow_evidence_select(*fields):
        if len(fields) == 2 and fields[0] is ChatMessage.id and fields[1] is ChatMessage.content:
            entered.set()
            assert release.wait(3)
        return original_select(*fields)

    monkeypatch.setattr(ChatMessage, 'select', slow_evidence_select)
    app = FastAPI()

    @app.get('/health')
    async def health():
        return {'ok': True}

    checking = asyncio.create_task(service.check())
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/health'), .3)).status_code == 200
    finally:
        release.set()
        await checking
    items = (await service.state())['delegations']
    assert items[0]['followup_state'] == 'pending'
    assert not items[0].get('notified')

    await service.check()
    original, continued = (await service.state())['delegations']
    assert original['followup_state'] == 'continued'
    assert continued['session_id'] == first['session_id']
    assert continued['instruction'] == followup
    assert (await wait_for_status(service, target.id, continued['message_id'])).content == verified

    await service.check()
    assert (await service.state())['delegations'][-1]['followup_state'] == 'completed'
    assert assessments == [unverified, unverified, verified]


async def test_recovery_deduplicates_continuation_saved_before_delegation_record(runtime, monkeypatch, tmp_path):
    service, _, _ = runtime
    target = await asyncio.to_thread(service.projects.init_project, tmp_path / 'execution')

    async def invoke(*args, **kwargs):
        return '已执行，等待核对', [], 'execution-thread'

    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    first = await service.delegate(target.id, '核对结果', request_id='first')
    assert (await wait_for_status(service, target.id, first['message_id'])).status == 'succeeded'
    await service.delegation_management.refresh()
    real_mutate = service.mutate
    blocked = True

    async def interrupt(change):
        nonlocal blocked
        if blocked and change.__name__ == 'record':
            blocked = False
            raise RuntimeError('interrupted after project commit')
        return await real_mutate(change)

    monkeypatch.setattr(service, 'mutate', interrupt)
    args = (target.id, '运行回归测试', first['origin_session_id'], 'stable-followup', first['id'])
    with pytest.raises(RuntimeError, match='interrupted'):
        await service.delegate(*args, automatic_result_id=first['message_id'])
    service.chats._turn_keys.clear()
    recovered = await service.delegate(*args, automatic_result_id=first['message_id'])
    assert recovered['session_id'] == first['session_id']
    assert (await wait_for_status(service, target.id, recovered['message_id'])).status == 'succeeded'
    count = await service.projects.run_db(target.id, lambda _: ChatMessage.select().where(
        ChatMessage.session == first['session_id'], ChatMessage.author_type == 'internal').count())
    assert count == 1


async def test_background_and_chat_only_submit_one_continuation(runtime, monkeypatch, tmp_path):
    from services.digital_person import get_profile

    service, _, store = runtime
    store.set('digital_person', {'enabled': True, 'quiet_start': 0, 'quiet_end': 0})
    target = await asyncio.to_thread(service.projects.init_project, tmp_path / 'execution')
    release = asyncio.Event()

    async def invoke(*args, **kwargs):
        await release.wait()
        return '已执行，等待核对', [], 'execution-thread'

    monkeypatch.setattr('agent_assistants.base.invoke_engine', invoke)
    initial = await service.delegate(target.id, '核对结果', request_id='first')
    release.set()
    await wait_for_status(service, target.id, initial['message_id'])
    await service.delegation_management.refresh()
    management = service.delegation_management
    candidates = await management.eligible(await service.state())
    assert len(candidates) == 1
    actions = [{'id': initial['id'], 'action': 'continue', 'instruction': '运行回归测试'}]
    profile = get_profile()
    await asyncio.gather(management.apply(actions, candidates, profile),
                         management.apply(actions, candidates, profile, foreground=True))
    rows = (await service.state())['delegations']
    assert len(rows) == 2
    assert rows[0]['followup_state'] == 'continued'
    assert rows[0]['session_id'] == rows[1]['session_id']
    await wait_for_status(service, target.id, rows[1]['message_id'])
    await management.refresh()
    candidates = await management.eligible(await service.state())
    assert {item['id'] for item in candidates} == {rows[1]['id']}
    monkeypatch.setattr('services.digital_person_channels.get_bindings', lambda: [])
    await management.apply([{'id': rows[1]['id'], 'action': 'continue', 'instruction': '重新验证'}],
                           candidates, profile)
    rows = (await service.state())['delegations']
    assert len(rows) == 2
    assert rows[1]['followup_state'] == 'needs_user'


async def test_pending_approval_is_reported_once_without_ending_execution(runtime, monkeypatch):
    service, home, _, _, _ = await seed(runtime, status='running')
    await service.mutate(lambda state: state['delegations'][0].update(followup_state='pending'))
    item = (await service.state())['delegations'][0]
    management = service.delegation_management
    management.track(item)
    management.interaction(home.id, 'result', 'interaction_request', {
        'interaction_id': 'approval-1', 'method': 'session/request_permission', 'title': '写入清单',
    })
    calls = []

    async def decide(context):
        await context['_load']()
        assert context['delegations'][0]['question']['title'] == '写入清单'
        calls.append(True)
        return {'decision': 'silent', 'summary': '', 'source_ids': [], 'delegation_actions': [
            {'id': 'work', 'action': 'needs_user', 'summary': '请在执行会话审批写入清单'},
        ]}

    monkeypatch.setattr(service, '_decide', decide)
    monkeypatch.setattr('services.digital_person_channels.get_bindings', lambda: [])
    await service.check()
    await service.check()
    assert calls == [True]
    item = (await service.state())['delegations'][0]
    assert item['followup_state'] == 'pending'
    assert item['reported_question'] == 'approval-1'
    assert (await service.projects.run_db(home.id, lambda _: ChatMessage.get_by_id('result'))).status == 'running'


async def test_foreground_delegation_read_yields_during_slow_sql(runtime, monkeypatch):
    service, _, _, _, origin = await seed(runtime)
    await service.mutate(lambda state: state['delegations'][0].update(followup_state='pending'))
    entered, release = threading.Event(), threading.Event()
    original = ChatMessage.select

    def slow_select(*args):
        if ChatMessage.status in args:
            entered.set()
            assert release.wait(3)
        return original(*args)

    monkeypatch.setattr(ChatMessage, 'select', slow_select)
    app = FastAPI()

    @app.get('/health')
    async def health():
        return {'ok': True}

    task = asyncio.create_task(service.delegation_management.for_conversation(origin))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/health'), .3)).status_code == 200
    finally:
        release.set()
        await task
