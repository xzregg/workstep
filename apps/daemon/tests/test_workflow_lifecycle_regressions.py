"""Admission ownership, failure cleanup and stop/recovery regression boundaries."""
import asyncio
import threading
import time

import pytest

from models import ReviewRun, StepRun, Task, TaskStep, WorkflowRun
from services.concurrency import ConcurrencyGate, concurrency_gate
from services.task_state import task_has_active_execution
from tests.test_api_contracts import api_context  # noqa: F401
from tests.test_task_workflow_execution import scenario  # noqa: F401


@pytest.mark.anyio
async def test_queue_cleanup_waits_for_cancellation_audit(scenario, monkeypatch):
    s = scenario
    concurrency_gate.reset()
    concurrency_gate.configure(max_tasks=1, max_chats=0, schedule_exempt=False)
    await concurrency_gate.acquire_task(s.pid, 'occupant', 'manual')
    queued = asyncio.Event()
    audit_started = asyncio.Event()
    finish_audit = asyncio.Event()
    cleanup_released = asyncio.Event()
    cleanup_persisted = asyncio.Event()
    original_mark = s.runtime._mark_task_status
    original_release = concurrency_gate.release_task

    async def mark(project_id, task_id, status, **kwargs):
        if status == 'ready':
            if kwargs.get('audit_action'):
                audit_started.set()
                await finish_audit.wait()
            else:
                cleanup_persisted.set()
        await original_mark(project_id, task_id, status, **kwargs)
        if status == 'queued':
            queued.set()

    async def release(project_id, task_id, **kwargs):
        await original_release(project_id, task_id, **kwargs)
        if task_id == s.task_id:
            cleanup_released.set()

    monkeypatch.setattr(s.runtime, '_mark_task_status', mark)
    monkeypatch.setattr(concurrency_gate, 'release_task', release)
    pending = asyncio.create_task(s.runtime.start(s.pid, s.task_id))
    cancelling = None
    try:
        await asyncio.wait_for(queued.wait(), 2)
        cancelling = asyncio.create_task(s.runtime.cancel(s.task_id))
        await asyncio.wait_for(audit_started.wait(), 2)
        await asyncio.wait_for(cleanup_released.wait(), 2)
        await asyncio.sleep(0)
        assert not cleanup_persisted.is_set(), 'waiter cleanup must not erase the queue identity before audit'
    finally:
        finish_audit.set()
        if cancelling is not None:
            await cancelling
        await asyncio.gather(pending, return_exceptions=True)
        await concurrency_gate.release_task(s.pid, 'occupant')
    from models import ProjectAuditEvent
    assert await s.db(lambda _p: ProjectAuditEvent.select().where(
        (ProjectAuditEvent.task_id == s.task_id) & (ProjectAuditEvent.action == 'task.cancel')).exists())


@pytest.mark.anyio
async def test_old_permit_cleanup_does_not_release_new_attempt():
    gate = ConcurrencyGate()
    gate.configure(max_tasks=1, max_chats=0, schedule_exempt=False)
    await gate.acquire_task('p', 'occupant', 'manual')
    assert await gate.acquire_task('p', 'task', 'manual') == 'queued'
    old = gate.task_permit('p', 'task')
    assert gate.cancel_queued_task('p', 'task')
    assert await gate.acquire_task('p', 'task', 'manual') == 'queued'
    new = gate.task_permit('p', 'task')
    with pytest.raises(asyncio.CancelledError):
        await gate.wait_task_slot('p', 'task', permit=old)
    await gate.release_task('p', 'task', permit=old)
    assert gate.task_permit('p', 'task') is new
    await gate.release_task('p', 'occupant')
    await gate.wait_task_slot('p', 'task', permit=new)
    assert not gate.cancel_queued_task('p', 'task')
    assert gate.active_count('p')['tasks_running'] == 1
    await gate.release_task('p', 'task', permit=new)


@pytest.mark.anyio
async def test_unlimited_running_tasks_count_when_limit_is_enabled():
    gate = ConcurrencyGate()
    assert await gate.acquire_task('p', 'first', 'manual') == 'granted'
    assert await gate.acquire_task('p', 'first', 'manual') == 'already_active'
    gate.configure(max_tasks=1, max_chats=0, schedule_exempt=False)
    assert await gate.acquire_task('p', 'second', 'manual') == 'queued'
    await gate.release_task('p', 'first')
    await gate.wait_task_slot('p', 'second')
    await gate.release_task('p', 'second')


