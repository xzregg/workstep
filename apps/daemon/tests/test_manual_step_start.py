"""Real scheduler/API regression tests for per-step manual start gates."""
import asyncio
import base64
import json
import threading
import time

import pytest

from models import ReviewRun, Task, TaskStep
from tests.test_api_contracts import api_context  # noqa: F401
from tests.test_task_workflow_execution import scenario, node, edge  # noqa: F401


def test_auto_start_compiles_both_formats_and_validates_boolean():
    from services.workflow_definition import WorkflowDefinition, WorkflowValidationError
    for raw in ({'nodes': [dict(node('a', []), autoStart=False)], 'connections': []},
                {'steps': [{'key': 'a', 'autoStart': False}]}):
        assert WorkflowDefinition.load(raw).compile().steps[0]['autoStart'] is False
    with pytest.raises(WorkflowValidationError, match='autoStart'):
        WorkflowDefinition.load({'steps': [{'key': 'a', 'autoStart': 'false'}]}).compile()


async def configure(s, *, parallel=False):
    def edit(flow):
        flow['nodes'] = [node('requirements', ['PRD']), node('develop', ['API'], ['PRD']),
                         node('publish', ['Delivery'], ['API'])]
        for item in flow['nodes']:
            item['autoStart'] = item['type'] == 'publish'
        flow['connections'] = [edge('requirements', 'develop'), edge('develop', 'publish')]
        if parallel:
            flow['nodes'].append(node('extra', ['Extra']))
            flow['nodes'][-1]['autoStart'] = True
    await s.source_update(edit)


async def start_step(s, key='develop'):
    return await s.client.post(f'/api/task/{s.task_id}/step/{key}/start?project_id={s.pid}')


@pytest.mark.anyio
async def test_manual_step_waits_then_starts_without_repeating_upstream(scenario):
    s = scenario
    await configure(s)
    assert await s.start() == 'waiting'  # Explicit task start authorizes the entry only.
    task = (await s.client.get(f'/api/task/{s.task_id}?project_id={s.pid}')).json()
    assert task['status_reason'] == 'manual_start'
    assert {'step_key': 'develop', 'reason': 'manual_start'} in task['pending_confirmations']
    assert next(step for step in task['steps'] if step['step_key'] == 'develop')['status'] == 'awaiting_start'
    assert not s.script.select('develop') and not s.script.select('publish')
    run_id = task['active_workflow_run_id']
    response = await start_step(s)
    assert response.status_code == 200, response.text
    assert await s.idle() == 'completed'
    assert [len(s.script.select(key)) for key in ('requirements', 'develop', 'publish')] == [1, 1, 1]
    assert await s.db(lambda _p: Task.get_by_id(s.task_id).active_workflow_run_id) == run_id
    await s.unchanged_source()


@pytest.mark.anyio
async def test_manual_start_wait_survives_fresh_runtime(scenario):
    from services.workflow_runtime import WorkflowRuntime
    import main
    s = scenario
    await configure(s)
    assert await s.start() == 'waiting'
    fresh = WorkflowRuntime(main.event_bus, main.project_manager)
    previous = main.workflow_runtime
    main.workflow_runtime = fresh
    try:
        assert await fresh.recover_running_workflows() == 0
        assert not s.script.select('develop')
        response = await start_step(s)
        assert response.status_code == 200, response.text
        assert await s.idle() == 'completed'
    finally:
        await fresh.shutdown()
        main.workflow_runtime = previous


@pytest.mark.anyio
async def test_interrupted_authorized_manual_step_recovers_without_another_click(scenario):
    from services.workflow_runtime import WorkflowRuntime
    import main
    s = scenario
    await configure(s)
    assert await s.start() == 'waiting'
    s.script.block = ('develop', 'execution', 1)
    assert (await start_step(s)).status_code == 200
    await asyncio.wait_for(s.script.entered.wait(), 5)
    previous = s.runtime
    await previous.shutdown()
    fresh = WorkflowRuntime(main.event_bus, main.project_manager)
    main.workflow_runtime = fresh
    s.script.block = None
    try:
        assert await fresh.recover_running_workflows() == 1
        assert await s.idle() == 'completed'
        assert len(s.script.select('requirements')) == 1
        assert len(s.script.select('develop')) == 2
        assert len(s.script.select('publish')) == 1
    finally:
        await fresh.shutdown()
        main.workflow_runtime = previous


@pytest.mark.anyio
async def test_stop_at_manual_checkpoint_cannot_be_started(scenario):
    s = scenario
    await configure(s)
    assert await s.start() == 'waiting'
    assert await s.runtime.cancel(s.task_id)
    assert (await start_step(s)).status_code == 409
    assert await s.db(lambda _p: TaskStep.get((TaskStep.task == s.task_id) & (TaskStep.step_key == 'develop')).status) == 'cancelled'
    assert not s.script.select('develop')


