import asyncio
import json
import time

import httpx
import pytest
from fastapi import FastAPI


@pytest.fixture
def hook_app(tmp_path, monkeypatch):
    import main
    from api import workflow_hooks
    from api.desktop_security import DesktopSecurityMiddleware
    from services.project import ProjectManager
    from services.task import TaskService
    from streaming.bus import EventBus
    from services.workflow_hooks import WorkflowHookService

    manager = ProjectManager()
    project = manager.init_project(tmp_path / 'project')
    with manager.activate_project_by_id(project.id):
        flow = manager.create_workflow(project, name='钩子测试', steps={'steps': [
            {'key': 'design', 'name': '设计', 'prompt': '设计'},
            {'key': 'test', 'name': '测试', 'prompt': '测试'},
        ]})
    service = WorkflowHookService(manager)
    monkeypatch.setattr(workflow_hooks, 'hook_service', service)
    monkeypatch.setattr(main, 'project_manager', manager)
    monkeypatch.setattr(main, 'task_service', TaskService(EventBus()))
    app = FastAPI()
    app.add_middleware(DesktopSecurityMiddleware)
    app.include_router(workflow_hooks.router)
    app.include_router(workflow_hooks.public_router)
    @app.get('/api/health')
    async def health():
        return {'status': 'ok'}
    yield app, manager, project, flow, service
    manager.close_all()


async def save(client, project, flow, hooks):
    response = await client.put(f'/api/workflow/{flow["id"]}/hooks', params={'project_id': project.id}, json={'hooks': hooks})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.asyncio
async def test_hook_api_body_stage_defaults_token_and_persistence(hook_app):
    app, manager, project, flow, service = hook_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        data = await save(client, project, flow, [dict(name='设计', default_title='默认标题', default_creator='机器人')])
        hook = data['hooks'][0]
        path = f'/api/hook/{data["device_id"]}/{hook["id"]}'
        assert (await client.post(path, params={'token': 'wrong'})).status_code == 401
        body = '{\n "merged": true, "title": "保持原始正文"\n}'
        response = await client.post(path, params={'token': hook['token'], 'step_key': 'test', 'creator': '张三', 'title': 'URL 标题'}, content=body, headers={'content-type': 'application/json'})
        assert response.status_code == 201, response.text
        task = await manager.run_db(project.id, lambda _: dict(__import__('models').Task.get_by_id(response.json()['task_id']).__data__) | {'steps': {r.step_key:r.status for r in __import__('models').TaskStep.select().where(__import__('models').TaskStep.task == response.json()['task_id'])}})
        assert task['title'] == 'URL 标题'
        assert task['creator_name'] == '张三'
        assert body in task['description']
        assert task['steps']['design'] == 'skipped' and task['steps']['test'] == 'pending'
        assert (await client.post(path, params={'token': hook['token'], 'step_key': 'missing'})).status_code == 422
        result = await client.post(path, params={'token': hook['token']}, content='原文')
        assert result.status_code == 201, result.text
        row = await manager.run_db(project.id, lambda _: dict(__import__('models').Task.get_by_id(result.json()['task_id']).__data__) | {'steps': {r.step_key:r.status for r in __import__('models').TaskStep.select().where(__import__('models').TaskStep.task == result.json()['task_id'])}})
        assert row['title'] == '默认标题' and row['creator_name'] == '机器人' and row['steps']['design'] == 'pending'
        service.invalidate()
        assert (await client.post(path, params={'token': hook['token']}, content='恢复')).status_code == 201
        new = await save(client, project, flow, [{**hook, 'rotate_token': True}])
        assert new['hooks'][0]['token'] != hook['token']
        assert (await client.post(path, params={'token': hook['token']})).status_code == 401
        await save(client, project, flow, [{**new['hooks'][0], 'enabled': False}])
        assert (await client.post(path, params={'token': new['hooks'][0]['token']})).status_code == 403
        await save(client, project, flow, [])
        assert (await client.post(path, params={'token': new['hooks'][0]['token']})).status_code == 404


