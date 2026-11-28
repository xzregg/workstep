"""Gateway handoff tests use fakes or isolated local HTTP servers only."""
import importlib.util
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
from unittest.mock import Mock

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / 'gateway_restart.py'


@pytest.fixture
def restart(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(SCRIPT.parent))
    spec = importlib.util.spec_from_file_location('gateway_restart_test', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, module.Restart(tmp_path, tmp_path / 'runtime', 18700)


def configure(monkeypatch, runner):
    calls = []
    candidate, previous = {'id': 'candidate'}, {'id': 'previous'}
    monkeypatch.setattr(runner, 'prepare', lambda: (candidate, previous))
    monkeypatch.setattr(runner, 'preflight', lambda release: calls.append('preflight'))
    monkeypatch.setattr(runner, 'stop_existing', lambda: calls.append('stop-old'))
    monkeypatch.setattr(runner, 'launch', lambda release: calls.append(release['id']) or release)
    monkeypatch.setattr(runner, 'stop_child', lambda child: calls.append('stop-' + child['id']))
    monkeypatch.setattr(runner, 'save_current', lambda release: calls.append('save-' + release['id']))
    return calls


def test_preparation_failure_keeps_old_service(restart, monkeypatch):
    _, runner = restart
    stop = Mock()
    monkeypatch.setattr(runner, 'stop_existing', stop)
    monkeypatch.setattr(runner, 'prepare', Mock(side_effect=RuntimeError('build failed')))
    with pytest.raises(RuntimeError, match='build failed'):
        runner.run()
    stop.assert_not_called()


def test_preflight_failure_keeps_old_service(restart, monkeypatch):
    _, runner = restart
    calls = configure(monkeypatch, runner)
    monkeypatch.setattr(runner, 'preflight', Mock(side_effect=RuntimeError('migration mismatch')))
    with pytest.raises(RuntimeError, match='migration mismatch'):
        runner.run()
    assert calls == []


def test_success_is_only_recorded_after_health(restart, monkeypatch):
    _, runner = restart
    calls = configure(monkeypatch, runner)
    monkeypatch.setattr(runner, 'wait_ready', lambda child: calls.append('health'))
    runner.run()
    assert calls == ['preflight', 'preflight', 'stop-old', 'candidate', 'health', 'save-candidate']
    assert json.loads((runner.runtime / 'restart-status.json').read_text())['stage'] == 'ready'


def test_failed_candidate_recovers_previous_release(restart, monkeypatch):
    _, runner = restart
    calls = configure(monkeypatch, runner)
    def ready(child):
        if child['id'] == 'candidate':
            raise RuntimeError('new server failed')
    monkeypatch.setattr(runner, 'wait_ready', ready)
    runner.run()
    assert calls == ['preflight', 'preflight', 'stop-old', 'candidate', 'stop-candidate', 'previous', 'save-previous']
    assert json.loads((runner.runtime / 'restart-status.json').read_text())['stage'] == 'recovered'


def test_recovery_is_bounded_and_failure_is_not_success(restart, monkeypatch):
    _, runner = restart
    calls = configure(monkeypatch, runner)
    monkeypatch.setattr(runner, 'wait_ready', Mock(side_effect=RuntimeError('failed')))
    monkeypatch.setattr(time, 'sleep', lambda seconds: None)
    with pytest.raises(RuntimeError, match='recovery failed'):
        runner.run()
    assert calls.count('previous') == 3
    assert not any(item.startswith('save-') for item in calls)


def test_health_rejects_live_parent_with_dead_or_unhealthy_server(restart, monkeypatch):
    _, runner = restart
    child = Mock()
    child.poll.return_value = 1
    with pytest.raises(RuntimeError, match='exited'):
        runner.wait_ready(child)


def test_unrelated_listener_is_never_stopped(restart, monkeypatch):
    module, runner = restart
    monkeypatch.setattr(module, 'listeners', lambda port: {900})
    monkeypatch.setattr(module, 'process_table', lambda: {900: module.Process(900, 1, 'old', 'unrelated', 900)})
    monkeypatch.setattr(module, 'process_cwd', lambda pid: runner.root / 'elsewhere')
    kill = Mock()
    monkeypatch.setattr(os, 'kill', kill)
    with pytest.raises(RuntimeError, match='unrelated'):
        runner.stop_existing()
    kill.assert_not_called()


def test_duplicate_submission_is_rejected_while_worker_holds_lock(tmp_path):
    with (tmp_path / 'restart.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = subprocess.run([sys.executable, str(SCRIPT), '--root', str(tmp_path),
                                 '--runtime', str(tmp_path)], capture_output=True, text=True, timeout=5)
    assert result.returncode != 0
    assert 'already in progress' in result.stderr
    assert not (tmp_path / 'restart.log').exists()


