"""Second-pass lifecycle audit: real services, isolated projects, explicit barriers."""
import asyncio

import pytest

from models import ReviewRun, StepRun, Task, TaskStep, WorkflowRun
from services.concurrency import concurrency_gate
from services.task_state import task_has_active_execution
from tests.test_api_contracts import api_context  # noqa: F401
from tests.test_task_workflow_execution import scenario, node, edge  # noqa: F401
from tests.test_parallel_review_decisions import start_parallel, pending_review


async def decide(s, review, decision, **options):
    return await s.client.post(
        f'/api/task/{s.task_id}/steps/{review.step_key}/review/{decision}?project_id={s.pid}',
        json={'review_run_id': review.id, **options},
    )


@pytest.mark.anyio
async def test_api_terminate_parallel_preserves_execution_protection(scenario):
    s = scenario
    handle, review = await start_parallel(s)
    try:
        response = await decide(s, review, 'terminate')
        assert response.status_code == 200, response.text
        snapshot = await s.db(lambda _p: (
            Task.get_by_id(s.task_id).status,
            TaskStep.get((TaskStep.task == s.task_id) & (TaskStep.step_key == 'develop')).status,
            task_has_active_execution(Task.get_by_id(s.task_id)),
        ))
        assert snapshot[1] != 'running' or snapshot[2], snapshot
        assert snapshot[:2] == ('stopped', 'cancelled')
        assert s.task_id not in s.runtime._runners
        assert not s.script.select('publish')
    finally:
        s.script.release.set()
        await s.runtime.wait(handle)


@pytest.mark.anyio
@pytest.mark.parametrize('downstream', [False, True])
async def test_api_set_complete_only_waits_when_downstream_remains(scenario, downstream):
    s = scenario
    def configure(flow):
        first = node('requirements', ['PRD'])
        first['review'] = {'mode': 'manual'}
        flow['nodes'] = [first] + ([node('develop', ['API'], ['PRD'])] if downstream else [])
        flow['connections'] = [edge('requirements', 'develop')] if downstream else []
    await s.source_update(configure)
    assert await s.start() == 'waiting'
    review = await pending_review(s)
    response = await decide(s, review, 'set-complete', schedule_downstream=False)
    assert response.status_code == 200, response.text
    snapshot = await s.db(lambda _p: (
        Task.get_by_id(s.task_id).status,
        WorkflowRun.get_by_id(review.workflow_run_id).status,
    ))
    assert snapshot == (('waiting', 'paused') if downstream else ('completed', 'succeeded')), snapshot


@pytest.mark.anyio
async def test_restart_respects_existing_concurrency_occupant(scenario):
    s = scenario
    concurrency_gate.reset()
    concurrency_gate.configure(max_tasks=1, max_chats=0, schedule_exempt=False)
    await concurrency_gate.acquire_task(s.pid, 'another-task', 'manual')
    s.script.block = ('requirements', 'execution', 1)
    restart = asyncio.create_task(s.runtime.restart_from_step(s.pid, s.task_id, 'requirements'))
    try:
        # A real engine entry is positive evidence that the full slot was bypassed.
        try:
            await asyncio.wait_for(s.script.entered.wait(), .5)
            entered = True
        except asyncio.TimeoutError:
            entered = False
        assert not entered, concurrency_gate.active_count(s.pid)
    finally:
        s.script.release.set()
        await concurrency_gate.release_task(s.pid, 'another-task')
        handle = await asyncio.wait_for(restart, 5)
        await s.runtime.wait(handle)
        concurrency_gate.reset()


@pytest.mark.anyio
async def test_review_resume_respects_existing_concurrency_occupant(scenario):
    s = scenario
    def configure(flow):
        flow['nodes'][0]['review'] = {'mode': 'manual'}
    await s.source_update(configure)
    concurrency_gate.reset()
    concurrency_gate.configure(max_tasks=1, max_chats=0, schedule_exempt=False)
    assert await s.start() == 'waiting'
    review = await pending_review(s)
    assert await concurrency_gate.acquire_task(s.pid, 'another-task', 'manual') == 'granted'
    s.script.block = ('develop', 'execution', 1)
    request = asyncio.create_task(decide(s, review, 'approve'))
    try:
        try:
            await asyncio.wait_for(s.script.entered.wait(), .5)
            entered = True
        except asyncio.TimeoutError:
            entered = False
        assert not entered, concurrency_gate.active_count(s.pid)
    finally:
        s.script.release.set()
        await concurrency_gate.release_task(s.pid, 'another-task')
        response = await asyncio.wait_for(request, 5)
        assert response.status_code == 200, response.text
        await s.idle()
        concurrency_gate.reset()


@pytest.mark.anyio
@pytest.mark.parametrize('decision', ['approve', 'reject', 'terminate'])
async def test_old_review_cannot_change_restarted_run(scenario, decision):
    s = scenario
    handle, review = await start_parallel(s)
    try:
        s.script.block = ('develop', 'execution', 2)
        new = await s.runtime.restart_from_step(s.pid, s.task_id, 'develop')
        before = await s.db(lambda _p: (
            ReviewRun.get_by_id(review.id).status,
            WorkflowRun.get_by_id(review.workflow_run_id).status,
        ))
        assert before == ('cancelled', 'superseded'), before
        response = await decide(s, review, decision)
        after = await s.db(lambda _p: (
            Task.get_by_id(s.task_id).status,
            ReviewRun.get_by_id(review.id).status,
            WorkflowRun.get_by_id(review.workflow_run_id).status,
        ))
        assert response.status_code == 409, (response.text, after)
        active = await s.db(lambda _p: Task.get_by_id(s.task_id).active_workflow_run_id)
        assert active == new.id
    finally:
        s.script.release.set()
        await s.runtime.wait(handle)
        await s.idle()


