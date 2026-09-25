"""Exercise Git management through HTTP against disposable real repositories."""
import asyncio
import shutil
import subprocess
import threading
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient, ReadTimeout

import api.git as git_api
from services.git import GitService
from services.git.command import GitError, run_git, explain_auth_error


def git(path, *args):
    return subprocess.check_output(['git', '-C', str(path), *args], stderr=subprocess.STDOUT).decode().strip()


def repository(path):
    path.mkdir(parents=True, exist_ok=True)
    git(path, 'init', '-b', 'main')
    git(path, 'config', 'user.name', 'Test User')
    git(path, 'config', 'user.email', 'test@example.invalid')
    (path / 'one.txt').write_text('original\n')
    (path / 'two.txt').write_text('second\n')
    git(path, 'add', '.')
    git(path, 'commit', '-m', 'initial')
    return path


@pytest.fixture
def layout(tmp_path):
    root = tmp_path / 'project'
    repo = repository(root / 'services' / 'payment')
    external = tmp_path / 'external'
    git(repo, 'worktree', 'add', '-b', 'feature', str(external))
    repository(root / 'a' / 'b' / 'c' / 'd' / 'fifth')
    repository(root / 'a' / 'b' / 'c' / 'd' / 'e' / 'sixth')
    return root, repo, external


@pytest.fixture
async def client(layout, monkeypatch):
    root, _, _ = layout
    service = GitService(lambda: [{'id': 'p', 'name': 'Project', 'path': str(root)}], lambda: 5,
                         credential_file=root / 'git-credentials.json')
    monkeypatch.setattr(git_api, 'git_service', service)
    app = FastAPI()
    app.include_router(git_api.router)
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as http:
        yield http, service
    await service.close()


async def scan(http):
    job = (await http.post('/api/git/scans')).json()
    for _ in range(300):
        result = (await http.get('/api/git/scans/' + job['id'])).json()
        if result['state'] != 'running':
            assert result['state'] == 'complete', result
            return (await http.get('/api/git/repositories')).json()
        await asyncio.sleep(.01)
    pytest.fail('scan never completed')


async def test_initialize_project_repository_creates_gitignore_and_rejects_repeat(client, layout):
    http, _ = client
    root, _, _ = layout
    response = await http.post('/api/git/projects/p/initialize')
    assert response.status_code == 200
    assert response.json()['path'] == str(root)
    assert git(root, 'branch', '--show-current') == 'main'
    assert '.workstep/' in (root / '.gitignore').read_text().splitlines()
    assert (await http.post('/api/git/projects/p/initialize')).status_code == 409
    assert (await http.post('/api/git/projects/unknown/initialize')).status_code == 404


async def test_scan_non_git_root_depth_boundary_and_external_worktree(client, layout):
    http, service = client
    root, repo, external = layout
    result = await scan(http)
    assert result['depth'] == 5
    assert len(result['repositories']) == 2
    payment = next(r for r in result['repositories'] if r['name'] == 'payment')
    assert payment['projects'] == [{'id': 'p', 'relative_path': 'services/payment'}]
    assert {w['path'] for w in payment['worktrees']} == {str(repo), str(external)}
    service.depth_provider = lambda: 1
    assert (await scan(http))['repositories'] == []
    service.depth_provider = lambda: 0
    assert (await scan(http))['repositories'] == []


async def payment_id(http):
    result = await scan(http)
    repo = next(r for r in result['repositories'] if r['name'] == 'payment')
    return next(w['id'] for w in repo['worktrees'] if w['main'])


async def test_task_workspace_selects_only_requested_repository(client, layout):
    http, service = client
    root, repo, _ = layout
    data = await scan(http)
    payment = next(item for item in data['repositories'] if item['name'] == 'payment')
    fifth = next(item for item in data['repositories'] if item['name'] == 'fifth')
    from services.git.task_workspace import TaskGitWorkspace

    workspace = TaskGitWorkspace(service)
    task_id = 'task-123'
    opened = await workspace.ensure(root, task_id)
    assert Path(opened['path']).is_dir()
    assert opened['worktrees'] == []

    created = await workspace.add(root, task_id, payment['id'], 'payment', 'main')
    created = await workspace.add(root, task_id, fifth['id'], 'fifth', 'main')
    assert next(tree for tree in created['worktrees'] if tree['alias'] == 'payment')['path'] == str(root / '.workstep' / 'worktrees' / task_id / 'payment')
    assert git(repo, 'branch', '--show-current') == 'main'
    assert all(git(tree['path'], 'branch', '--show-current').startswith('workstep/') for tree in created['worktrees'])
    assert [tree['alias'] for tree in created['worktrees']] == ['fifth', 'payment']
    assert len(created['worktrees']) == 2
    status = await http.get(f"/api/git/worktrees/{created['worktrees'][0]['id']}/status")
    assert status.status_code == 200, status.text
    assert (await workspace.ensure(root, task_id))['worktrees'] == created['worktrees']
    payment_tree = root / '.workstep' / 'worktrees' / task_id / 'payment'
    (payment_tree / 'one.txt').write_text('modified\n')
    with pytest.raises(Exception):
        await workspace.remove(root, task_id, 'payment')
    (payment_tree / 'one.txt').write_text('original\n')
    after_remove = await workspace.remove(root, task_id, 'payment')
    assert [tree['alias'] for tree in after_remove['worktrees']] == ['fifth']
    assert not payment_tree.exists()
    assert git(repo, 'show-ref', '--verify', 'refs/heads/workstep/task-123/payment')
    restored = await workspace.add(root, task_id, payment['id'], 'payment', 'main')
    assert {tree['alias'] for tree in restored['worktrees']} == {'fifth', 'payment'}


async def test_workflow_task_workspace_uses_artifact_task_directory(client, layout):
    http, service = client
    root, _repo, _ = layout
    data = await scan(http)
    payment = next(item for item in data['repositories'] if item['name'] == 'payment')
    from services.git.task_workspace import TaskGitWorkspace

    workspace = TaskGitWorkspace(service, workflow_id='wf-dev')
    created = await workspace.add(root, 'task-123', payment['id'], 'payment', 'main')
    assert created['worktrees'][0]['path'] == str(
        root / '.workstep' / 'artifacts' / 'wf-dev' / 'task-123' / '.worktrees' / 'payment'
    )


async def test_task_worktree_git_links_survive_project_relocation(client, layout, tmp_path):
    http, service = client
    root, _repo, _ = layout
    help_text = subprocess.run(['git', 'worktree', 'add', '-h'], capture_output=True, text=True)
    if 'relative-paths' not in help_text.stdout + help_text.stderr:
        pytest.skip('Git before 2.48 cannot create portable worktree links')
    data = await scan(http)
    payment = next(item for item in data['repositories'] if item['name'] == 'payment')
    from services.git.task_workspace import TaskGitWorkspace

    workspace = TaskGitWorkspace(service)
    created = await workspace.add(root, 'task-123', payment['id'], 'payment', 'main')
    tree = created['worktrees'][0]
    assert created['relative_path'] == '.workstep/worktrees/task-123'
    assert tree['relative_path'] == '.workstep/worktrees/task-123/payment'
    assert (Path(tree['path']) / '.git').read_text().startswith('gitdir: ../')
    relocated = tmp_path / 'relocated-project'
    shutil.copytree(root, relocated)
    relocated_tree = relocated / '.workstep' / 'worktrees' / 'task-123' / 'payment'
    assert git(relocated_tree, 'rev-parse', '--show-toplevel') == str(relocated_tree)
    assert git(relocated_tree, 'branch', '--show-current') == 'workstep/task-123/payment'


async def test_task_worktree_requires_git_with_relative_links(client, layout, monkeypatch):
    http, service = client
    root, _repo, _ = layout
    data = await scan(http)
    payment = next(item for item in data['repositories'] if item['name'] == 'payment')
    from services.git.task_workspace import TaskGitWorkspace

    workspace = TaskGitWorkspace(service)

    async def unsupported(_path):
        return False

    monkeypatch.setattr(workspace, '_relative_links_supported', unsupported)
    with pytest.raises(GitError, match='Git 2.48'):
        await workspace.add(root, 'task-123', payment['id'], 'payment', 'main')


async def test_open_task_workspace_repairs_existing_absolute_worktree_link(client, layout, monkeypatch):
    http, service = client
    root, repo, _ = layout
    help_text = subprocess.run(['git', 'worktree', 'repair', '-h'], capture_output=True, text=True)
    if 'relative-paths' not in help_text.stdout + help_text.stderr:
        pytest.skip('Git before 2.48 cannot repair portable worktree links')
    data = await scan(http)
    payment = next(item for item in data['repositories'] if item['name'] == 'payment')
    from services.git.task_workspace import TaskGitWorkspace

    workspace = TaskGitWorkspace(service)
    tree = (await workspace.add(root, 'task-123', payment['id'], 'payment', 'main'))['worktrees'][0]
    git(repo, 'worktree', 'repair', '--no-relative-paths', tree['path'])
    assert (Path(tree['path']) / '.git').read_text().startswith('gitdir: /')
    command = service.command

    async def slow_repair(path, *args, **kwargs):
        if args[:2] == ('worktree', 'repair'):
            await asyncio.sleep(.2)
        return await command(path, *args, **kwargs)

    monkeypatch.setattr(service, 'command', slow_repair)
    pending = asyncio.create_task(workspace.ensure(root, 'task-123'))
    await asyncio.sleep(.05)
    started = asyncio.get_running_loop().time()
    assert (await http.get('/api/git/repositories')).status_code == 200
    assert asyncio.get_running_loop().time() - started < .1
    reopened = await pending
    assert reopened['worktrees'][0]['id'] == tree['id']
    assert (Path(tree['path']) / '.git').read_text().startswith('gitdir: ../')


async def test_task_worktree_uses_selected_source_branch_and_custom_new_branch(client, layout):
    http, service = client
    root, repo, _ = layout
    git(repo, 'switch', '-c', 'release')
    (repo / 'one.txt').write_text('release version\n')
    git(repo, 'add', 'one.txt')
    git(repo, 'commit', '-m', 'release change')
    release_head = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'switch', 'main')
    data = await scan(http)
    payment = next(item for item in data['repositories'] if item['name'] == 'payment')
    from services.git.task_workspace import TaskGitWorkspace

    workspace = TaskGitWorkspace(service)
    created = await workspace.add(root, 'task-123', payment['id'], 'payment', 'release', 'taskfix/payment-fix')
    tree = created['worktrees'][0]
    assert tree['branch'] == 'taskfix/payment-fix'
    assert tree['head'] == release_head
    assert git(repo, 'branch', '--show-current') == 'main'
    assert git(tree['path'], 'show', 'HEAD:one.txt') == 'release version'
    with pytest.raises(Exception):
        await workspace.add(root, 'task-other', payment['id'], 'other', 'main', 'taskfix/payment-fix')


async def test_task_worktree_inherits_git_identity_without_writing_overrides(client, layout):
    http, service = client
    root, repo, _ = layout
    data = await scan(http)
    payment = next(item for item in data['repositories'] if item['name'] == 'payment')
    from services.git.task_workspace import TaskGitWorkspace

    created = await TaskGitWorkspace(service).add(root, 'task-123', payment['id'], 'payment', 'main', creator_name='任务创建人')
    tree = Path(created['worktrees'][0]['path'])
    assert subprocess.run(['git', '-C', str(tree), 'config', '--worktree', '--get', 'user.name'], capture_output=True).returncode == 1
    assert subprocess.run(['git', '-C', str(tree), 'config', '--worktree', '--get', 'user.email'], capture_output=True).returncode == 1
    assert git(tree, 'config', '--get', 'user.name') == 'Test User'
    assert git(tree, 'config', '--get', 'user.email') == 'test@example.invalid'
    assert git(repo, 'config', '--get', 'user.name') == 'Test User'
    assert git(repo, 'config', '--get', 'user.email') == 'test@example.invalid'
    (tree / 'one.txt').write_text('changed by task\n')
    status = (await http.get(f"/api/git/worktrees/{created['worktrees'][0]['id']}/status")).json()
    response = await http.post(f"/api/git/worktrees/{created['worktrees'][0]['id']}/commit", json={
        'paths': ['one.txt'], 'message': 'task change', 'snapshot': status['snapshot'],
    })
    assert response.status_code == 200, response.text
    assert git(tree, 'log', '-1', '--format=%an <%ae>') == 'Test User <test@example.invalid>'


