"""Local CLI works without user login; public HTTP keeps its auth boundary."""
import asyncio
import json
import os
import stat
import time
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from api.desktop_security import DesktopSecurityMiddleware
from services.gateway_client.identity import ManagedLocalSessions
from services.tool_registry import WorkstepClient
from services.local_cli import LocalCliRuntime, local_cli_headers, credential_path


def test_cli_credentials_follow_the_shared_config_directory(tmp_path, monkeypatch):
    import services.config as config
    monkeypatch.delenv('WORKSTEP_CONFIG_DIR', raising=False)
    monkeypatch.setattr(config, 'CONFIG_DIR', tmp_path / 'isolated-config')
    assert credential_path('http://127.0.0.1:8765').parent == config.CONFIG_DIR / 'cli-runtime'


@pytest.mark.skipif(os.name == 'nt', reason='PID liveness is verified on POSIX')
def test_another_process_cannot_replace_a_live_cli_instance(tmp_path, monkeypatch):
    monkeypatch.setenv('WORKSTEP_CONFIG_DIR', str(tmp_path))
    runtime = LocalCliRuntime('http://127.0.0.1:8765')
    runtime.publish()
    path = credential_path(runtime.url)
    value = json.loads(path.read_text())
    value['pid'] = os.getppid()
    path.write_text(json.dumps(value))
    original = path.read_bytes()
    replacement = LocalCliRuntime(runtime.url)
    with pytest.raises(RuntimeError, match='another live process'):
        replacement.publish()
    replacement.close()
    assert path.read_bytes() == original


@pytest.mark.parametrize('failure', ['rejected', 'timeout'])
def test_windows_acl_failure_records_cause_without_environment(tmp_path, monkeypatch, caplog, failure):
    import services.local_cli as cli
    monkeypatch.setattr(cli, 'os', SimpleNamespace(name='nt', environ={'SECRET': 'never-log-this'}))

    def run(arguments, **kwargs):
        if failure == 'timeout':
            raise cli.subprocess.TimeoutExpired(arguments, 10)
        return SimpleNamespace(returncode=1, stderr=b'Access is denied')

    monkeypatch.setattr(cli.subprocess, 'run', run)
    assert not cli._windows_private([tmp_path], protect=True)
    assert ('Access is denied' if failure == 'rejected' else 'timed out') in caplog.text
    assert 'never-log-this' not in caplog.text


def test_windows_acl_child_does_not_inherit_incompatible_powershell_module_path(tmp_path, monkeypatch):
    import services.local_cli as cli
    inherited = {'PSMODULEPATH': 'powershell-seven-modules', 'OTHER': 'retained'}
    monkeypatch.setattr(cli, 'os', SimpleNamespace(name='nt', environ=inherited))
    calls = []

    def run(arguments, **kwargs):
        calls.append(kwargs['env'])
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(cli.subprocess, 'run', run)
    assert cli._windows_private([tmp_path], protect=True)
    assert not any(key.casefold() == 'psmodulepath' for key in calls[0])
    assert calls[0]['OTHER'] == 'retained'
    assert inherited['PSMODULEPATH'] == 'powershell-seven-modules'


