import asyncio
import logging
import os
from pathlib import Path
import subprocess
import sys
import time
import re
import urllib.request

import pytest

from services.runtime_logging import BoundedLog, LogPolicy, RuntimeLogging, prune_action_logs


def test_size_count_utf8_and_oversized_old_log_are_bounded(tmp_path):
    path = tmp_path / 'daemon.log'
    path.write_bytes(b'x' * 10000)
    policy = LogPolicy(max_bytes=256, backups=2, retention_days=14)
    sink = BoundedLog(path, policy)
    for i in range(40): sink.append(f'{i}:中文错误\n')
    files = list(tmp_path.glob('daemon.log*'))
    assert len(files) <= 3
    assert all(p.stat().st_size <= 256 for p in files)
    assert '39:中文错误' in path.read_text()


def test_age_cleanup_daily_rotation_and_scope(tmp_path):
    now = time.time()
    old = now - 20 * 86400
    path = tmp_path / 'daemon.log'
    path.write_text('expired')
    os.utime(path, (old, old))
    backup = tmp_path / 'daemon.log.1'
    backup.write_text('expired backup')
    os.utime(backup, (old, old))
    unrelated = tmp_path / 'business.jsonl'
    unrelated.write_text('keep')
    sink = BoundedLog(path, LogPolicy(max_bytes=256, backups=2, retention_days=14))
    sink.prune(now=now)
    assert all('expired' not in p.read_text() for p in tmp_path.glob('daemon.log*'))
    sink.append('yesterday\n', now=now)
    sink.append('tomorrow\n', now=now + 86400)
    assert 'tomorrow' in path.read_text()
    assert 'yesterday' in backup.read_text()
    assert unrelated.read_text() == 'keep'


def test_standard_logging_preserves_python_errors_and_leaves_native_output_to_host(tmp_path):
    program = '''import logging,os
from services.runtime_logging import install_runtime_logging
install_runtime_logging(os.environ['TEST_LOG_DIR'])
logging.getLogger('startup').info('STARTUP test')
os.write(2,b'native stderr error\\n')
try: raise ValueError('logged failure')
except ValueError: logging.getLogger('test').exception('operation failed')
raise RuntimeError('uncaught failure')
'''
    result = subprocess.run([sys.executable, '-c', program],
                            env={**os.environ, 'TEST_LOG_DIR': str(tmp_path)},
                            capture_output=True, timeout=10)
    assert result.returncode != 0
    log = (tmp_path / 'daemon.log').read_text()
    assert b'native stderr error' in result.stderr
    assert 'native stderr error' not in log
    for value in ('STARTUP test', 'Traceback',
                  'ValueError: logged failure', 'RuntimeError: uncaught failure', 'operation failed'):
        assert value in log


@pytest.mark.anyio
async def test_slow_disk_does_not_block_event_loop_and_queue_is_bounded(tmp_path, monkeypatch):
    sink = BoundedLog(tmp_path / 'daemon.log', LogPolicy())
    runtime = RuntimeLogging(sink, queue_size=8)
    original = runtime.file_handler.emit
    def slow(value):
        time.sleep(.02)
        original(value)
    monkeypatch.setattr(runtime.file_handler, 'emit', slow)
    try:
        for _ in range(500):
            runtime.handler.handle(logging.makeLogRecord({'msg': 'error', 'levelno': logging.ERROR}))
        assert runtime.queue.qsize() <= 8
        started = time.monotonic()
        await asyncio.sleep(.01)
        assert time.monotonic() - started < .1
    finally:
        await asyncio.to_thread(runtime.close)
    assert '省略' in sink.path.read_text()


def test_action_cleanup_preserves_active_runs_and_business_data(tmp_path):
    policy = LogPolicy(max_bytes=100, backups=1, retention_days=1)
    for name in ('active', 'old', 'recent'):
        folder = tmp_path / 'action-runs' / name
        folder.mkdir(parents=True)
        (folder / 'output.log').write_bytes(b'x' * 150)
        (folder / '.worktrees.json').write_text('keep')
    old = tmp_path / 'action-runs/old/output.log'
    os.utime(old, (time.time()-172800,) * 2)
    prune_action_logs(tmp_path, {'active'}, policy)
    assert (tmp_path / 'action-runs/active/output.log').exists()
    assert not old.exists()
    assert all(p.read_text() == 'keep' for p in tmp_path.glob('action-runs/*/.worktrees.json'))


