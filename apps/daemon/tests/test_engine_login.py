"""Native login through the generic host-only engine contract."""
import asyncio
import stat
import time

import httpx
import pytest
from fastapi import FastAPI

from engines.antigravity import AntigravityEngine
from services.engine_login import EngineLoginManager


@pytest.fixture
def binary(tmp_path, monkeypatch):
    script = tmp_path / 'agy'
    script.write_text('''#!/usr/bin/env python3
import os, sys, time
assert sys.argv[1:] == ['acp', '--login']
mode = os.getenv('LOGIN_FIXTURE', '')
if mode == 'hang':
    time.sleep(30)
if mode == 'overflow':
    print('x' * 300000, flush=True)
    time.sleep(30)
sys.stderr.write('Open this link in a browser to log in with Google:\\n\\n  https://accounts.google.com/o/oauth2/auth?state=fixture\\n\\n')
sys.stderr.flush()
sys.stdout.write('Then paste the authorization code, or the full URL of the page you land on, and press Enter: ')
sys.stdout.flush()
code = sys.stdin.readline().strip()
if code != 'test-code':
    print('sensitive diagnostic: ' + code, flush=True)
    sys.exit(1)
with open(os.path.join(os.environ['HOME'], 'login-persisted'), 'w') as f:
    f.write('native credential fixture')
print('Signed in successfully', flush=True)
''')
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv('HOME', str(tmp_path))
    monkeypatch.setattr(AntigravityEngine, 'resolve_binary', staticmethod(lambda: str(script)))
    from engines.antigravity import config_store
    monkeypatch.setattr(config_store, 'clear_engine_models', lambda _: None)
    monkeypatch.setattr(config_store, 'set_engine_verified', lambda *_: None)
    return script


async def phase(manager, target):
    async with asyncio.timeout(3):
        while True:
            state = manager.status('antigravity')
            if state and state['phase'] == target:
                return state
            await asyncio.sleep(.01)


@pytest.mark.asyncio
async def test_code_reaches_same_native_process_and_home_is_persistent(binary):
    manager = EngineLoginManager()
    revision = AntigravityEngine._login_revision
    try:
        first = await manager.start('antigravity', AntigravityEngine())
        state = await phase(manager, 'waiting_code')
        assert state['id'] == first['id']
        assert state['authorization_url'].startswith('https://accounts.google.com/')
        await manager.submit('antigravity', first['id'], 'test-code')
        state = await phase(manager, 'succeeded')
        assert state['authorization_url'] is None
        assert 'test-code' not in str(state)
        assert (binary.parent / 'login-persisted').is_file()
        assert AntigravityEngine._login_revision == revision + 1
        assert AntigravityEngine().project_skill_env('')['WORKSTEP_ENGINE_LOGIN_REVISION'] == str(revision + 1)
        second = await manager.start('antigravity', AntigravityEngine())
        assert second['id'] != first['id']
        with pytest.raises(ValueError, match='expired'):
            await manager.submit('antigravity', first['id'], 'test-code')
    finally:
        await manager.shutdown()


@pytest.mark.asyncio
async def test_failure_does_not_expose_native_diagnostics_or_code(binary):
    manager = EngineLoginManager()
    try:
        state = await manager.start('antigravity', AntigravityEngine())
        await phase(manager, 'waiting_code')
        await manager.submit('antigravity', state['id'], 'secret-code')
        result = await phase(manager, 'failed')
        assert result['error'] == 'login_failed'
        assert 'secret-code' not in str(result)
        assert 'sensitive' not in str(result)
    finally:
        await manager.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize('mode', ['hang', 'overflow'])
async def test_timeout_and_output_limits_reap_native_process(binary, monkeypatch, mode):
    monkeypatch.setenv('LOGIN_FIXTURE', mode)
    monkeypatch.setattr(AntigravityEngine, 'LOGIN_TIMEOUT_SECONDS', .2)
    manager = EngineLoginManager()
    try:
        await manager.start('antigravity', AntigravityEngine())
        result = await phase(manager, 'failed')
        assert result['error'] in ('login_timeout', 'login_output_limit')
        assert manager.sessions['antigravity'].process.returncode is not None
    finally:
        await manager.shutdown()


