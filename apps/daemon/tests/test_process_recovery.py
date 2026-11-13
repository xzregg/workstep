import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import psutil
import pytest

from services.process_recovery import ProcessOwnership, runtime_identity


def peer(env=None):
    return subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], env=env)


def stale_record(directory, process, token='a' * 32, *, created=None):
    directory.mkdir(parents=True, exist_ok=True)
    record = {'version': 2, 'realm': runtime_identity(), 'token': token, 'owner': {'pid': os.getpid(), 'created': -1},
              'children': [{'pid': process.pid, 'created': created or psutil.Process(process.pid).create_time()}]}
    (directory / (token + '.json')).write_text(json.dumps(record))


@pytest.mark.anyio
async def test_recovery_reaps_stale_identity_but_preserves_unrelated_and_pid_reuse(tmp_path):
    owned, other = peer(), peer()
    service = ProcessOwnership(tmp_path)
    try:
        stale_record(service.directory, owned)
        stale_record(service.directory, other, 'b' * 32, created=-1)
        await service.start()
        await asyncio.to_thread(owned.wait, 3)
        assert other.poll() is None
    finally:
        await service.close()
        assert other.poll() is None
        for process in [owned, other]:
            if process.poll() is None:
                process.kill()
            process.wait()


@pytest.mark.anyio
async def test_live_owner_is_not_reaped(tmp_path):
    other = peer()
    service = ProcessOwnership(tmp_path)
    stale_record(service.directory, other)
    file = service.directory / ('a' * 32 + '.json')
    record = json.loads(file.read_text())
    record['owner']['created'] = psutil.Process().create_time()
    file.write_text(json.dumps(record))
    try:
        await service.start()
        assert other.poll() is None
    finally:
        await service.close()
        other.kill(); other.wait()


@pytest.mark.anyio
async def test_marker_recovers_child_after_parent_kill_before_checkpoint(tmp_path):
    output = tmp_path / 'child.json'
    script = '''import asyncio,json,os,subprocess,sys
from pathlib import Path
from services.process_recovery import ProcessOwnership
async def main():
    owner=ProcessOwnership(Path(sys.argv[1]))
    await owner.start()
    child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],start_new_session=True)
    Path(sys.argv[2]).write_text(json.dumps({'pid':child.pid}))
    await asyncio.sleep(60)
asyncio.run(main())
'''
    parent = subprocess.Popen([sys.executable, '-c', script, str(tmp_path), str(output)])
    child = None
    service = ProcessOwnership(tmp_path)
    try:
        for _ in range(300):
            if output.exists():
                child = psutil.Process(json.loads(output.read_text())['pid'])
                child.create_time()
                break
            await asyncio.sleep(.01)
        assert child is not None
        parent.kill(); await asyncio.to_thread(parent.wait, 3)
        await service.start()
        assert not child.is_running() or child.status() == psutil.STATUS_ZOMBIE
    finally:
        await service.close()
        if parent.poll() is None: parent.kill()
        parent.wait()
        if child and child.is_running() and child.status() != psutil.STATUS_ZOMBIE: child.kill()


@pytest.mark.anyio
async def test_slow_recovery_does_not_block_event_loop(tmp_path, monkeypatch):
    service = ProcessOwnership(tmp_path)
    original = service.recover
    def slow():
        time.sleep(.2)
        return original()
    monkeypatch.setattr(service, 'recover', slow)
    task = asyncio.create_task(service.start())
    try:
        await asyncio.sleep(.02)
        started = time.monotonic()
        await asyncio.sleep(.02)
        assert time.monotonic() - started < .1 and not task.done()
        await task
    finally:
        await service.close()


@pytest.mark.anyio
async def test_normal_shutdown_cleans_marked_worker_and_corrupt_record_is_ignored(tmp_path):
    service = ProcessOwnership(tmp_path)
    service.directory.mkdir(parents=True)
    (service.directory / ('b' * 32 + '.json')).write_text('{invalid')
    await service.start()
    worker = peer()
    try:
        await service.close()
        await asyncio.to_thread(worker.wait, 3)
        assert not service.file.exists()
    finally:
        if worker.poll() is None: worker.kill()
        worker.wait()


@pytest.mark.anyio
async def test_live_daemon_with_same_config_is_not_reaped(tmp_path):
    output = tmp_path / 'live.json'
    script = """import asyncio,json,subprocess,sys
from pathlib import Path
from services.process_recovery import ProcessOwnership
async def main():
    owner=ProcessOwnership(Path(sys.argv[1]));await owner.start()
    child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])
    Path(sys.argv[2]).write_text(json.dumps({'pid':child.pid}))
    await asyncio.sleep(60)
asyncio.run(main())
"""
    parent = subprocess.Popen([sys.executable, '-c', script, str(tmp_path), str(output)])
    service = ProcessOwnership(tmp_path)
    child = None
    try:
        for _ in range(300):
            if output.exists():
                child = psutil.Process(json.loads(output.read_text())['pid']);child.create_time();break
            await asyncio.sleep(.01)
        assert child is not None
        await service.start()
        await service.close()
        assert parent.poll() is None and child.is_running()
    finally:
        await service.close()
        if parent.poll() is None:parent.kill()
        parent.wait()
        if child and child.is_running():child.kill()


