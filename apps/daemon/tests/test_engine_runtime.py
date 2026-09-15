"""Runtime version management contracts; registry and process boundaries are offline."""
import asyncio
import base64
import hashlib
import importlib.metadata
import json
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from api.engine import router
from engines.core.base import EngineInstallResult
from services import engine_runtime


@pytest.fixture
async def runtime_client(tmp_path, monkeypatch):
    monkeypatch.delenv("WORKSTEP_ENGINE_PACKAGE_DIR", raising=False)
    monkeypatch.setattr(engine_runtime.config_store, "set_engine_verified", lambda *args: None)
    async def unexpected_install(*args, **kwargs):
        raise AssertionError("Unexpected installer boundary: tests must stay offline")
    monkeypatch.setattr(engine_runtime, "install_python_package", unexpected_install)
    monkeypatch.setattr(engine_runtime, "install_with_command", unexpected_install)
    payload = b"a wheel payload"
    def registry(request):
        if request.url.host == "files.pythonhosted.org":
            return httpx.Response(200, content=payload)
        return httpx.Response(200, json={
            "info": {"version": "0.150.0"},
            "releases": {
                "0.146.0": [{"filename": "openai_codex-0.146.0-py3-none-any.whl"}],
                "0.150.0": [{
                    "filename": "openai_codex-0.150.0-py3-none-any.whl",
                    "url": "https://files.pythonhosted.org/package.whl",
                    "size": len(payload), "requires_python": ">=3.11",
                    "digests": {"sha256": hashlib.sha256(payload).hexdigest()},
                }],
            },
        })
    service = engine_runtime.EngineRuntimeManager(tmp_path, transport=httpx.MockTransport(registry))
    monkeypatch.setattr(engine_runtime, "runtime_manager", service)
    monkeypatch.setattr(service, "installed_version", lambda spec: "0.149.0")
    app = FastAPI()
    app.include_router(router)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client, service


async def test_versions_expose_compatible_package_size_and_minimum(runtime_client):
    client, _ = runtime_client
    response = await client.get("/api/engine/codex_sdk/runtime")
    assert response.status_code == 200
    data = response.json()
    assert data["current_version"] == "0.149.0"
    assert data["default_version"] == "0.150.0"
    assert [v["version"] for v in data["versions"]] == ["0.150.0"]
    assert data["versions"][0]["size_bytes"] == 15
    assert data["size_scope"] == "primary_package"


async def wait_finished(client, engine_id="codex_sdk"):
    for _ in range(200):
        state = (await client.get(f'/api/engine/{engine_id}/runtime/operation')).json()
        if state and state['status'] in ('succeeded', 'failed'):
            return state
        await asyncio.sleep(.01)
    pytest.fail('operation did not finish')


async def test_exact_version_install_tracks_bytes_and_persists_rollback(runtime_client, monkeypatch):
    client, service = runtime_client
    installed = ['0.149.0']
    monkeypatch.setattr(service, 'installed_version', lambda spec: installed[0])
    entered, finish = asyncio.Event(), asyncio.Event()
    async def install(package, *, upgrade=False):
        assert Path(package).read_bytes() == b'a wheel payload'
        assert '0.150.0' in package
        entered.set()
        await finish.wait()
        installed[0] = '0.150.0'
        return EngineInstallResult(success=True, message='done')
    monkeypatch.setattr(engine_runtime, 'install_python_package', install)
    response = await client.post('/api/engine/codex_sdk/runtime/operation', json={'version': '0.150.0'})
    assert response.status_code == 202
    await asyncio.wait_for(entered.wait(), 2)
    state = (await client.get('/api/engine/codex_sdk/runtime/operation')).json()
    assert state['stage'] == 'installing'
    assert state['downloaded_bytes'] == state['total_bytes'] == 15
    assert state['status'] == 'running'
    busy = await client.post('/api/engine/codex_sdk/runtime/operation', json={'version': '0.150.0'})
    assert busy.status_code == 409
    finish.set()
    state = await wait_finished(client)
    assert state['status'] == 'succeeded'
    fresh = engine_runtime.EngineRuntimeManager(service.directory, transport=service.transport)
    monkeypatch.setattr(fresh, 'installed_version', lambda spec: installed[0])
    catalog = await fresh.catalog('codex_sdk')
    assert catalog['rollback_version'] == '0.149.0'
    assert catalog['history'][-1]['to_version'] == '0.150.0'