@pytest.mark.anyio
async def test_task_override_can_disable_automatic_start_without_changing_source(scenario):
    s = scenario
    await s.save(lambda flow: flow['nodes'][1].update(autoStart=False))
    assert await s.start() == 'waiting'
    assert (await start_step(s)).status_code == 200
    assert await s.idle() == 'completed'
    await s.unchanged_source()


@pytest.mark.anyio
async def test_explicit_step_entry_without_parent_authorizes_target_with_passed_upstream(scenario):
    s = scenario
    await configure(s)
    await s.db(lambda _p: TaskStep.update(status='passed').where(
        (TaskStep.task == s.task_id) & (TaskStep.step_key == 'requirements')).execute())
    assert await s.start('develop') == 'completed'
    assert not s.script.select('requirements')
    assert len(s.script.select('develop')) == len(s.script.select('publish')) == 1


@pytest.mark.anyio
async def test_manual_start_during_parallel_execution_is_idempotent(scenario):
    s = scenario
    await configure(s, parallel=True)
    s.script.block = ('extra', 'execution', 1)
    handle = await s.runtime.start(s.pid, s.task_id)
    await asyncio.wait_for(s.script.entered.wait(), 5)
    # requirements and extra share the initial batch; the next gate is reached
    # after the batch, so exercise another root waiting alongside live work.
    # requirements is explicitly authorized; develop is not yet reached.
    early = await start_step(s)
    assert early.status_code == 409
    s.script.release.set()
    await s.runtime.wait(handle)
    assert await s.idle() == 'waiting'
    s.script.block = ('develop', 'execution', 1)
    s.script.entered.clear(); s.script.release.clear()
    try:
        first = await start_step(s)
        assert first.status_code == 200, first.text
        await asyncio.wait_for(s.script.entered.wait(), 5)
        duplicate = await start_step(s)
        assert duplicate.status_code == 200, duplicate.text
    finally:
        s.script.release.set()
    assert await s.idle() == 'completed'
    assert len(s.script.select('develop')) == len(s.script.select('extra')) == 1


@pytest.mark.anyio
async def test_manual_start_rejects_unreached_and_stopped_steps(scenario):
    s = scenario
    await configure(s)
    assert (await start_step(s)).status_code == 409
    assert await s.start() == 'waiting'
    assert (await start_step(s, 'publish')).status_code == 409
    assert (await start_step(s, 'missing')).status_code == 409
    await s.db(lambda _p: Task.update(status='stopped', status_reason='user_stop').where(Task.id == s.task_id).execute())
    assert (await start_step(s)).status_code == 409
    assert not s.script.select('develop')


@pytest.mark.anyio
@pytest.mark.parametrize('source', ['manual', 'scheduled_start'])
async def test_immediate_and_scheduled_start_authorize_selected_entry_only(scenario, source):
    s = scenario
    await configure(s)
    response = await s.client.post(f'/api/task/create?project_id={s.pid}', json={
        'title': 'EntryTask', 'workflow_id': s.workflow_id, 'start_step_key': 'develop',
        'auto_start': source == 'manual',
        **({'scheduled_start_at': '2099-01-01T00:00:00Z'} if source == 'scheduled_start' else {}),
    })
    assert response.status_code == 200, response.text
    task_id = response.json()['id']
    configuration = (await s.client.get(f'/api/task/{task_id}/workflow?project_id={s.pid}')).json()
    selected = next(item for item in configuration['workflow']['nodes'] if item['type'] == 'develop')
    assert selected['autoStart'] is True
    assert next(item for item in configuration['source']['nodes'] if item['type'] == 'develop')['autoStart'] is False
    if source == 'scheduled_start':
        handle = await s.runtime.start(s.pid, task_id, source=source)
        await s.runtime.wait(handle)
    async with asyncio.timeout(5):
        while task_id in s.runtime._runners:
            await asyncio.sleep(.01)
    assert await s.db(lambda _p: Task.get_by_id(task_id).status) == 'completed'
    assert not s.script.select('requirements')
    assert len(s.script.select('develop')) == len(s.script.select('publish')) == 1
    await s.unchanged_source()


