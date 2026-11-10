"""Every browser file delivery must respect the configured preview directory."""

import asyncio
import threading
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from tests.test_fs_security_boundaries import filesystem_app


@pytest.fixture
def preview_scope(filesystem_app, tmp_path, monkeypatch):
    from services.config import config_store
    app, data = filesystem_app
    monkeypatch.setattr(config_store, '_cache', {
        'default_project_directory': str(data.parent),
    })
    outside = tmp_path / 'private.txt'
    outside.write_text('synthetic secret')
    (data.parent / 'escape.txt').symlink_to(outside)
    (data.parent / 'ok.txt').write_text('allowed')
    return app, data.parent, outside


@pytest.mark.asyncio
@pytest.mark.parametrize('route', ['preview', 'file', 'raw', 'project-raw'])
@pytest.mark.parametrize('kind', ['absolute', 'parent', 'symlink', 'encoded'])
async def test_preview_routes_reject_escape(preview_scope, route, kind):
    from urllib.parse import quote
    app, root, outside = preview_scope
    path = {'absolute': str(outside), 'parent': '../private.txt',
            'symlink': 'escape.txt', 'encoded': '../private.txt'}[kind]
    params = {'project_id': 'p1', 'absolute': 'true'}
    url = '/api/fs/' + route
    if route in ('preview', 'file'):
        params['path'] = path
    else:
        path = str(root / path) if not Path(path).is_absolute() else path
        url += ('/p1/' if route == 'project-raw' else '/') + quote(path.lstrip('/'), safe='/' if kind != 'encoded' else '')
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://local') as client:
        response = await client.get(url, params=params)
    assert response.status_code == 403, response.text
    assert 'synthetic secret' not in response.text


@pytest.mark.asyncio
async def test_no_project_and_absolute_flag_cannot_bypass_root(preview_scope):
    app, root, outside = preview_scope
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://local') as client:
        for endpoint in ('preview', 'file'):
            assert (await client.get('/api/fs/' + endpoint, params={
                'path': str(outside), 'absolute': 'true',
            })).status_code == 403
            assert (await client.get('/api/fs/' + endpoint, params={
                'path': str(root / 'ok.txt'),
            })).status_code == 200


@pytest.mark.asyncio
async def test_upload_delivery_and_existing_html_ticket_recheck_root(preview_scope, monkeypatch):
    from services.config import config_store
    app, root, _ = preview_scope
    (root / 'index.html').write_text('<h1>allowed</h1>')
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://local') as client:
        preview = await client.get('/api/fs/preview', params={'path': 'index.html', 'project_id': 'p1'})
        assert preview.status_code == 200
        token = preview.json()['html_preview']['token']
        urls = [f'/api/fs/html-resource/p1/{token}/index.html',
                '/api/fs/serve/known.txt?project_id=p1', '/demo/.workstep/uploads/known.txt']
        for url in urls:
            assert (await client.get(url)).status_code == 200
        monkeypatch.setitem(config_store._cache, 'default_project_directory', str(root / 'narrower'))
        for url in urls:
            assert (await client.get(url)).status_code == 403


@pytest.mark.asyncio
async def test_share_preview_and_download_keep_task_scope_and_root(preview_scope, monkeypatch):
    import api.share as share
    from services.config import config_store
    app, root, _ = preview_scope
    app.include_router(share.router)
    report = root / '.workstep/artifacts/workflow/task/step/report.txt'
    report.parent.mkdir(parents=True)
    report.write_text('allowed task output')
    ctx = {'project_id': 'p1', 'task_id': 'task', 'token': 'share'}
    async def session(*_args):
        return ctx
    monkeypatch.setattr(share, '_require_share_session', session)
    monkeypatch.setattr(share, '_require_share_session_token', session)
    relative = report.relative_to(root).as_posix()
    urls = [f'/api/task-share/public/share/file-preview?path={relative}',
            f'/api/task-share/public/share/files/session/{relative}',
            '/api/task-share/public/share/uploads/known.txt?session=session']
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://local') as client:
        for url in urls:
            assert (await client.get(url)).status_code == 200
        denied = await client.get('/api/task-share/public/share/file-preview?path=ok.txt')
        assert denied.status_code == 403
        monkeypatch.setitem(config_store._cache, 'default_project_directory', str(root / 'narrower'))
        for url in urls:
            assert (await client.get(url)).status_code == 403


@pytest.mark.asyncio
async def test_slow_boundary_resolution_keeps_health_responsive(preview_scope, monkeypatch):
    app, root, _ = preview_scope
    original = Path.resolve
    entered, release = threading.Event(), threading.Event()
    def slow(path, *args, **kwargs):
        if path == root:
            entered.set()
            assert release.wait(2)
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'resolve', slow)
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://local') as client:
        pending = asyncio.create_task(client.get('/api/fs/preview', params={'path': str(root / 'ok.txt')}))
        try:
            assert await asyncio.to_thread(entered.wait, 1)
            assert (await asyncio.wait_for(client.get('/api/health'), .2)).status_code == 200
            assert not pending.done()
        finally:
            release.set()
            response = await pending
        assert response.status_code == 200


