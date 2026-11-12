"""User-operation regressions with isolated databases, files and engines."""
import asyncio
from contextlib import nullcontext
from types import SimpleNamespace

import pytest

from models import ReviewRun, StepRun, Task, TaskStep, WorkflowRun, init_db
from services.concurrency import ConcurrencyGate, concurrency_gate
from services.intervention import InterventionManager
from services.remote_access import ActorSnapshot, actor_context
from services.task_state import summarize_task_state, task_has_active_execution
from services.workflow_runtime import WorkflowRuntime
from streaming.bus import EventBus


@pytest.fixture
def scenario(tmp_path):
    db = init_db(str(tmp_path / 'scenario.db'))
    project = SimpleNamespace(id='scenario', path=tmp_path,
        workstep_dir=tmp_path / '.workstep', steps={'steps': []})
    class Manager:
        def activate_project_by_id(self, _pid):
            return nullcontext(project)
    runtime = WorkflowRuntime(EventBus(), Manager())
    concurrency_gate.reset()
    with actor_context(ActorSnapshot(actor_id='tester', user_name='Tester',
        device_id='test', device_name='Test', source='browser')):
        yield project, runtime
    concurrency_gate.reset()
    db.close()


def make_task(project, identity='task'):
    return Task.create(id=identity, title='Scenario', cwd=str(project.path),
        status='ready', created_at=1, updated_at=1)


def test_finish_last_step_closes_task():
    result = summarize_task_state('waiting', [{'step_key': 'last', 'status': 'passed'}],
        reason='manual_continue', settled=True)
    assert result['status'] == 'completed'


@pytest.mark.anyio
async def test_terminate_review_keeps_running_sibling_protected(scenario):
    from services.review_decision import persist_review_decision
    project, runtime = scenario
    task = make_task(project)
    run = WorkflowRun.create(id='run', task=task, status='running', workflow_schema_version=1)
    task.status = 'running'
    task.active_workflow_run_id = run.id
    task.save()
    TaskStep.create(task=task, step_key='a', status='awaiting_review')
    TaskStep.create(task=task, step_key='b', status='running')
    step = StepRun.create(id='step', run=run, step_key='a', status='succeeded', attempt=1)
    review = ReviewRun.create(id='review', task=task, workflow_run=run, step_run=step,
        step_key='a', mode='manual', status='pending')
    try:
        persist_review_decision(project, task.id, 'a', review.id, 'terminate', None,
            {}, None, active_runners={task.id: object()}, instance_id='test',
            current_workflow_steps=lambda p, t: {'steps': [{'key': 'a'}, {'key': 'b'}]})
        assert task_has_active_execution(Task.get_by_id(task.id))
    finally:
        await runtime.shutdown()


@pytest.mark.anyio
@pytest.mark.parametrize('failure', ['empty', 'artifact_io'])
async def test_pre_execution_exit_is_not_running(scenario, monkeypatch, failure):
    from services.step_artifact_routes import StepArtifactRoutes
    project, runtime = scenario
    task = make_task(project)
    if failure == 'artifact_io':
        project.steps = {'steps': [{'key': 'a'}]}
        async def broken(*args, **kwargs):
            raise OSError('injected routing I/O failure')
        monkeypatch.setattr(StepArtifactRoutes, 'reconcile_configuration', broken)
    try:
        if failure == 'empty':
            with pytest.raises(ValueError, match='空流程'):
                await runtime._start_after_slot(project.id, task.id, '')
            assert not WorkflowRun.select().where(WorkflowRun.task == task).exists()
            assert Task.get_by_id(task.id).status == 'ready'
            return
        handle = await runtime._start_after_slot(project.id, task.id, '')
        try:
            await runtime.wait(handle)
        except OSError:
            pass
        assert Task.get_by_id(task.id).status != 'running'
    finally:
        await runtime.shutdown()


@pytest.mark.anyio
async def test_failed_start_can_be_retried(scenario, monkeypatch):
    project, runtime = scenario
    concurrency_gate.configure(max_tasks=1, max_chats=0, schedule_exempt=False)
    async def rejected(*args, **kwargs):
        raise RuntimeError('injected startup rejection')
    monkeypatch.setattr(runtime, '_start_after_slot', rejected)
    try:
        with pytest.raises(RuntimeError):
            await runtime.start(project.id, 'task')
        assert await concurrency_gate.acquire_task(project.id, 'task', 'manual') == 'granted'
    finally:
        await runtime.shutdown()


@pytest.mark.anyio
@pytest.mark.parametrize('order', [
    'cancel_then_release',
    'cancel_yield_release',
])
async def test_cancel_queued_vs_slot_release(order):
    gate = ConcurrencyGate()
    gate.configure(max_tasks=1, max_chats=0, schedule_exempt=False)
    await gate.acquire_task('p', 'a', 'manual')
    await gate.acquire_task('p', 'b', 'manual')
    waiter = asyncio.create_task(gate.wait_task_slot('p', 'b'))
    await asyncio.sleep(0)
    gate.cancel_queued_task('p', 'b')
    if order == 'cancel_yield_release':
        await asyncio.sleep(0)
    await gate.release_task('p', 'a')
    await asyncio.gather(waiter, return_exceptions=True)
    assert 'b' not in gate._task_running['p']


@pytest.mark.anyio
@pytest.mark.parametrize('first', ['response', 'stop'])
async def test_user_response_vs_stop(first):
    manager = InterventionManager()
    waiting = asyncio.create_task(manager.request_response('q', 'task', 'step', {}))
    await asyncio.sleep(0)
    if first == 'response':
        assert manager.deliver_response('q', {'answer': 'yes'}, 'task')
        manager.cancel('q')
        assert await waiting == {'answer': 'yes'}
    else:
        assert manager.cancel('q')
        assert not manager.deliver_response('q', {'answer': 'late'}, 'task')
        assert await waiting == {'error': 'cancelled'}
    assert manager.pending_count == 0
