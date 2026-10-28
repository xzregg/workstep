"""Canonical task state distinguishes work, decisions, errors and user stops."""
from types import SimpleNamespace

import pytest

from services.task_state import summarize_task_state
from tests.test_api_contracts import api_context


@pytest.mark.parametrize('status,steps,reason,settled,expected', [
    ('running', [('build', 'awaiting_review')], None, True, ('waiting', 'manual_review')),
    ('paused', [('build', 'awaiting_review')], None, True, ('waiting', 'manual_review')),
    ('running', [('build', 'awaiting_review'), ('test', 'running')], None, False, ('running', 'execution')),
    ('running', [('build', 'reviewing')], None, False, ('running', 'auto_review')),
    ('running', [('build', 'retrying')], None, False, ('running', 'rework')),
    ('running', [('build', 'awaiting_review'), ('test', 'rework_waiting')], None, True, ('waiting', 'manual_review')),
    ('waiting', [('build', 'awaiting_review'), ('test', 'rework_waiting')], 'manual_review', False, ('waiting', 'manual_review')),
    ('running', [('build', 'failed')], None, True, ('failed', 'step_failed')),
    ('running', [('build', 'failed'), ('test', 'running')], None, False, ('running', 'execution')),
    ('running', [('build', 'passed'), ('test', 'pending')], None, True, ('failed', 'workflow_blocked')),
    ('running', [('build', 'cancelled')], 'user_stop', True, ('stopped', 'user_stop')),
    ('stopped', [('build', 'awaiting_review')], 'user_stop', False, ('stopped', 'user_stop')),
    ('stopped', [('build', 'awaiting_review')], None, True, ('stopped', 'user_stop')),
    ('stopped', [('build', 'failed')], None, True, ('failed', 'step_failed')),
    ('paused', [('build', 'cancelled')], None, True, ('stopped', 'user_stop')),
    ('paused', [('build', 'failed')], None, True, ('failed', 'step_failed')),
    ('completed', [('build', 'passed')], None, True, ('completed', None)),
    ('queued', [('build', 'pending')], None, False, ('queued', 'concurrency_limit')),
    ('ready', [('build', 'pending')], None, False, ('ready', None)),
    ('waiting', [('build', 'passed'), ('test', 'pending')], 'manual_continue', False, ('waiting', 'manual_continue')),
])
def test_task_state_priority(status, steps, reason, settled, expected):
    rows = [SimpleNamespace(step_key=key, status=value, waiting_interactions_json=None) for key, value in steps]
    result = summarize_task_state(status, rows, reason=reason, settled=settled)
    assert (result['status'], result['status_reason']) == expected


def test_parallel_review_wait_is_retained_while_another_step_runs():
    result = summarize_task_state('running', [
        SimpleNamespace(step_key='backend', status='awaiting_review'),
        SimpleNamespace(step_key='frontend', status='running'),
    ])
    assert result['status'] == 'running'
    assert result['pending_confirmations'] == [{'step_key': 'backend', 'reason': 'manual_review'}]


def test_tool_and_input_waits_do_not_look_like_active_execution():
    step = SimpleNamespace(step_key='build', status='running',
                           waiting_interactions_json='{"tool-1":"tool_approval","q-1":"user_input"}')
    result = summarize_task_state('running', [step])
    assert (result['status'], result['status_reason']) == ('waiting', 'tool_approval')
    assert len(result['pending_confirmations']) == 2
    other = SimpleNamespace(step_key='test', status='running')
    assert summarize_task_state('running', [step, other])['status'] == 'running'


def test_removed_steps_do_not_block_current_workflow():
    result = summarize_task_state('running', [
        {'step_key': 'old', 'status': 'awaiting_review', 'in_workflow': False},
        {'step_key': 'build', 'status': 'running'},
    ])
    assert result['status'] == 'running'
    assert result['pending_confirmations'] == []


def test_database_aggregate_respects_workflow_overlay_and_current_run_scope(tmp_path):
    import json
    from models import Task, TaskStep, Workflow, WorkflowRun, init_db
    from services.task_state import current_task_steps, reconcile_task_state

    db = init_db(str(tmp_path / 'scoped-state.db'))
    try:
        Workflow.create(id='flow', name='Flow', created_at=1, updated_at=1,
                        steps_json=json.dumps({'nodes': [{'type': 'build'}, {'type': 'removed'}]}))
        task = Task.create(id='task', title='Scoped task', cwd=str(tmp_path), status='running',
                           workflow_id='flow', created_at=1, updated_at=1,
                           workflow_overrides_json=json.dumps({'added_nodes': [{'type': 'extra'}], 'removed_nodes': ['removed']}))
        for key, status in [('build', 'passed'), ('removed', 'failed'), ('extra', 'awaiting_review'), ('historical', 'running')]:
            TaskStep.create(task=task, step_key=key, status=status)
        assert {step.step_key for step in current_task_steps(task)} == {'build', 'extra'}
        assert reconcile_task_state(task, settled=True)['status'] == 'waiting'
        version = task.state_version
        assert reconcile_task_state(task, settled=True)['status'] == 'waiting'
        assert task.state_version == version  # Unchanged reads must not advance the version.
        run = WorkflowRun.create(id='run', task=task, workflow_schema_version=1,
                                 routing_state_json=json.dumps({'execution_scope': ['build']}))
        task.active_workflow_run_id = run.id
        task.save()
        state = reconcile_task_state(task, settled=True)
        assert state == {'status': 'completed', 'status_reason': None, 'pending_confirmations': []}
    finally:
        db.close()


