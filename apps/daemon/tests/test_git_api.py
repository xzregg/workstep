"""Exercise Git management through HTTP against disposable real repositories."""
import asyncio
import subprocess
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient, ReadTimeout

import api.git as git_api
from services.git import GitService


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
    service = GitService(lambda: [{'id': 'p', 'name': 'Project', 'path': str(root)}], lambda: 5)
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
    (repo / 'untracked').write_text('keep me')
    body['snapshot'] = (await http.get(url + '/status')).json()['snapshot']
    assert (await http.post(url + '/switch', json=body)).status_code == 409
    (repo / 'untracked').unlink()
    body['snapshot'] = (await http.get(url + '/status')).json()['snapshot']
    response = await http.post(url + '/switch', json=body)
    assert response.status_code == 200, response.text
    assert response.json()['branch'] == 'other'
    assert git(repo, 'branch', '--show-current') == 'other'


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


async def test_pull_refuses_dirty_active_diverged_and_missing_upstream(client, layout, tmp_path):
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
    assert (await pull()).status_code == 409
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


async def test_push_requires_clean_review_and_only_pushes_current_branch(client, layout, tmp_path):
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
    assert (await push()).status_code == 409
    git(repo, 'add', 'new.txt')
    assert (await push()).status_code == 409
    git(repo, 'commit', '-m', 'new commit')
    (repo / 'one.txt').write_text('dirty tracked')
    assert (await push()).status_code == 409
    assert git(remote, 'rev-parse', 'refs/heads/main') == initial
    git(repo, 'add', 'one.txt')
    git(repo, 'commit', '-m', 'second commit')
    response = await push()
    assert response.status_code == 200, response.text
    assert git(remote, 'rev-parse', 'refs/heads/main') == git(repo, 'rev-parse', 'HEAD')
    assert git(remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/') == 'refs/heads/main'


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
