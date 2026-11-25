"""Native CLI uses the existing runtime lifecycle and WorkStep-only paths."""
import asyncio
import hashlib
import io
import tarfile
import time
import sys

import httpx
import pytest

from engines.antigravity import AntigravityEngine
from services import antigravity_runtime as native
from services import config, engine_runtime


def archive(version):
    payload = f'#!/bin/sh\necho "agy {version}"\n'.encode()
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:gz') as out:
        entry = tarfile.TarInfo('antigravity')
        entry.size = len(payload)
        entry.mode = 0o755
        out.addfile(entry, io.BytesIO(payload))
    return stream.getvalue()


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    if sys.platform == 'win32':
        pytest.skip('This fixture executes a POSIX shell binary')
    monkeypatch.setattr(config, 'CONFIG_DIR', tmp_path / 'workstep')
    monkeypatch.setattr(native, 'platform_key', lambda: 'darwin_arm64')
    monkeypatch.setattr(AntigravityEngine, '_binary_override', None)
    monkeypatch.delenv('ANTIGRAVITY_BIN', raising=False)
    monkeypatch.setattr('engines.antigravity.shutil.which', lambda _: None)
    monkeypatch.setattr(engine_runtime.config_store, 'set_engine_verified', lambda *args: None)
    monkeypatch.setattr('engines.core.registry.refresh_registry', lambda: None)
    current = ['1.2.0']
    payloads = {version: archive(version) for version in ['1.2.0', '1.3.0']}
    requests = []
    def remote(request):
        requests.append(request)
        if request.url.host == native.MANIFEST_HOST:
            version = current[0]
            return httpx.Response(200, json={
                'version': version, 'url': f'https://storage.googleapis.com/antigravity-public/antigravity-cli/{version}/cli.tar.gz',
                'sha512': hashlib.sha512(payloads[version]).hexdigest(),
            })
        version = request.url.path.split('/')[-2]
        payload = payloads[version]
        if request.method == 'HEAD':
            return httpx.Response(200, headers={'content-length': str(len(payload))})
        return httpx.Response(200, content=payload)
    manager = engine_runtime.EngineRuntimeManager(tmp_path / 'records', transport=httpx.MockTransport(remote))
    return manager, current, payloads, requests