@pytest.mark.anyio
async def test_creation_entry_authorization_preserves_review_overrides(scenario):
    s = scenario
    await configure(s)
    response = await s.client.post(f'/api/task/create?project_id={s.pid}', json={
        'title':'EntryReview', 'workflow_id':s.workflow_id,'start_step_key':'develop','auto_start':True,
        'review_overrides':{'develop':{'mode':'manual','auto':False,'prompt':'TASK_REVIEW','maxRetries':1}},
    })
    assert response.status_code == 200, response.text
    task_id=response.json()['id']
    config=(await s.client.get(f'/api/task/{task_id}/workflow?project_id={s.pid}')).json()
    selected=next(item for item in config['workflow']['nodes'] if item['type']=='develop')
    assert selected['autoStart'] is True
    assert selected['review']['mode']=='manual'
    assert selected['review']['prompt']=='TASK_REVIEW'
    async with asyncio.timeout(5):
        while task_id in s.runtime._runners:
            await asyncio.sleep(.01)
    assert await s.db(lambda _p:Task.get_by_id(task_id).status_reason)=='manual_review'


@pytest.mark.anyio
async def test_parallel_manual_roots_and_two_decisions_keep_siblings_once(scenario):
    s = scenario
    def edit(flow):
        flow['nodes'] = [dict(node('requirements', ['PRD']), autoStart=False),
                         dict(node('develop', ['API']), autoStart=False),
                         dict(node('extra', ['Extra']), autoStart=False),
                         dict(node('publish', ['Delivery'], ['PRD','API','Extra']), autoStart=True),
                         dict(node('test', ['BugList']), autoStart=True)]
        flow['connections'] = [edge('requirements','publish'), edge('develop','publish',0,1), edge('extra','publish',0,2)]
    await s.source_update(edit)
    s.script.block = ('test', 'execution', 1)
    handle = await s.runtime.start(s.pid, s.task_id)
    await asyncio.wait_for(s.script.entered.wait(), 5)
    try:
        task = (await s.client.get(f'/api/task/{s.task_id}?project_id={s.pid}')).json()
        assert task['status'] == 'running'
        assert {item['step_key'] for item in task['pending_confirmations']} == {'develop', 'extra'}
        # Both decisions arrive before the live batch retires and must coalesce.
        for key in ('develop', 'extra'):
            response = await start_step(s, key)
            assert response.status_code == 200, response.text
            current = (await s.client.get(f'/api/task/{s.task_id}?project_id={s.pid}')).json()
            assert key not in {item['step_key'] for item in current['pending_confirmations']}
        continuation = s.runtime._review_resumes[s.task_id]
    finally:
        s.script.release.set()
    await s.runtime.wait(handle)
    await s.runtime.wait(continuation)
    assert await s.idle() == 'completed'
    assert all(len(s.script.select(key)) == 1 for key in ('requirements','develop','extra','publish','test'))


@pytest.mark.anyio
async def test_start_decision_survives_batch_retiring_before_resume_is_enqueued(scenario, monkeypatch):
    s = scenario
    await configure(s, parallel=True)
    def edit(flow):
        flow['nodes'].append(dict(node('test', ['BugList']), autoStart=False))
    await s.source_update(edit)
    s.script.block = ('extra', 'execution', 1)
    first = await s.runtime.start(s.pid, s.task_id)
    await asyncio.wait_for(s.script.entered.wait(), 5)
    original = s.runtime._publish_persisted_task_status
    async def release_batch(*args, **kwargs):
        await original(*args, **kwargs)
        s.script.release.set()
        await s.runtime.wait(first)
        await s.idle()
    with monkeypatch.context() as patch:
        patch.setattr(s.runtime, '_publish_persisted_task_status', release_batch)
        response = await start_step(s, 'test')
        assert response.status_code == 200, response.text
    continuation = s.runtime._review_resumes.get(s.task_id)
    if continuation:
        await s.runtime.wait(continuation)
    # The deferred handle is removed before launch validation finishes; a
    # momentary absence from _runners is not completion of the continuation.
    async with asyncio.timeout(5):
        while not s.script.select('test'):
            await asyncio.sleep(.01)
    assert await s.idle() == 'waiting'
    assert len(s.script.select('test')) == 1
    assert (await start_step(s)).status_code == 200
    assert await s.idle() == 'completed'
    assert len(s.script.select('requirements')) == len(s.script.select('extra')) == 1


@pytest.mark.anyio
async def test_return_to_manual_step_requires_another_start(scenario):
    s = scenario
    def edit(flow):
        for item in flow['nodes']:
            item['autoStart'] = item['type'] != 'develop'
    await s.source_update(edit)
    s.script.feedback_rounds = 1
    assert await s.start() == 'waiting'
    assert (await start_step(s)).status_code == 200
    assert await s.idle() == 'waiting'
    assert len(s.script.select('develop')) == 1
    assert (await start_step(s)).status_code == 200
    assert await s.idle() == 'completed'
    assert len(s.script.select('develop')) == 2
    assert len(s.script.select('requirements')) == 1


