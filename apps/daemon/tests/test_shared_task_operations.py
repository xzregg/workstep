import asyncio
import base64
import json
import threading
import time

import pytest

from services.gateway_client.bridge import ManagedHttpBridge
from tests.test_api_contracts import api_context
from tests.test_coordinator import _create_task
from tests.test_gateway_share_ticket import _ticket
from workstep_gateway_protocol import FrameType, ProxyFrame


@pytest.mark.anyio
async def test_editable_share_reuses_task_routes_with_bound_scope_and_responsive_database(api_context, monkeypatch):
    import main
    from models import Task, Message
    from models.fields import utc_now
    client, tmp_path = api_context
    project_id, task_id = await _create_task(client, tmp_path)
    monkeypatch.setattr(main.gateway_client, 'managed_config', object())
    import services.project as project_service
    monkeypatch.setattr(project_service, 'project_manager', main.project_manager)
    async def step_config(pid, tid, step):
        assert (pid, tid, step) == (project_id, task_id, 'req')
        return {'editable': True, 'resolved': {'engine': 'claude', 'model': '', 'config': {}}}
    monkeypatch.setattr(main.workflow_runtime, 'get_step_execution_config', step_config)
    from services.git.task_workspace import TaskGitWorkspace
    async def workspace(_self, project_path, tid):
        assert tid == task_id
        return {'path': str(project_path / 'task-root'), 'worktrees': []}
    monkeypatch.setattr(TaskGitWorkspace, 'list', workspace)

    async def operation(path, *, method='GET', body=None, mode='interactive', key=None):
        ticket, signer, fingerprint = _ticket(task_id=task_id, host_project_id=project_id, mode=mode)
        frames = []
        async def send(frame):
            frames.append(frame)
        bridge = ManagedHttpBridge(main.app, 'shared-operation', {
            'method': 'POST', 'path': '/api/platform-share/operation', 'query': '',
            'headers': [['content-type', 'application/json']], 'share_ticket': ticket,
        }, send, 'device-1', gateway_key=signer, gateway_fingerprint=fingerprint, gateway_id='gateway-1')
        bridge.start_task()
        raw = json.dumps({'path': path, 'method': method, 'body': body, 'idempotency_key': key}).encode()
        await bridge.feed(ProxyFrame(stream_id='shared-operation', type=FrameType.http_request,
                                    payload={'phase': 'body', 'data': base64.b64encode(raw).decode()}))
        await bridge.feed(ProxyFrame(stream_id='shared-operation', type=FrameType.http_request, payload={'phase': 'end'}))
        await asyncio.wait_for(bridge._task, 3)
        raw = b''.join(base64.b64decode(frame.payload['data']) for frame in frames if frame.payload.get('phase') == 'body')
        return frames[0].payload['status'], json.loads(raw) if raw else None

    base = f'/task/{task_id}'
    assert (await operation(base, mode='read_only'))[0] == 403
    assert (await operation('/task/foreign', method='PATCH', body={'title': 'No'}))[0] == 403
    assert (await operation('https://owner.test/api/task/' + task_id))[0] == 403
    assert (await operation('/task%2fforeign'))[0] == 403
    assert (await operation('/task/%252e%252e/foreign'))[0] == 403
    assert (await operation('/provider/key/reveal', method='POST'))[0] == 403
    assert (await operation('/workflow/foreign/step/req/prompt', method='PATCH', body={'prompt': 'No'}))[0] == 403
    status, task = await operation(base + '?project_id=foreign')
    assert status == 200 and task['id'] == task_id
    status, task = await operation(base, method='PATCH', body={'title': 'SharedEdit'})
    assert status == 200 and task['title'] == 'SharedEdit'
    assert (await operation('/task/list'))[1]['tasks'][0]['id'] == task_id
    assert (await operation(base + '/step/req/config'))[0] == 200
    assert (await operation(f'/git/projects/share%3Atoken/tasks/{task_id}/workspace'))[0] == 200
    root = main.project_manager.get_project_by_id(project_id).path / 'task-root'
    root.mkdir()
    (root / 'draft.md').write_text('before')
    assert (await operation('/fs/preview?path=workspace:draft.md'))[1]['content'] == 'before'
    assert (await operation('/fs/entry', method='POST', body={'project_id': 'foreign',
        'root': 'workspace:', 'parent': 'workspace:', 'name': 'new.md', 'kind': 'file'}))[0] == 200
    assert (await operation('/fs/content', method='PUT', body={'project_id': 'foreign',
        'root': 'workspace:', 'path': 'workspace:draft.md', 'content': 'after', 'expected_content': 'before'}))[0] == 200
    assert (root / 'draft.md').read_text() == 'after'
    assert (await operation('/fs/entry', method='DELETE', body={'project_id': 'foreign',
        'root': 'workspace:', 'path': str(root.parent / 'private.md')}))[0] == 403

    def seed(_project):
        Task.create(id='foreign-task', title='Foreign', cwd=str(_project.path), created_at=utc_now(), updated_at=utc_now())
        Message.create(id='foreign-message', task='foreign-task', step_key='req', channel='coordinator',
                       role='assistant', content='', position=0, sequence=1, created_at=utc_now())
        Message.create(id='own-message', task=task_id, step_key='req', channel='coordinator',
                       role='assistant', content='', position=0, sequence=1, created_at=utc_now())
    await main.project_manager.run_db(project_id, seed)
    assert (await operation('/pending-message-inserts', method='POST', body={
        'project_id': 'foreign', 'target_message_id': 'unknown-message', 'content': 'No',
    }))[0] == 404
    assert (await operation('/pending-message-inserts?target_message_id=own-message', method='POST', body={
        'project_id': 'foreign', 'target_message_id': 'foreign-message', 'content': 'No',
    }))[0] == 404
    status, inserted = await operation('/pending-message-inserts', method='POST', body={
        'project_id': 'foreign', 'target_message_id': 'own-message', 'content': 'Draft',
    })
    assert status == 200 and inserted['content'] == 'Draft'
    assert (await operation('/pending-message-inserts?target_message_id=own-message'))[1]['items'][0]['id'] == inserted['id']
    assert (await operation('/action-runs/foreign/stop', method='POST'))[0] == 404
    assert (await operation(base + '/messages/foreign/retry', method='POST'))[0] == 404
    entered = threading.Event()
    original_get = Task.get_or_none
    def slow_get(*args, **kwargs):
        entered.set(); time.sleep(0.4)
        return original_get(*args, **kwargs)
    monkeypatch.setattr(Task, 'get_or_none', slow_get)
    pending = asyncio.create_task(operation(base, method='PATCH', body={'description': 'shared description'}))
    assert await asyncio.to_thread(entered.wait, 2)
    started = time.monotonic()
    assert (await client.get('/api/health')).status_code == 200
    assert time.monotonic() - started < 0.25
    assert (await pending)[0] == 200