@pytest.mark.anyio
async def test_api_and_events_share_parallel_wait_and_stop_states(api_context, monkeypatch):
    import asyncio
    import json
    import threading
    import main
    import services.project as project_service
    from models import Task, TaskStep
    from services.task_runner import TaskRunner
    from services.task_state import reconcile_task_state

    client, tmp_path = api_context
    monkeypatch.setattr(project_service, 'project_manager', main.project_manager)
    directory = tmp_path / 'state-project'
    directory.mkdir()
    pid = (await client.post('/api/project/init', json={'path': str(directory)})).json()['id']
    workflow = (await client.post(f'/api/workflow/create?project_id={pid}', json={
        'name': 'StateFlow', 'steps': {'steps': [{'key': 'backend'}, {'key': 'frontend'}]},
    })).json()
    created = await client.post(f'/api/task/create?project_id={pid}', json={
        'title': 'State task', 'workflow_id': workflow['id'], 'auto_start': False,
    })
    tid = created.json()['id']
    project = main.project_manager.get_project_by_id(pid)
    runner = TaskRunner(main.event_bus, database_executor=project.database_executor)

    def prepare():
        task = Task.get_by_id(tid)
        task.status = 'running'
        task.save()
        for key in ('backend', 'frontend'):
            TaskStep.get_or_create(task=task, step_key=key)
        TaskStep.update(status='awaiting_review').where((TaskStep.task == tid) & (TaskStep.step_key == 'backend')).execute()
        TaskStep.update(status='running').where((TaskStep.task == tid) & (TaskStep.step_key == 'frontend')).execute()
        return reconcile_task_state(task)

    await main.project_manager.run_db(pid, lambda _p: prepare())
    queue = main.event_bus.subscribe()
    try:
        payload = (await client.get(f'/api/task/{tid}?project_id={pid}')).json()
        assert payload['status'] == 'running'
        assert payload['pending_confirmations'] == [{'step_key': 'backend', 'reason': 'manual_review'}]
        await runner._publish(tid, 'frontend', {'type': 'interaction_request', 'data': {
            'interaction_id': 'permission-1', 'method': 'session/request_permission',
        }})
        payload = (await client.get(f'/api/task/{tid}?project_id={pid}')).json()
        assert payload['status'] == 'waiting'
        assert {p['reason'] for p in payload['pending_confirmations']} == {'manual_review', 'tool_approval'}
        assert (await client.delete(f'/api/git/projects/{pid}/tasks/{tid}/workspace?force=true')).status_code == 409
        assert (await client.request('DELETE', f'/api/task/delete?project_id={pid}', json={'task_id': tid})).status_code == 409
        await runner._publish(tid, 'frontend', {'type': 'interaction_request', 'data': {
            'interaction_id': 'parallel-question', 'method': 'question',
        }})
        await runner._publish(tid, 'frontend', {'type': 'interaction_response', 'data': {'interaction_id': 'permission-1'}})
        payload = (await client.get(f'/api/task/{tid}?project_id={pid}')).json()
        assert payload['status'] == 'waiting'
        assert {p['reason'] for p in payload['pending_confirmations']} == {'manual_review', 'user_input'}
        await runner._publish(tid, 'frontend', {'type': 'interaction_response', 'data': {'interaction_id': 'parallel-question'}})
        payload = (await client.get(f'/api/task/{tid}?project_id={pid}')).json()
        assert payload['status'] == 'running' and payload['status_reason'] == 'execution'
        events = []
        while not queue.empty():
            events.append(await queue.get())
        assert any(event.get('value', {}).get('status') == 'waiting' for event in events)
        assert any(event.get('status_reason') == 'execution' and event.get('pending_confirmations') for event in events)

        # Slow real SQLite writes cannot stall HTTP health checks.
        entered, release = threading.Event(), threading.Event()
        original = project.db.execute_sql
        def slow(sql, params=None, commit=None):
            if sql.startswith('UPDATE "taskstep"') and 'waiting_interactions_json' in sql:
                entered.set()
                release.wait(2)
            return original(sql, params)
        monkeypatch.setattr(project.db, 'execute_sql', slow)
        pending = asyncio.create_task(runner._publish(tid, 'frontend', {'type': 'interaction_request', 'data': {
            'interaction_id': 'question-1', 'method': 'question',
        }}))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            assert (await asyncio.wait_for(client.get('/api/health'), .3)).status_code == 200
        finally:
            release.set()
        await pending
        await main.project_manager.run_db(pid, lambda _p: Task.update(status='stopped', status_reason='user_stop').where(Task.id == tid).execute())
        payload = (await client.get(f'/api/task/{tid}?project_id={pid}')).json()
        assert payload['status'] == 'stopped' and not payload['pending_confirmations']
    finally:
        main.event_bus.unsubscribe(queue)
        await runner.close()