@pytest.mark.asyncio
async def test_hook_public_boundary_size_and_slow_database(hook_app, monkeypatch):
    app, _, project, flow, service = hook_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        data = await save(client, project, flow, [dict(name='入口', default_title='任务')])
        path = f'/api/hook/{data["device_id"]}/{data["hooks"][0]["id"]}'
        params = {'token': data['hooks'][0]['token']}
        monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
        monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'private-desktop-token')
        assert (await client.post(path, params=params, content=b'\xff')).status_code == 422
        assert (await client.post(path, params=params, content=b'x' * (1024 * 1024 + 1))).status_code == 413
        assert (await client.post(path.replace(data['device_id'], 'other-device'), params=params)).status_code == 404
        assert (await client.get(path, params=params)).status_code == 405
        original = service.load_hook
        def slow(*args):
            time.sleep(.15)
            return original(*args)
        monkeypatch.setattr(service, 'load_hook', slow)
        pending = asyncio.create_task(client.post(path, params=params, content='slow'))
        started = time.monotonic()
        await asyncio.sleep(.02)
        assert time.monotonic() - started < .1
        assert (await client.get('/api/health', headers={'x-workstep-desktop-token': 'private-desktop-token'})).status_code == 200
        assert (await pending).status_code == 201


@pytest.mark.asyncio
async def test_anonymous_gateway_bridge_creates_task_and_cannot_proxy_other_apis(hook_app):
    import base64
    from services.gateway_client.bridge import ManagedHttpBridge
    from workstep_gateway_protocol import FrameType, ProxyFrame
    app, manager, project, flow, _ = hook_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        data = await save(client, project, flow, [dict(name='入口', default_title='网关任务')])
    hook = data['hooks'][0]
    path = f'/api/hook/{data["device_id"]}/{hook["id"]}'
    async def forwarded(path, query):
        frames = []
        async def capture(frame): frames.append(frame)
        bridge = ManagedHttpBridge(app, 'hook-stream', {
            'method': 'POST', 'path': path, 'query': query,
            'headers': [['content-type', 'text/plain']], 'hook_request': True,
        }, capture, 'gateway-device')
        bridge.start_task()
        for payload in [dict(phase='body', data=base64.b64encode('整个正文'.encode()).decode()), dict(phase='end')]:
            await bridge.feed(ProxyFrame(stream_id='hook-stream', type=FrameType.http_request, payload=payload))
        await asyncio.wait_for(bridge._task, timeout=2)
        status = next(f.payload['status'] for f in frames if f.payload.get('phase') == 'start')
        body = b''.join(base64.b64decode(f.payload['data']) for f in frames if f.payload.get('phase') == 'body')
        return status, json.loads(body) if body else None
    status, result = await forwarded(path, f'token={hook["token"]}&step_key=test')
    assert status == 201
    content = await manager.run_db(project.id, lambda _: __import__('models').Task.get_by_id(result['task_id']).description)
    assert content == '整个正文'
    assert (await forwarded(path, 'token=wrong'))[0] == 401
    assert (await forwarded('/api/task/create', f'token={hook["token"]}'))[0] == 502


@pytest.mark.asyncio
async def test_hook_run_failure_returns_created_id_and_display_name_does_not_grant_permission(hook_app, monkeypatch):
    import main
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    app, _, project, flow, _ = hook_app
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        data = await save(client, project, flow, [dict(name='入口', default_title='任务', execution_mode='immediate')])
        hook = data['hooks'][0]
        path = f'/api/hook/{data["device_id"]}/{hook["id"]}'
        monkeypatch.setattr(main, 'workflow_runtime', SimpleNamespace(start=AsyncMock(side_effect=RuntimeError('not ready'))))
        response = await client.post(path, params={'token': hook['token']}, content='任务')
        assert response.status_code == 201
        assert response.json()['task_id'] and response.json()['run_error']
        monkeypatch.setattr(main.gateway_client, 'managed_config', object())
        response = await client.post(path, params={'token': hook['token'], 'creator': 'admin'}, content='任务')
        assert response.status_code == 403