@pytest.mark.anyio
async def test_manual_start_and_manual_review_are_independent_checkpoints(scenario):
    s = scenario
    await configure(s)
    await s.source_update(lambda flow: flow['nodes'][1].update(review={'mode':'manual'}))
    assert await s.start() == 'waiting'
    assert (await start_step(s)).status_code == 200
    assert await s.idle() == 'waiting'
    review = await s.db(lambda _p: ReviewRun.get((ReviewRun.task == s.task_id) & (ReviewRun.status == 'pending')))
    response = await s.client.post(f'/api/task/{s.task_id}/steps/develop/review/approve?project_id={s.pid}',json={'review_run_id':review.id})
    assert response.status_code == 200, response.text
    assert await s.idle() == 'completed'
    assert len(s.script.select('develop')) == len(s.script.select('publish')) == 1


@pytest.mark.anyio
async def test_manual_start_project_ticket_requires_edit_and_correct_project(scenario, monkeypatch):
    import main
    from services.gateway_client.bridge import ManagedHttpBridge
    from workstep_gateway_protocol import FrameType, ProxyFrame
    s = scenario
    await configure(s)
    assert await s.start() == 'waiting'
    monkeypatch.setattr(main.gateway_client, 'managed_config', object())
    async def request(level='edit', project=None):
        frames=[]
        async def capture(frame): frames.append(frame)
        bridge=ManagedHttpBridge(main.app, 'manual-step', {
            'method':'POST', 'path': f'/api/task/{s.task_id}/step/develop/start',
            'query': f'project_id={project or s.pid}', 'headers':[],
            'user_id':'worker', 'username':'worker', 'project_id':s.pid, 'access_level':level,
        }, capture, 'device-1')
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id='manual-step',type=FrameType.http_request,payload={'phase':'end'}))
        await asyncio.wait_for(bridge._task,3)
        return frames[0].payload['status']
    assert await request('read') == 403
    assert await request(project='other-project') == 403
    assert not s.script.select('develop')
    assert await request() == 200
    assert await s.idle() == 'completed'


@pytest.mark.anyio
async def test_share_start_requires_interactive_mode_and_bound_task(scenario, monkeypatch):
    import main
    from services.gateway_client.bridge import ManagedHttpBridge
    from workstep_gateway_protocol import FrameType, ProxyFrame
    from tests.test_gateway_share_ticket import _ticket
    s = scenario
    await configure(s)
    assert await s.start() == 'waiting'
    monkeypatch.setattr(main.gateway_client, 'managed_config', object())
    async def request(mode='interactive', task=None):
        ticket, signer, pin = _ticket(task_id=s.task_id, host_project_id=s.pid, mode=mode)
        frames=[]
        async def capture(frame): frames.append(frame)
        bridge=ManagedHttpBridge(main.app, 'manual-share', {
            'method':'POST','path':'/api/platform-share/operation','query':'',
            'headers':[['content-type','application/json']], 'share_ticket':ticket,
        },capture,'device-1',gateway_key=signer,gateway_fingerprint=pin,gateway_id='gateway-1')
        bridge.start_task()
        body=json.dumps({'path':f'/task/{task or s.task_id}/step/develop/start','method':'POST','body':{}}).encode()
        await bridge.feed(ProxyFrame(stream_id='manual-share',type=FrameType.http_request,payload={'phase':'body','data':base64.b64encode(body).decode()}))
        await bridge.feed(ProxyFrame(stream_id='manual-share',type=FrameType.http_request,payload={'phase':'end'}))
        await asyncio.wait_for(bridge._task,3)
        return frames[0].payload['status']
    assert await request('read_only') == 403
    assert await request(task='foreign-task') == 403
    assert not s.script.select('develop')
    assert await request() == 200
    assert await s.idle() == 'completed'


@pytest.mark.anyio
async def test_manual_step_start_slow_sql_does_not_block_health(scenario, monkeypatch):
    import main
    s = scenario
    await configure(s)
    assert await s.start() == 'waiting'
    database = main.project_manager.get_project_by_id(s.pid).db
    original = database.execute_sql
    entered = threading.Event()
    def slow(sql, params=None, commit=None):
        if sql.startswith(f'UPDATE "{TaskStep._meta.table_name}"'):
            entered.set(); time.sleep(.25)
        return original(sql, params)
    monkeypatch.setattr(database, 'execute_sql', slow)
    request = asyncio.create_task(start_step(s))
    try:
        assert await asyncio.to_thread(entered.wait, 3)
        before = time.monotonic()
        assert (await s.client.get('/api/health')).status_code == 200
        assert time.monotonic() - before < .15
        response = await request
        assert response.status_code == 200, response.text
    finally:
        await request
    assert await s.idle() == 'completed'