@pytest.mark.anyio
async def test_close_waits_for_in_progress_checkpoint_before_final_reap(tmp_path, monkeypatch):
    import threading
    entered = threading.Event()
    service = ProcessOwnership(tmp_path)
    original = service.checkpoint
    def slow_checkpoint():
        entered.set();time.sleep(.15);original()
    monkeypatch.setattr(service, 'checkpoint', slow_checkpoint)
    await service.start()
    worker = peer()
    try:
        for _ in range(300):
            if entered.is_set():break
            await asyncio.sleep(.01)
        assert entered.is_set()
        await asyncio.wait_for(service.close(), 5)
        assert not service.file.exists()
        await asyncio.to_thread(worker.wait, 3)
    finally:
        await service.close()
        if worker.poll() is None:worker.kill()
        worker.wait()


@pytest.mark.anyio
async def test_startup_failure_still_reaps_all_workers_and_restores_environment(tmp_path, monkeypatch):
    from contextlib import asynccontextmanager
    import main
    import services.config as config
    import services.git.engine_credentials as credentials
    from services.process_recovery import OWNER_ENV
    restored=[]
    children=[]
    previous=os.environ.get(OWNER_ENV)
    monkeypatch.setattr(config, 'CONFIG_DIR', tmp_path)
    monkeypatch.setattr(credentials, 'install_engine_credentials', lambda path: lambda: restored.append(True))
    @asynccontextmanager
    async def failure(app):
        for role in ['speech-input', 'speech-output', 'jev']:
            children.append(await asyncio.create_subprocess_exec(sys.executable, '-c', 'import time; time.sleep(60)', role))
        raise RuntimeError('startup failed')
        yield
    monkeypatch.setattr(main, '_application_lifespan', failure)
    try:
        with pytest.raises(RuntimeError, match='startup failed'):
            async with main.lifespan(main.app):
                pass
        assert restored == [True]
        assert os.environ.get(OWNER_ENV) == previous
        for child in children:
            await asyncio.wait_for(child.wait(), 3)
    finally:
        for child in children:
            if child.returncode is None:child.kill()
            await child.wait()


@pytest.mark.anyio
async def test_nested_live_daemon_is_excluded_from_parent_final_sweep(tmp_path):
    service=ProcessOwnership(tmp_path)
    await service.start()
    other=peer()
    record=service.directory / ('b'*32+'.json')
    record.write_text(json.dumps({'version':2, 'realm': runtime_identity(), 'token':'b'*32,
        'owner':{'pid':other.pid,'created':psutil.Process(other.pid).create_time()}, 'children':[]}))
    try:
        await service.close()
        assert other.poll() is None
    finally:
        if other.poll() is None:other.kill()
        other.wait()


@pytest.mark.anyio
@pytest.mark.parametrize('operation', ['prepare', 'recover', 'write', 'checkpoint', 'reap'])
@pytest.mark.parametrize('error', [PermissionError, RuntimeError])
async def test_recovery_errors_do_not_prevent_startup_health_or_shutdown(tmp_path, monkeypatch, operation, error):
    from contextlib import asynccontextmanager
    from fastapi import FastAPI
    from httpx import AsyncClient, ASGITransport
    import main
    import services.config as config
    import services.git.engine_credentials as credentials
    from services.process_recovery import OWNER_ENV
    lifecycle = []
    previous = os.environ.get(OWNER_ENV)
    monkeypatch.setattr(config, 'CONFIG_DIR', tmp_path)
    monkeypatch.setattr(credentials, 'install_engine_credentials', lambda path: lambda: lifecycle.append('restored'))
    @asynccontextmanager
    async def application(app):
        lifecycle.append('started')
        try:
            yield
        finally:
            lifecycle.append('stopped')
    monkeypatch.setattr(main, '_application_lifespan', application)
    def fail(*args, **kwargs):
        raise error('injected failure')
    monkeypatch.setattr(ProcessOwnership, operation, fail)
    app = FastAPI(lifespan=main.lifespan)
    @app.get('/health')
    async def health(): return {'ok': True}
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
            assert (await asyncio.wait_for(client.get('/health'), .1)).json() == {'ok': True}
    assert lifecycle == ['started', 'stopped', 'restored']
    assert os.environ.get(OWNER_ENV) == previous


@pytest.mark.anyio
async def test_failed_final_checkpoint_still_reaps_marked_workers_and_retains_record(tmp_path, monkeypatch):
    service = ProcessOwnership(tmp_path)
    await service.start()
    worker = peer()
    def fail(): raise OSError('disk unavailable')
    monkeypatch.setattr(service, 'checkpoint', fail)
    try:
        await service.close()
        await asyncio.to_thread(worker.wait, 3)
        assert service.file.exists()
    finally:
        if worker.poll() is None:worker.kill()
        worker.wait()


@pytest.mark.anyio
async def test_failed_reap_retains_record_for_next_startup(tmp_path, monkeypatch):
    service = ProcessOwnership(tmp_path)
    await service.start()
    def fail(*args): raise RuntimeError('could not terminate')
    monkeypatch.setattr(service, 'reap', fail)
    await service.close()
    assert service.file.exists()


