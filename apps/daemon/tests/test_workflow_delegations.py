import asyncio
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient

from tests.test_digital_person_runtime import chat_module, runtime


@pytest.fixture
async def workflow_delegation(runtime, monkeypatch, tmp_path):
    import main
    from services.task import TaskService
    from models import Task
    current, home, store = runtime
    store.set('digital_person', {'enabled': True, 'quiet_start': 0, 'quiet_end': 0})
    target = await asyncio.to_thread(current.projects.init_project, tmp_path / 'workflow-work')
    workflow = await current.projects.run_db(target.id, lambda p: current.projects.create_workflow(
        p, '开发流程', {'steps': [{'key': 'develop', 'name': '开发'}, {'key': 'test', 'name': '测试', 'dependsOn': ['develop']}]}))
    starts, messages = [], []

    async def start(pid, tid, prompt, **kwargs):
        starts.append(tid)
        await current.projects.run_db(pid, lambda _: Task.update(status='running').where(Task.id == tid).execute())

    async def submit(pid, tid, content, key, **kwargs):
        messages.append((tid, content, key))
        return SimpleNamespace(assistant_message_id='coordinator-reply', turn_id='coordinator-turn')

    monkeypatch.setattr(main, 'task_service', TaskService(current.bus))
    monkeypatch.setattr(main, 'workflow_runtime', SimpleNamespace(start=start))
    monkeypatch.setattr(main, 'coordinator_module', SimpleNamespace(submit_message=submit))
    monkeypatch.setattr(main, 'digital_person_runtime', current)
    monkeypatch.setattr('services.digital_person_channels.get_bindings', lambda: [])
    origin = (await current.main_session())['id']
    return current, home, target, workflow, origin, starts, messages


async def test_api_creates_selected_workflow_task_once_and_projects_real_state(workflow_delegation):
    from fastapi import FastAPI
    from api.digital_person import router
    from models import Task, TaskStep
    current, _, project, workflow, origin, starts, _ = workflow_delegation
    app = FastAPI()
    app.include_router(router)
    body = dict(project_id=project.id, workflow_id=workflow['id'], origin_session_id=origin,
                request_id='workflow-request', title='实现登录', instruction='实现并测试登录')
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        first = await client.post('/api/digital-person/delegate', json=body)
        assert first.status_code == 200, first.text
        item = first.json()
        replay = await client.post('/api/digital-person/delegate', json=body)
        assert replay.json()['task_id'] == item['task_id']
        conflict = await client.post('/api/digital-person/delegate', json={**body, 'instruction': '别的工作'})
        assert conflict.status_code == 400
        assert starts == [item['task_id']]
        assert await current.projects.run_db(project.id, lambda _: Task.select().count()) == 1
        def wait(_):
            Task.update(status='waiting', status_reason='manual_review').where(Task.id == item['task_id']).execute()
            TaskStep.update(status='awaiting_review').where(TaskStep.task == item['task_id'], TaskStep.step_key == 'develop').execute()
        await current.projects.run_db(project.id, wait)
        listing = (await client.get('/api/digital-person/delegations')).json()['items'][0]
        assert listing['task_id'] == item['task_id']
        assert listing['status'] == 'waiting'
        assert listing['pending_confirmations'][0]['reason'] == 'manual_review'
        activity = (await client.get('/api/digital-person/activity/records')).json()['delegations'][0]
        assert activity['task_id'] == item['task_id']
        assert activity['status'] == 'waiting'
        assert item['task_id'] in item['task_detail_url']