@pytest.mark.anyio
@pytest.mark.parametrize('desktop', [False, True])
async def test_local_cli_reads_projects_in_gateway_mode_without_login(tmp_path, monkeypatch, desktop):
    monkeypatch.setenv('WORKSTEP_CONFIG_DIR', str(tmp_path))
    monkeypatch.delenv('WORKSTEP_DESKTOP_TOKEN', raising=False)
    monkeypatch.delenv('WORKSTEP_DESKTOP_RUNTIME', raising=False)
    if desktop:
        monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
        monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'runtime-only')
    url = 'http://127.0.0.1:8765'
    runtime = LocalCliRuntime(url)
    await asyncio.to_thread(runtime.publish)
    app = FastAPI()
    app.state.local_cli_runtime = runtime
    app.state.gateway_client = SimpleNamespace(managed_config=object(), local_sessions=ManagedLocalSessions())
    app.add_middleware(DesktopSecurityMiddleware)

    @app.get('/api/project/list')
    async def projects():
        return {'projects': []}

    transport = httpx.ASGITransport(app=app, client=('127.0.0.1', 43210))
    result = await WorkstepClient(base_url=url, transport=transport).call('workstep_list_projects')
    assert result == {'projects': []}
    async with httpx.AsyncClient(transport=transport, base_url=url) as browser:
        assert (await browser.get('/api/project/list')).status_code == 401
        headers = local_cli_headers(url)
        assert (await browser.get('/api/project/list', headers={**headers, 'Origin': url})).status_code == 401
        assert (await browser.get('/api/project/list', headers={**headers, 'Sec-Fetch-Site': 'same-origin'})).status_code == 401
        assert (await browser.get('/api/project/list', headers={**headers, 'X-Forwarded-For': '192.0.2.10'})).status_code == 401
    remote = httpx.ASGITransport(app=app, client=('192.0.2.10', 43210))
    async with httpx.AsyncClient(transport=remote, base_url=url) as client:
        assert (await client.get('/api/project/list', headers=headers)).status_code == 401
    await asyncio.to_thread(runtime.close)
    assert local_cli_headers(url) == {}


@pytest.mark.anyio
async def test_local_cli_reads_remote_tasks_without_forwarding_local_credentials(tmp_path, monkeypatch):
    from api.remote_project_proxy import RemoteProjectProxyMiddleware
    from services.remote_protocol import RemoteHttpResponse
    from services.remote_registry import RemoteProjectRegistry
    from tests.test_remote_project import MemoryConfig

    monkeypatch.setenv('WORKSTEP_CONFIG_DIR', str(tmp_path))
    monkeypatch.setenv('WORKSTEP_DESKTOP_RUNTIME', '1')
    monkeypatch.delenv('WORKSTEP_DESKTOP_TOKEN', raising=False)
    url = 'http://127.0.0.1:8765'
    runtime = LocalCliRuntime(url)
    await asyncio.to_thread(runtime.publish)
    config = MemoryConfig()
    config.set('remote_projects', [{'id': 'remote:abc', 'name': 'Remote project'}])
    forwarded = []
    remote_status = 200

    class Manager:
        async def request(self, project_id, request):
            forwarded.append((project_id, request))
            return RemoteHttpResponse(
                request_id=request.request_id, status=remote_status,
                headers={'content-type': 'application/json'},
                body=json.dumps({'id': 'task-1', 'status': 'paused'} if remote_status == 200
                                else {'detail': 'project scope denied'}).encode(),
            )

    app = FastAPI()
    app.state.local_cli_runtime = runtime
    app.state.gateway_client = SimpleNamespace(managed_config=object(), local_sessions=ManagedLocalSessions())
    app.add_middleware(RemoteProjectProxyMiddleware, registry=RemoteProjectRegistry(config), client_manager=Manager())
    app.add_middleware(DesktopSecurityMiddleware)
    transport = httpx.ASGITransport(app=app, client=('127.0.0.1', 43210))
    try:
        client = WorkstepClient(base_url=url, transport=transport)
        result = await client.call('workstep_get_task', {'project_id': 'remote:abc', 'task_id': 'task-1'})
        assert result == {'id': 'task-1', 'status': 'paused'}
        assert forwarded[0][0] == 'remote:abc'
        assert not any('token' in key.lower() for key in forwarded[0][1].headers)
        remote_status = 403
        result = await client.call('workstep_get_task', {'project_id': 'remote:abc', 'task_id': 'task-1'})
        assert result == {'ok': False, 'error': 'project scope denied'}
    finally:
        await asyncio.to_thread(runtime.close)