def test_server_snapshot_is_kept_after_next_success(restart):
    _, runner = restart
    releases = runner.runtime / 'releases'
    names = ['a' * 32, 'b' * 32, 'c' * 32]
    for name in names:
        (releases / name).mkdir(parents=True)
    (runner.runtime / 'current.json').write_text(json.dumps({'id': names[1], 'cwd': str(releases / names[1])}))
    runner.save_current({'id': names[2], 'cwd': str(releases / names[2])})
    assert not (releases / names[0]).exists()
    assert (releases / names[1]).exists()
    assert (releases / names[2]).exists()


def test_detached_worker_recovers_after_the_caller_disconnects(tmp_path):
    """Kill the submitting session group; recovery must finish without it."""
    runtime = tmp_path / 'runtime'
    runtime.mkdir()
    with socket.socket() as port_socket:
        port_socket.bind(('127.0.0.1', 0))
        port = port_socket.getsockname()[1]
    server = tmp_path / 'server.py'
    server.write_text('''
from http.server import HTTPServer, BaseHTTPRequestHandler
import sys
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"status":"ok"}')
HTTPServer(('127.0.0.1', int(sys.argv[1])), Handler).serve_forever()
''')
    worker = tmp_path / 'worker.py'
    worker.write_text('''
import fcntl, json, os, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from gateway_restart import Restart
root, runtime, port = Path(sys.argv[2]), Path(sys.argv[3]), int(sys.argv[4])
class IsolatedRestart(Restart):
    def prepare(self):
        time.sleep(1)
        return {'id':'candidate'}, {'id':'previous'}
    def preflight(self, release): pass
    def stop_existing(self): pass
    def launch(self, release):
        command = [sys.executable, '-c', 'raise SystemExit(1)'] if release['id'] == 'candidate' else [sys.executable, str(root / 'server.py'), str(port)]
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        (runtime / 'test-server.pid').write_text(str(child.pid))
        return child
    def save_current(self, release): pass
with (runtime / 'restart.lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    runner = IsolatedRestart(root, runtime, port)
    runner.run()
''')
    caller = tmp_path / 'caller.py'
    caller.write_text('''
import subprocess, sys, time
from pathlib import Path
with open(Path(sys.argv[3]) / 'worker.log', 'wb') as log:
    worker = subprocess.Popen([sys.executable, str(Path(sys.argv[2]) / 'worker.py'), *sys.argv[1:]], stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    (Path(sys.argv[3]) / 'worker.pid').write_text(str(worker.pid))
time.sleep(60)
''')
    caller_process = subprocess.Popen([sys.executable, str(caller), str(SCRIPT.parent), str(tmp_path), str(runtime), str(port)], start_new_session=True)
    try:
        deadline = time.monotonic() + 5
        while not (runtime / 'worker.pid').exists() and time.monotonic() < deadline:
            time.sleep(.05)
        assert (runtime / 'worker.pid').exists()
        os.killpg(caller_process.pid, signal.SIGKILL)
        caller_process.wait(timeout=5)
        deadline = time.monotonic() + 10
        state = {}
        while time.monotonic() < deadline:
            status = runtime / 'restart-status.json'
            if status.exists():
                state = json.loads(status.read_text())
                if state['stage'] == 'recovered':
                    break
            time.sleep(.1)
        assert state.get('stage') == 'recovered', (runtime / 'worker.log').read_text()
        import urllib.request
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health', timeout=2) as response:
            assert json.load(response) == {'status': 'ok'}
    finally:
        for file in ('test-server.pid', 'worker.pid'):
            path = runtime / file
            if path.exists():
                try:
                    os.killpg(int(path.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        if caller_process.poll() is None:
            os.killpg(caller_process.pid, signal.SIGKILL)
            caller_process.wait(timeout=5)