async def test_task_workspace_can_select_nested_git_inside_git_project(tmp_path):
    from services.git.task_workspace import TaskGitWorkspace

    root = repository(tmp_path / 'project')
    (root / '.gitignore').write_text('.workstep/\n')
    nested = repository(root / 'B')
    service = GitService(lambda: [{'id': 'p', 'name': 'Project', 'path': str(root)}], lambda: 5)
    try:
        job = await service.start_scan()
        for _ in range(300):
            if job['state'] != 'running':
                break
            await asyncio.sleep(.01)
        assert job['state'] == 'complete'
        repos = service.snapshot['repositories']
        assert {member['relative_path'] for repo in repos for member in repo['projects']} == {'.', 'B'}
        nested_repo = next(repo for repo in repos if repo['common_dir'] == str(nested / '.git'))
        created = await TaskGitWorkspace(service).add(root, 'task-123', nested_repo['id'], 'B', 'main')
        assert [tree['alias'] for tree in created['worktrees']] == ['B']
        assert git(created['worktrees'][0]['path'], 'branch', '--show-current') == 'workstep/task-123/B'
        assert git(root, 'branch', '--show-current') == 'main'
        assert git(nested, 'branch', '--show-current') == 'main'
    finally:
        await service.close()


async def test_delete_task_workspace_preflights_all_worktrees_and_preserves_branches(client, layout):
    http, service = client
    root, payment, _ = layout
    data = await scan(http)
    repos = {repo['name']: repo for repo in data['repositories']}
    from services.git.task_workspace import TaskGitWorkspace

    workspace = TaskGitWorkspace(service)
    await workspace.add(root, 'task-123', repos['payment']['id'], 'payment', 'main')
    await workspace.add(root, 'task-123', repos['fifth']['id'], 'fifth', 'main')
    folder = root / '.workstep' / 'worktrees' / 'task-123'
    (folder / 'fifth' / 'one.txt').write_text('dirty\n')
    with pytest.raises(Exception):
        await workspace.delete(root, 'task-123')
    assert (folder / 'payment').is_dir()
    deleted_dirty = await workspace.delete(root, 'task-123', force=True)
    assert deleted_dirty['worktrees'] == []
    assert not folder.exists()
    assert git(payment, 'show-ref', '--verify', 'refs/heads/workstep/task-123/payment')
    await workspace.add(root, 'task-123', repos['payment']['id'], 'payment', 'main')
    await workspace.add(root, 'task-123', repos['fifth']['id'], 'fifth', 'main')
    (folder / 'fifth' / 'one.txt').write_text('original\n')
    (folder / 'notes.txt').write_text('keep me')
    with pytest.raises(Exception):
        await workspace.delete(root, 'task-123')
    with pytest.raises(Exception):
        await workspace.delete(root, 'task-123', force=True)
    assert (folder / 'payment').is_dir()
    (folder / 'notes.txt').unlink()
    deleted = await workspace.delete(root, 'task-123')
    assert deleted['worktrees'] == []
    assert not folder.exists()
    assert git(payment, 'show-ref', '--verify', 'refs/heads/workstep/task-123/payment')


async def test_delete_task_workspace_slow_disk_does_not_block_event_loop(client, layout, monkeypatch):
    _, service = client
    root, _, _ = layout
    from services.git.task_workspace import TaskGitWorkspace

    workspace = TaskGitWorkspace(service)
    await workspace.ensure(root, 'task-123')
    original_root = TaskGitWorkspace.root

    def slow_root(project_path, task_id):
        time.sleep(.2)
        return original_root(project_path, task_id)

    monkeypatch.setattr(TaskGitWorkspace, 'root', staticmethod(slow_root))
    pending = asyncio.create_task(workspace.delete(root, 'task-123'))
    start = asyncio.get_running_loop().time()
    await asyncio.sleep(.02)
    assert asyncio.get_running_loop().time() - start < .12
    await pending


async def test_task_workspace_rejects_unrelated_or_unsafe_repository(client, layout):
    http, service = client
    root, _, _ = layout
    await scan(http)
    from services.git.task_workspace import TaskGitWorkspace

    workspace = TaskGitWorkspace(service)
    with pytest.raises(Exception):
        await workspace.add(root, 'task-123', 'unknown', 'unknown', 'main')
    selected = service.snapshot['repositories'][0]
    with pytest.raises(Exception):
        await workspace.add(root, 'task-123', selected['id'], '../outside', 'main')
    assert not (root / '.workstep' / 'worktrees' / 'outside').exists()


async def test_task_workspace_api_keeps_execution_directory(layout, monkeypatch):
    from models import Task
    from models.fields import utc_now
    from services.project import ProjectManager
    import services.project as project_module

    root, repo, _ = layout
    manager = ProjectManager()
    project = manager.init_project(root)
    monkeypatch.setattr(project_module, 'project_manager', manager)
    now = utc_now()
    await manager.run_db(project.id, lambda _: Task.create(
        id='task-123', title='Change payment', cwd=str(root), status='ready',
        creator_name='任务创建人',
        created_at=now, updated_at=now,
    ))
    service = GitService(lambda: [{'id': project.id, 'name': project.name, 'path': str(root)}], lambda: 5)
    monkeypatch.setattr(git_api, 'git_service', service)
    app = FastAPI()
    app.include_router(git_api.router)
    @app.get('/health')
    async def health():
        return {'ok': True}
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as http:
            await scan(http)
            original_get = Task.get_or_none
            entered = threading.Event()

            def slow_task_read(*args, **kwargs):
                entered.set()
                time.sleep(.3)
                return original_get(*args, **kwargs)

            monkeypatch.setattr(Task, 'get_or_none', slow_task_read)
            pending = asyncio.create_task(http.post(f'/api/git/projects/{project.id}/tasks/task-123/workspace'))
            assert await asyncio.to_thread(entered.wait, 1)
            health_response = await asyncio.wait_for(http.get('/health'), .15)
            assert health_response.json() == {'ok': True}
            opened = await pending
            monkeypatch.setattr(Task, 'get_or_none', original_get)
            assert opened.status_code == 200, opened.text
            assert opened.json()['worktrees'] == []
            listing = await http.get(f'/api/git/projects/{project.id}/repositories')
            repository_id = next(repo['id'] for repo in listing.json()['repositories'] if repo['name'] == 'payment')
            await manager.run_db(project.id, lambda _: Task.update(status='running').where(Task.id == 'task-123').execute())
            created = await http.post(f'/api/git/projects/{project.id}/tasks/task-123/worktrees', json={
                'repository_id': repository_id, 'alias': 'payment', 'base_ref': 'main',
                'branch_name': 'taskfix/payment',
            })
            assert created.status_code == 200, created.text
            assert created.json()['worktrees'][0]['branch'] == 'taskfix/payment'
            tree_path = created.json()['worktrees'][0]['path']
            assert git(tree_path, 'config', '--get', 'user.name') == 'Test User'
            assert git(tree_path, 'config', '--get', 'user.email') == 'test@example.invalid'
            assert git(repo, 'config', '--get', 'user.name') == 'Test User'
            assert subprocess.run(['git', '-C', tree_path, 'config', '--worktree', '--get', 'user.name'], capture_output=True).returncode == 1
            assert subprocess.run(['git', '-C', tree_path, 'config', '--worktree', '--get', 'user.email'], capture_output=True).returncode == 1
            reopened = await http.post(f'/api/git/projects/{project.id}/tasks/task-123/workspace')
            assert reopened.status_code == 200, reopened.text
            assert subprocess.run(['git', '-C', tree_path, 'config', '--worktree', '--get', 'user.name'], capture_output=True).returncode == 1
            assert subprocess.run(['git', '-C', tree_path, 'config', '--worktree', '--get', 'user.email'], capture_output=True).returncode == 1
            git(tree_path, 'config', '--worktree', 'user.name', '手动设置')
            git(tree_path, 'config', '--worktree', 'user.email', 'manual@example.invalid')
            reopened = await http.post(f'/api/git/projects/{project.id}/tasks/task-123/workspace')
            assert reopened.status_code == 200, reopened.text
            assert git(tree_path, 'config', '--worktree', '--get', 'user.name') == '手动设置'
            assert git(tree_path, 'config', '--worktree', '--get', 'user.email') == 'manual@example.invalid'
            task_cwd = await manager.run_db(project.id, lambda _: Task.get_by_id('task-123').cwd)
            assert task_cwd == str(root)
            blocked = await http.delete(f'/api/git/projects/{project.id}/tasks/task-123/workspace')
            assert blocked.status_code == 409
            assert Path(created.json()['path']).is_dir()
            await manager.run_db(project.id, lambda _: Task.update(status='ready').where(Task.id == 'task-123').execute())
            removed = await http.delete(f'/api/git/projects/{project.id}/tasks/task-123/worktrees/payment')
            assert removed.status_code == 200, removed.text
            assert await manager.run_db(project.id, lambda _: Task.get_by_id('task-123').cwd) == str(root)
            deleted = await http.delete(f'/api/git/projects/{project.id}/tasks/task-123/workspace')
            assert deleted.status_code == 200, deleted.text
            assert not Path(created.json()['path']).exists()
    finally:
        await service.close()
        manager.close_all()


async def test_status_diff_history_and_blame_read_real_content(client, layout):
    http, _ = client
    _, repo, _ = layout
    (repo / 'one.txt').write_text('updated\n')
    (repo / '新 文件.txt').write_text('new file\n')
    id = await payment_id(http)
    status = (await http.get(f'/api/git/worktrees/{id}/status')).json()
    assert status['branch'] == 'main'
    assert {f['path'] for f in status['files']} == {'one.txt', '新 文件.txt'}
    assert next(f for f in status['files'] if f['path'] == '新 文件.txt')['untracked'] is True
    diff = (await http.get(f'/api/git/worktrees/{id}/diff', params={'path': 'one.txt'})).json()
    assert '-original' in diff['patch'] and '+updated' in diff['patch']
    assert diff['before'] == 'original\n' and diff['after'] == 'updated\n'
    blame = (await http.get(f'/api/git/worktrees/{id}/blame', params={'path': 'one.txt'})).json()
    assert blame['lines'][0]['author'] == 'Test User'
    history = (await http.get(f'/api/git/worktrees/{id}/history')).json()
    assert history['commits'][0]['message'] == 'initial'
    assert (await http.get(f'/api/git/worktrees/{id}/diff', params={'path': '../outside'})).status_code == 400
    assert (await http.get('/api/git/worktrees/unknown/status')).status_code == 404