@pytest.mark.anyio
async def test_step_restart_does_not_replace_a_queued_start(scenario):
    s = scenario
    concurrency_gate.reset()
    concurrency_gate.configure(max_tasks=1, max_chats=0, schedule_exempt=False)
    await concurrency_gate.acquire_task(s.pid, 'occupant', 'manual')
    pending = asyncio.create_task(s.runtime.start(s.pid, s.task_id))
    try:
        async with asyncio.timeout(5):
            while await s.db(lambda _p: Task.get_by_id(s.task_id).status) != 'queued':
                await asyncio.sleep(.01)
        with pytest.raises(RuntimeError, match='排队|启动'):
            await s.runtime.restart_from_step(s.pid, s.task_id, 'requirements')
        assert not await s.db(lambda _p: WorkflowRun.select().where(WorkflowRun.task == s.task_id).exists())
        assert await s.db(lambda _p: Task.get_by_id(s.task_id).status) == 'queued'
        await concurrency_gate.release_task(s.pid, 'occupant')
        handle = await asyncio.wait_for(pending, 5)
        await s.runtime.wait(handle)
        assert len(s.script.select('requirements')) == 1
        assert await s.db(lambda _p: Task.get_by_id(s.task_id).status) == 'completed'
    finally:
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
        await s.runtime.shutdown()
        concurrency_gate.reset()


@pytest.mark.anyio
async def test_queued_persistence_failure_releases_request(scenario, monkeypatch):
    s = scenario
    concurrency_gate.reset()
    concurrency_gate.configure(max_tasks=1, max_chats=0, schedule_exempt=False)
    await concurrency_gate.acquire_task(s.pid, 'occupant', 'manual')
    original = s.runtime._mark_task_status
    async def failed_queue(project_id, task_id, status, **kwargs):
        if status == 'queued':
            raise OSError('queue persistence failed')
        return await original(project_id, task_id, status, **kwargs)
    monkeypatch.setattr(s.runtime, '_mark_task_status', failed_queue)
    try:
        with pytest.raises(OSError, match='queue persistence'):
            await s.runtime.start(s.pid, s.task_id)
        assert concurrency_gate.task_permit(s.pid, s.task_id) is None
        assert concurrency_gate.active_count(s.pid)['tasks_queued'] == 0
        assert not s.script.calls
    finally:
        concurrency_gate.reset()


@pytest.mark.anyio
async def test_stop_queued_restart_prevents_engine_and_releases_resources(scenario):
    s = scenario
    concurrency_gate.reset()
    concurrency_gate.configure(max_tasks=1, max_chats=0, schedule_exempt=False)
    await concurrency_gate.acquire_task(s.pid, 'occupant', 'manual')
    try:
        handle = await s.runtime.restart_from_step(s.pid, s.task_id, 'requirements')
        async with asyncio.timeout(5):
            while not concurrency_gate.task_queue_position(s.pid, s.task_id):
                await asyncio.sleep(.01)
        assert await s.runtime.cancel(s.task_id)
        await asyncio.wait_for(s.runtime.wait(handle), 5)
        assert not s.script.calls
        assert await s.db(lambda _p: Task.get_by_id(s.task_id).status) == 'stopped'
        assert await s.db(lambda _p: WorkflowRun.get_by_id(handle.id).status) == 'stopped'
        assert s.task_id not in s.runtime._runners
        assert handle.id not in s.runtime._leases._leased_runs
        assert concurrency_gate.active_count(s.pid)['tasks_running'] == 1
        assert concurrency_gate.active_count(s.pid)['tasks_queued'] == 0
    finally:
        await s.runtime.shutdown()
        concurrency_gate.reset()


@pytest.mark.anyio
async def test_shutdown_preserves_queued_start_for_requeue(scenario):
    s = scenario
    concurrency_gate.reset()
    concurrency_gate.configure(max_tasks=1, max_chats=0, schedule_exempt=False)
    await concurrency_gate.acquire_task(s.pid, 'occupant', 'manual')
    pending = asyncio.create_task(s.runtime.start(s.pid, s.task_id, 'remember queued input'))
    try:
        async with asyncio.timeout(5):
            while await s.db(lambda _p: Task.get_by_id(s.task_id).status) != 'queued':
                await asyncio.sleep(.01)
        await s.runtime.shutdown()
        with pytest.raises(asyncio.CancelledError):
            await pending
        state, metadata = await s.db(lambda _p: (
            Task.get_by_id(s.task_id).status, Task.get_by_id(s.task_id).queued_run_json))
        assert state == 'queued'
        assert 'remember queued input' in metadata
        assert concurrency_gate.task_permit(s.pid, s.task_id) is None
        assert not s.script.calls
    finally:
        concurrency_gate.reset()


