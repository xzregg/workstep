#!/usr/bin/env python3
"""Prepare a gateway release before handing restart to an independent worker."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
import uuid

from workstep_restart import Process, process_table, process_cwd, listeners, descendants


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value), encoding='utf-8')
    temporary.replace(path)


def run_checked(command, *, cwd, timeout, env=None):
    child = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                             start_new_session=True, close_fds=True)
    try:
        code = child.wait(timeout=timeout)
        if code:
            raise subprocess.CalledProcessError(code, command[0])
    except BaseException:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        raise


class Restart:
    def __init__(self, root, runtime, port):
        self.root, self.runtime, self.port = Path(root).resolve(), Path(runtime).resolve(), port
        self.runtime.mkdir(parents=True, exist_ok=True)

    def status(self, stage):
        write_json(self.runtime / 'restart-status.json', {'stage': stage, 'worker_pid': os.getpid(), 'port': self.port})
        print(f'Gateway restart: {stage}', flush=True)

    def prepare(self):
        release = self.runtime / 'releases' / uuid.uuid4().hex
        release.mkdir(parents=True)
        self.status('building')
        # Never write into dist directories that the old gateway is serving.
        for app, command, output in [('gateway-web', 'build', 'portal'), ('web', 'build:gateway-share', 'workspace')]:
            run_checked(['yarn', command, '--outDir', str(release / output)],
                        cwd=self.root / 'apps' / app, timeout=600)
            if not (release / output / 'index.html').is_file():
                raise RuntimeError(f'Missing {output} build entry')
        python = self.root / 'apps/gateway/.venv/bin/python'
        if not python.is_file():
            raise RuntimeError('Gateway environment is missing; install its dependencies before restarting')
        # Pin first-party backend and protocol source as well as frontend assets.
        # Editable packages in the venv must not redirect recovery to changed code.
        paths = []
        for source, name in [('apps/gateway/src', 'gateway'),
                             ('packages/gateway-protocol/src', 'protocol'),
                             ('packages/webrtc-signal/src', 'signal')]:
            target = release / name
            shutil.copytree(self.root / source, target, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
            paths.append(str(target))
        candidate = {'id': release.name, 'python': str(python), 'cwd': str(release),
                     'pythonpath': os.pathsep.join(paths), 'portal': str(release / 'portal'),
                     'workspace': str(release / 'workspace')}
        current = self.runtime / 'current.json'
        if current.is_file():
            previous = json.loads(current.read_text())
        else:
            # First adoption has no historical backend snapshot. Preserve the
            # currently served assets and validate this bootstrap fallback too.
            previous = {**candidate, 'id': candidate['id'] + '-bootstrap'}
            for key, source in [('portal', 'apps/gateway-web/dist'), ('workspace', 'apps/web/dist-gateway-share')]:
                target = release / ('previous-' + key)
                existing = self.root / source
                if not (existing / 'index.html').is_file():
                    existing = Path(candidate[key])
                shutil.copytree(existing, target)
                previous[key] = str(target)
        return candidate, previous

    def environment(self, release):
        return {**os.environ, 'PYTHONPATH': release['pythonpath'],
                'WORKSTEP_GATEWAY_PORT': str(self.port),
                'WORKSTEP_GATEWAY_WEB_DIST': release['portal'],
                'WORKSTEP_GATEWAY_WORKSPACE_WEB_DIST': release['workspace'],
                'WORKSTEP_GATEWAY_PUBLIC_ORIGIN': os.environ.get('WORKSTEP_GATEWAY_PUBLIC_ORIGIN', f'http://localhost:{self.port}')}

    def preflight(self, release):
        # Validate imports and migrations against a SQLite backup, never against
        # live data. No application lifecycle/background jobs run in this check.
        code = '''
import asyncio, sqlite3, tempfile
from contextlib import closing
from pathlib import Path
from sqlalchemy.engine import make_url
from gateway.app import app
from gateway.config import GatewaySettings
from gateway.database import GatewayDatabase
settings = GatewaySettings()
url = make_url(settings.effective_database_url)
if url.drivername != 'sqlite+aiosqlite' or not url.database or url.database == ':memory:':
    raise RuntimeError('Automatic restart requires a file SQLite database; keep the existing gateway running')
async def validate():
    with tempfile.TemporaryDirectory() as folder:
        copy = Path(folder) / 'preflight.db'
        source = Path(url.database)
        revision = None
        if source.exists():
            with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=5)) as src, closing(sqlite3.connect(copy)) as dst:
                src.backup(dst)
                revision = dst.execute('SELECT version_num FROM alembic_version').fetchone()[0]
        # Do not run a schema-changing deployment from a remote restart button:
        # restoring old code after such a migration may be unsafe.
        if revision is not None and revision != GatewayDatabase.head_revision:
            raise RuntimeError('Gateway schema change requires maintenance; existing gateway has not been stopped')
        database = GatewayDatabase(settings.model_copy(update={'data_dir': Path(folder), 'database_url': f'sqlite+aiosqlite:///{copy}'}))
        try:
            await database.start()
        finally:
            await database.close()
asyncio.run(validate())
'''
        run_checked([release['python'], '-c', code], env=self.environment(release),
                    cwd=release['cwd'], timeout=60)

    def gateway_process(self, process):
        command = process.command
        if 'uvicorn' not in command or 'main:app' not in command and 'gateway.app:app' not in command:
            return False
        cwd = process_cwd(process.pid)
        return cwd == self.root / 'apps/gateway' or (cwd is not None and cwd.is_relative_to(self.runtime / 'releases'))

    def stop_existing(self):
        table = process_table()
        seeds = set()
        for pid in listeners(self.port):
            process = table.get(pid)
            # Uvicorn's spawned worker inherits the listening socket; validate
            # the reloader ancestor instead of trusting an old PID file.
            while process and not self.gateway_process(process):
                process = table.get(process.parent)
            if process is None:
                raise RuntimeError('Gateway port belongs to an unrelated process; nothing was stopped')
            seeds.add(process.pid)
        for pid in list(seeds):
            parent = table.get(table[pid].parent)
            while parent and self.gateway_process(parent):
                seeds.add(parent.pid)
                parent = table.get(parent.parent)
        targets = {pid: table[pid] for pid in descendants(seeds, table)}
        if os.getpid() in targets:
            raise RuntimeError('Refusing to stop the restart worker')
        for sig, seconds in [(signal.SIGTERM, 8), (signal.SIGKILL, 3)]:
            for pid, original in targets.items():
                current = process_table().get(pid)
                if current and current.started == original.started:
                    try:
                        os.kill(pid, sig)
                    except ProcessLookupError:
                        pass
            deadline = time.monotonic() + seconds
            while listeners(self.port) and time.monotonic() < deadline:
                time.sleep(.1)
            if not listeners(self.port):
                # Wait for launchers/DB locks too, not just the listening socket.
                remaining = process_table()
                if not any(pid in remaining and remaining[pid].started == old.started for pid, old in targets.items()):
                    return
        if listeners(self.port):
            raise RuntimeError('Gateway port was not released')

    def launch(self, release):
        log_path = self.runtime / 'server.log'
        with log_path.open('ab') as log:
            child = subprocess.Popen([release['python'], '-m', 'uvicorn', 'gateway.app:app',
                                      '--host', '0.0.0.0', '--port', str(self.port),
                                      '--ws-ping-interval', '20', '--ws-ping-timeout', '60'],
                                     cwd=release['cwd'], env=self.environment(release),
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                     start_new_session=True, close_fds=True)
        write_json(self.runtime / 'server.json', {'pid': child.pid, 'release': release['id']})
        return child

    def wait_ready(self, child):
        deadline = time.monotonic() + 45
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        successes = 0
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError('Gateway process exited before readiness; see server.log')
            try:
                with opener.open(f'http://127.0.0.1:{self.port}/api/health', timeout=2) as response:
                    healthy = response.status == 200 and json.load(response).get('status') == 'ok'
                    healthy = healthy and child.pid in listeners(self.port)
            except (OSError, ValueError):
                healthy = False
            successes = successes + 1 if healthy else 0
            if successes >= 3:
                return
            time.sleep(.5)
        raise RuntimeError('Gateway health check timed out; see server.log')

    def stop_child(self, child):
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(child.pid, sig)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=8)
                return
            except subprocess.TimeoutExpired:
                pass
        raise RuntimeError('Unable to stop failed gateway process')

    def save_current(self, release):
        current = self.runtime / 'current.json'
        previous = json.loads(current.read_text()) if current.is_file() else None
        write_json(self.runtime / 'current.json', release)
        keep = {Path(release['cwd']).name}
        if previous:
            keep.add(Path(previous['cwd']).name)
        for directory in (self.runtime / 'releases').glob('*'):
            if directory.name not in keep and len(directory.name) == 32 and all(c in '0123456789abcdef' for c in directory.name):
                if directory.is_dir() and not directory.is_symlink():
                    shutil.rmtree(directory, ignore_errors=True)

    def run(self):
        self.status('preparing')
        candidate, previous = self.prepare()
        self.preflight(candidate)
        self.preflight(previous)
        self.status('switching')
        child = None
        try:
            self.stop_existing()
            child = self.launch(candidate)
            self.wait_ready(child)
        except Exception:
            if child is not None:
                self.stop_child(child)
            self.status('recovering')
            for attempt in range(3):
                child = None
                try:
                    child = self.launch(previous)
                    self.wait_ready(child)
                    self.save_current(previous)
                    self.status('recovered')
                    return
                except Exception:
                    if child is not None:
                        self.stop_child(child)
                    time.sleep(1)
            raise RuntimeError('Gateway recovery failed; local intervention required, see server.log')
        self.save_current(candidate)
        self.status('ready')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--runtime', type=Path, default=Path.home() / '.workstep-gateway/restart')
    parser.add_argument('--port', type=int, default=8700)
    parser.add_argument('--worker', action='store_true')
    parser.add_argument('--lock-fd', type=int)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('port must be between 1 and 65535')
    runner = Restart(args.root, args.runtime, args.port)
    if args.worker:
        if args.lock_fd is None:
            parser.error('worker requires inherited restart lock')
        os.fstat(args.lock_fd)
        try:
            runner.run()
        except Exception as exc:
            runner.status('failed')
            print(f'{type(exc).__name__}: {exc}', flush=True)
            return 1
        return 0
    with (runner.runtime / 'restart.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('A gateway restart is already in progress')
        runner.status('queued')
        with (runner.runtime / 'restart.log').open('wb') as log:
            child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()),
                                      '--root', str(runner.root), '--runtime', str(runner.runtime),
                                      '--port', str(args.port), '--worker', '--lock-fd', str(lock.fileno())],
                                     cwd=runner.root, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                     start_new_session=True, close_fds=True, pass_fds=(lock.fileno(),))
    print(f'已交给本机独立重启进程 {child.pid}；断线后会继续，尚不代表启动成功。')
    print(f'最终状态：{runner.runtime / "restart-status.json"}；日志：{runner.runtime / "restart.log"}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