async def test_tracking_survives_reload_waits_for_source_and_notifies_each_transition_once(workflow_delegation):
    from models import Task, TaskStep
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    from services.digital_person import get_profile
    from services.digital_person_runtime import DigitalPersonRuntime
    current, home, project, workflow, origin, _, _ = workflow_delegation
    item = await current.delegate(project.id, '实现并测试', origin, 'track', workflow_id=workflow['id'])
    current = DigitalPersonRuntime(current.projects, current.chats, None, current.bus)
    async def change(status, step_status):
        def update(_):
            Task.update(status=status, status_reason=None).where(Task.id == item['task_id']).execute()
            TaskStep.update(status=step_status).where(TaskStep.task == item['task_id']).execute()
        await current.projects.run_db(project.id, update)
    await change('waiting', 'awaiting_review')
    await current.projects.run_db(home.id, lambda _: ChatMessage.create(
        id='foreground', session=origin, role='assistant', status='running', content='', created_at=utc_now()))
    await current.delegation_management.refresh(get_profile())
    assert not await current.projects.run_db(home.id, lambda _: ChatMessage.select().where(ChatMessage.id != 'foreground').exists())
    await current.projects.run_db(home.id, lambda _: ChatMessage.update(status='completed').where(ChatMessage.id == 'foreground').execute())
    for _ in range(2):
        await current.delegation_management.refresh(get_profile())
    notices = await current.projects.run_db(home.id, lambda _: list(ChatMessage.select().where(ChatMessage.id != 'foreground').dicts()))
    assert len(notices) == 1
    assert '审核' in notices[0]['content']
    assert (await current.list_delegations())['items'][0]['status'] == 'waiting'
    await change('running', 'running')
    await current.delegation_management.refresh(get_profile())
    await change('completed', 'passed')
    for _ in range(2):
        await current.delegation_management.refresh(get_profile())
    notices = await current.projects.run_db(home.id, lambda _: list(ChatMessage.select().where(ChatMessage.id != 'foreground').dicts()))
    assert len(notices) == 2
    assert any('已完成' in row['content'] for row in notices)
    assert (await current.delegation_management.eligible(await current.state())) == []


async def test_attach_created_task_and_continue_use_same_task_coordinator(workflow_delegation):
    from models import Task
    current, _, project, workflow, origin, starts, messages = workflow_delegation
    original = await current.delegate(project.id, '创建流程任务', origin, 'create', workflow_id=workflow['id'])
    attached = await current.delegate(project.id, '跟踪已有任务', origin, 'attach', target_task_id=original['task_id'])
    assert attached['id'] == original['id']
    followed = await current.delegate(project.id, '增加错误场景测试', origin, 'follow', original['id'])
    assert followed['task_id'] == original['task_id']
    assert followed['id'] == original['id']
    assert messages[0][:2] == (original['task_id'], '增加错误场景测试')
    await current.delegate(project.id, '增加错误场景测试', origin, 'follow', original['id'])
    assert len(messages) == 1
    assert starts == [original['task_id']]
    assert await current.projects.run_db(project.id, lambda _: Task.select().count()) == 1


async def test_start_failure_keeps_created_task_and_retry_never_duplicates(workflow_delegation, monkeypatch):
    import main
    from models import Task
    current, _, project, workflow, origin, _, _ = workflow_delegation
    async def fail(*args, **kwargs):
        raise ValueError('Engine unavailable')
    monkeypatch.setattr(main, 'workflow_runtime', SimpleNamespace(start=fail))
    first = await current.delegate(project.id, '开发', origin, 'start-failure', workflow_id=workflow['id'])
    assert first['startup_error']
    assert first['task_id']
    replay = await current.delegate(project.id, '开发', origin, 'start-failure', workflow_id=workflow['id'])
    assert replay['task_id'] == first['task_id']
    assert await current.projects.run_db(project.id, lambda _: Task.select().count()) == 1


async def test_cross_origin_and_project_actor_cannot_adopt_or_continue(workflow_delegation):
    from services.remote_access import ActorSnapshot, actor_context
    current, home, project, workflow, origin, _, _ = workflow_delegation
    item = await current.delegate(project.id, '开发', origin, 'scoped', workflow_id=workflow['id'])
    peer = await current.projects.run_db(home.id, lambda _: current.chats.create_session(home.id)['id'])
    with pytest.raises(ValueError):
        await current.delegate(project.id, '越权', peer, 'other-origin', target_task_id=item['task_id'])
    with actor_context(ActorSnapshot('u', 'User', 'd', 'Device', 'remote', project.id, 'edit')):
        with pytest.raises((ValueError, PermissionError)):
            await current.delegate(project.id, '越权', origin, 'project-actor', workflow_id=workflow['id'])