async def test_commit_selected_unstaged_file_preserves_unselected_index_and_rejects_stale_review(client, layout):
    http, _ = client
    _, repo, _ = layout
    (repo / 'one.txt').write_text('selected change\n')
    (repo / 'two.txt').write_text('already staged\n')
    git(repo, 'add', 'two.txt')
    id = await payment_id(http)
    status = (await http.get(f'/api/git/worktrees/{id}/status')).json()
    (repo / 'one.txt').write_text('changed after review\n')
    body = {'paths': ['one.txt'], 'message': 'selected only', 'snapshot': status['snapshot']}
    response = await http.post(f'/api/git/worktrees/{id}/commit', json=body)
    assert response.status_code == 409
    assert git(repo, 'log', '-1', '--format=%s') == 'initial'
    body['snapshot'] = (await http.get(f'/api/git/worktrees/{id}/status')).json()['snapshot']
    response = await http.post(f'/api/git/worktrees/{id}/commit', json=body)
    assert response.status_code == 200, response.text
    assert git(repo, 'show', 'HEAD:one.txt') == 'changed after review'
    assert git(repo, 'show', 'HEAD:two.txt') == 'second'
    assert git(repo, 'show', ':two.txt') == 'already staged'
    assert git(repo, 'diff', '--cached', '--name-only') == 'two.txt'


async def test_discard_and_ignore_single_files_with_review_tokens(client, layout):
    http, _ = client
    _, repo, _ = layout
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'

    (repo / 'one.txt').write_text('discard me\n')
    state = (await http.get(url + '/status')).json()
    response = await http.post(url + '/discard', json={'path': 'one.txt', 'snapshot': state['snapshot']})
    assert response.status_code == 200, response.text
    assert (repo / 'one.txt').read_text() == 'original\n'

    staged = repo / 'staged [new].txt'
    staged.write_text('new\n')
    git(repo, 'add', staged.name)
    state = (await http.get(url + '/status')).json()
    response = await http.post(url + '/discard', json={'path': staged.name, 'snapshot': state['snapshot']})
    assert response.status_code == 200, response.text
    assert not staged.exists()
    assert not git(repo, 'diff', '--cached', '--name-only')

    ignored = repo / 'ignore [literal]*.txt'
    ignored.write_text('ignored\n')
    state = (await http.get(url + '/status')).json()
    response = await http.post(url + '/ignore', json={'path': ignored.name, 'snapshot': state['snapshot']})
    assert response.status_code == 200, response.text
    assert ignored.name not in {item['path'] for item in response.json()['files']}
    assert '/ignore \\[literal]\\*.txt' in (repo / '.gitignore').read_text()


async def test_save_file_content_uses_reviewed_snapshot_and_preserves_mode(client, layout):
    http, _ = client
    _, repo, _ = layout
    target = repo / 'one.txt'
    target.chmod(0o755)
    target.write_text('editable\n')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    target.write_text('external change\n')
    response = await http.post(url + '/files/content', json={'path': 'one.txt', 'content': 'must not win\n', 'snapshot': state['snapshot']})
    assert response.status_code == 409
    assert target.read_text() == 'external change\n'
    state = (await http.get(url + '/status')).json()
    response = await http.post(url + '/files/content', json={'path': 'one.txt', 'content': 'saved from editor\n', 'snapshot': state['snapshot']})
    assert response.status_code == 200, response.text
    assert target.read_text() == 'saved from editor\n'
    assert target.stat().st_mode & 0o777 == 0o755


async def test_save_file_can_undo_an_applied_block_after_file_becomes_clean(client, layout, monkeypatch):
    import services.git.write as git_write
    http, _ = client
    _, repo, _ = layout
    target = repo / 'one.txt'
    target.write_text('changed\n')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    applied = await http.post(url + '/files/content', json={
        'path': 'one.txt', 'content': 'original\n', 'snapshot': state['snapshot'],
    })
    assert applied.status_code == 200, applied.text
    assert not applied.json()['files']

    entered = threading.Event()
    release = threading.Event()
    original_read = git_write.read_file
    def slow_read(*args):
        entered.set()
        release.wait(1)
        return original_read(*args)
    monkeypatch.setattr(git_write, 'read_file', slow_read)
    pending = asyncio.create_task(http.post(url + '/files/content', json={
        'path': 'one.txt', 'content': 'changed\n', 'snapshot': applied.json()['snapshot'],
        'expected_content': 'original\n',
    }))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        assert (await asyncio.wait_for(http.get('/api/git/repositories'), .15)).status_code == 200
    finally:
        release.set()
    restored = await pending
    assert restored.status_code == 200, restored.text
    assert target.read_text() == 'changed\n'

    stale = await http.post(url + '/files/content', json={
        'path': 'one.txt', 'content': 'wrong\n', 'snapshot': applied.json()['snapshot'],
        'expected_content': 'original\n',
    })
    assert stale.status_code == 409
    assert target.read_text() == 'changed\n'


async def test_generate_commit_message_uses_prompt_enhance_provider_and_selected_diff(client, layout, monkeypatch):
    from services.config import config_store

    http, _ = client
    _, repo, _ = layout
    (repo / 'one.txt').write_text('fixed behavior\n')
    (repo / 'new.txt').write_text('new behavior\n')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    calls = []

    monkeypatch.setattr(config_store, 'get_prompt_enhance_config', lambda: {
        'provider_id': 'enhance-provider',
        'model': 'fast-model',
        'protocol': 'openai_chat_completions',
    })
    monkeypatch.setattr(config_store, 'get_provider', lambda value: {'id': value, 'base_url': 'http://provider.invalid/v1', 'protocols': ['openai_chat_completions']})

    async def fake_completion(provider, model, messages, **kwargs):
        calls.append((provider, model, messages, kwargs))
        return 'fix(git): 修正行为并补充新文件\n\n- 更新已选文件内容'

    monkeypatch.setattr('services.providers.text_completion', fake_completion)
    response = await http.post(url + '/commit-message', json={'paths': ['one.txt', 'new.txt'], 'snapshot': state['snapshot']})
    assert response.status_code == 200, response.text
    assert response.json()['message'].startswith('fix(git):')
    assert calls[0][1] == 'fast-model'
    assert 'fixed behavior' in calls[0][2][1]['content']
    assert 'new behavior' in calls[0][2][1]['content']
    assert 'two.txt' not in calls[0][2][1]['content']
    assert calls[0][3]['thinking'] == 'disabled'
    assert calls[0][3]['protocol'] == 'openai_chat_completions'
    assert calls[0][3]['timeout'] == 180

    async def timeout_completion(*args, **kwargs):
        raise ReadTimeout('')

    monkeypatch.setattr('services.providers.text_completion', timeout_completion)
    response = await http.post(url + '/commit-message', json={'paths': ['one.txt'], 'snapshot': state['snapshot']})
    assert response.status_code == 504
    assert '180 秒' in response.json()['detail']


async def test_switch_checks_dirty_active_and_worktree_occupation(client, layout):
    http, service = client
    _, repo, _ = layout
    git(repo, 'branch', 'other')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    body = {'branch': 'feature', 'snapshot': state['snapshot']}
    assert (await http.post(url + '/switch', json=body)).status_code == 409
    body['branch'] = 'other'
    service.active_provider = lambda _: True
    assert (await http.post(url + '/switch', json=body)).status_code == 409
    service.active_provider = lambda _: False
    body['snapshot'] = (await http.get(url + '/status')).json()['snapshot']
    response = await http.post(url + '/switch', json=body)
    assert response.status_code == 200, response.text
    assert response.json()['branch'] == 'other'
    assert git(repo, 'branch', '--show-current') == 'other'


async def test_create_branch_from_selected_local_or_remote_ref_without_switching(client, layout, tmp_path):
    http, _ = client
    _, repo, external = layout
    (external / 'feature.txt').write_text('feature\n')
    git(external, 'add', '.'); git(external, 'commit', '-m', 'feature change')
    remote = tmp_path / 'branch-origin.git'
    git(tmp_path, 'init', '--bare', str(remote))
    git(repo, 'remote', 'add', 'origin', str(remote))
    git(repo, 'push', 'origin', 'feature:remote-base')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    feature_head = git(repo, 'rev-parse', 'feature')
    created = await http.post(url + '/branches', json={
        'name': 'topic/local', 'base_branch': 'feature', 'base_head': feature_head, 'snapshot': state['snapshot'],
    })
    assert created.status_code == 200, created.text
    assert git(repo, 'rev-parse', 'topic/local') == feature_head
    assert git(repo, 'branch', '--show-current') == 'main'
    assert (await http.post(url + '/branches', json={
        'name': 'topic/local', 'base_branch': 'feature', 'base_head': feature_head, 'snapshot': state['snapshot'],
    })).status_code == 409

    await http.post(url + '/fetch')
    remote_head = git(repo, 'rev-parse', 'refs/remotes/origin/remote-base')
    created = await http.post(url + '/branches', json={
        'name': 'topic/remote', 'base_branch': 'remote-base', 'base_remote': 'origin',
        'base_head': remote_head, 'snapshot': state['snapshot'],
    })
    assert created.status_code == 200, created.text
    assert git(repo, 'rev-parse', 'topic/remote') == remote_head
    assert (await http.post(url + '/branches', json={
        'name': 'topic/stale', 'base_branch': 'feature', 'base_head': git(repo, 'rev-parse', 'main'),
        'snapshot': state['snapshot'],
    })).status_code == 409
    assert (await http.post(url + '/branches', json={
        'name': 'bad name', 'base_branch': 'feature', 'base_head': feature_head,
        'snapshot': state['snapshot'],
    })).status_code == 400


async def test_slow_branch_creation_keeps_api_responsive(client, layout, monkeypatch):
    http, service = client
    _, repo, _ = layout
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    command = service.command

    async def slow_branch(path, *args, **kwargs):
        if args and args[0] == 'branch' and '--no-track' in args:
            await asyncio.sleep(.2)
        return await command(path, *args, **kwargs)

    monkeypatch.setattr(service, 'command', slow_branch)
    pending = asyncio.create_task(http.post(url + '/branches', json={
        'name': 'topic/slow', 'base_branch': 'main', 'base_head': state['head'], 'snapshot': state['snapshot'],
    }))
    await asyncio.sleep(.05)
    started = asyncio.get_running_loop().time()
    assert (await http.get('/api/git/repositories')).status_code == 200
    assert asyncio.get_running_loop().time() - started < .05
    assert (await pending).status_code == 200
    assert git(repo, 'branch', '--show-current') == 'main'


async def test_delete_local_branch_requires_merged_tip_and_unoccupied_worktree(client, layout):
    http, _ = client
    _, repo, _ = layout
    git(repo, 'branch', 'merged')
    git(repo, 'switch', '-c', 'unmerged')
    (repo / 'unique.txt').write_text('keep commit\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'unique change')
    unmerged_head = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'switch', 'main')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    merged_head = git(repo, 'rev-parse', 'merged')
    response = await http.post(url + '/branches/delete', json={
        'branch': 'merged', 'head': merged_head, 'snapshot': state['snapshot'],
    })
    assert response.status_code == 200, response.text
    assert 'merged' not in {branch['name'] for branch in response.json()['branches']}
    assert (await http.post(url + '/branches/delete', json={
        'branch': 'unmerged', 'head': unmerged_head, 'snapshot': state['snapshot'],
    })).status_code == 409
    assert git(repo, 'rev-parse', 'unmerged') == unmerged_head
    assert (await http.post(url + '/branches/delete', json={
        'branch': 'main', 'head': state['head'], 'snapshot': state['snapshot'],
    })).status_code == 409
    assert (await http.post(url + '/branches/delete', json={
        'branch': 'feature', 'head': git(repo, 'rev-parse', 'feature'), 'snapshot': state['snapshot'],
    })).status_code == 409
    assert (await http.post(url + '/branches/delete', json={
        'branch': 'unmerged', 'head': state['head'], 'snapshot': state['snapshot'],
    })).status_code == 409


