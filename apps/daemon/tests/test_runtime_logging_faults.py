"""Real Uvicorn processes: diagnostic failures must not stop serving business."""
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

import pytest


APP = '''import asyncio,errno,logging,os,sqlite3,threading
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from fastapi import FastAPI
import services.runtime_logging as logs
runtime=logs._installed
runtime.shutdown_timeout=.1
mode=os.environ['FAULT_MODE']
database=Path(os.environ['FAULT_ROOT'])/'business.sqlite'
counter=0
guard=asyncio.Lock()
def fail(*args,**kwargs):
    number=errno.EACCES if mode in ('permission','rollover') else errno.ENOSPC
    raise OSError(number,'injected diagnostic storage failure')
if mode=='full':runtime.file_handler._open=fail
elif mode=='permission':runtime.file_handler.sink.prune=fail
elif mode=='rollover':
    runtime.file_handler.maxBytes=128
    runtime.file_handler.doRollover=fail
elif mode=='format':runtime.handler.setFormatter(logging.Formatter('%(missing_field)s'))
elif mode=='sink-format':runtime.file_handler.setFormatter(logging.Formatter('%(missing_field)s'))
elif mode=='stuck':
    runtime.queue.maxsize=8
    runtime.file_handler.emit=lambda record: threading.Event().wait()
elif mode=='cleanup':logs.prune_action_logs=fail
@asynccontextmanager
async def lifespan(app):
    service=logs.DiagnosticLogRetention(
        SimpleNamespace(iter_projects=lambda:[SimpleNamespace(id='fixture',workstep_dir=database.parent)]),
        SimpleNamespace(tasks={}),startup_delay=0,interval=.02)
    if mode=='cleanup':service.start()
    try:yield
    finally:await service.close()
app=FastAPI(lifespan=lifespan)
@app.get('/health')
async def health():
    logging.info('health diagnostic')
    return {'ok':True,'counter':counter,'pid':os.getpid(),
            'listener_alive':runtime.listener._thread.is_alive(),
            'fallback':runtime.fallback_reason is not None}
@app.post('/business')
async def business():
    global counter
    async with guard:
        counter+=1
        value=counter
        def persist():
            with sqlite3.connect(database) as connection:
                connection.execute('CREATE TABLE IF NOT EXISTS business(value INTEGER)')
                connection.execute('INSERT INTO business VALUES (?)',(value,))
        await asyncio.to_thread(persist)
    logging.info('business persisted %s',value)
    return {'value':value}
@app.get('/failure')
async def failure():raise RuntimeError('ordinary request exception')
@app.post('/flood')
async def flood():
    for _ in range(3000):logging.error('injected diagnostic flood')
    return {'ok':True}
'''


@pytest.mark.parametrize('mode', ['full', 'permission', 'rollover', 'format', 'sink-format', 'stuck', 'cleanup', 'startup-directory', 'startup-config'])
def test_main_process_survives_log_faults_and_persists_business(tmp_path, mode):
    (tmp_path / 'fault_fixture.py').write_text(APP)
    log_dir = tmp_path / 'logs'
    if mode == 'startup-directory': log_dir.write_text('not a directory')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    env = {**os.environ, 'WORKSTEP_LOG_DIR': str(log_dir),
           'FAULT_ROOT': str(tmp_path), 'FAULT_MODE': mode}
    if mode == 'startup-config': env['WORKSTEP_LOG_MAX_MIB'] = '0'
    child = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'fault_fixture:app',
                              '--app-dir', str(tmp_path), '--host', '127.0.0.1', '--port', str(port),
                              '--log-config', str(Path(__file__).resolve().parents[1] / 'data/logging.json')],
                             env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    origin = f'http://127.0.0.1:{port}'
    def request(path, method='GET'):
        req = urllib.request.Request(origin + path, method=method)
        with urllib.request.urlopen(req, timeout=2) as response:
            return json.load(response)
    try:
        deadline = time.monotonic() + 10
        ready = None
        while time.monotonic() < deadline and child.poll() is None:
            try:
                ready = request('/health')
                break
            except OSError: time.sleep(.02)
        assert ready and ready['pid'] == child.pid, f'{mode}: startup failed ({child.poll()})'
        assert ready['fallback'] == (mode == 'startup-directory')
        assert request('/business', 'POST')['value'] == 1
        with pytest.raises(urllib.error.HTTPError) as failure:
            request('/failure')
        assert failure.value.code == 500
        assert request('/flood', 'POST')['ok']
        timings = []
        for value in range(2, 10):
            started = time.monotonic()
            health = request('/health')
            timings.append(time.monotonic() - started)
            assert health['ok'] and health['listener_alive']
            assert request('/business', 'POST')['value'] == value
        assert child.poll() is None
        with sqlite3.connect(tmp_path / 'business.sqlite') as connection:
            assert connection.execute('SELECT COUNT(*) FROM business').fetchone()[0] == 9
        (tmp_path / 'fault-metrics.json').write_text(json.dumps({
            'mode': mode, 'health_max_ms': max(timings)*1000, 'committed_rows': 9,
            'main_alive_before_shutdown': child.poll() is None}, indent=2))
    finally:
        if child.poll() is None: child.terminate()
        try: child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill(); child.wait()
            raise


@pytest.mark.parametrize('mode', ['full', 'startup-directory'])
def test_real_daemon_lifespan_survives_diagnostic_storage_failure(tmp_path, mode):
    (tmp_path / 'real_daemon_log_fault.py').write_text('''import errno,os
from services import runtime_logging
if os.environ['FAULT_MODE']=='full':
    def fail(*args,**kwargs):raise OSError(errno.ENOSPC,'injected log-only disk full')
    runtime_logging._installed.file_handler._open=fail
from main import app
''')
    log_dir = tmp_path / 'logs'
    if mode == 'startup-directory': log_dir.write_text('not a directory')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    environment = {key:value for key,value in os.environ.items()
                   if not key.startswith(('WORKSTEP_', 'LOGFIRE_'))}
    environment.update({'WORKSTEP_CONFIG_DIR':str(tmp_path/'config'),
                        'WORKSTEP_LOG_DIR':str(log_dir), 'WORKSTEP_ENV':'test',
                        'WORKSTEP_PORT':str(port), 'WORKSTEP_DAEMON_URL':origin,
                        'FAULT_MODE':mode})
    console = tmp_path / 'daemon-console.log'
    with console.open('wb') as output:
        child = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'real_daemon_log_fault:app',
            '--app-dir', str(tmp_path), '--host', '127.0.0.1', '--port', str(port),
            '--log-config', str(Path(__file__).resolve().parents[1]/'data/logging.json')],
            env=environment, stdout=output, stderr=subprocess.STDOUT)
    try:
        deadline = time.monotonic() + 20
        ready = False
        while time.monotonic() < deadline and child.poll() is None:
            try:
                with urllib.request.urlopen(origin+'/api/health', timeout=.5) as response:
                    ready = json.load(response)['status'] == 'ok'
                if ready: break
            except (OSError, ValueError): time.sleep(.05)
        assert ready, console.read_text(errors='replace')[-4000:]
        with urllib.request.urlopen(origin+'/api/project/list', timeout=2) as response:
            assert response.status == 200
            projects = json.load(response)
        assert projects
        assert child.poll() is None
        (tmp_path/'real-daemon-result.json').write_text(json.dumps({
            'mode':mode, 'health_ok':True, 'project_api_ok':True, 'pid':child.pid}))
    finally:
        if child.poll() is None: child.terminate()
        try: child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill(); child.wait()
            raise
    assert not list((tmp_path/'config/runtime/process-owners').glob('*.json'))