@pytest.mark.asyncio
async def test_gateway_share_artifact_download_and_preview_recheck_root(preview_scope, monkeypatch):
    import main
    import api.platform_share as platform
    from services.config import config_store
    app, root, _ = preview_scope
    app.include_router(platform.router)
    artifact_id = 'a' * 64
    monkeypatch.setattr(platform, '_share_scope', lambda _: {'host_project_id': 'p1', 'task_id': 'task'})
    monkeypatch.setattr(platform, '_task_artifacts', lambda *_: [
        ({'id': artifact_id, 'is_dir': False}, root / 'ok.txt'),
    ])
    async def run_db(project_id, operation):
        return await asyncio.to_thread(operation, main.project_manager.get_project_by_id(project_id))
    monkeypatch.setattr(main.project_manager, 'run_db', run_db, raising=False)
    urls = [f'{platform.router.prefix}/artifacts/{artifact_id}/{action}' for action in ('content', 'preview')]
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://local') as client:
        for url in urls:
            assert (await client.get(url)).status_code == 200
        monkeypatch.setitem(config_store._cache, 'default_project_directory', str(root / 'narrower'))
        for url in urls:
            assert (await client.get(url)).status_code == 403


@pytest.mark.asyncio
async def test_unset_directory_uses_home_and_container_scope_still_applies(preview_scope, monkeypatch):
    from services.config import config_store
    app, root, outside = preview_scope
    monkeypatch.setitem(config_store._cache, 'default_project_directory', '')
    monkeypatch.setattr(Path, 'home', classmethod(lambda cls: root))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://local') as client:
        assert (await client.get('/api/fs/preview', params={'path': str(root / 'ok.txt')})).status_code == 200
        assert (await client.get('/api/fs/preview', params={'path': str(outside)})).status_code == 403
        monkeypatch.setenv('WORKSTEP_PROJECTS_ROOT', str(root / 'narrower'))
        assert (await client.get('/api/fs/preview', params={'path': str(root / 'ok.txt')})).status_code == 403


@pytest.mark.asyncio
async def test_project_browse_and_search_reject_projects_outside_root(preview_scope, monkeypatch):
    from services.config import config_store
    app, root, _ = preview_scope
    monkeypatch.setitem(config_store._cache, 'default_project_directory', str(root / 'narrower'))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://local') as client:
        for route in ('browse', 'search'):
            assert (await client.get('/api/fs/' + route, params={'project_id': 'p1', 'query': 'ok'})).status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize('action', ['browse', 'preview', 'content'])
async def test_gateway_share_workspace_reads_recheck_root(preview_scope, monkeypatch, action):
    import json
    import api.platform_share as platform
    from services.config import config_store
    app, root, _ = preview_scope
    app.include_router(platform.router)
    monkeypatch.setattr(platform, '_share_scope', lambda _: {'host_project_id': 'p1', 'task_id': 'task'})
    async def workspace(_scope):
        return {'path': str(root), 'worktrees': []}
    monkeypatch.setattr(platform, '_share_git_workspace', workspace)
    path = 'workspace:' + ('' if action == 'browse' else 'ok.txt')
    encoded = json.dumps({'path': path}).encode().hex()
    url = f'{platform.router.prefix}/git/read/{action}/{encoded}'
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://local') as client:
        assert (await client.get(url)).status_code == 200
        monkeypatch.setitem(config_store._cache, 'default_project_directory', str(root / 'narrower'))
        assert (await client.get(url)).status_code == 403


@pytest.mark.asyncio
async def test_switch_disables_only_global_root_not_project_boundary(preview_scope, monkeypatch):
    from services.config import config_store
    app, root, outside = preview_scope
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://local') as client:
        params = {'path': str(outside), 'project_id': 'p1', 'absolute': 'true'}
        assert (await client.get('/api/fs/preview', params=params)).status_code == 403
        monkeypatch.setitem(config_store._cache, 'restrict_file_access_root', False)
        assert (await client.get('/api/fs/preview', params=params)).status_code == 200
        params['absolute'] = 'false'
        assert (await client.get('/api/fs/preview', params=params)).status_code == 403
        monkeypatch.setenv('WORKSTEP_PROJECTS_ROOT', str(root))
        params['absolute'] = 'true'
        assert (await client.get('/api/fs/preview', params=params)).status_code == 403