@pytest.mark.anyio
async def test_task_resources_accept_normal_file_and_git_routes_only_within_task(api_context, monkeypatch):
    import main
    from api.shared_task_resources import prepare_task_resource
    from services.git import git_service
    from services.git.task_workspace import TaskGitWorkspace
    client, tmp_path = api_context
    project_id, task_id = await _create_task(client, tmp_path)
    project = main.project_manager.get_project_by_id(project_id)
    root = project.path / 'task-workspace'
    root.mkdir()
    tree_id = 'a' * 24
    async def workspace(*args):
        return {'path': str(root), 'worktrees': [{'id': tree_id}]}
    monkeypatch.setattr(TaskGitWorkspace, 'list', workspace)
    body = {'root': str(root), 'parent': str(root / 'nested'), 'name': 'draft.md'}
    assert await prepare_task_resource('/fs/entry', 'POST', {}, body, project_id, task_id, None) == '/fs/entry'
    assert body['parent'] == str(root / 'nested')
    with pytest.raises(Exception) as denied:
        await prepare_task_resource('/fs/entry', 'POST', {}, {'root': str(root), 'parent': str(project.path)}, project_id, task_id, None)
    assert denied.value.status_code == 403
    for route in ('files/content', 'commit-message', 'merge-into', 'recoveries', 'recovery/preview', 'recovery/apply', 'push-branch', 'fetch-remote'):
        path = f'/git/worktrees/{tree_id}/{route}'
        assert await prepare_task_resource(path, 'GET' if route == 'recoveries' else 'POST', {}, {}, project_id, task_id, None) == path
    with pytest.raises(Exception) as denied:
        await prepare_task_resource('/git/worktrees/' + 'b' * 24 + '/commit', 'POST', {}, {}, project_id, task_id, None)
    assert denied.value.status_code == 403


@pytest.mark.anyio
async def test_local_share_expiry_is_enforced_by_api_and_slow_lookup_keeps_health_responsive(api_context, monkeypatch):
    from datetime import timedelta
    import main
    import services.project as project_service
    from models import TaskShare
    from models.fields import utc_now
    client, tmp_path = api_context
    project_id, task_id = await _create_task(client, tmp_path)
    monkeypatch.setattr(project_service, 'project_manager', main.project_manager)
    monkeypatch.setattr(main.gateway_client, 'managed_config', None)
    base = f'/api/task-share/{task_id}'
    expiry = utc_now() + timedelta(days=7)
    created = await client.post(base + f'/create?project_id={project_id}', json={'password': 'generated-access-key', 'expires_at': expiry.isoformat()})
    assert created.status_code == 200, created.text
    assert created.json()['expires_at'] == expiry.isoformat()
    token = created.json()['token']
    public = f'/api/task-share/public/{token}'
    session = (await client.post(public + '/unlock', json={'password': 'generated-access-key'})).json()['session_token']
    original_select = TaskShare.select
    entered = threading.Event()
    def slow_select(*args, **kwargs):
        entered.set()
        time.sleep(0.3)
        return original_select(*args, **kwargs)
    monkeypatch.setattr(TaskShare, 'select', slow_select)
    pending = asyncio.create_task(client.get(public + '/task', headers={'X-Share-Session': session}))
    assert await asyncio.to_thread(entered.wait, 1)
    start = time.monotonic()
    assert (await client.get('/api/health')).status_code == 200
    assert time.monotonic() - start < 0.2
    assert (await pending).status_code == 200
    monkeypatch.setattr(TaskShare, 'select', original_select)
    await main.project_manager.run_db(project_id, lambda _: TaskShare.update(expires_at=utc_now() - timedelta(seconds=1)).where(TaskShare.token == token).execute())
    assert (await client.get(public + '/task', headers={'X-Share-Session': session})).status_code == 401
    assert (await client.get(public + '/meta')).status_code == 404
    assert (await client.post(public + '/unlock', json={'password': 'generated-access-key'})).status_code == 404