async def test_failed_install_keeps_previous_version_for_rollback(runtime_client, monkeypatch):
    client, service = runtime_client
    async def fail(*args, **kwargs):
        return EngineInstallResult(success=False, message='disk full')
    monkeypatch.setattr(engine_runtime, 'install_python_package', fail)
    await client.post('/api/engine/codex_sdk/runtime/operation', json={'version': '0.150.0'})
    state = await wait_finished(client)
    assert state['status'] == 'failed'
    assert state['message'] == 'disk full'
    catalog = (await client.get('/api/engine/codex_sdk/runtime')).json()
    assert catalog['rollback_version'] == '0.149.0'
    assert catalog['history'] == []

    # The old version remains selectable for recovery even after a failed switch.
    transport = service.transport
    def registry(request):
        response = transport.handle_request(request)
        if request.url.host != 'files.pythonhosted.org':
            data = response.json()
            entry = dict(data['releases']['0.150.0'][0])
            entry['filename'] = 'openai_codex-0.149.0-py3-none-any.whl'
            data['releases']['0.149.0'] = [entry]
            return httpx.Response(200, json=data)
        return response
    service.transport = httpx.MockTransport(registry)
    async def restore(package, **kwargs):
        assert '0.149.0' in package
        return EngineInstallResult(success=True, message='restored')
    monkeypatch.setattr(engine_runtime, 'install_python_package', restore)
    response = await client.post('/api/engine/codex_sdk/runtime/operation', json={'rollback': True})
    assert response.status_code == 202
    assert response.json()['target_version'] == '0.149.0'
    assert (await wait_finished(client))['status'] == 'succeeded'


async def test_invalid_versions_and_terms_are_rejected_before_install(runtime_client):
    client, _ = runtime_client
    assert (await client.post('/api/engine/codex_sdk/runtime/operation', json={'version': '--help'})).status_code == 422
    assert (await client.post('/api/engine/codex_sdk/runtime/operation', json={'rollback': True})).status_code == 400
    assert (await client.post('/api/engine/qoder_sdk/runtime/operation', json={'version': '1.0.11'})).status_code == 400
    assert (await client.post('/api/engine/hermes/runtime/operation', json={'version': '1.0.0'})).status_code == 400


async def test_tampered_download_never_runs_installer(runtime_client, monkeypatch):
    client, service = runtime_client
    transport = service.transport
    def registry(request):
        if request.url.host == 'files.pythonhosted.org':
            return httpx.Response(200, content=b'corrupt payload')
        return transport.handle_request(request)
    service.transport = httpx.MockTransport(registry)
    async def forbidden(*args, **kwargs):
        pytest.fail('corrupt package must not be installed')
    monkeypatch.setattr(engine_runtime, 'install_python_package', forbidden)
    await client.post('/api/engine/codex_sdk/runtime/operation', json={'version': '0.150.0'})
    state = await wait_finished(client)
    assert state['status'] == 'failed'
    assert '校验失败' in state['message']


async def test_interrupted_operation_survives_restart(runtime_client):
    client, service = runtime_client
    service.directory.mkdir(parents=True, exist_ok=True)
    (service.directory / 'codex_sdk.json').write_text(json.dumps({
        'rollback_version': '0.149.0',
        'operation': {'id': 'interrupted', 'status': 'running', 'stage': 'installing'},
    }))
    state = (await client.get('/api/engine/codex_sdk/runtime/operation')).json()
    assert state['status'] == 'failed'
    assert '重启' in state['message']
    assert (await client.get('/api/engine/codex_sdk/runtime')).json()['rollback_version'] == '0.149.0'


async def test_npm_install_and_rollback_use_exact_archives(runtime_client, monkeypatch):
    client, service = runtime_client
    installed = ['1.0.0']
    monkeypatch.setattr(service, 'installed_version', lambda spec: installed[0])
    payload = b'compressed npm archive'
    digest = base64.b64encode(hashlib.sha512(payload).digest()).decode()
    def registry(request):
        if request.url.path.endswith('.tgz'):
            return httpx.Response(200, content=payload)
        return httpx.Response(200, json={'dist-tags': {'latest': '1.1.0'}, 'versions': {
            v: {'dist': {'tarball': f'https://registry.npmjs.org/pkg-{v}.tgz', 'integrity': f'sha512-{digest}'}}
            for v in ['1.0.0', '1.1.0']
        }})
    service.transport = httpx.MockTransport(registry)
    async def install(command, **kwargs):
        assert command[:3] == ['npm', 'install', '-g']
        assert Path(command[3]).read_bytes() == payload
        installed[0] = '1.1.0'
        return EngineInstallResult(success=True, message='ok')
    monkeypatch.setattr(engine_runtime, 'install_with_command', install)
    response = await client.post('/api/engine/codex/runtime/operation', json={'version': '1.1.0'})
    assert response.status_code == 202
    state = await wait_finished(client, 'codex')
    assert state['status'] == 'succeeded'
    assert state['downloaded_bytes'] == state['total_bytes'] == len(payload)
    assert (await client.get('/api/engine/codex/runtime')).json()['rollback_version'] == '1.0.0'