@pytest.mark.anyio
async def test_stop_during_execution_message_preparation_never_spawns(scenario, monkeypatch):
    from services.step_execution_messages import StepExecutionMessages
    s = scenario
    entered, release = asyncio.Event(), asyncio.Event()
    original = StepExecutionMessages.start
    async def delayed(*args, **kwargs):
        result = await original(*args, **kwargs)
        entered.set()
        await release.wait()
        return result
    monkeypatch.setattr(StepExecutionMessages, 'start', delayed)
    handle = await s.runtime.start(s.pid, s.task_id)
    try:
        await asyncio.wait_for(entered.wait(), 5)
        assert await s.runtime.cancel(s.task_id)
    finally:
        release.set()
    await asyncio.wait_for(s.runtime.wait(handle), 5)
    assert not s.script.calls
    assert await s.db(lambda _p: Task.get_by_id(s.task_id).status) == 'stopped'
    assert not await s.db(lambda _p: task_has_active_execution(Task.get_by_id(s.task_id)))


@pytest.mark.anyio
async def test_slow_failure_cleanup_keeps_health_responsive(scenario, monkeypatch):
    from services.step_artifact_routes import StepArtifactRoutes
    import services.workflow_finalization as finalization
    s = scenario
    entered = threading.Event()
    original = finalization.settle_interrupted_run
    async def failed_routes(*args, **kwargs):
        raise OSError('injected preparation failure')
    def slow_cleanup(*args, **kwargs):
        entered.set()
        time.sleep(.3)
        return original(*args, **kwargs)
    monkeypatch.setattr(StepArtifactRoutes, 'reconcile_configuration', failed_routes)
    monkeypatch.setattr(finalization, 'settle_interrupted_run', slow_cleanup)
    handle = await s.runtime.start(s.pid, s.task_id)
    assert await asyncio.to_thread(entered.wait, 5)
    before = time.monotonic()
    assert (await s.client.get('/api/health')).status_code == 200
    assert time.monotonic() - before < .15
    await s.runtime.wait(handle)
    assert await s.db(lambda _p: Task.get_by_id(s.task_id).status) == 'failed'
    assert await s.db(lambda _p: WorkflowRun.get_by_id(handle.id).status) == 'failed'


@pytest.mark.anyio
async def test_recovery_ignores_replaced_running_run(scenario):
    import main
    s = scenario
    assert await s.start() == 'completed'
    def stale_run(_p):
        task = Task.get_by_id(s.task_id)
        old = WorkflowRun.create(id='obsolete', task=task, status='running', workflow_schema_version=1)
        return task.active_workflow_run_id, old.id
    current_id, old_id = await s.db(stale_run)
    calls = len(s.script.calls)
    await s.runtime._recover_project_runs(main.project_manager.get_project_by_id(s.pid))
    await s.idle()
    state = await s.db(lambda _p: (
        Task.get_by_id(s.task_id).status,
        Task.get_by_id(s.task_id).active_workflow_run_id,
        WorkflowRun.get_by_id(old_id).status,
    ))
    assert state == ('completed', current_id, 'superseded')
    assert len(s.script.calls) == calls


@pytest.mark.anyio
async def test_terminate_paused_parallel_reviews_closes_all_pending_work(scenario):
    from tests.test_parallel_review_decisions import start_parallel
    s = scenario
    handle, review = await start_parallel(s, manual_sibling=True)
    s.script.release.set()
    await s.runtime.wait(handle)
    assert s.task_id not in s.runtime._runners
    queue = s.runtime._event_bus.subscribe()
    response = await s.client.post(
        f'/api/task/{s.task_id}/steps/requirements/review/terminate?project_id={s.pid}',
        json={'review_run_id': review.id},
    )
    assert response.status_code == 200, response.text
    states = await s.db(lambda _p: dict(
        (row.step_key, row.status) for row in TaskStep.select().where(TaskStep.task == s.task_id)))
    assert states['requirements'] == states['develop'] == 'cancelled'
    assert not await s.db(lambda _p: ReviewRun.select().where(
        (ReviewRun.task == s.task_id) & ReviewRun.status.in_(['pending', 'running'])).exists())
    assert await s.db(lambda _p: Task.get_by_id(s.task_id).status) == 'stopped'
    assert not s.script.select('publish')
    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    s.runtime._event_bus.unsubscribe(queue)
    assert any(event.get('step_key') == 'develop'
               and (event.get('status') or (event.get('value') or {}).get('status')) == 'cancelled'
               for event in events)
