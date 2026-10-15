"""LLM child processes use saved credentials through the real Git protocol."""

import asyncio
import json
import os
import shlex
import sys
from contextlib import asynccontextmanager

import pytest

from services.git.credentials import save_credentials
from services.git.engine_credentials import install_engine_credentials


@pytest.fixture
def credential_env(tmp_path, monkeypatch):
    monkeypatch.setenv('GIT_CONFIG_GLOBAL', os.devnull)
    monkeypatch.setenv('GIT_CONFIG_NOSYSTEM', '1')
    monkeypatch.setenv('GIT_TERMINAL_PROMPT', '0')
    monkeypatch.delenv('GIT_CONFIG_PARAMETERS', raising=False)
    monkeypatch.setenv('GIT_CONFIG_COUNT', '0')
    path = tmp_path / "credentials with spaces ' quote" / 'git-credentials.json'
    save_credentials(path, {'git.example.test': {'username': 'alice', 'token': 'test-secret'}})
    restore = install_engine_credentials(path)
    yield path
    restore()


async def fill(url, cwd, env=None):
    process = await asyncio.create_subprocess_exec(
        'git', 'credential', 'fill', cwd=cwd, env=env,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate(f'url={url}\n\n'.encode())
    return process.returncode, stdout.decode(), stderr.decode()


@pytest.mark.asyncio
async def test_llm_child_git_reads_latest_saved_credentials(credential_env, tmp_path):
    code, output, error = await fill('https://git.example.test/repo.git', tmp_path)
    assert code == 0, error
    assert 'username=alice' in output
    assert 'password=test-secret' in output
    # Only paths/configuration travel through the engine environment, no secrets.
    assert 'test-secret' not in json.dumps(dict(os.environ))
    save_credentials(credential_env, {'git.example.test': {'username': 'bob', 'token': 'new-secret'}})
    code, output, error = await fill('https://git.example.test/other.git', tmp_path)
    assert code == 0, error
    assert 'username=bob' in output and 'password=new-secret' in output
    save_credentials(credential_env, {})
    code, output, _ = await fill('https://git.example.test/repo.git', tmp_path)
    assert code != 0
    assert 'secret' not in output


@pytest.mark.asyncio
@pytest.mark.parametrize('url', [
    'https://other.example.test/repo.git',
    'http://git.example.test/repo.git',
    'https://git.example.test:8443/repo.git',
    'https://mallory@git.example.test/repo.git',
])
async def test_credentials_are_scoped_to_https_host_and_account(credential_env, tmp_path, url):
    code, output, _ = await fill(url, tmp_path)
    assert code != 0
    assert 'test-secret' not in output


@pytest.mark.asyncio
async def test_invalid_credential_file_does_not_expose_contents(credential_env, tmp_path):
    credential_env.write_text('{broken test-secret')
    code, output, error = await fill('https://git.example.test/repo.git', tmp_path)
    assert code != 0
    assert 'test-secret' not in output + error


@pytest.mark.asyncio
async def test_filtered_engine_environment_can_use_saved_credentials(credential_env, tmp_path):
    filtered = {key: value for key, value in os.environ.items()
                if not any(word in key.upper() for word in ('KEY', 'TOKEN', 'SECRET'))}
    code, output, error = await fill('https://git.example.test/repo.git', tmp_path, filtered)
    assert code == 0, error
    assert 'password=test-secret' in output


@pytest.mark.asyncio
async def test_provider_child_environment_can_use_saved_credentials(credential_env, tmp_path):
    from engines.core.base import ProviderRuntimeConfig

    env = ProviderRuntimeConfig(env={'ENGINE_MODEL': 'test'}).child_env()
    code, output, error = await fill('https://git.example.test/repo.git', tmp_path, env)
    assert code == 0, error
    assert 'password=test-secret' in output


@pytest.mark.asyncio
@pytest.mark.parametrize('filtered', [False, True])
async def test_harness_shell_git_uses_common_helper(credential_env, tmp_path, filtered):
    from engines.pydantic_ai.coder import WorkStepShell

    request = tmp_path / 'request.txt'
    request.write_text('url=https://git.example.test/repo.git\n\n')
    toolset = WorkStepShell(
        cwd=tmp_path,
        denied_env_patterns=['*KEY*', '*TOKEN*', '*SECRET*'] if filtered else (),
    ).get_toolset()
    output = await toolset.run_command('git credential fill < request.txt')
    assert 'username=alice' in output
    assert 'password=test-secret' in output


@pytest.mark.asyncio
async def test_existing_git_parameters_and_child_overrides_remain_effective(credential_env, tmp_path, monkeypatch):
    monkeypatch.setenv('GIT_CONFIG_PARAMETERS', "'user.name'='Existing User' 'credential.helper'=''")
    before = dict(os.environ)
    restore = install_engine_credentials(credential_env)
    try:
        code, output, error = await fill('https://git.example.test/repo.git', tmp_path)
        assert code == 0, error
        assert 'password=test-secret' in output
        process = await asyncio.create_subprocess_exec(
            'git', '-c', 'user.email=child@example.test', 'config', '--get-regexp', '^user\\.',
            cwd=tmp_path, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()
        assert process.returncode == 0, stderr.decode()
        assert 'user.name Existing User' in stdout.decode()
        assert 'user.email child@example.test' in stdout.decode()
    finally:
        restore()
    assert dict(os.environ) == before


def test_environment_preserves_existing_git_config_and_restores(tmp_path, monkeypatch):
    monkeypatch.setenv('GIT_CONFIG_COUNT', '1')
    monkeypatch.setenv('GIT_CONFIG_KEY_0', 'http.proxy')
    monkeypatch.setenv('GIT_CONFIG_VALUE_0', 'http://proxy.test')
    before = dict(os.environ)
    restore = install_engine_credentials(tmp_path / 'credentials.json')
    assert os.environ['GIT_CONFIG_COUNT'] == '1'
    assert os.environ['GIT_CONFIG_VALUE_0'] == 'http://proxy.test'
    assert 'credential.helper=' in os.environ['GIT_CONFIG_PARAMETERS']
    restore()
    assert dict(os.environ) == before


@pytest.mark.asyncio
async def test_slow_credential_helper_does_not_block_health(credential_env, tmp_path, monkeypatch):
    from httpx import ASGITransport, AsyncClient
    from main import app

    helper = shlex.split(os.environ['GIT_CONFIG_PARAMETERS'])[0].split('=', 1)[1][1:]
    marker = tmp_path / 'helper-started'
    slow = tmp_path / 'slow-helper.py'
    slow.write_text(
        'import pathlib, time\n'
        f'pathlib.Path({str(marker)!r}).touch()\n'
        'time.sleep(0.5)\n'
    )
    value = f'credential.helper=!{shlex.quote(sys.executable)} {shlex.quote(str(slow))}; {helper}'
    monkeypatch.setenv('GIT_CONFIG_PARAMETERS', "'" + value.replace("'", "'\\''") + "'")
    pending = asyncio.create_task(fill('https://git.example.test/repo.git', tmp_path))
    try:
        async with asyncio.timeout(2):
            while not await asyncio.to_thread(marker.exists):
                await asyncio.sleep(0.01)
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
            response = await asyncio.wait_for(client.get('/api/health'), timeout=0.2)
        assert response.status_code == 200
        assert not pending.done(), 'health must finish while the credential helper is still blocked'
        code, output, error = await pending
        assert code == 0, error
        assert 'password=test-secret' in output
    finally:
        await pending


@pytest.mark.asyncio
@pytest.mark.parametrize('startup_fails', [False, True])
async def test_daemon_lifecycle_installs_helper_before_engines_start(tmp_path, monkeypatch, startup_fails):
    import main

    path = tmp_path / 'credentials.json'
    save_credentials(path, {'git.example.test': {'username': 'alice', 'token': 'test-secret'}})
    monkeypatch.setattr(main.git_service, 'credential_file', path)
    monkeypatch.setenv('GIT_CONFIG_GLOBAL', os.devnull)
    monkeypatch.setenv('GIT_CONFIG_NOSYSTEM', '1')
    monkeypatch.setenv('GIT_CONFIG_COUNT', '0')
    before = dict(os.environ)

    @asynccontextmanager
    async def application_lifespan(app):
        code, output, error = await fill('https://git.example.test/repo.git', tmp_path)
        assert code == 0, error
        assert 'password=test-secret' in output
        if startup_fails:
            raise RuntimeError('startup failed')
        yield

    monkeypatch.setattr(main, '_application_lifespan', application_lifespan)
    if startup_fails:
        with pytest.raises(RuntimeError, match='startup failed'):
            async with main.lifespan(main.app):
                pass
    else:
        async with main.lifespan(main.app):
            pass
    assert dict(os.environ) == before