def test_configuration_is_validated(monkeypatch):
    monkeypatch.setenv('WORKSTEP_LOG_MAX_MIB', '3')
    monkeypatch.setenv('WORKSTEP_LOG_BACKUPS', '4')
    monkeypatch.setenv('WORKSTEP_LOG_RETENTION_DAYS', '7')
    assert LogPolicy.from_env() == LogPolicy(3*1024*1024, 4, 7)
    monkeypatch.setenv('WORKSTEP_LOG_MAX_MIB', '0')
    with pytest.raises(ValueError): LogPolicy.from_env()


def test_only_one_standard_library_logging_thread_is_created(tmp_path):
    import threading
    from logging.handlers import QueueHandler, QueueListener, RotatingFileHandler
    before = set(threading.enumerate())
    runtime = RuntimeLogging(BoundedLog(tmp_path / 'daemon.log', LogPolicy()))
    try:
        assert isinstance(runtime.handler, QueueHandler)
        assert isinstance(runtime.listener, QueueListener)
        assert isinstance(runtime.file_handler, RotatingFileHandler)
        created = set(threading.enumerate()) - before
        assert len(created) == 1
    finally:
        runtime.close()
    assert all(not thread.is_alive() for thread in created)


def test_retention_io_failure_does_not_kill_queue_listener(tmp_path, monkeypatch, capsys):
    runtime = RuntimeLogging(BoundedLog(tmp_path / 'daemon.log', LogPolicy()))
    def fail(**kwargs): raise PermissionError('retention fixture')
    monkeypatch.setattr(runtime.sink, 'prune', fail)
    try:
        runtime.handler.handle(logging.makeLogRecord({'msg': 'fixture', 'levelno': logging.ERROR}))
        time.sleep(.03)
        assert runtime.listener._thread.is_alive()
    finally:
        runtime.close()
    assert 'retention fixture' in capsys.readouterr().err