async def test_delete_local_branch_allowed_after_pushing_its_upstream(client, layout, tmp_path):
    http, _ = client
    _, repo, _ = layout
    git(repo, 'switch', '-c', 'pushed-only')
    (repo / 'pushed.txt').write_text('pushed\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'pushed change')
    head = git(repo, 'rev-parse', 'HEAD')
    remote = tmp_path / 'delete-origin.git'
    git(tmp_path, 'init', '--bare', str(remote))
    git(repo, 'remote', 'add', 'origin', str(remote))
    git(repo, 'push', '-u', 'origin', 'pushed-only')
    git(repo, 'switch', 'main')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    response = await http.post(url + '/branches/delete', json={
        'branch': 'pushed-only', 'head': head, 'snapshot': state['snapshot'],
    })
    assert response.status_code == 200, response.text
    assert git(remote, 'rev-parse', 'refs/heads/pushed-only') == head


async def test_slow_branch_deletion_keeps_api_responsive(client, layout, monkeypatch):
    http, service = client
    _, repo, _ = layout
    git(repo, 'branch', 'obsolete')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    command = service.command

    async def slow_delete(path, *args, **kwargs):
        if args[:2] == ('update-ref', '-d'):
            await asyncio.sleep(.2)
        return await command(path, *args, **kwargs)

    monkeypatch.setattr(service, 'command', slow_delete)
    pending = asyncio.create_task(http.post(url + '/branches/delete', json={
        'branch': 'obsolete', 'head': git(repo, 'rev-parse', 'obsolete'), 'snapshot': state['snapshot'],
    }))
    await asyncio.sleep(.05)
    started = asyncio.get_running_loop().time()
    assert (await http.get('/api/git/repositories')).status_code == 200
    assert asyncio.get_running_loop().time() - started < .05
    assert (await pending).status_code == 200


async def test_switch_allows_git_to_carry_safe_uncommitted_changes(client, layout):
    http, _ = client
    _, repo, _ = layout
    git(repo, 'branch', 'other')
    (repo / 'one.txt').write_text('carry this change\n')
    (repo / 'untracked').write_text('keep me\n')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    response = await http.post(url + '/switch', json={
        'branch': 'other', 'snapshot': state['snapshot'],
    })
    assert response.status_code == 200, response.text
    assert response.json()['branch'] == 'other'
    assert (repo / 'one.txt').read_text() == 'carry this change\n'
    assert (repo / 'untracked').read_text() == 'keep me\n'


async def test_switch_keeps_original_branch_when_dirty_change_would_be_overwritten(client, layout):
    http, _ = client
    _, repo, _ = layout
    git(repo, 'switch', '-c', 'other')
    (repo / 'one.txt').write_text('other branch version\n')
    git(repo, 'add', 'one.txt')
    git(repo, 'commit', '-m', 'change on other')
    git(repo, 'switch', 'main')
    (repo / 'one.txt').write_text('unsaved local version\n')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    response = await http.post(url + '/switch', json={
        'branch': 'other', 'snapshot': state['snapshot'],
    })
    assert response.status_code == 400
    assert git(repo, 'branch', '--show-current') == 'main'
    assert (repo / 'one.txt').read_text() == 'unsaved local version\n'


async def test_fetch_lists_remote_branches_and_switch_creates_local_tracking_branch(client, layout, tmp_path):
    http, _ = client
    _, repo, _ = layout
    remote = tmp_path / 'switch-origin.git'
    git(tmp_path, 'init', '--bare', str(remote))
    git(repo, 'remote', 'add', 'origin', str(remote))
    git(repo, 'push', 'origin', 'main:remote-only')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'

    fetched = await http.post(url + '/fetch')
    assert fetched.status_code == 200, fetched.text
    assert {'name': 'origin/remote-only', 'remote': 'origin', 'branch': 'remote-only',
        'head': git(repo, 'rev-parse', 'refs/remotes/origin/remote-only')} in fetched.json()['remote_branches']

    state = (await http.get(url + '/status')).json()
    response = await http.post(url + '/switch', json={
        'branch': 'remote-only', 'remote': 'origin', 'snapshot': state['snapshot'],
    })
    assert response.status_code == 200, response.text
    assert response.json()['branch'] == 'remote-only'
    assert git(repo, 'rev-parse', '--abbrev-ref', '@{upstream}') == 'origin/remote-only'


async def test_commit_handles_literal_new_paths_deletion_and_hook_failure(client, layout):
    http, _ = client
    _, repo, _ = layout
    name = 'new [file] 中文.txt'
    (repo / name).write_text('new\n')
    (repo / 'one.txt').unlink()
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    hook = repo / '.git/hooks/pre-commit'
    hook.write_text('#!/bin/sh\necho rejected >&2\nexit 1\n')
    hook.chmod(0o755)
    body = {'paths': [name, 'one.txt'], 'message': 'literal paths', 'snapshot': (await http.get(url + '/status')).json()['snapshot']}
    response = await http.post(url + '/commit', json=body)
    assert response.status_code == 400
    assert 'rejected' in response.text
    assert git(repo, 'log', '-1', '--format=%s') == 'initial'
    assert (repo / name).read_text() == 'new\n'
    hook.unlink()
    body['snapshot'] = (await http.get(url + '/status')).json()['snapshot']
    response = await http.post(url + '/commit', json=body)
    assert response.status_code == 200, response.text
    assert git(repo, 'ls-tree', '--name-only', 'HEAD').splitlines() == [name, 'two.txt'] or name in git(repo, '-c', 'core.quotePath=false', 'ls-tree', '--name-only', 'HEAD')


async def test_commit_without_author_identity_explains_repository_config(client, layout, monkeypatch):
    from services.git.command import GitError

    http, service = client
    _, repo, _ = layout
    command = service.command

    async def missing_identity(path, *args, **kwargs):
        if args and args[0] == 'commit':
            raise GitError('Author identity unknown\n\n*** Please tell me who you are.\n\nfatal: unable to auto-detect email address')
        return await command(path, *args, **kwargs)

    monkeypatch.setattr(service, 'command', missing_identity)
    (repo / 'one.txt').write_text('changed\n')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    snapshot = (await http.get(url + '/status')).json()['snapshot']
    response = await http.post(url + '/commit', json={'paths': ['one.txt'], 'message': 'change', 'snapshot': snapshot})
    assert response.status_code == 400
    detail = response.json()['detail']
    assert 'Git 未配置提交作者' in detail
    assert 'git config user.name' in detail
    assert 'git config user.email' in detail
    assert 'git config --global' not in detail
    assert git(repo, 'log', '-1', '--format=%s') == 'initial'


async def test_slow_disk_does_not_block_health_requests(client, monkeypatch):
    import time
    import services.git as module
    http, _ = client
    original = module.directory_entries
    def slow(path):
        time.sleep(.08)
        return original(path)
    monkeypatch.setattr(module, 'directory_entries', slow)
    job = (await http.post('/api/git/scans')).json()
    await asyncio.sleep(.02)
    started = asyncio.get_running_loop().time()
    response = await http.get('/api/git/repositories')
    assert response.status_code == 200
    assert asyncio.get_running_loop().time() - started < .05
    assert (await http.get('/api/git/scans/' + job['id'])).json()['state'] == 'running'


async def test_initial_commit_partial_staging_and_rename(client, layout, tmp_path):
    http, service = client
    _, repo, _ = layout
    (repo / 'one.txt').write_text('staged version\n')
    git(repo, 'add', 'one.txt')
    (repo / 'one.txt').write_text('complete current version\n')
    git(repo, 'mv', 'two.txt', 'renamed.txt')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    response = await http.post(url + '/commit', json={'paths': ['one.txt', 'renamed.txt'], 'message': 'complete file and rename', 'snapshot': state['snapshot']})
    assert response.status_code == 200, response.text
    assert git(repo, 'show', 'HEAD:one.txt') == 'complete current version'
    assert git(repo, 'ls-tree', '--name-only', 'HEAD').splitlines() == ['one.txt', 'renamed.txt']
    initial = tmp_path / 'unborn'
    initial.mkdir()
    git(initial, 'init', '-b', 'main')
    git(initial, 'config', 'user.name', 'Test')
    git(initial, 'config', 'user.email', 'test@example.invalid')
    (initial / 'first.txt').write_text('first\n')
    service.projects_provider = lambda: [{'id': 'new', 'name': 'new', 'path': str(initial)}]
    data = await scan(http)
    id = data['repositories'][0]['worktrees'][0]['id']
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    response = await http.post(url + '/commit', json={'paths': ['first.txt'], 'message': 'first commit', 'snapshot': state['snapshot']})
    assert response.status_code == 200, response.text
    assert git(initial, 'show', 'HEAD:first.txt') == 'first'


async def test_symlink_discovery_and_removed_project_authorization(client, layout):
    http, service = client
    root, repo, external = layout
    (root / 'loop').symlink_to(root, target_is_directory=True)
    (root / 'external-link').symlink_to(external, target_is_directory=True)
    id = await payment_id(http)
    service.projects_provider = lambda: []
    assert (await http.get(f'/api/git/worktrees/{id}/status')).status_code == 404


async def test_review_token_binds_branch_even_when_commit_is_identical(client, layout):
    http, _ = client
    _, repo, _ = layout
    (repo / 'one.txt').write_text('change\n')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    before = (await http.get(url + '/status')).json()
    git(repo, 'switch', '-c', 'same-head')
    response = await http.post(url + '/commit', json={'paths': ['one.txt'], 'message': 'must not land on other branch', 'snapshot': before['snapshot']})
    assert response.status_code == 409
    assert git(repo, 'log', '-1', '--format=%s') == 'initial'


async def test_slow_file_hash_and_git_hook_keep_api_responsive(client, layout, monkeypatch):
    import time
    import services.git.query as queries
    http, _ = client
    _, repo, _ = layout
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    (repo / 'one.txt').write_text('slow disk\n')
    original = queries.file_digest
    def slow(*args):
        time.sleep(.12)
        return original(*args)
    monkeypatch.setattr(queries, 'file_digest', slow)
    pending = asyncio.create_task(http.get(url + '/status'))
    await asyncio.sleep(.05)
    started = asyncio.get_running_loop().time()
    assert (await http.get('/api/git/repositories')).status_code == 200
    assert asyncio.get_running_loop().time() - started < .05
    state = (await pending).json()
    hook = repo / '.git/hooks/pre-commit'
    hook.write_text('#!/bin/sh\nsleep 0.4\nexit 1\n')
    hook.chmod(0o755)
    pending = asyncio.create_task(http.post(url + '/commit', json={'paths': ['one.txt'], 'message': 'slow hook', 'snapshot': state['snapshot']}))
    await asyncio.sleep(.25)
    started = asyncio.get_running_loop().time()
    assert (await http.get('/api/git/repositories')).status_code == 200
    assert asyncio.get_running_loop().time() - started < .05
    assert (await pending).status_code == 400


async def test_invalid_git_marker_does_not_hide_nested_repository(client, layout):
    http, _ = client
    root, _, _ = layout
    (root / '.git').write_text('invalid git marker\n')
    data = await scan(http)
    assert any(r['name'] == 'payment' for r in data['repositories'])
    assert data['errors']


async def test_history_root_commit_binary_and_large_previews(client, layout):
    http, _ = client
    _, repo, _ = layout
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    head = git(repo, 'rev-parse', 'HEAD')
    changes = (await http.get(url + '/changes', params={'commit': head})).json()
    assert {f['path'] for f in changes['files']} == {'one.txt', 'two.txt'}
    diff = (await http.get(url + '/diff', params={'commit': head, 'path': 'one.txt'})).json()
    assert diff['before'] == '' and diff['after'] == 'original\n'
    (repo / 'binary.dat').write_bytes(b'\0binary')
    (repo / 'large.txt').write_bytes(b'x' * (2 * 1024 * 1024 + 1))
    binary = (await http.get(url + '/diff', params={'path': 'binary.dat'})).json()
    large = (await http.get(url + '/diff', params={'path': 'large.txt'})).json()
    assert binary['binary'] and not binary['patch']
    assert large['truncated'] and not large['patch']


async def test_git_routes_are_not_exposed_over_remote_project_channel():
    from services.remote_project import _build_route_catalog
    app = FastAPI()
    app.include_router(git_api.router)
    assert not _build_route_catalog(app)


async def test_branch_sync_fetch_and_fast_forward_pull(client, layout, tmp_path):
    http, _ = client
    _, repo, _ = layout
    remote = tmp_path / 'remote.git'
    git(tmp_path, 'init', '--bare', str(remote))
    git(repo, 'remote', 'add', 'origin', str(remote))
    git(repo, 'push', '-u', 'origin', 'main')
    peer = repository(tmp_path / 'peer')
    git(peer, 'remote', 'add', 'origin', str(remote))
    git(peer, 'fetch', 'origin')
    git(peer, 'reset', '--hard', 'origin/main')
    (peer / 'remote.txt').write_text('remote change')
    git(peer, 'add', '.')
    git(peer, 'commit', '-m', 'remote update')
    git(peer, 'push', 'origin', 'HEAD:main')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    before = (await http.get(url + '/branches')).json()
    branch = next(b for b in before['branches'] if b['name'] == 'main')
    assert branch['upstream'] == 'origin/main'
    assert branch['ahead'] == branch['behind'] == 0
    response = await http.post(url + '/fetch')
    assert response.status_code == 200, response.text
    branch = next(b for b in response.json()['branches'] if b['name'] == 'main')
    assert branch['behind'] == 1 and branch['ahead'] == 0
    assert response.json()['fetched_at']
    assert not (repo / 'remote.txt').exists()
    state = (await http.get(url + '/status')).json()
    response = await http.post(url + '/pull', json={'branch': 'main', 'snapshot': state['snapshot']})
    assert response.status_code == 200, response.text
    assert (repo / 'remote.txt').read_text() == 'remote change'
    assert response.json()['behind'] == 0


async def test_merge_local_and_remote_branch_into_current_and_preserve_conflicts(client, layout, tmp_path):
    http, _ = client
    _, repo, external = layout
    (external / 'feature.txt').write_text('feature\n')
    git(external, 'add', '.'); git(external, 'commit', '-m', 'feature change')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    response = await http.post(url + '/merge', json={'branch': 'main', 'snapshot': state['snapshot'], 'source': 'feature'})
    assert response.status_code == 200, response.text
    assert (repo / 'feature.txt').read_text() == 'feature\n'

    remote = tmp_path / 'merge-remote.git'
    git(tmp_path, 'init', '--bare', str(remote))
    git(repo, 'remote', 'add', 'origin', str(remote))
    git(repo, 'push', 'origin', 'feature:remote-feature')
    git(repo, 'fetch', 'origin')
    (repo / 'one.txt').write_text('local\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'local change')
    git(external, 'switch', 'feature')
    (external / 'one.txt').write_text('remote\n')
    git(external, 'add', '.'); git(external, 'commit', '-m', 'remote change')
    git(external, 'push', 'origin', 'feature:remote-feature')
    git(repo, 'fetch', 'origin')
    (repo / 'dirty.txt').write_text('untouched\n')
    (repo / 'two.txt').write_text('tracked draft\n')
    state = (await http.get(url + '/status')).json()
    response = await http.post(url + '/merge', json={'branch': 'main', 'snapshot': state['snapshot'], 'source': 'remote-feature', 'remote': 'origin'})
    assert response.status_code == 409, response.text
    assert '已自动中止' in response.json()['detail']
    assert not (repo / '.git' / 'MERGE_HEAD').exists()
    assert (repo / 'one.txt').read_text() == 'local\n'
    assert (repo / 'dirty.txt').read_text() == 'untouched\n'
    assert (repo / 'two.txt').read_text() == 'tracked draft\n'


async def test_merge_keeps_unrelated_dirty_files_and_does_not_block_event_loop(client, layout, monkeypatch):
    http, service = client
    _, repo, external = layout
    (external / 'feature.txt').write_text('feature\n')
    git(external, 'add', '.'); git(external, 'commit', '-m', 'feature change')
    (repo / 'two.txt').write_text('local commit\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'local change')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    (repo / 'dirty.txt').write_text('keep me\n')
    state = (await http.get(url + '/status')).json()
    body = {'branch': 'main', 'snapshot': state['snapshot'], 'source': 'feature'}
    command = service.command

    async def slow_merge(path, *args, **kwargs):
        if 'merge' in args:
            await asyncio.sleep(.2)
        return await command(path, *args, **kwargs)

    monkeypatch.setattr(service, 'command', slow_merge)
    pending = asyncio.create_task(http.post(url + '/merge', json=body))
    await asyncio.sleep(.05)
    started = asyncio.get_running_loop().time()
    assert (await http.get('/api/git/repositories')).status_code == 200
    assert asyncio.get_running_loop().time() - started < .05
    assert (await pending).status_code == 200
    assert (repo / 'dirty.txt').read_text() == 'keep me\n'
    assert (repo / 'feature.txt').read_text() == 'feature\n'


async def test_merge_refuses_to_overwrite_dirty_file_without_changing_it(client, layout):
    http, _ = client
    _, repo, external = layout
    (external / 'one.txt').write_text('feature\n')
    git(external, 'add', '.'); git(external, 'commit', '-m', 'feature change')
    (repo / 'one.txt').write_text('local draft\n')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    response = await http.post(url + '/merge', json={'branch': 'main', 'snapshot': state['snapshot'], 'source': 'feature'})
    assert response.status_code == 409, response.text
    assert (repo / 'one.txt').read_text() == 'local draft\n'
    assert git(repo, 'rev-parse', 'HEAD') == state['head']
    assert git(repo, 'status', '--porcelain') == 'M one.txt'
    assert git(repo, 'diff', '--cached', '--name-only') == ''


async def test_merge_current_branch_into_checked_out_target_without_switching(client, layout):
    http, _ = client
    _, repo, external = layout
    (external / 'feature.txt').write_text('feature\n')
    git(external, 'add', '.'); git(external, 'commit', '-m', 'feature change')
    (external / 'draft.txt').write_text('uncommitted\n')
    id = next(w['id'] for r in (await scan(http))['repositories'] for w in r['worktrees'] if w['path'] == str(external))
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    response = await http.post(url + '/merge-into', json={'branch': 'feature', 'target': 'main', 'snapshot': state['snapshot']})
    assert response.status_code == 200, response.text
    assert (repo / 'feature.txt').read_text() == 'feature\n'
    assert git(external, 'branch', '--show-current') == 'feature'
    assert (external / 'draft.txt').read_text() == 'uncommitted\n'


async def test_recovery_undoes_fast_forward_merge_into_target_with_new_commit(client, layout):
    http, _ = client
    _, repo, external = layout
    before = git(repo, 'rev-parse', 'HEAD')
    (external / 'feature.txt').write_text('feature\n')
    git(external, 'add', '.'); git(external, 'commit', '-m', 'feature change')
    id = next(w['id'] for r in (await scan(http))['repositories'] for w in r['worktrees'] if w['path'] == str(external))
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    merged = await http.post(url + '/merge-into', json={'branch': 'feature', 'target': 'main', 'snapshot': state['snapshot']})
    assert merged.status_code == 200, merged.text
    records = (await http.get(url + '/recoveries')).json()
    assert len(records['merges']) == 1
    operation = records['merges'][0]
    assert operation['before'] == before
    assert operation['target'] == 'main'
    preview = await http.post(url + '/recovery/preview', json={'mode': 'undo_merge', 'target': 'main', 'operation_id': operation['id']})
    assert preview.status_code == 200, preview.text
    assert 'feature.txt' in preview.json()['files']
    assert preview.json()['changes'] == [{'path': 'feature.txt', 'added': '0', 'deleted': '1'}]
    applied = await http.post(url + '/recovery/apply', json={**preview.json()['request'], 'expected_head': preview.json()['head']})
    assert applied.status_code == 200, applied.text
    assert not (repo / 'feature.txt').exists()
    assert git(repo, 'rev-parse', 'HEAD') != before
    assert git(repo, 'rev-parse', 'HEAD^') == merged.json()['head']


async def test_recovery_restores_historical_tree_without_rewriting_history(client, layout):
    http, _ = client
    _, repo, _ = layout
    old = git(repo, 'rev-parse', 'HEAD')
    (repo / 'one.txt').write_text('new\n')
    (repo / 'new.txt').write_text('new file\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'new state')
    current = git(repo, 'rev-parse', 'HEAD')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    preview = await http.post(url + '/recovery/preview', json={'mode': 'restore_tree', 'target': 'main', 'commit': old})
    assert preview.status_code == 200, preview.text
    applied = await http.post(url + '/recovery/apply', json={**preview.json()['request'], 'expected_head': preview.json()['head']})
    assert applied.status_code == 200, applied.text
    assert git(repo, 'rev-parse', 'HEAD^') == current
    assert git(repo, 'rev-parse', 'HEAD^{tree}') == git(repo, 'rev-parse', old + '^{tree}')
    assert not (repo / 'new.txt').exists()


async def test_recovery_commit_uses_target_worktree_identity(client, layout):
    http, _ = client
    _, repo, _ = layout
    old = git(repo, 'rev-parse', 'HEAD')
    (repo / 'one.txt').write_text('new\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'new state')
    git(repo, 'config', 'extensions.worktreeConfig', 'true')
    git(repo, 'config', '--worktree', 'user.name', 'Target Writer')
    git(repo, 'config', '--worktree', 'user.email', 'target@example.test')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    preview = (await http.post(url + '/recovery/preview', json={'mode': 'restore_tree', 'target': 'main', 'commit': old})).json()
    response = await http.post(url + '/recovery/apply', json={**preview['request'], 'expected_head': preview['head']})
    assert response.status_code == 200, response.text
    assert git(repo, 'log', '-1', '--format=%an <%ae>') == 'Target Writer <target@example.test>'


async def test_recovery_undoes_merge_commit_without_removing_later_changes(client, layout):
    http, _ = client
    _, repo, external = layout
    (repo / 'main.txt').write_text('main\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'main change')
    (external / 'feature.txt').write_text('feature\n')
    git(external, 'add', '.'); git(external, 'commit', '-m', 'feature change')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    merged = await http.post(url + '/merge', json={'branch': 'main', 'snapshot': state['snapshot'], 'source': 'feature'})
    assert merged.status_code == 200, merged.text
    merge_head = git(repo, 'rev-parse', 'HEAD')
    assert len(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split()) == 3
    (repo / 'later.txt').write_text('later\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'later change')
    preview = await http.post(url + '/recovery/preview', json={'mode': 'undo_commit', 'target': 'main', 'commit': merge_head})
    assert preview.status_code == 200, preview.text
    applied = await http.post(url + '/recovery/apply', json={**preview.json()['request'], 'expected_head': preview.json()['head']})
    assert applied.status_code == 200, applied.text
    assert not (repo / 'feature.txt').exists()
    assert (repo / 'main.txt').read_text() == 'main\n'
    assert (repo / 'later.txt').read_text() == 'later\n'


async def test_recovery_undoes_fast_forward_with_later_commit(client, layout):
    http, _ = client
    _, repo, external = layout
    (external / 'feature.txt').write_text('feature\n')
    git(external, 'add', '.'); git(external, 'commit', '-m', 'feature change')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    assert (await http.post(url + '/merge', json={'branch': 'main', 'snapshot': state['snapshot'], 'source': 'feature'})).status_code == 200
    record = (await http.get(url + '/recoveries')).json()['merges'][0]
    (repo / 'later.txt').write_text('later\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'later change')
    preview = await http.post(url + '/recovery/preview', json={'mode': 'undo_merge', 'target': 'main', 'operation_id': record['id']})
    assert preview.status_code == 200, preview.text
    applied = await http.post(url + '/recovery/apply', json={**preview.json()['request'], 'expected_head': preview.json()['head']})
    assert applied.status_code == 200, applied.text
    assert not (repo / 'feature.txt').exists()
    assert (repo / 'later.txt').read_text() == 'later\n'


async def test_recovery_of_pushed_merge_can_be_pushed_without_force(client, layout, tmp_path):
    http, _ = client
    _, repo, external = layout
    remote = tmp_path / 'recovery-remote.git'
    git(tmp_path, 'init', '--bare', str(remote))
    git(repo, 'remote', 'add', 'origin', str(remote))
    git(repo, 'push', '-u', 'origin', 'main')
    (external / 'feature.txt').write_text('feature\n')
    git(external, 'add', '.'); git(external, 'commit', '-m', 'feature change')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    assert (await http.post(url + '/merge', json={'branch': 'main', 'snapshot': state['snapshot'], 'source': 'feature'})).status_code == 200
    git(repo, 'push', 'origin', 'main')
    record = (await http.get(url + '/recoveries')).json()['merges'][0]
    preview = (await http.post(url + '/recovery/preview', json={'mode': 'undo_merge', 'target': 'main', 'operation_id': record['id']})).json()
    response = await http.post(url + '/recovery/apply', json={**preview['request'], 'expected_head': preview['head']})
    assert response.status_code == 200, response.text
    assert response.json()['push_available'] is True
    git(repo, 'push', 'origin', 'main')
    assert git(remote, 'rev-parse', 'refs/heads/main') == response.json()['head']


async def test_recovery_refuses_stale_preview_and_preserves_dirty_file(client, layout):
    http, _ = client
    _, repo, _ = layout
    old = git(repo, 'rev-parse', 'HEAD')
    (repo / 'one.txt').write_text('new\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'new state')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    preview = (await http.post(url + '/recovery/preview', json={'mode': 'restore_tree', 'target': 'main', 'commit': old})).json()
    (repo / 'one.txt').write_text('draft\n')
    response = await http.post(url + '/recovery/apply', json={**preview['request'], 'expected_head': preview['head']})
    assert response.status_code == 409, response.text
    assert (repo / 'one.txt').read_text() == 'draft\n'
    git(repo, 'restore', 'one.txt')
    (repo / 'later.txt').write_text('later\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'later change')
    response = await http.post(url + '/recovery/apply', json={**preview['request'], 'expected_head': preview['head']})
    assert response.status_code == 409, response.text


async def test_recovery_preview_keeps_api_responsive_during_slow_git(client, layout, monkeypatch):
    http, service = client
    _, repo, _ = layout
    old = git(repo, 'rev-parse', 'HEAD')
    (repo / 'one.txt').write_text('new\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'new state')
    id = await payment_id(http)
    command = service.command

    async def slow_restore(path, *args, **kwargs):
        if args and args[0] == 'restore':
            await asyncio.sleep(.2)
        return await command(path, *args, **kwargs)

    monkeypatch.setattr(service, 'command', slow_restore)
    pending = asyncio.create_task(http.post(f'/api/git/worktrees/{id}/recovery/preview', json={
        'mode': 'restore_tree', 'target': 'main', 'commit': old,
    }))
    await asyncio.sleep(.05)
    started = asyncio.get_running_loop().time()
    assert (await http.get('/api/git/repositories')).status_code == 200
    assert asyncio.get_running_loop().time() - started < .1
    assert (await pending).status_code == 200


async def test_merge_into_checked_out_target_keeps_unrelated_uncommitted_files(client, layout):
    http, _ = client
    _, repo, external = layout
    (repo / 'one.txt').write_text('target draft\n')
    (external / 'two.txt').write_text('source commit\n')
    git(external, 'add', 'two.txt'); git(external, 'commit', '-m', 'source change')
    id = next(w['id'] for r in (await scan(http))['repositories'] for w in r['worktrees'] if w['path'] == str(external))
    state = (await http.get(f'/api/git/worktrees/{id}/status')).json()
    response = await http.post(f'/api/git/worktrees/{id}/merge-into', json={
        'branch': 'feature', 'target': 'main', 'snapshot': state['snapshot'],
    })
    assert response.status_code == 200, response.text
    assert git(repo, 'show', 'HEAD:two.txt') == 'source commit'
    assert (repo / 'one.txt').read_text() == 'target draft\n'
    assert git(repo, 'status', '--short') == 'M one.txt'
    assert not (repo / '.git' / 'MERGE_HEAD').exists()


async def test_merge_into_checked_out_target_rejects_overlapping_uncommitted_file_without_merge_state(client, layout):
    http, _ = client
    _, repo, external = layout
    target_head = git(repo, 'rev-parse', 'HEAD')
    (repo / 'one.txt').write_text('target draft\n')
    (external / 'one.txt').write_text('source commit\n')
    git(external, 'add', 'one.txt'); git(external, 'commit', '-m', 'source change')
    id = next(w['id'] for r in (await scan(http))['repositories'] for w in r['worktrees'] if w['path'] == str(external))
    state = (await http.get(f'/api/git/worktrees/{id}/status')).json()
    response = await http.post(f'/api/git/worktrees/{id}/merge-into', json={
        'branch': 'feature', 'target': 'main', 'snapshot': state['snapshot'],
    })
    assert response.status_code == 409, response.text
    assert '未提交' in response.json()['detail']
    assert git(repo, 'rev-parse', 'HEAD') == target_head
    assert (repo / 'one.txt').read_text() == 'target draft\n'
    assert git(repo, 'status', '--short') == 'M one.txt'
    assert not (repo / '.git' / 'MERGE_HEAD').exists()


async def test_merge_into_detects_committed_conflict_without_touching_dirty_target(client, layout):
    http, _ = client
    _, repo, external = layout
    (repo / 'one.txt').write_text('target commit\n')
    git(repo, 'add', 'one.txt'); git(repo, 'commit', '-m', 'target change')
    target_head = git(repo, 'rev-parse', 'HEAD')
    (repo / 'one.txt').write_text('target draft\n')
    (external / 'one.txt').write_text('source commit\n')
    git(external, 'add', 'one.txt'); git(external, 'commit', '-m', 'source change')
    id = next(w['id'] for r in (await scan(http))['repositories'] for w in r['worktrees'] if w['path'] == str(external))
    state = (await http.get(f'/api/git/worktrees/{id}/status')).json()
    response = await http.post(f'/api/git/worktrees/{id}/merge-into', json={
        'branch': 'feature', 'target': 'main', 'snapshot': state['snapshot'],
    })
    assert response.status_code == 409, response.text
    assert '已自动中止' in response.json()['detail']
    assert git(repo, 'rev-parse', 'HEAD') == target_head
    assert (repo / 'one.txt').read_text() == 'target draft\n'
    assert git(repo, 'status', '--short') == 'M one.txt'
    assert not (repo / '.git' / 'MERGE_HEAD').exists()


async def test_merge_current_branch_into_unchecked_out_target_without_switching(client, layout):
    http, _ = client
    _, repo, _ = layout
    git(repo, 'branch', 'release')
    (repo / 'main.txt').write_text('main commit\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'main change')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    response = await http.post(url + '/merge-into', json={'branch': 'main', 'target': 'release', 'snapshot': state['snapshot']})
    assert response.status_code == 200, response.text
    assert git(repo, 'branch', '--show-current') == 'main'
    assert git(repo, 'rev-parse', 'release') == state['head']


@pytest.mark.parametrize('target_checked_out', [False, True])
async def test_merge_into_updates_target_upstream_before_merge_without_pushing(client, layout, tmp_path, target_checked_out):
    http, _ = client
    _, repo, external = layout
    if target_checked_out:
        git(repo, 'switch', '-c', 'dev')
    else:
        git(repo, 'branch', 'dev')
    remote = tmp_path / 'origin.git'
    git(tmp_path, 'init', '--bare', str(remote))
    git(repo, 'remote', 'add', 'origin', str(remote))
    git(repo, 'push', '-u', 'origin', 'dev')
    peer = repository(tmp_path / 'peer')
    git(peer, 'remote', 'add', 'origin', str(remote))
    git(peer, 'fetch', 'origin')
    git(peer, 'reset', '--hard', 'origin/dev')
    (peer / 'remote.txt').write_text('remote\n')
    git(peer, 'add', '.'); git(peer, 'commit', '-m', 'remote change')
    git(peer, 'push', 'origin', 'HEAD:dev')
    (external / 'feature.txt').write_text('feature\n')
    git(external, 'add', '.'); git(external, 'commit', '-m', 'feature change')
    id = next(w['id'] for r in (await scan(http))['repositories'] for w in r['worktrees'] if w['path'] == str(external))
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    response = await http.post(url + '/merge-into', json={'branch': 'feature', 'target': 'dev', 'snapshot': state['snapshot']})
    assert response.status_code == 200, response.text
    assert response.json()['updated'] is True
    assert git(repo, 'show', 'dev:remote.txt') == 'remote'
    assert git(repo, 'show', 'dev:feature.txt') == 'feature'
    assert git(remote, 'rev-parse', 'refs/heads/dev') != git(repo, 'rev-parse', 'dev')
    assert git(external, 'branch', '--show-current') == 'feature'
    pushed = await http.post(url + '/push-branch', json={'branch': 'dev', 'head': response.json()['head']})
    assert pushed.status_code == 200, pushed.text
    assert git(remote, 'rev-parse', 'refs/heads/dev') == git(repo, 'rev-parse', 'dev')


async def test_merge_into_conflict_does_not_advance_checked_out_target_upstream(client, layout, tmp_path):
    http, _ = client
    _, repo, external = layout
    git(repo, 'switch', '-c', 'dev')
    remote = tmp_path / 'origin.git'
    git(tmp_path, 'init', '--bare', str(remote))
    git(repo, 'remote', 'add', 'origin', str(remote))
    git(repo, 'push', '-u', 'origin', 'dev')
    original_head = git(repo, 'rev-parse', 'HEAD')
    peer = repository(tmp_path / 'peer')
    git(peer, 'remote', 'add', 'origin', str(remote))
    git(peer, 'fetch', 'origin')
    git(peer, 'reset', '--hard', 'origin/dev')
    (peer / 'one.txt').write_text('remote change\n')
    git(peer, 'add', 'one.txt'); git(peer, 'commit', '-m', 'remote change')
    git(peer, 'push', 'origin', 'HEAD:dev')
    (external / 'one.txt').write_text('source change\n')
    git(external, 'add', 'one.txt'); git(external, 'commit', '-m', 'source change')
    (repo / 'two.txt').write_text('local draft\n')
    id = next(w['id'] for r in (await scan(http))['repositories'] for w in r['worktrees'] if w['path'] == str(external))
    state = (await http.get(f'/api/git/worktrees/{id}/status')).json()
    response = await http.post(f'/api/git/worktrees/{id}/merge-into', json={
        'branch': 'feature', 'target': 'dev', 'snapshot': state['snapshot'],
    })
    assert response.status_code == 409, response.text
    assert '已自动中止' in response.json()['detail']
    assert git(repo, 'rev-parse', 'HEAD') == original_head
    assert (repo / 'two.txt').read_text() == 'local draft\n'
    assert not (repo / '.git' / 'MERGE_HEAD').exists()


async def test_merge_into_temporary_worktree_keeps_api_responsive(client, layout, monkeypatch):
    http, service = client
    _, _, external = layout
    (external / 'feature.txt').write_text('feature\n')
    git(external, 'add', 'feature.txt'); git(external, 'commit', '-m', 'feature change')
    id = next(w['id'] for r in (await scan(http))['repositories'] for w in r['worktrees'] if w['path'] == str(external))
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    entered = asyncio.Event()
    original = service.command

    async def delayed(path, *args, **kwargs):
        if args[:2] == ('worktree', 'add'):
            entered.set()
            await asyncio.sleep(.2)
        return await original(path, *args, **kwargs)

    monkeypatch.setattr(service, 'command', delayed)
    pending = asyncio.create_task(http.post(url + '/merge-into', json={
        'branch': 'feature', 'target': 'main', 'snapshot': state['snapshot'],
    }))
    await asyncio.wait_for(entered.wait(), 2)
    started = asyncio.get_running_loop().time()
    assert (await asyncio.wait_for(http.get('/api/git/repositories'), .1)).status_code == 200
    assert asyncio.get_running_loop().time() - started < .1
    response = await pending
    assert response.status_code == 200, response.text


async def test_push_unchecked_out_branch_with_explicit_remote_sets_upstream(client, layout, tmp_path):
    http, _ = client
    _, repo, _ = layout
    remote = tmp_path / 'push-target.git'
    git(tmp_path, 'init', '--bare', str(remote))
    git(repo, 'remote', 'add', 'origin', str(remote))
    git(repo, 'branch', 'tt')
    (repo / 'draft.txt').write_text('uncommitted work\n')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    head = git(repo, 'rev-parse', 'tt')
    response = await http.post(url + '/push-branch', json={
        'branch': 'tt', 'head': head, 'remote': 'origin', 'target_branch': 'tt', 'set_upstream': True,
    })
    assert response.status_code == 200, response.text
    assert git(remote, 'rev-parse', 'refs/heads/tt') == head
    assert git(repo, 'for-each-ref', '--format=%(upstream:short)', 'refs/heads/tt') == 'origin/tt'
    assert (repo / 'draft.txt').read_text() == 'uncommitted work\n'
    assert (await http.post(url + '/push-branch', json={
        'branch': 'tt', 'head': git(repo, 'rev-parse', 'main')[:-1] + '0',
        'remote': 'origin', 'target_branch': 'tt',
    })).status_code == 409


async def test_fast_forward_inactive_branch_keeps_current_dirty_files(client, layout, tmp_path):
    http, _ = client
    _, repo, _ = layout
    remote = tmp_path / 'advance-origin.git'
    git(tmp_path, 'init', '--bare', str(remote))
    git(repo, 'remote', 'add', 'origin', str(remote))
    git(repo, 'branch', 'release')
    git(repo, 'push', '-u', 'origin', 'release')
    peer = repository(tmp_path / 'advance-peer')
    git(peer, 'remote', 'add', 'origin', str(remote))
    git(peer, 'fetch', 'origin')
    git(peer, 'reset', '--hard', 'origin/release')
    (peer / 'remote-release.txt').write_text('new release\n')
    git(peer, 'add', '.')
    git(peer, 'commit', '-m', 'advance release')
    git(peer, 'push', 'origin', 'HEAD:release')
    (repo / 'one.txt').write_text('dirty current branch\n')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()

    response = await http.post(url + '/advance', json={
        'branch': 'release', 'snapshot': state['snapshot'],
    })
    assert response.status_code == 200, response.text
    release = next(branch for branch in response.json()['branches'] if branch['name'] == 'release')
    assert (release['ahead'], release['behind']) == (0, 0)
    assert git(repo, 'rev-parse', 'refs/heads/release') == git(remote, 'rev-parse', 'refs/heads/release')
    assert git(repo, 'branch', '--show-current') == 'main'
    assert (repo / 'one.txt').read_text() == 'dirty current branch\n'


async def test_remote_inventory_and_explicit_push_target_support_multiple_remotes(client, layout, tmp_path):
    http, _ = client
    _, repo, _ = layout
    origin = tmp_path / 'origin.git'
    backup = tmp_path / 'backup.git'
    git(tmp_path, 'init', '--bare', str(origin))
    git(tmp_path, 'init', '--bare', str(backup))
    git(repo, 'remote', 'add', 'origin', str(origin))
    git(repo, 'remote', 'add', 'backup', str(backup))
    git(repo, 'push', '-u', 'origin', 'main')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'

    inventory = await http.get(url + '/remotes')
    assert inventory.status_code == 200, inventory.text
    assert [item['name'] for item in inventory.json()['remotes']] == ['backup', 'origin']
    assert inventory.json()['upstream'] == {'remote': 'origin', 'branch': 'main'}

    (repo / 'release.txt').write_text('release\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'release')
    state = (await http.get(url + '/status')).json()
    response = await http.post(url + '/push', json={
        'branch': 'main', 'snapshot': state['snapshot'], 'remote': 'backup',
        'target_branch': 'release/next', 'set_upstream': False,
    })
    assert response.status_code == 200, response.text
    assert git(backup, 'rev-parse', 'refs/heads/release/next') == git(repo, 'rev-parse', 'HEAD')
    assert git(origin, 'rev-parse', 'refs/heads/main') != git(repo, 'rev-parse', 'HEAD')
    assert git(repo, 'rev-parse', '--abbrev-ref', '@{upstream}') == 'origin/main'

    refreshed = await http.post(url + '/fetch-remote', json={'remote': 'backup'})
    assert refreshed.status_code == 200, refreshed.text
    remote = next(item for item in refreshed.json()['remotes'] if item['name'] == 'backup')
    assert any(branch['name'] == 'release/next' for branch in remote['branches'])


async def test_https_credentials_are_used_only_for_the_current_git_command(tmp_path):
    repo = repository(tmp_path / 'repo')
    auth = {'username': 'git-user', 'token': 'one-time-token', 'host': 'example.test'}
    output, _ = await run_git(repo, 'credential', 'fill',
        stdin=b'protocol=https\nhost=example.test\n\n', auth=auth)
    assert b'username=git-user' in output
    assert b'password=one-time-token' in output
    assert subprocess.run(['git', '-C', str(repo), 'config', '--local', '--get', 'credential.helper'], capture_output=True).returncode == 1
    with pytest.raises(Exception):
        await run_git(repo, 'credential', 'fill',
            stdin=b'protocol=https\nhost=other.example.test\n\n', auth=auth)


def test_missing_https_credentials_explain_where_to_configure_them():
    message = explain_auth_error("fatal: could not read Username for 'https://gitlab.base.packertec.com': terminal prompts disabled")
    assert 'gitlab.base.packertec.com' in message
    assert 'Git 设置' in message


async def test_unset_https_credentials_use_the_local_git_credential_helper(tmp_path):
    repo = repository(tmp_path / 'repo')
    credential_file = tmp_path / 'credentials'
    credential_file.write_text('https://local-user:local-token@example.test\n')
    git(repo, 'config', 'credential.helper', f'store --file={credential_file}')
    output, _ = await run_git(repo, 'credential', 'fill', stdin=b'protocol=https\nhost=example.test\n\n')
    assert b'username=local-user' in output
    assert b'password=local-token' in output


async def test_git_identity_can_be_saved_for_repository(client, layout):
    http, _ = client
    root, repo, other_worktree = layout
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}/identity'
    assert (await http.get(url)).json() == {'name': 'Test User', 'email': 'test@example.invalid'}
    response = await http.put(url, json={'name': '仓库作者', 'email': 'author@example.com'})
    assert response.status_code == 200, response.text
    assert response.json() == {'name': '仓库作者', 'email': 'author@example.com'}
    assert git(repo, 'config', '--local', '--get', 'user.name') == '仓库作者'
    assert git(repo, 'config', '--local', '--get', 'user.email') == 'author@example.com'
    assert git(other_worktree, 'config', '--get', 'user.name') == '仓库作者'
    assert git(other_worktree, 'config', '--get', 'user.email') == 'author@example.com'
    from services.git.task_workspace import TaskGitWorkspace
    workspace = TaskGitWorkspace(client[1])
    payment = next(item for item in (await scan(http))['repositories'] if item['name'] == 'payment')
    created = await workspace.add(root, 'identity-task', payment['id'], 'payment', 'main', creator_name='其他创建人')
    task_tree = created['worktrees'][0]['path']
    assert git(task_tree, 'config', '--get', 'user.name') == '仓库作者'
    assert git(task_tree, 'config', '--get', 'user.email') == 'author@example.com'
    assert (await http.put(url, json={'name': ' ', 'email': 'bad'})).status_code == 422


async def test_global_identity_applies_to_other_repositories_without_local_override(client, layout, tmp_path, monkeypatch):
    http, _ = client
    _, repo, _ = layout
    monkeypatch.setenv('HOME', str(tmp_path / 'git-home'))
    (tmp_path / 'git-home').mkdir()
    id = await payment_id(http)
    response = await http.put(f'/api/git/worktrees/{id}/identity/global', json={
        'name': 'Shared Author', 'email': 'shared@example.test'})
    assert response.status_code == 200, response.text
    assert response.json() == {'name': 'Shared Author', 'email': 'shared@example.test'}
    git(repo, 'config', '--local', '--unset', 'user.name')
    git(repo, 'config', '--local', '--unset', 'user.email')
    assert (await http.get(f'/api/git/worktrees/{id}/identity')).json() == {'name': 'Shared Author', 'email': 'shared@example.test'}
    other = repository(tmp_path / 'another-repository')
    git(other, 'config', '--local', '--unset', 'user.name')
    git(other, 'config', '--local', '--unset', 'user.email')
    assert git(other, 'config', '--get', 'user.name') == 'Shared Author'
    assert git(other, 'config', '--get', 'user.email') == 'shared@example.test'


async def test_https_remote_credentials_are_shared_by_host_and_never_returned(client, layout):
    http, service = client
    _, repo, _ = layout
    git(repo, 'remote', 'add', 'origin', 'https://git.example.test/team/repo.git')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}/credentials'
    response = await http.put(url, json={'remote': 'origin', 'username': 'alice', 'token': 'secret-token'})
    assert response.status_code == 200, response.text
    assert response.json()['remotes'][0]['configured'] is True
    assert 'secret-token' not in response.text
    directory = await service.directory(id)
    assert await service.credential_for(directory, 'origin') == {'username': 'alice', 'token': 'secret-token', 'host': 'git.example.test'}
    git(repo, 'remote', 'add', 'other', 'https://git.example.test/team/other.git')
    assert await service.credential_for(directory, 'other') == {'username': 'alice', 'token': 'secret-token', 'host': 'git.example.test'}
    git(repo, 'remote', 'set-url', 'origin', 'https://other.example.test/repo.git')
    assert await service.credential_for(directory, 'origin') is None
    assert all(not item['configured'] for item in (await http.delete(url + '/other')).json()['remotes'])


async def test_https_credentials_survive_restart_and_delete_persists(client, layout):
    http, service = client
    root, repo, _ = layout
    git(repo, 'remote', 'add', 'origin', 'https://git.example.test/team/repo.git')
    await http.put('/api/git/credentials', json={
        'host': 'git.example.test', 'username': 'alice', 'token': 'secret-token'})
    credential_file = root / 'git-credentials.json'
    assert credential_file.stat().st_mode & 0o777 == 0o600
    restarted = GitService(service.projects_provider, service.depth_provider,
                           credential_file=credential_file)
    try:
        assert (await restarted.credential_hosts()) == {'hosts': ['git.example.test']}
        assert await restarted.credential_for({'path': str(repo)}, 'origin') == {
            'username': 'alice', 'token': 'secret-token', 'host': 'git.example.test'}
        await restarted.clear_host_credentials('git.example.test')
        reloaded = GitService(service.projects_provider, service.depth_provider,
                              credential_file=credential_file)
        assert (await reloaded.credential_hosts()) == {'hosts': []}
        await reloaded.close()
    finally:
        await restarted.close()


async def test_slow_credential_storage_does_not_block_event_loop(client, monkeypatch):
    http, _ = client
    import services.git as git_module
    original = git_module.save_credentials
    started = threading.Event()

    def slow_save(path, credentials):
        started.set()
        time.sleep(.2)
        original(path, credentials)

    monkeypatch.setattr(git_module, 'save_credentials', slow_save)
    start = time.monotonic()
    request = asyncio.create_task(http.put('/api/git/credentials', json={
        'host': 'git.example.test', 'username': 'alice', 'token': 'secret-token'}))
    await asyncio.wait_for(asyncio.to_thread(started.wait), .5)
    await asyncio.wait_for(asyncio.sleep(.01), .1)
    assert time.monotonic() - start < .15
    assert (await request).status_code == 200


async def test_credentials_can_be_set_for_https_push_host_when_fetch_is_ssh(client, layout):
    http, service = client
    _, repo, _ = layout
    git(repo, 'remote', 'add', 'origin', 'git@git.example.test:team/repo.git')
    git(repo, 'remote', 'set-url', '--push', 'origin', 'https://gitlab.base.packertec.com/team/repo.git')
    id = await payment_id(http)
    inventory = (await http.get(f'/api/git/worktrees/{id}/credentials')).json()
    assert inventory['remotes'][0]['push_url'] == 'https://gitlab.base.packertec.com/team/repo.git'
    response = await http.put('/api/git/credentials', json={
        'host': 'gitlab.base.packertec.com', 'username': 'alice', 'token': 'secret-token'})
    assert response.status_code == 200, response.text
    assert 'secret-token' not in response.text
    directory = await service.directory(id)
    assert await service.credential_for(directory, 'origin') is None
    assert await service.credential_for(directory, 'origin', push=True) == {
        'username': 'alice', 'token': 'secret-token', 'host': 'gitlab.base.packertec.com'}
    assert 'gitlab.base.packertec.com' in (await http.get('/api/git/credentials')).json()['hosts']
    assert (await http.delete('/api/git/credentials/gitlab.base.packertec.com')).status_code == 200
    assert await service.credential_for(directory, 'origin', push=True) is None


async def test_saved_https_credentials_upgrade_same_host_http_remote_before_git_uses_it(client, layout):
    http, service = client
    _, repo, _ = layout
    git(repo, 'remote', 'add', 'origin', 'http://gitlab.base.packertec.com/team/repo.git')
    id = await payment_id(http)
    response = await http.put('/api/git/credentials', json={
        'host': 'gitlab.base.packertec.com', 'username': 'alice', 'token': 'secret-token'})
    assert response.status_code == 200, response.text
    directory = await service.directory(id)
    auth = await service.credential_for(directory, 'origin', push=True)
    assert auth == {'username': 'alice', 'token': 'secret-token', 'host': 'gitlab.base.packertec.com',
                    'upgrade_from': 'http://gitlab.base.packertec.com/',
                    'upgrade_to': 'https://gitlab.base.packertec.com/'}
    upgraded, _ = await run_git(repo, 'remote', 'get-url', '--push', 'origin', auth=auth)
    assert upgraded.decode().strip() == 'https://gitlab.base.packertec.com/team/repo.git'


async def test_http_remote_can_save_and_show_https_host_credentials(client, layout):
    http, service = client
    _, repo, _ = layout
    git(repo, 'remote', 'add', 'origin', 'http://gitlab.base.packertec.com/team/repo.git')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}/credentials'
    response = await http.put(url, json={
        'remote': 'origin', 'username': 'alice', 'token': 'secret-token'})
    assert response.status_code == 200, response.text
    assert response.json()['remotes'][0]['configured'] is True
    assert response.json()['hosts'] == ['gitlab.base.packertec.com']
    directory = await service.directory(id)
    assert (await service.credential_for(directory, 'origin'))['host'] == 'gitlab.base.packertec.com'
    assert (await http.delete(url + '/origin')).json()['remotes'][0]['configured'] is False


async def test_explicit_pull_uses_selected_remote_branch_and_can_set_upstream(client, layout, tmp_path):
    http, _ = client
    _, repo, _ = layout
    backup = tmp_path / 'backup.git'
    git(tmp_path, 'init', '--bare', str(backup))
    git(repo, 'remote', 'add', 'backup', str(backup))
    git(repo, 'push', 'backup', 'main:release')
    peer = repository(tmp_path / 'remote-peer')
    git(peer, 'remote', 'add', 'backup', str(backup))
    git(peer, 'fetch', 'backup')
    git(peer, 'reset', '--hard', 'backup/release')
    (peer / 'remote-release.txt').write_text('remote release\n')
    git(peer, 'add', '.')
    git(peer, 'commit', '-m', 'remote release')
    git(peer, 'push', 'backup', 'HEAD:release')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()

    response = await http.post(url + '/pull', json={
        'branch': 'main', 'snapshot': state['snapshot'], 'remote': 'backup',
        'target_branch': 'release', 'set_upstream': True,
    })
    assert response.status_code == 200, response.text
    assert (repo / 'remote-release.txt').read_text() == 'remote release\n'
    assert git(repo, 'rev-parse', '--abbrev-ref', '@{upstream}') == 'backup/release'


async def test_pull_preserves_dirty_files_and_refuses_active_diverged_and_missing_upstream(client, layout, tmp_path):
    http, service = client
    _, repo, _ = layout
    remote = tmp_path / 'origin.git'
    git(tmp_path, 'init', '--bare', str(remote))
    git(repo, 'remote', 'add', 'origin', str(remote))
    git(repo, 'push', '-u', 'origin', 'main')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    async def pull():
        state = (await http.get(url + '/status')).json()
        return await http.post(url + '/pull', json={'branch': 'main', 'snapshot': state['snapshot']})
    (repo / 'one.txt').write_text('do not lose')
    assert (await pull()).status_code == 200
    assert (repo / 'one.txt').read_text() == 'do not lose'
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'local only')
    service.active_provider = lambda _: True
    assert (await pull()).status_code == 409
    service.active_provider = lambda _: False
    peer = repository(tmp_path / 'other')
    git(peer, 'remote', 'add', 'origin', str(remote))
    git(peer, 'fetch', 'origin')
    git(peer, 'reset', '--hard', 'origin/main')
    (peer / 'remote.txt').write_text('remote only')
    git(peer, 'add', '.')
    git(peer, 'commit', '-m', 'remote only')
    git(peer, 'push', 'origin', 'HEAD:main')
    head = git(repo, 'rev-parse', 'HEAD')
    response = await pull()
    assert response.status_code == 409 and '分叉' in response.text
    assert git(repo, 'rev-parse', 'HEAD') == head
    branches = (await http.get(url + '/branches')).json()['branches']
    main = next(b for b in branches if b['name'] == 'main')
    assert (main['ahead'], main['behind']) == (1, 1)
    assert next(b for b in branches if b['name'] == 'feature')['upstream'] is None
    git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/unused')
    git(peer, 'push', 'origin', '--delete', 'main')
    assert (await pull()).status_code == 409
    branches = (await http.get(url + '/branches')).json()['branches']
    assert next(b for b in branches if b['name'] == 'main')['upstream_gone'] is True


async def test_pull_rechecks_changes_after_slow_fetch_and_keeps_api_responsive(client, layout, tmp_path, monkeypatch):
    http, service = client
    _, repo, _ = layout
    remote = tmp_path / 'origin.git'
    git(tmp_path, 'init', '--bare', str(remote))
    git(repo, 'remote', 'add', 'origin', str(remote))
    git(repo, 'push', '-u', 'origin', 'main')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    entered = asyncio.Event()
    release = asyncio.Event()
    original = service.command
    async def delayed(path, *args, **kwargs):
        if args[0] == 'fetch':
            entered.set()
            await release.wait()
        return await original(path, *args, **kwargs)
    monkeypatch.setattr(service, 'command', delayed)
    pending = asyncio.create_task(http.post(url + '/pull', json={'branch': 'main', 'snapshot': state['snapshot']}))
    await asyncio.wait_for(entered.wait(), 2)
    assert (await asyncio.wait_for(http.get('/api/git/repositories'), .1)).status_code == 200
    (repo / 'one.txt').write_text('edited during fetch')
    release.set()
    response = await pending
    assert response.status_code == 409
    assert (repo / 'one.txt').read_text() == 'edited during fetch'


async def test_push_sends_committed_head_and_preserves_uncommitted_files(client, layout, tmp_path):
    http, _ = client
    _, repo, _ = layout
    remote = tmp_path / 'push-origin.git'
    git(tmp_path, 'init', '--bare', str(remote))
    git(repo, 'remote', 'add', 'origin', str(remote))
    git(repo, 'push', '-u', 'origin', 'main')
    initial = git(remote, 'rev-parse', 'refs/heads/main')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    async def push():
        state = (await http.get(url + '/status')).json()
        return await http.post(url + '/push', json={'branch': 'main', 'snapshot': state['snapshot']})
    (repo / 'new.txt').write_text('new')
    git(repo, 'add', 'new.txt')
    git(repo, 'commit', '-m', 'new commit')
    (repo / 'one.txt').write_text('dirty tracked')
    git(repo, 'add', 'one.txt')
    (repo / 'two.txt').write_text('unstaged draft')
    (repo / 'draft.txt').write_text('untracked draft')
    response = await push()
    assert response.status_code == 200, response.text
    assert git(remote, 'rev-parse', 'refs/heads/main') != initial
    assert git(remote, 'rev-parse', 'refs/heads/main') == git(repo, 'rev-parse', 'HEAD')
    assert git(remote, 'show', 'main:one.txt') == 'original'
    assert git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/') == 'refs/heads/main'
    assert git(repo, 'status', '--short').splitlines() == ['M  one.txt', ' M two.txt', '?? draft.txt']
    state = (await http.get(url + '/status')).json()
    wrong_branch = await http.post(url + '/push', json={'branch': 'other', 'snapshot': state['snapshot']})
    assert wrong_branch.status_code == 409


async def test_push_does_not_force_remote_and_slow_hook_keeps_api_responsive(client, layout, tmp_path):
    http, _ = client
    _, repo, _ = layout
    remote = tmp_path / 'push-origin.git'
    git(tmp_path, 'init', '--bare', str(remote))
    git(repo, 'remote', 'add', 'origin', str(remote))
    git(repo, 'push', '-u', 'origin', 'main')
    peer = repository(tmp_path / 'push-peer')
    git(peer, 'remote', 'add', 'origin', str(remote))
    git(peer, 'fetch', 'origin')
    git(peer, 'reset', '--hard', 'origin/main')
    (peer / 'remote.txt').write_text('remote')
    git(peer, 'add', '.')
    git(peer, 'commit', '-m', 'remote')
    git(peer, 'push', 'origin', 'HEAD:main')
    (repo / 'local.txt').write_text('local')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'local')
    id = await payment_id(http)
    url = f'/api/git/worktrees/{id}'
    state = (await http.get(url + '/status')).json()
    body = {'branch': 'main', 'snapshot': state['snapshot']}
    response = await http.post(url + '/push', json=body)
    assert response.status_code == 400
    assert git(remote, 'rev-parse', 'refs/heads/main') == git(peer, 'rev-parse', 'HEAD')
    # Run a clean fast-forward attempt through a slow rejecting hook.
    git(repo, 'fetch', 'origin')
    git(repo, 'merge', '--no-edit', 'origin/main')
    hook = repo / '.git/hooks/pre-push'
    hook.write_text('#!/bin/sh\nsleep 0.4\necho push-rejected >&2\nexit 1\n')
    hook.chmod(0o755)
    body['snapshot'] = (await http.get(url + '/status')).json()['snapshot']
    pending = asyncio.create_task(http.post(url + '/push', json=body))
    await asyncio.sleep(.15)
    assert (await asyncio.wait_for(http.get('/api/git/repositories'), .1)).status_code == 200
    response = await pending
    assert response.status_code == 400 and 'push-rejected' in response.text
    assert git(remote, 'rev-parse', 'refs/heads/main') == git(peer, 'rev-parse', 'HEAD')