async def test_creation_conversation_hands_off_to_real_task_without_duplicate_tracking(workflow_delegation, monkeypatch):
    import main
    current, _, project, workflow, origin, starts, messages = workflow_delegation
    async def invoke(*args, **kwargs):
        return 'Created workflow', [], 'worker'
    monkeypatch.setattr(current.chats, '_invoke', invoke)
    creation = await current.delegate(project.id, '建立流程并执行', origin, 'creation-chat')
    await current.chats.await_turn(creation['turn_id'], timeout=2)
    created = await current.projects.run_db(project.id, lambda p: main.task_service.create_task(
        title='开发', cwd=str(p.path), workflow_id=workflow['id'], workflow=workflow['steps']))
    handed = await current.delegate(project.id, '跟踪执行结果', origin, 'handoff', creation['id'], target_task_id=created['id'])
    assert handed['id'] == creation['id']
    assert handed['task_id'] == created['id']
    assert len((await current.state())['delegations']) == 1
    assert len((await current.state())['delegation_executions']) == 1
    assert starts == messages == []


async def test_slow_task_sql_keeps_api_responsive(workflow_delegation, monkeypatch):
    import threading
    from fastapi import FastAPI
    from api.digital_person import router
    import services.workflow_delegations as service
    current, _, project, workflow, origin, _, _ = workflow_delegation
    await current.delegate(project.id, '开发', origin, 'slow-sql', workflow_id=workflow['id'])
    entered, release = threading.Event(), threading.Event()
    read = service.read_task
    def slow(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return read(*args, **kwargs)
    monkeypatch.setattr(service, 'read_task', slow)
    app = FastAPI()
    app.include_router(router)
    @app.get('/health')
    async def health():
        return {'ok': True}
    async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
        pending = asyncio.create_task(client.get('/api/digital-person/delegations'))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            assert (await asyncio.wait_for(client.get('/health'), .5)).json() == {'ok': True}
        finally:
            release.set()
            await pending


async def test_quiet_wait_notice_is_replaced_by_completion_and_archived_task_is_silent(workflow_delegation):
    from models import Task, TaskStep
    from models.chat_session import ChatMessage
    from services.digital_person import get_profile
    current, home, project, workflow, origin, _, _ = workflow_delegation
    item = await current.delegate(project.id, '开发', origin, 'quiet', workflow_id=workflow['id'])
    profile = get_profile()
    from models.fields import utc_now
    profile.quiet_start = utc_now().astimezone().hour
    profile.quiet_end = (profile.quiet_start + 1) % 24
    async def change(status, step_status, archived=0):
        def update(_):
            Task.update(status=status, archived=archived).where(Task.id == item['task_id']).execute()
            TaskStep.update(status=step_status).where(TaskStep.task == item['task_id']).execute()
        await current.projects.run_db(project.id, update)
    await change('waiting', 'awaiting_review')
    await current.delegation_management.refresh(profile)
    assert not await current.projects.run_db(home.id, lambda _: ChatMessage.select().exists())
    await change('completed', 'passed', 1)
    profile.quiet_end = profile.quiet_start
    await current.delegation_management.refresh(profile)
    assert not await current.projects.run_db(home.id, lambda _: ChatMessage.select().exists())
    await change('completed', 'passed')
    await current.delegation_management.refresh(profile)
    notices = await current.projects.run_db(home.id, lambda _: [row.content for row in ChatMessage.select()])
    assert len(notices) == 1
    assert '已完成' in notices[0]
    assert '等待审核' not in notices[0]


async def test_real_workflow_runtime_finishes_task_before_delegation_reports_completion(workflow_delegation, monkeypatch):
    import main
    from engines.core.registry import ENGINE_REGISTRY
    from services.workflow_runtime import WorkflowRuntime
    from tests.test_workflow_runtime import RuntimeFakeEngine
    from models import Task, StepRun
    from services.digital_person import get_profile
    current, _, project, _, origin, _, _ = workflow_delegation
    workflow = await current.projects.run_db(project.id, lambda p: current.projects.create_workflow(
        p, '验证流程', {'nodes': [{'id': 1, 'type': 'verify', 'title': '验证', 'engine': 'pydantic_ai'}], 'connections': []}))
    monkeypatch.setitem(ENGINE_REGISTRY, 'pydantic_ai', RuntimeFakeEngine)
    from services.task_runner import config_store
    monkeypatch.setattr(config_store, 'get_engine_idle_timeout_seconds', lambda: 120, raising=False)
    execution = WorkflowRuntime(current.bus, current.projects)
    monkeypatch.setattr(main, 'workflow_runtime', execution)
    try:
        item = await current.delegate(project.id, '验证流程执行', origin, 'real-runtime', workflow_id=workflow['id'])
        assert not item.get('startup_error'), item
        for _ in range(100):
            state = await current.projects.run_db(project.id, lambda _: Task.get_by_id(item['task_id']).status)
            if state not in ('ready', 'queued', 'running'):
                break
            await asyncio.sleep(.02)
        assert state == 'completed'
        assert await current.projects.run_db(project.id, lambda _: StepRun.select().where(StepRun.status == 'succeeded').count()) == 1
        await current.delegation_management.refresh(get_profile())
        result = (await current.list_delegations(delegation_id=item['id']))['items'][0]
        assert result['status'] == 'completed'
        assert 'done' in result['result']
    finally:
        await execution.shutdown()


async def test_restart_after_task_persisted_restores_tracking_without_recreating_or_starting(workflow_delegation, monkeypatch):
    from models import Task
    from services.digital_person import get_profile
    from services.digital_person_runtime import DigitalPersonRuntime
    current, _, project, workflow, origin, starts, _ = workflow_delegation
    async def interrupted(item):
        raise asyncio.CancelledError()
    monkeypatch.setattr(current.workflow_delegations, '_save', interrupted)
    with pytest.raises(asyncio.CancelledError):
        await current.delegate(project.id, '开发', origin, 'interrupted-create', workflow_id=workflow['id'])
    assert await current.projects.run_db(project.id, lambda _: Task.select().count()) == 1
    restored = DigitalPersonRuntime(current.projects, current.chats, None, current.bus)
    await restored.delegation_management.refresh(get_profile())
    item = await restored.delegate(project.id, '开发', origin, 'interrupted-create', workflow_id=workflow['id'])
    assert item['startup_error']
    assert starts == []
    assert await current.projects.run_db(project.id, lambda _: Task.select().count()) == 1


async def test_followup_on_completed_task_does_not_report_old_completion(workflow_delegation, monkeypatch):
    import main
    from models import Task, TaskStep, Message, CoordinatorTurn
    from models.chat_session import ChatMessage
    from models.fields import utc_now
    from services.digital_person import get_profile
    current, home, project, workflow, origin, _, _ = workflow_delegation
    item = await current.delegate(project.id, '开发', origin, 'before-followup', workflow_id=workflow['id'])
    def complete(_):
        Task.update(status='completed').where(Task.id == item['task_id']).execute()
        TaskStep.update(status='passed').where(TaskStep.task == item['task_id']).execute()
    await current.projects.run_db(project.id, complete)
    await current.delegation_management.refresh(get_profile())
    async def submit(pid, tid, content, key):
        def persist(_):
            for role in ('user', 'assistant'):
                Message.create(id=f'follow-{role}', task=tid, step_key='', role=role, channel='coordinator',
                               position=1 if role == 'user' else 2, created_at=utc_now())
            CoordinatorTurn.create(id='follow-turn', task=tid, user_message='follow-user', assistant_message='follow-assistant',
                                   idempotency_key=key, status='queued', created_at=utc_now())
        await current.projects.run_db(pid, persist)
        return SimpleNamespace(turn_id='follow-turn', assistant_message_id='follow-assistant')
    monkeypatch.setattr(main, 'coordinator_module', SimpleNamespace(submit_message=submit))
    await current.delegate(project.id, '再增加错误场景', origin, 'new-requirements', item['id'])
    await current.delegation_management.refresh(get_profile())
    assert await current.projects.run_db(home.id, lambda _: ChatMessage.select().count()) == 1
    await current.projects.run_db(project.id, lambda _: CoordinatorTurn.update(status='succeeded').where(CoordinatorTurn.id == 'follow-turn').execute())
    await current.delegation_management.refresh(get_profile())
    notices = await current.projects.run_db(home.id, lambda _: [row.content for row in ChatMessage.select().order_by(ChatMessage.created_at)])
    assert len(notices) == 2
    assert '尚无新的执行结果' in notices[-1]
    assert '已完成' not in notices[-1]