async def test_desktop_target_switch_is_staged_and_removes_old_metadata(runtime_client, monkeypatch, tmp_path):
    client, service = runtime_client
    target = tmp_path / 'desktop-packages'
    target.mkdir()
    old_info = target / 'openai_codex-0.149.0.dist-info'
    old_info.mkdir()
    (old_info / 'METADATA').write_text('Name: openai-codex\nVersion: 0.149.0\n')
    (target / 'unrelated.txt').write_text('keep')
    monkeypatch.setenv('WORKSTEP_ENGINE_PACKAGE_DIR', str(target))
    # Read actual on-disk metadata so stale dist-info is observable via the API.
    monkeypatch.setattr(service, 'installed_version', lambda spec: next(
        (d.version for d in importlib.metadata.distributions(path=[str(target)]) if d.metadata['Name'] == spec.name), None))
    async def pip(command, **kwargs):
        stage = Path(command[command.index('--target') + 1])
        assert stage != target
        assert old_info.exists()  # live directory still untouched
        info = stage / 'openai_codex-0.150.0.dist-info'
        info.mkdir()
        (info / 'METADATA').write_text('Name: openai-codex\nVersion: 0.150.0\n')
        report = Path(command[command.index('--report') + 1])
        report.write_text(json.dumps({'install': [{'metadata': {'name': 'openai-codex', 'version': '0.150.0'}}]}))
        return EngineInstallResult(success=True, message='ok')
    monkeypatch.setattr(engine_runtime, 'install_with_command', pip)
    await client.post('/api/engine/codex_sdk/runtime/operation', json={'version': '0.150.0'})
    state = await wait_finished(client)
    assert state['status'] == 'succeeded', state['message']
    assert not old_info.exists()
    assert (target / 'unrelated.txt').read_text() == 'keep'
    assert (await client.get('/api/engine/codex_sdk/runtime')).json()['current_version'] == '0.150.0'


async def test_progress_reports_partial_download_while_api_remains_responsive(runtime_client, monkeypatch):
    client, service = runtime_client
    payload = b'x' * 524288
    first, release = asyncio.Event(), asyncio.Event()
    class Download(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield payload[:262144]
            first.set()
            await release.wait()
            yield payload[262144:]
    def registry(request):
        if request.url.host == 'files.pythonhosted.org':
            return httpx.Response(200, headers={'Content-Length': str(len(payload))}, stream=Download())
        return httpx.Response(200, json={'info': {'version': '0.150.0'}, 'releases': {'0.150.0': [{
            'filename': 'openai_codex-0.150.0-py3-none-any.whl', 'url': 'https://files.pythonhosted.org/pkg.whl',
            'size': len(payload), 'digests': {'sha256': hashlib.sha256(payload).hexdigest()},
        }]}})
    service.transport = httpx.MockTransport(registry)
    async def install(*args, **kwargs):
        monkeypatch.setattr(service, 'installed_version', lambda spec: '0.150.0')
        return EngineInstallResult(success=True, message='ok')
    monkeypatch.setattr(engine_runtime, 'install_python_package', install)
    await client.post('/api/engine/codex_sdk/runtime/operation', json={'version': '0.150.0'})
    await asyncio.wait_for(first.wait(), 2)
    try:
        response = await asyncio.wait_for(client.get('/api/engine/codex_sdk/runtime/operation'), .5)
        state = response.json()
        assert state['stage'] == 'downloading'
        assert state['downloaded_bytes'] == 262144
        assert state['total_bytes'] == 524288
        assert (await client.post('/api/engine/codex_sdk/update')).status_code == 409
    finally:
        release.set()
    assert (await wait_finished(client))['status'] == 'succeeded'


async def test_desktop_failed_install_does_not_replace_live_directory(runtime_client, monkeypatch, tmp_path):
    client, service = runtime_client
    target = tmp_path / 'site'
    target.mkdir()
    (target / 'existing.py').write_text('original')
    monkeypatch.setenv('WORKSTEP_ENGINE_PACKAGE_DIR', str(target))
    async def fail(command, **kwargs):
        stage = Path(command[command.index('--target') + 1])
        (stage / 'existing.py').write_text('partially modified')
        return EngineInstallResult(success=False, message='installer failed')
    monkeypatch.setattr(engine_runtime, 'install_with_command', fail)
    await client.post('/api/engine/codex_sdk/runtime/operation', json={'version': '0.150.0'})
    assert (await wait_finished(client))['status'] == 'failed'
    assert (target / 'existing.py').read_text() == 'original'