@pytest.mark.asyncio
@pytest.mark.parametrize('ignore_range', [False, True])
async def test_native_download_resumes_and_cleanup_preserves_installed_content(tmp_path, ignore_range):
    from services.resource_download import ResourceDownload
    payload = b'first-second'
    entry = {'version':'1.0.0', 'url':'https://storage.googleapis.com/antigravity-public/antigravity-cli/1/cli.tar.gz',
             'sha512':hashlib.sha512(payload).hexdigest(), 'size_bytes':len(payload)}
    calls = []
    class Broken(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield payload[:6]
            raise httpx.ReadError('interrupted')
    def remote(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(200, stream=Broken())
        assert request.headers['range'] == 'bytes=6-'
        if ignore_range:
            return httpx.Response(200, content=payload)
        return httpx.Response(206, headers={'content-range':f'bytes 6-{len(payload)-1}/{len(payload)}'}, content=payload[6:])
    manager = engine_runtime.EngineRuntimeManager(tmp_path / 'records', transport=httpx.MockTransport(remote))
    target = tmp_path / 'archive.tar.gz'
    with pytest.raises(httpx.ReadError):
        await manager._download(entry, target, {'downloaded_bytes':0})
    cache = ResourceDownload(manager.directory, 'antigravity')
    assert cache.cached_bytes() == 6
    state = {'downloaded_bytes':0}
    await manager._download(entry, target, state)
    assert target.read_bytes() == payload
    assert state['downloaded_bytes'] == state['total_bytes'] == len(payload)
    other = manager.directory / '.downloads' / 'other'
    other.mkdir()
    (other / 'keep').write_text('keep')
    cache.discard()
    assert target.read_bytes() == payload
    assert (other / 'keep').read_text() == 'keep'


@pytest.mark.asyncio
async def test_native_override_blocks_installation(runtime, monkeypatch):
    manager, _, _, requests = runtime
    monkeypatch.setenv('ANTIGRAVITY_BIN', '/external/agy')
    with pytest.raises(ValueError, match='custom executable'):
        await manager.start('antigravity', '1.2.0')
    assert requests == []
    assert not native.managed_binary().exists()


def test_native_managed_binary_precedes_host_path(runtime, monkeypatch):
    binary = native.managed_binary()
    binary.parent.mkdir(parents=True)
    binary.write_text('managed fixture')
    monkeypatch.setattr('engines.antigravity.shutil.which', lambda _: '/external/agy')
    assert AntigravityEngine.resolve_binary() == str(binary)


@pytest.mark.asyncio
async def test_external_install_is_fallback_and_not_the_managed_version(runtime, monkeypatch):
    manager, _, _, _ = runtime
    monkeypatch.setattr('engines.antigravity.shutil.which', lambda _: '/external/agy')
    assert AntigravityEngine.resolve_binary() == '/external/agy'
    assert (await manager.catalog('antigravity'))['current_version'] is None


def test_native_release_rejects_untrusted_origin_and_checksum():
    with pytest.raises(ValueError, match='download address'):
        native.validate_release({'url':'https://example.com/cli.exe'})
    with pytest.raises(ValueError, match='checksum'):
        native.validate_release({'url':'https://storage.googleapis.com/antigravity-public/antigravity-cli/1/cli.exe','sha512':'bad'})


async def install(manager, version, **kwargs):
    await manager.start('antigravity', version, **kwargs)
    await manager._task
    return await manager.operation('antigravity')


@pytest.mark.asyncio
async def test_native_runtime_installs_exact_version_and_rolls_back(runtime):
    manager, current, _, requests = runtime
    assert manager.package('antigravity').kind == 'native'
    catalog = await manager.catalog('antigravity')
    assert catalog['default_version'] == '1.2.0'
    assert catalog['versions'][0]['size_bytes'] > 0
    assert (await install(manager, '1.2.0'))['status'] == 'succeeded'
    binary = native.managed_binary()
    assert binary.is_relative_to(config.CONFIG_DIR / 'runtime')
    assert AntigravityEngine.resolve_binary() == str(binary)
    assert AntigravityEngine.get_version().endswith('1.2.0')
    current[0] = '1.3.0'
    assert (await install(manager, '1.3.0'))['status'] == 'succeeded'
    restarted = engine_runtime.EngineRuntimeManager(manager.directory, transport=manager.transport)
    assert (await install(restarted, None, rollback=True))['status'] == 'succeeded'
    assert AntigravityEngine.get_version().endswith('1.2.0')
    assert len((await restarted.catalog('antigravity'))['history']) == 3
    assert all(r.method in ('GET', 'HEAD') for r in requests)


@pytest.mark.asyncio
async def test_native_checksum_failure_preserves_installed_binary(runtime):
    manager, current, _, _ = runtime
    assert (await install(manager, '1.2.0'))['status'] == 'succeeded'
    old = native.managed_binary().read_bytes()
    current[0] = '1.3.0'
    remote = manager.transport.handler
    def corrupt(request):
        response = remote(request)
        if request.method == 'GET' and request.url.host == 'storage.googleapis.com':
            return httpx.Response(200, content=b'x' * len(response.content))
        return response
    manager.transport = httpx.MockTransport(corrupt)
    state = await install(manager, '1.3.0')
    assert state['status'] == 'failed'
    assert native.managed_binary().read_bytes() == old


@pytest.mark.asyncio
async def test_native_stage_version_failure_preserves_previous_install(runtime, monkeypatch):
    manager, current, _, _ = runtime
    assert (await install(manager, '1.2.0'))['status'] == 'succeeded'
    old = native.managed_binary().read_bytes()
    current[0] = '1.3.0'
    monkeypatch.setattr(native, 'binary_version', lambda _: '9.9.9')
    assert (await install(manager, '1.3.0'))['status'] == 'failed'
    assert native.managed_binary().read_bytes() == old


@pytest.mark.asyncio
async def test_slow_native_extract_does_not_block_event_loop(runtime, monkeypatch):
    manager, _, _, _ = runtime
    original = native.stage_binary
    import threading
    entered = threading.Event()
    def slow(*args):
        entered.set()
        time.sleep(.2)
        return original(*args)
    monkeypatch.setattr(native, 'stage_binary', slow)
    await manager.start('antigravity', '1.2.0')
    while not entered.is_set():
        if manager._task.done():
            pytest.fail(str(await manager.operation('antigravity')))
        await asyncio.sleep(.005)
    await asyncio.wait_for(asyncio.sleep(.01), .1)
    await manager._task
    assert (await manager.operation('antigravity'))['status'] == 'succeeded'