@pytest.mark.anyio
async def test_accepted_stop_between_recovery_prepare_and_launch_is_not_revived(tmp_path, monkeypatch):
    from engines.core.registry import ENGINE_REGISTRY
    from services.workflow_runtime import WorkflowRuntime
    from streaming.bus import EventBus
    from tests.test_recovery import _project_with_run, MemoryConfigStore, RecoveryFakeEngine
    import services.project as project_service

    monkeypatch.setattr(project_service, 'config_store', MemoryConfigStore())
    original, manager, project, run_id = _project_with_run(tmp_path)
    runtime = WorkflowRuntime(EventBus(), manager)
    RecoveryFakeEngine.prompts = []
    entered, release = asyncio.Event(), asyncio.Event()
    resume = runtime._resume_in_project

    async def delayed_resume(*args, **kwargs):
        entered.set()
        await release.wait()
        return await resume(*args, **kwargs)

    monkeypatch.setattr(runtime, '_resume_in_project', delayed_resume)
    def prepare_review(_p):
        TaskStep.update(status='reviewing').where(
            (TaskStep.task == 'task-rec') & (TaskStep.step_key == 'b')).execute()
        StepRun.update(status='succeeded').where(StepRun.id == 'step-b-1').execute()
    await manager.run_db(project.id, prepare_review)
    recovery = asyncio.create_task(runtime._recover_project_runs(project))
    try:
        await asyncio.wait_for(entered.wait(), 5)
        assert await runtime.cancel_step(project.id, 'task-rec', 'b')
        assert await manager.run_db(project.id, lambda _p: Task.get_by_id('task-rec').status) == 'stopped'
        release.set()
        await recovery
        async with asyncio.timeout(5):
            while runtime._active_tasks:
                await asyncio.sleep(.01)
        state = await manager.run_db(project.id, lambda _p: (
            Task.get_by_id('task-rec').status,
            TaskStep.get((TaskStep.task == 'task-rec') & (TaskStep.step_key == 'b')).status,
        ))
        assert state == ('stopped', 'cancelled'), state
    finally:
        release.set()
        await asyncio.gather(recovery, return_exceptions=True)
        await runtime.shutdown()
        await asyncio.to_thread(manager.close_all)
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        RecoveryFakeEngine.prompts = []


@pytest.mark.anyio
async def test_final_run_write_failure_still_releases_concurrency_slot(scenario, monkeypatch):
    from services.task_runner import TaskRunner
    s = scenario
    original = TaskRunner._run_db
    async def failed_finalize(runner, operation):
        if operation.__name__ == 'finalize_run':
            raise OSError('injected final database write failure')
        return await original(runner, operation)
    monkeypatch.setattr(TaskRunner, '_run_db', failed_finalize)
    concurrency_gate.reset()
    concurrency_gate.configure(max_tasks=1, max_chats=0, schedule_exempt=False)
    try:
        handle = await s.runtime.start(s.pid, s.task_id)
        with pytest.raises(OSError, match='injected final database write failure'):
            await s.runtime.wait(handle)
        assert concurrency_gate.active_count(s.pid)['tasks_running'] == 0
    finally:
        await s.runtime.shutdown()
        concurrency_gate.reset()


@pytest.mark.anyio
async def test_cancel_during_queued_status_publication_does_not_start(scenario, monkeypatch):
    s = scenario
    entered, release = asyncio.Event(), asyncio.Event()
    original = s.runtime._mark_task_status
    async def delayed_mark(project_id, task_id, status, **kwargs):
        await original(project_id, task_id, status, **kwargs)
        if status == 'queued':
            entered.set()
            await release.wait()
    monkeypatch.setattr(s.runtime, '_mark_task_status', delayed_mark)
    concurrency_gate.reset()
    concurrency_gate.configure(max_tasks=1, max_chats=0, schedule_exempt=False)
    await concurrency_gate.acquire_task(s.pid, 'another-task', 'manual')
    s.script.block = ('requirements', 'execution', 1)
    start = asyncio.create_task(s.runtime.start(s.pid, s.task_id))
    try:
        await asyncio.wait_for(entered.wait(), 5)
        assert await s.runtime.cancel_queued(s.pid, s.task_id)
        assert concurrency_gate.task_queue_position(s.pid, s.task_id) == 0
        release.set()
        try:
            await asyncio.wait_for(s.script.entered.wait(), .5)
            engine_entered = True
        except asyncio.TimeoutError:
            engine_entered = False
        assert not engine_entered
    finally:
        release.set()
        s.script.release.set()
        await concurrency_gate.release_task(s.pid, 'another-task')
        results = await asyncio.gather(start, return_exceptions=True)
        for result in results:
            if not isinstance(result, BaseException):
                await s.runtime.wait(result)
        concurrency_gate.reset()