@pytest.mark.asyncio
async def test_restriction_covers_browse_search_mkdir_memory_and_uploads(preview_scope, monkeypatch):
    from services.config import config_store
    app, root, outside = preview_scope
    monkeypatch.setitem(config_store._cache, 'default_project_directory', str(root / 'narrower'))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://local') as client:
        requests = [
            ('GET', '/api/fs/browse', {'params': {'path': str(root)}}),
            ('GET', '/api/fs/search', {'params': {'root': str(root), 'query': 'ok'}}),
            ('POST', '/api/fs/mkdir', {'json': {'parent': str(root), 'name': 'blocked'}}),
            ('GET', '/api/fs/memory', {'params': {'project_id': 'p1'}}),
            ('PUT', '/api/fs/memory', {'params': {'project_id': 'p1'}, 'json': {'content': 'blocked'}}),
            ('POST', '/api/fs/upload/file', {'params': {'project_id': 'p1'}, 'json': {'filename': 'a.txt', 'data_url': 'data:text/plain;base64,YQ=='}}),
            ('POST', '/api/fs/open-directory', {'json': {'path': str(root)}}),
        ]
        for method, url, kwargs in requests:
            response = await client.request(method, url, **kwargs)
            assert response.status_code == 403, (url, response.text)
    assert not (root / 'blocked').exists()
    assert not (root / '.workstep/MEMORY.md').exists()


@pytest.mark.asyncio
@pytest.mark.parametrize('module,key', [
    ('languages', 'pack_id'),
    ('skins', 'skin_id'),
    ('custom_engine', 'engine_id'),
])
async def test_package_paths_respect_file_root(preview_scope, module, key):
    import importlib
    app, root, outside = preview_scope
    routes = importlib.import_module('api.' + module)
    app.include_router(routes.router)
    prefix = routes.router.prefix
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://local') as client:
        for endpoint, payload in [
            ('export', {key: 'test', 'output': str(outside.with_suffix('.zip'))}),
            ('register', {'path': str(outside.parent)}),
        ]:
            response = await client.post(prefix + '/' + endpoint, json=payload)
            assert response.status_code == 403, response.text
    assert not outside.with_suffix('.zip').exists()


@pytest.mark.asyncio
async def test_project_and_git_entries_reject_outside_root(preview_scope, monkeypatch):
    import main
    import services.project
    import api.project as projects
    import api.git as git
    from services.config import config_store
    app, root, outside = preview_scope
    monkeypatch.setattr(services.project, 'project_manager', main.project_manager)
    app.include_router(projects.router)
    app.include_router(git.router)
    monkeypatch.setitem(config_store._cache, 'default_project_directory', str(root / 'narrower'))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://local') as client:
        for route in ('init', 'register'):
            response = await client.post('/api/project/' + route, json={'path': str(root)})
            assert response.status_code == 403, response.text
        response = await client.get('/api/git/projects/p1/tasks/task/workspace')
        assert response.status_code == 403, response.text


@pytest.mark.asyncio
async def test_default_workspace_is_allowed_without_its_parent(preview_scope, monkeypatch):
    from services import customization_workspace
    app, configured, outside = preview_scope
    workspace = outside.parent / 'runtime' / 'workspace'
    workspace.mkdir(parents=True)
    (workspace / 'ok.txt').write_text('workspace allowed')
    secret = workspace.parent / 'private.txt'
    secret.write_text('not shared')
    (workspace / 'escape.txt').symlink_to(secret)
    sibling = workspace.parent / 'workspace-other'
    sibling.mkdir()
    (sibling / 'file.txt').write_text('not shared')
    monkeypatch.setattr(customization_workspace, 'workspace_root', lambda: workspace)
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://local') as client:
        for endpoint in ('preview', 'file'):
            assert (await client.get('/api/fs/' + endpoint, params={'path': str(workspace / 'ok.txt')})).status_code == 200
            for path in (workspace / '../private.txt', workspace / 'escape.txt', sibling / 'file.txt'):
                assert (await client.get('/api/fs/' + endpoint, params={'path': str(path), 'absolute': 'true'})).status_code == 403
        browse = await client.get('/api/fs/browse', params={'path': str(workspace)})
        assert browse.status_code == 200
        assert browse.json()['parent'] is None
        assert 'escape.txt' not in {entry['name'] for entry in browse.json()['entries']}
        assert (await client.get('/api/fs/browse', params={'path': str(workspace.parent)})).status_code == 403
        # Adding the default workspace does not grant it to another project.
        assert (await client.get('/api/fs/preview', params={'project_id': 'p1', 'path': str(workspace / 'ok.txt')})).status_code == 403


@pytest.mark.asyncio
async def test_unset_directory_uses_container_root_for_browsing_and_files(preview_scope, monkeypatch):
    from services.config import config_store
    app, root, outside = preview_scope
    monkeypatch.setitem(config_store._cache, 'default_project_directory', '')
    monkeypatch.setenv('WORKSTEP_PROJECTS_ROOT', str(root))
    monkeypatch.setattr(Path, 'home', classmethod(lambda cls: outside.parent / 'home'))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://local') as client:
        response = await client.get('/api/fs/browse')
        assert response.status_code == 200, response.text
        assert response.json()['path'] == str(root)
        assert response.json()['parent'] is None
        assert (await client.get('/api/fs/preview', params={'path': str(root / 'ok.txt')})).status_code == 200
        for path in (outside, root / 'escape.txt'):
            assert (await client.get('/api/fs/preview', params={'path': str(path)})).status_code == 403
        monkeypatch.setitem(config_store._cache, 'default_project_directory', str(root / 'narrower'))
        assert (await client.get('/api/fs/preview', params={'path': str(root / 'ok.txt')})).status_code == 403
