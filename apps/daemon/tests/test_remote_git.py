"""Remote Git uses authenticated project scope and real repositories."""
import asyncio
import json
import threading
import time
from pathlib import Path

import pytest
from fastapi import FastAPI

import api.git as git_api
from services.remote_access import ActorSnapshot, RemotePrincipal
from streaming.remote_host import RemoteRouteDispatcher
from services.remote_protocol import RemoteHttpRequest
from tests.test_git_api import client, layout, git, payment_id


def principal():
    return RemotePrincipal(project_id='p', actor=ActorSnapshot('device', 'User', 'device', 'Computer', 'remote'))


async def test_remote_git_reads_commits_and_rejects_other_projects(client, monkeypatch):
    http, service = client
    tree_id = await payment_id(http)
    monkeypatch.setattr(git_api, '_task_project', lambda project_id: None)
    app = FastAPI()
    app.include_router(git_api.router)
    dispatcher = RemoteRouteDispatcher(app)

    async def send(path, method='GET', body=None):
        return await dispatcher.dispatch(RemoteHttpRequest(
            request_id='git', method=method, path='/api/git' + path,
            query={'project_id': 'forged'}, headers={'content-type': 'application/json'},
            body=json.dumps(body).encode() if body else b'',
        ), principal())

    try:
        discovery = await send('/projects/remote:abc/repositories')
        assert discovery.status == 200
        assert [project['id'] for project in discovery.json()['projects']] == ['p']
        state = await send(f'/worktrees/{tree_id}/status')
        assert state.status == 200
        path = service.directories[tree_id]['path']
        await asyncio.to_thread(Path(path, 'one.txt').write_text, 'remote edit\n')
        state = (await send(f'/worktrees/{tree_id}/status')).json()
        committed = await send(f'/worktrees/{tree_id}/commit', 'POST', {
            'paths': ['one.txt'], 'message': 'remote commit', 'snapshot': state['snapshot'],
        })
        assert committed.status == 200, committed.body
        assert await asyncio.to_thread(git, path, 'log', '-1', '--format=%s') == 'remote commit'
        service.directories[tree_id]['project_ids'] = ['other']
        assert (await send(f'/worktrees/{tree_id}/status')).status == 403
        for path, method in [('/scans', 'POST'), ('/credentials', 'PUT'), (f'/worktrees/{tree_id}/identity/global', 'PUT')]:
            with pytest.raises(PermissionError):
                await send(path, method)
    finally:
        await dispatcher.aclose()


async def test_remote_git_slow_scan_keeps_event_loop_responsive(client, monkeypatch):
    _, service = client
    monkeypatch.setattr(git_api, '_task_project', lambda project_id: None)
    import services.git as git_module
    original = git_module.directory_entries
    started = threading.Event()

    def slow(path):
        started.set()
        time.sleep(.1)
        return original(path)

    monkeypatch.setattr(git_module, 'directory_entries', slow)
    app = FastAPI()
    app.include_router(git_api.router)

    @app.get('/health')
    async def health():
        return {'ok': True}

    dispatcher = RemoteRouteDispatcher(app)
    pending = asyncio.create_task(dispatcher.dispatch(RemoteHttpRequest(
        request_id='scan', method='GET', path='/api/git/projects/client/repositories',
        query={'refresh': 'true'},
    ), principal()))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        response = await asyncio.wait_for(dispatcher._client.get('/health'), .1)
        assert response.status_code == 200
        assert (await pending).status == 200
    finally:
        await pending
        await dispatcher.aclose()


async def test_remote_task_workspace_lifecycle_uses_bound_project(layout, monkeypatch):
    from models import Task
    from models.fields import utc_now
    from services.project import ProjectManager
    import services.project as project_module
    from services.git import GitService

    root, _, _ = layout
    manager = ProjectManager()
    project = await asyncio.to_thread(manager.init_project, root)
    monkeypatch.setattr(project_module, 'project_manager', manager)
    now = utc_now()
    await manager.run_db(project.id, lambda _: Task.create(
        id='remote-task', title='Remote change', cwd=str(root), status='ready', created_at=now, updated_at=now,
    ))
    service = GitService(lambda: [{'id': project.id, 'name': project.name, 'path': str(root)}], lambda: 5)
    monkeypatch.setattr(git_api, 'git_service', service)
    app = FastAPI()
    app.include_router(git_api.router)
    dispatcher = RemoteRouteDispatcher(app)
    actor = principal().actor
    bound = RemotePrincipal(project_id=project.id, actor=actor)

    async def send(suffix, method='GET', body=None):
        return await dispatcher.dispatch(RemoteHttpRequest(
            request_id='task-git', method=method, path='/api/git/projects/remote:client/' + suffix,
            headers={'content-type': 'application/json'}, body=json.dumps(body).encode() if body else b'',
        ), bound)

    try:
        discovery = (await send('repositories')).json()
        repository_id = next(repo['id'] for repo in discovery['repositories'] if repo['name'] == 'payment')
        opened = await send('tasks/remote-task/workspace', 'POST')
        assert opened.status == 200, opened.body
        assert opened.json()['path'].startswith(str(root))
        created = await send('tasks/remote-task/worktrees', 'POST', {
            'repository_id': repository_id, 'alias': 'payment', 'base_ref': 'main', 'branch_name': 'remote/payment',
        })
        assert created.status == 200, created.body
        assert created.json()['worktrees'][0]['branch'] == 'remote/payment'
        assert (await send('tasks/other-task/workspace')).status == 404
        removed = await send('tasks/remote-task/worktrees/payment', 'DELETE')
        assert removed.status == 200, removed.body
        assert removed.json()['worktrees'] == []
        deleted = await send('tasks/remote-task/workspace', 'DELETE')
        assert deleted.status == 200, deleted.body
        assert not await asyncio.to_thread(Path(opened.json()['path']).exists)
    finally:
        await dispatcher.aclose()
        await service.close()
        await asyncio.to_thread(manager.close_all)