def test_credentials_are_port_scoped_private_and_restart_safe(tmp_path, monkeypatch):
    monkeypatch.setenv('WORKSTEP_CONFIG_DIR', str(tmp_path))
    first = LocalCliRuntime('http://127.0.0.1:8765')
    first.publish()
    path = credential_path(first.url)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    original = local_cli_headers(first.url)
    assert original and local_cli_headers('http://127.0.0.1:8766') == {}
    assert local_cli_headers('https://example.com') == {}
    assert local_cli_headers('http://127.0.0.1:8765@evil.example.com') == {}
    second = LocalCliRuntime(first.url)
    second.publish()
    assert local_cli_headers(first.url) != original
    first.close()  # Old daemon shutdown must not delete its replacement's file.
    assert local_cli_headers(second.url)
    second.close()
    assert not path.exists()


def test_unsafe_or_stale_credentials_are_rejected(tmp_path, monkeypatch):
    monkeypatch.setenv('WORKSTEP_CONFIG_DIR', str(tmp_path))
    runtime = LocalCliRuntime('http://127.0.0.1:8765')
    runtime.publish()
    path = credential_path(runtime.url)
    path.chmod(0o644)
    assert local_cli_headers(runtime.url) == {}
    path.chmod(0o600)
    data = json.loads(path.read_text())
    data['pid'] = 999999999
    path.write_text(json.dumps(data))
    assert local_cli_headers(runtime.url) == {}
    path.unlink()
    target = tmp_path / 'other'
    target.write_text(json.dumps({**data, 'pid': os.getpid()}))
    target.chmod(0o600)
    path.symlink_to(target)
    assert local_cli_headers(runtime.url) == {}


@pytest.mark.anyio
async def test_credential_disk_io_does_not_block_cli_event_loop(tmp_path, monkeypatch):
    monkeypatch.setenv('WORKSTEP_CONFIG_DIR', str(tmp_path))
    import services.tool_registry as registry
    real = registry.local_cli_headers
    def slow(url):
        time.sleep(0.1)
        return real(url)
    monkeypatch.setattr(registry, 'local_cli_headers', slow)
    task = asyncio.create_task(WorkstepClient(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json={'projects': []}))).call('workstep_list_projects'))
    started = time.monotonic()
    await asyncio.sleep(0.01)
    assert time.monotonic() - started < 0.08
    assert not task.done()
    await task


@pytest.mark.anyio
async def test_missing_local_credentials_explain_daemon_repair_instead_of_browser_login(tmp_path, monkeypatch):
    monkeypatch.setenv('WORKSTEP_CONFIG_DIR', str(tmp_path))
    monkeypatch.delenv('WORKSTEP_DESKTOP_TOKEN', raising=False)
    result = await WorkstepClient(base_url='http://127.0.0.1:8765', transport=httpx.MockTransport(
        lambda request: httpx.Response(401, json={'detail': 'desktop authentication required'}),
    )).call('workstep_list_projects')
    assert result['ok'] is False
    assert '本机 CLI 凭据' in result['error']
    assert '重启目标 daemon' in result['error']
    assert '无需在浏览器登录' in result['error']


@pytest.mark.anyio
@pytest.mark.parametrize('url', ['https://example.com', 'http://127.0.0.1:8766'])
async def test_cli_never_leaks_desktop_token_to_a_different_daemon(url, tmp_path, monkeypatch):
    monkeypatch.setenv('WORKSTEP_CONFIG_DIR', str(tmp_path))
    monkeypatch.setenv('WORKSTEP_DESKTOP_TOKEN', 'ephemeral-test-secret')
    monkeypatch.setenv('WORKSTEP_DAEMON_URL', 'http://127.0.0.1:8765')
    async def handler(request):
        assert 'x-workstep-desktop-token' not in request.headers
        assert 'x-workstep-cli-token' not in request.headers
        return httpx.Response(200, json={'projects': []})
    await WorkstepClient(base_url=url, transport=httpx.MockTransport(handler)).call('workstep_list_projects')