@pytest.mark.anyio
async def test_one_stale_record_failure_does_not_skip_other_record(tmp_path, monkeypatch):
    service = ProcessOwnership(tmp_path)
    service.directory.mkdir(parents=True)
    for token in ['a' * 32, 'b' * 32]:
        (service.directory / (token + '.json')).write_text(json.dumps({
            'version': 2, 'realm': runtime_identity(), 'token': token, 'owner': {'pid': os.getpid(), 'created': -1}, 'children': []}))
    def reap(record):
        if record['token'] == 'a' * 32: raise RuntimeError('failed first')
        return 0
    monkeypatch.setattr(service, 'reap', reap)
    await service.start()
    try:
        assert (service.directory / ('a' * 32 + '.json')).exists()
        assert not (service.directory / ('b' * 32 + '.json')).exists()
    finally:
        await service.close()


@pytest.mark.anyio
async def test_monitor_retries_after_unexpected_checkpoint_error(tmp_path, monkeypatch):
    service = ProcessOwnership(tmp_path)
    original = service.checkpoint
    calls = []
    def flaky():
        calls.append(True)
        if len(calls) == 1: raise RuntimeError('transient error')
        original()
    monkeypatch.setattr(service, 'checkpoint', flaky)
    await service.start()
    try:
        for _ in range(300):
            if len(calls) >= 2: break
            await asyncio.sleep(.01)
        assert len(calls) >= 2 and not service.monitor.done()
    finally:
        await service.close()


@pytest.mark.anyio
async def test_owner_record_unlink_failure_does_not_break_close(tmp_path, monkeypatch):
    service = ProcessOwnership(tmp_path)
    await service.start()
    original = Path.unlink
    def fail(path, *args, **kwargs):
        if path == service.file: raise PermissionError('cannot remove record')
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'unlink', fail)
    await service.close()
    assert service.file.exists()
    assert service.previous_env is None and service.monitor is None


@pytest.mark.anyio
async def test_cleanup_failure_does_not_mask_business_startup_error(tmp_path, monkeypatch):
    from contextlib import asynccontextmanager
    import main
    import services.config as config
    import services.git.engine_credentials as credentials
    restored = []
    monkeypatch.setattr(config, 'CONFIG_DIR', tmp_path)
    monkeypatch.setattr(credentials, 'install_engine_credentials', lambda path: lambda: restored.append(True))
    @asynccontextmanager
    async def application(app):
        raise LookupError('business startup error')
        yield
    def fail(*args): raise RuntimeError('recovery cleanup error')
    monkeypatch.setattr(main, '_application_lifespan', application)
    monkeypatch.setattr(ProcessOwnership, 'reap', fail)
    with pytest.raises(LookupError, match='business startup error'):
        async with main.lifespan(main.app): pass
    assert restored == [True]


@pytest.mark.anyio
async def test_startup_cancellation_is_preserved_and_recovery_resources_close(tmp_path, monkeypatch):
    import threading
    from contextlib import asynccontextmanager
    import main
    import services.config as config
    import services.git.engine_credentials as credentials
    from services.process_recovery import OWNER_ENV
    entered, proceed = threading.Event(), threading.Event()
    reached, restored = [], []
    previous = os.environ.get(OWNER_ENV)
    monkeypatch.setattr(config, 'CONFIG_DIR', tmp_path)
    monkeypatch.setattr(credentials, 'install_engine_credentials', lambda path: lambda: restored.append(True))
    def slow(self): entered.set(); proceed.wait(3); return 0
    monkeypatch.setattr(ProcessOwnership, 'recover', slow)
    @asynccontextmanager
    async def application(app):
        reached.append(True)
        yield
    monkeypatch.setattr(main, '_application_lifespan', application)
    async def run():
        async with main.lifespan(main.app): pass
    task = asyncio.create_task(run())
    try:
        for _ in range(100):
            if entered.is_set():break
            await asyncio.sleep(.01)
        assert entered.is_set()
        task.cancel(); proceed.set()
        with pytest.raises(asyncio.CancelledError): await task
        assert not reached and restored == [True]
        assert os.environ.get(OWNER_ENV) == previous
    finally:
        proceed.set()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.anyio
@pytest.mark.parametrize('legacy', [False, True])
async def test_foreign_namespace_or_legacy_record_never_reaps_local_pid(tmp_path, legacy):
    service = ProcessOwnership(tmp_path)
    sentinel = peer()
    stale_record(service.directory, sentinel)
    file = service.directory / ('a' * 32 + '.json')
    record = json.loads(file.read_text())
    if legacy:
        record['version'] = 1
        record.pop('realm', None)
    else:
        record['realm'] = {'platform': 'Linux', 'pid_namespace': 'another-container'}
    file.write_text(json.dumps(record))
    try:
        await service.start()
        assert sentinel.poll() is None
        assert file.exists()
    finally:
        await service.close()
        if sentinel.poll() is None:sentinel.kill()
        sentinel.wait()