def test_slow_file_does_not_serialize_unrelated_action_logs(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    import threading
    entered, release = threading.Event(), threading.Event()
    slow = BoundedLog(tmp_path / 'slow/output.log', LogPolicy())
    other = BoundedLog(tmp_path / 'other/output.log', LogPolicy())
    original = slow.prune
    def blocked(**kwargs):
        entered.set()
        assert release.wait(3)
        return original(**kwargs)
    monkeypatch.setattr(slow, 'prune', blocked)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(slow.append, 'slow')
        try:
            assert entered.wait(1)
            second = pool.submit(other.append, 'independent')
            second.result(timeout=.3)
        finally:
            release.set()
            first.result(timeout=3)


def test_queue_bounds_record_bytes_not_just_count(tmp_path, monkeypatch):
    import threading
    entered, release = threading.Event(), threading.Event()
    runtime = RuntimeLogging(BoundedLog(tmp_path / 'daemon.log', LogPolicy()), queue_size=8)
    original = runtime.file_handler.emit
    def blocked(record):
        entered.set()
        release.wait(3)
        original(record)
    monkeypatch.setattr(runtime.file_handler, 'emit', blocked)
    try:
        runtime.handler.handle(logging.makeLogRecord({'msg': 'blocked', 'levelno': logging.INFO}))
        assert entered.wait(1)
        runtime.handler.handle(logging.makeLogRecord({'msg': '中文' * 1000000, 'levelno': logging.ERROR}))
        with runtime.queue.mutex:
            records = list(runtime.queue.queue)
        assert all(len(record.getMessage().encode()) <= 64 * 1024 for record in records)
    finally:
        release.set()
        runtime.close()


def test_bounding_long_format_template_keeps_logging_valid():
    from services.runtime_logging import RecentQueueHandler
    import queue
    handler = RecentQueueHandler(queue.Queue(maxsize=2))
    record = logging.makeLogRecord({'msg': 'head' * 20000 + '%s' + 'tail' * 20000,
                                   'args': ('argument',), 'levelno': logging.INFO})
    handler.handle(record)
    result = handler.queue.get_nowait()
    assert '已截断' in result.getMessage()
    assert len(result.getMessage().encode()) <= 64 * 1024


def test_file_write_budget_limits_bytes_and_keeps_error_allowance(tmp_path, monkeypatch):
    from services.runtime_logging import DiagnosticBudget
    clock = [0.0]
    sink = BoundedLog(tmp_path / 'daemon.log', LogPolicy(max_bytes=1024*1024), persistent=True)
    sink.append('prime\n')
    budget = next(item for item in sink.handler.filters if isinstance(item, DiagnosticBudget))
    budget.clock = lambda: clock[0]
    budget.window = 0
    budget.count = budget.size = budget.normal_count = budget.normal_size = 0
    writes = []
    original_write = sink.handler.stream.write
    def counted_write(value):
        writes.append(len(value.encode('utf-8')))
        return original_write(value)
    monkeypatch.setattr(sink.handler.stream, 'write', counted_write)
    try:
        for _ in range(10000): sink.append('info ' + 'x'*4096 + '\n')
        error = logging.makeLogRecord({'msg': 'important error\n', 'levelno': logging.ERROR})
        sink.handler.handle(error)
        assert sink.path.stat().st_size <= 256*1024 + 6
        assert 'important error' in sink.path.read_text()
        assert len(writes) <= 100
        import json
        (tmp_path / 'write-budget-metrics.json').write_text(json.dumps({
            'submitted_records': 10001, 'file_write_calls': len(writes),
            'file_bytes': sink.path.stat().st_size, 'simulated_seconds': 1}, indent=2))
        clock[0] = 1.1
        sink.append('recovered\n')
        assert '省略' in sink.path.read_text()
    finally:
        sink.close()


def test_unwritable_log_directory_falls_back_without_aborting_program(tmp_path):
    blocked = tmp_path / 'not-a-directory'
    blocked.write_text('keep')
    program = '''import logging,os
from services.runtime_logging import install_runtime_logging
runtime=install_runtime_logging(os.environ['TEST_LOG_DIR'])
logging.error('fallback diagnostic')
print('business continued')
'''
    result = subprocess.run([sys.executable, '-c', program],
                            env={**os.environ, 'TEST_LOG_DIR': str(blocked)},
                            capture_output=True, text=True, timeout=5)
    assert result.returncode == 0, result.stderr
    assert 'business continued' in result.stdout
    assert 'fallback diagnostic' in result.stderr


def test_stuck_log_io_cannot_hold_process_exit_forever(tmp_path):
    program = '''import logging,os,threading
from services.runtime_logging import install_runtime_logging
runtime=install_runtime_logging(os.environ['TEST_LOG_DIR'])
runtime.shutdown_timeout=.1
entered=threading.Event()
def blocked(record):
    entered.set(); threading.Event().wait()
runtime.file_handler.emit=blocked
logging.error('blocked disk')
assert entered.wait(1)
for _ in range(600):logging.error('queued')
'''
    child = subprocess.Popen([sys.executable, '-c', program],
                             env={**os.environ, 'TEST_LOG_DIR': str(tmp_path)},
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        assert child.wait(timeout=2) != 0
    finally:
        if child.poll() is None: child.kill()
        child.wait()


def test_logging_race_cannot_evict_shutdown_sentinel(tmp_path, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    entered, release_write, producer_paused, release_producer = [threading.Event() for _ in range(4)]
    runtime = RuntimeLogging(BoundedLog(tmp_path / 'daemon.log', LogPolicy()), queue_size=1)
    runtime.shutdown_timeout = .5
    original_emit, original_put = runtime.file_handler.emit, runtime.queue.put_nowait
    def slow(record):
        entered.set()
        release_write.wait(2)
        original_emit(record)
    def delayed_put(record):
        if record is not None and record.getMessage() == 'late producer':
            producer_paused.set()
            release_producer.wait(2)
        return original_put(record)
    monkeypatch.setattr(runtime.file_handler, 'emit', slow)
    monkeypatch.setattr(runtime.queue, 'put_nowait', delayed_put)
    runtime.handler.handle(logging.makeLogRecord({'msg':'first','levelno':logging.INFO}))
    assert entered.wait(1)
    with ThreadPoolExecutor(max_workers=2) as pool:
        producer = pool.submit(runtime.handler.handle, logging.makeLogRecord({'msg':'late producer','levelno':logging.INFO}))
        try:
            assert producer_paused.wait(1)
            closing = pool.submit(runtime.close)
            deadline = time.monotonic() + 1
            while runtime.handler.accepting and time.monotonic() < deadline: time.sleep(.001)
            assert not runtime.handler.accepting
            release_producer.set()
            producer.result(timeout=1)
            release_write.set()
            assert closing.result(timeout=1) is True
        finally:
            release_producer.set()
            release_write.set()
            if runtime.listener._thread is not None:
                runtime.listener.stop(timeout=1)
                runtime.file_handler.close()


def test_chunked_action_output_reuses_writer_and_maintenance(tmp_path, monkeypatch):
    sink = BoundedLog(tmp_path / 'output.log', LogPolicy(records_per_second=1000), persistent=True)
    scans = []
    original = sink.prune
    def counted(**kwargs):
        scans.append(True)
        return original(**kwargs)
    monkeypatch.setattr(sink, 'prune', counted)
    try:
        for _ in range(100): sink.append('chunk\n')
        assert len(scans) <= 2
        stream = sink.handler.stream
        assert not stream.closed
    finally:
        sink.close()
    assert stream.closed
    assert (tmp_path / 'output.log').read_text() == 'chunk\n' * 100


@pytest.mark.anyio
@pytest.mark.parametrize('operation', ['write', 'rollover'])
async def test_health_during_stuck_disk_and_log_flood(tmp_path, monkeypatch, operation):
    import threading
    from fastapi import FastAPI
    from httpx import AsyncClient, ASGITransport
    entered, release = threading.Event(), threading.Event()
    runtime = RuntimeLogging(BoundedLog(tmp_path / 'daemon.log',
                                       LogPolicy(max_bytes=512, backups=2)), queue_size=8)
    original = getattr(runtime.file_handler, 'emit' if operation == 'write' else 'doRollover')
    def blocked(*args):
        entered.set()
        assert release.wait(3)
        return original(*args)
    monkeypatch.setattr(runtime.file_handler, 'emit' if operation == 'write' else 'doRollover', blocked)
    logger = logging.Logger('health-fixture', level=logging.INFO)
    logger.addHandler(runtime.handler)
    app = FastAPI()
    @app.get('/health')
    async def health():
        logger.info('health request')
        return {'ok': True}
    try:
        logger.info('prime rollover file')
        logger.error('trigger ' + 'x' * 1024)
        assert await asyncio.to_thread(entered.wait, 1)
        flood_started = time.monotonic()
        for _ in range(2000): logger.error('flood')
        flood_elapsed = time.monotonic() - flood_started
        assert flood_elapsed < .5
        async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
            started = time.monotonic()
            response = await asyncio.wait_for(client.get('/health'), .2)
            elapsed = time.monotonic() - started
            assert response.json() == {'ok': True}
            (tmp_path / 'health-timing.txt').write_text(
                f'{operation}: health={elapsed * 1000:.3f} ms; enqueue_2000={flood_elapsed * 1000:.3f} ms\n')
    finally:
        release.set()
        await asyncio.to_thread(runtime.close)


def test_redirected_log_keeps_append_descriptor_and_bounds_archives(tmp_path):
    path = tmp_path / 'web.log'
    sink = BoundedLog(path, LogPolicy(max_bytes=256, backups=2, retention_days=14))
    with path.open('ab', buffering=0) as writer:
        for _ in range(5):
            writer.write(b'x' * 1000)
            sink.prune_redirected()
        writer.write(b'last error\n')
    assert path.read_bytes() == b'last error\n'
    files = list(tmp_path.glob('web.log*'))
    assert len(files) <= 3
    assert all(file.stat().st_size <= 256 for file in files)


def test_framework_config_records_failure_before_application_import(tmp_path):
    result = subprocess.run([sys.executable, '-m', 'uvicorn', 'missing_workstep_module:app', '--log-config',
                             str(Path(__file__).resolve().parents[1] / 'data/logging.json')],
                            env={**os.environ, 'WORKSTEP_LOG_DIR': str(tmp_path)},
                            capture_output=True, timeout=10)
    assert result.returncode != 0
    assert 'missing_workstep_module' in (tmp_path / 'daemon.log').read_text()


def test_invalid_logging_configuration_remains_visible(tmp_path):
    result = subprocess.run([sys.executable, '-m', 'uvicorn', 'missing_workstep_module:app', '--log-config',
                             str(Path(__file__).resolve().parents[1] / 'data/logging.json')],
                            env={**os.environ, 'WORKSTEP_LOG_DIR': str(tmp_path),
                                 'WORKSTEP_LOG_MAX_MIB': '0'},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    assert result.returncode != 0
    content = (tmp_path / 'daemon.log').read_text()
    assert 'ERROR' in content and 'WORKSTEP_LOG_MAX_MIB' in content


def test_uvicorn_framework_serves_and_flushes_errors_on_shutdown(tmp_path):
    app = tmp_path / 'logging_fixture.py'
    app.write_text('''import logging,os
from fastapi import FastAPI
app=FastAPI()
@app.get('/api/health')
async def health():
    try: raise ValueError('retention fixture')
    except ValueError: logging.getLogger('fixture').exception('request diagnostic')
    os.write(2,b'native request diagnostic\\n')
    return {'status':'ok'}
''')
    directory = tmp_path / 'logs'
    command = [sys.executable, '-m', 'uvicorn', 'logging_fixture:app', '--app-dir', str(tmp_path),
               '--host', '127.0.0.1', '--port', '0', '--log-config',
               str(Path(__file__).resolve().parents[1] / 'data/logging.json')]
    child = subprocess.Popen(command,
                             env={**os.environ, 'WORKSTEP_LOG_DIR': str(directory)},
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    log = directory / 'daemon.log'
    try:
        deadline = time.monotonic() + 10
        match = None
        while time.monotonic() < deadline and child.poll() is None:
            if log.exists(): match = re.search(r'http://127\.0\.0\.1:(\d+)', log.read_text())
            if match: break
            time.sleep(.02)
        assert match, log.read_text() if log.exists() else 'no startup diagnostics'
        with urllib.request.urlopen(f'http://127.0.0.1:{match[1]}/api/health', timeout=2) as response:
            assert response.status == 200
    finally:
        if child.poll() is None: child.terminate()
        try: child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill(); child.wait()
            raise
    content = log.read_text()
    assert 'ValueError: retention fixture' in content
    assert 'native request diagnostic' not in content
    assert 'Application shutdown complete' in content


@pytest.mark.anyio
async def test_retention_lifecycle_slow_scan_keeps_health_responsive(tmp_path, monkeypatch):
    from types import SimpleNamespace
    import threading
    from fastapi import FastAPI
    from httpx import AsyncClient, ASGITransport
    import services.runtime_logging as module
    entered = threading.Event()
    original = module.prune_action_logs
    def slow(*args):
        entered.set()
        time.sleep(.15)
        return original(*args)
    monkeypatch.setattr(module, 'prune_action_logs', slow)
    project = SimpleNamespace(id='fixture', workstep_dir=tmp_path)
    service = module.DiagnosticLogRetention(SimpleNamespace(iter_projects=lambda: [project]),
                                            SimpleNamespace(tasks={}), startup_delay=0)
    app = FastAPI()
    @app.get('/health')
    async def health(): return {'ok': True}
    service.start()
    try:
        for _ in range(100):
            if entered.is_set(): break
            await asyncio.sleep(.005)
        assert entered.is_set()
        async with AsyncClient(transport=ASGITransport(app), base_url='http://test') as client:
            response = await asyncio.wait_for(client.get('/health'), .1)
            assert response.json() == {'ok': True}
    finally:
        await service.close()
    assert service.task.done()
