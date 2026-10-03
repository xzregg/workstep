"""Task changes and their audit row commit or roll back together."""
import pytest
from models import ProjectAuditEvent, Task
from tests.test_api_contracts import api_context, _create_test_workflow


@pytest.mark.anyio
async def test_task_crud_api_records_identity_and_rolls_back_when_audit_fails(api_context, monkeypatch):
    import main
    from services import project_audit
    from services.config import config_store
    monkeypatch.setattr(config_store, 'get_user_name', lambda: 'Audit Tester')
    client, root = api_context
    path = root / 'audit-crud'; path.mkdir()
    project = (await client.post('/api/project/init', json={'path': str(path)})).json()['id']
    workflow = await _create_test_workflow(client, project)
    query = {'project_id': project}
    body = {'title': 'Original', 'description': 'secret prompt must never enter audit',
            'workflow_id': workflow['id'], 'auto_start': False}
    created = await client.post('/api/task/create', params=query, json=body)
    assert created.status_code == 200, created.text
    task_id = created.json()['id']
    copied = await client.post('/api/task/copy', params=query, json={'task_id': task_id, 'newTitle': 'Copy'})
    assert copied.status_code == 200, copied.text
    assert copied.json()['creator_name'] == created.json()['creator_name'] == 'Audit Tester'
    assert (await client.post('/api/task/archive', params=query, json={'task_id': task_id})).status_code == 200
    assert (await client.post('/api/task/unarchive', params=query, json={'task_id': task_id})).status_code == 200
    assert (await client.request('DELETE', '/api/task/delete', params=query, json={'task_id': copied.json()['id']})).status_code == 200
    def read(_project):
        return [(row.action, row.actor_name, row.metadata_json) for row in ProjectAuditEvent.select().order_by(ProjectAuditEvent.created_at)]
    rows = await main.project_manager.run_db(project, read)
    assert [row[0] for row in rows] == ['task.create', 'task.copy', 'task.archive', 'task.unarchive', 'task.delete']
    assert all(row[1] == 'Audit Tester' and 'secret prompt' not in row[2] for row in rows)
    def fail(**_kwargs):
        raise RuntimeError('Audit storage unavailable')
    monkeypatch.setattr(project_audit, 'record_project_audit', fail)
    with pytest.raises(RuntimeError, match='Audit storage unavailable'):
        await client.post('/api/task/create', params=query, json={**body, 'title': 'Rolled back'})
    assert await main.project_manager.run_db(project, lambda _p: Task.select().count()) == 1
    response = await client.post('/api/task/archive', params=query, json={'task_id': task_id})
    assert response.status_code == 409
    assert await main.project_manager.run_db(project, lambda _p: Task.get_by_id(task_id).archived) == 0


@pytest.mark.anyio
async def test_task_creation_audit_and_post_start_read_keep_health_responsive(api_context, monkeypatch):
    import asyncio
    import threading
    import time
    from unittest.mock import AsyncMock
    import main
    from services.config import config_store
    monkeypatch.setattr(config_store, 'get_user_name', lambda: 'Audit Tester')
    client, root = api_context
    path = root / 'audit-canary'; path.mkdir()
    project_id = (await client.post('/api/project/init', json={'path': str(path)})).json()['id']
    workflow = await _create_test_workflow(client, project_id)
    project = main.project_manager.get_project_by_id(project_id)
    original_sql = project.db.execute_sql
    original_read = main.task_service.get_task
    entered = threading.Event()
    phase = 'audit'
    def slow_sql(sql, *args, **kwargs):
        if phase == 'audit' and 'INSERT INTO "project_audit_events"' in sql:
            entered.set(); time.sleep(0.6)
        return original_sql(sql, *args, **kwargs)
    def slow_read(*args, **kwargs):
        if phase == 'read':
            entered.set(); time.sleep(0.6)
        return original_read(*args, **kwargs)
    monkeypatch.setattr(project.db, 'execute_sql', slow_sql)
    monkeypatch.setattr(main.task_service, 'get_task', slow_read)
    monkeypatch.setattr(main.workflow_runtime, 'start', AsyncMock(return_value=None))
    for phase in ('audit', 'read'):
        entered.clear()
        pending = asyncio.create_task(client.post('/api/task/create', params={'project_id': project_id},
            json={'title': phase, 'workflow_id': workflow['id'], 'auto_start': phase == 'read'}))
        assert await asyncio.to_thread(entered.wait, 2)
        before = time.monotonic()
        health = await asyncio.wait_for(client.get('/api/health'), 0.3)
        assert health.status_code == 200 and time.monotonic() - before < 0.3
        result = await pending
        assert result.status_code == 200, result.text


@pytest.mark.anyio
async def test_remote_failure_audit_uses_bound_database_executor(api_context, monkeypatch):
    import asyncio
    import threading
    import time
    from types import SimpleNamespace
    import main
    from services.project_request_audit import record_remote_request_failure
    client, root = api_context
    path = root / 'failure-canary'; path.mkdir()
    project_id = (await client.post('/api/project/init', json={'path': str(path)})).json()['id']
    project = main.project_manager.get_project_by_id(project_id)
    execute = project.db.execute_sql
    entered = threading.Event()
    def slow(sql, *args, **kwargs):
        if 'INSERT INTO "project_audit_events"' in sql:
            entered.set(); time.sleep(0.6)
        return execute(sql, *args, **kwargs)
    monkeypatch.setattr(project.db, 'execute_sql', slow)
    actor = SimpleNamespace(project_id=project_id, user_id='worker', username='worker',
        display_name='Worker', device_id='device', project_access_level='read')
    pending = asyncio.create_task(record_remote_request_failure(actor, 403, 'project_scope'))
    assert await asyncio.to_thread(entered.wait, 2)
    assert (await asyncio.wait_for(client.get('/api/health'), 0.3)).status_code == 200
    await pending
    row = await main.project_manager.run_db(project_id, lambda _project:
        ProjectAuditEvent.get(ProjectAuditEvent.project_id == project_id).__data__)
    assert row['actor_id'] == 'worker' and row['task_id'] is None and row['result'] == 'denied'