@pytest.mark.asyncio
async def test_duplicate_start_cancel_and_shutdown(binary):
    manager = EngineLoginManager()
    first, second = await asyncio.gather(*(manager.start('antigravity', AntigravityEngine()) for _ in range(2)))
    assert first['id'] == second['id']
    waiting = await phase(manager, 'waiting_code')
    process = manager.sessions['antigravity'].process
    with pytest.raises(ValueError):
        await manager.submit('antigravity', waiting['id'], 'line1\nline2')
    result = await manager.cancel('antigravity', waiting['id'])
    assert result['phase'] == 'cancelled'
    assert result['authorization_url'] is None
    assert process.returncode is not None
    await manager.start('antigravity', AntigravityEngine())
    await phase(manager, 'waiting_code')
    process = manager.sessions['antigravity'].process
    await manager.shutdown()
    assert process.returncode is not None


@pytest.mark.asyncio
async def test_cancellation_during_native_launch_waits_then_reaps_process(binary, monkeypatch):
    original = asyncio.create_subprocess_exec
    entered = asyncio.Event()
    async def slow_launch(*args, **kwargs):
        entered.set()
        await asyncio.sleep(.1)
        return await original(*args, **kwargs)
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', slow_launch)
    manager = EngineLoginManager()
    state = await manager.start('antigravity', AntigravityEngine())
    await entered.wait()
    result = await manager.cancel('antigravity', state['id'])
    assert result['phase'] == 'cancelled'
    assert manager.sessions['antigravity'].process.returncode is not None
    await manager.shutdown()


@pytest.mark.asyncio
async def test_untrusted_url_is_not_exposed_to_browser(binary, monkeypatch):
    binary.write_text(binary.read_text().replace('https://accounts.google.com/', 'https://accounts.google.com.evil.invalid/'))
    monkeypatch.setattr(AntigravityEngine, 'LOGIN_TIMEOUT_SECONDS', .15)
    manager = EngineLoginManager()
    await manager.start('antigravity', AntigravityEngine())
    async with asyncio.timeout(2):
        while manager.sessions['antigravity'].state.active:
            state = manager.status('antigravity')
            assert state['authorization_url'] is None
            assert state['phase'] != 'waiting_code'
            await asyncio.sleep(.01)
    await manager.shutdown()


@pytest.mark.asyncio
async def test_generic_routes_authorize_before_engine_lookup_and_keep_loop_responsive(binary, monkeypatch):
    import api.engine_login as api
    from services.remote_access import ActorSnapshot, actor_context
    manager = EngineLoginManager()
    monkeypatch.setattr(api, 'login_manager', manager)
    calls = []
    def slow_lookup(engine_id):
        calls.append(engine_id)
        time.sleep(.2)
        return AntigravityEngine()
    monkeypatch.setattr(api, 'create_engine', slow_lookup)
    app = FastAPI()
    app.include_router(api.router, prefix='/api/engine')
    @app.get('/health')
    async def health():
        return {'ok': True}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        actor = ActorSnapshot(actor_id='project', user_name='Project', device_id='device',
                              device_name='Device', source='remote', project_id='p', access_level='edit')
        with actor_context(actor):
            for method, suffix, body in [('GET', '', None), ('POST', '', None),
                                         ('POST', '/code', {'id':'old','code':'test-code'}),
                                         ('POST', '/cancel', {'id':'old'})]:
                response = await client.request(method, '/api/engine/antigravity/login' + suffix, json=body)
                assert response.status_code == 403
        assert calls == []
        request = asyncio.create_task(client.post('/api/engine/antigravity/login'))
        await asyncio.sleep(.02)
        assert (await asyncio.wait_for(client.get('/health'), .1)).status_code == 200
        response = await request
        assert response.status_code == 200
        state = await phase(manager, 'waiting_code')
        assert (await client.get('/api/engine/antigravity/login')).json()['id'] == state['id']
        assert (await client.post('/api/engine/antigravity/login/code', json={'id':'old','code':'test-code'})).status_code == 409
        assert (await client.post('/api/engine/antigravity/login/code', json={'id':state['id'],'code':'test-code'})).status_code == 200
        await phase(manager, 'succeeded')
    await manager.shutdown()
