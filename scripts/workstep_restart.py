#!/usr/bin/env python3
"""Restart the checkout from a detached worker; never trust stale PID files."""

import fcntl
import json
import logging
import os
import shlex
import shutil
import signal
import subprocess
import sys
import time
import tempfile
import urllib.request
from dataclasses import dataclass
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(os.environ.get("WORKSTEP_PROJECT_ROOT", Path(__file__).resolve().parents[1])).resolve()
COMMAND = ["bash", "start.sh", "8765", "dev"]
logger = logging.getLogger('workstep.restart')


@contextmanager
def restart_deadline(seconds=240):
    def expired(signum, frame):
        raise TimeoutError(f"Restart exceeded total time limit ({seconds} seconds), stopping this attempt, no automatic retry")

    previous_handler = signal.signal(signal.SIGALRM, expired)
    started = time.monotonic()
    previous_timer = signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        if previous_timer[0]:
            signal.setitimer(signal.ITIMER_REAL,
                             max(.001, previous_timer[0] - (time.monotonic() - started)), previous_timer[1])


@contextmanager
def restart_ownership():
    # A new session alone still inherits the old daemon's ownership token and
    # may already be in its PID checkpoint. Register a live, independent owner
    # before shutdown, using the same identity checks as nested daemons.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps/daemon"))
    from services.config import CONFIG_DIR
    from services.process_recovery import OWNER_ENV, SCOPE_ENV, ProcessOwnership

    owner = ProcessOwnership(os.environ.get(SCOPE_ENV) or CONFIG_DIR)
    owner.prepare()
    owner.write()  # Fail before stopping services if protection cannot persist.
    previous = {key: os.environ.get(key) for key in (OWNER_ENV, SCOPE_ENV)}
    os.environ.update({OWNER_ENV: owner.token, SCOPE_ENV: owner.scope})
    try:
        yield
    except BaseException:
        # Also reap preflight/build children which outlived their subprocess.run
        # parent. Failed cleanup retains the record for the next daemon.
        try:
            with restart_deadline(10):
                owner.reap({'version': 2, 'realm': owner.realm, 'token': owner.token,
                            'children': list(owner.children.values())})
        except Exception as exc:
            logger.warning('重启执行器清理失败，保留归属记录', exc_info=True)
        raise
    else:
        owner.file.unlink(missing_ok=True)
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


@dataclass(frozen=True)
class Process:
    pid: int
    parent: int
    started: str
    command: str
    group: int = 0


def process_table() -> dict[int, Process]:
    output = subprocess.check_output(["ps", "-axo", "pid=,ppid=,pgid=,lstart=,command="], text=True, timeout=5)
    result = {}
    for line in output.splitlines():
        parts = line.split(maxsplit=8)
        if len(parts) == 9:
            pid, parent, group = map(int, parts[:3])
            result[pid] = Process(pid, parent, " ".join(parts[3:8]), parts[8], group)
    return result


def listeners(port: int) -> set[int]:
    result = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
        capture_output=True, text=True, timeout=5,
    )
    if result.returncode not in {0, 1}:
        raise RuntimeError(f"Unable to check port {port}: {result.stderr}")
    return {int(pid) for pid in result.stdout.split()}


def process_cwd(pid: int) -> Path | None:
    result = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
                            capture_output=True, text=True, timeout=5)
    return next((Path(line[1:]).resolve() for line in result.stdout.splitlines() if line.startswith("n")), None)


def descendants(seeds: set[int], processes: dict[int, Process]) -> set[int]:
    result = set(seeds)
    while True:
        expanded = result | {p.pid for p in processes.values() if p.parent in result}
        if expanded == result:
            return result
        result = expanded


def is_launcher(process: Process) -> bool:
    try:
        args = shlex.split(process.command)
    except ValueError:
        return False
    if len(args) < 2 or Path(args[0]).name not in {"bash", "sh"}:
        return False
    if Path(args[1]).name != "start.sh" or (len(args) > 2 and args[2] != "8765"):
        return False
    cwd = process_cwd(process.pid)
    return cwd == ROOT and (cwd / args[1]).resolve() == ROOT / "start.sh"


def is_service(process: Process, port: int | None = None) -> bool:
    try:
        args = shlex.split(process.command)
    except ValueError:
        return False
    daemon = "main:app" in args and any(Path(arg).name == "uvicorn" for arg in args)
    web = any(Path(arg).name in {"vite", "vite.js"} for arg in args)
    if not daemon and not web:
        return False
    cwd = process_cwd(process.pid)
    return ((port in {None, 8765} and daemon and cwd == ROOT / "apps/daemon")
            or (port in {None, 5173} and web and cwd == ROOT / "apps/web"))


def discover_targets() -> dict[int, Process]:
    processes = process_table()
    own_tree = descendants({os.getpid()}, processes)
    seeds = set()
    for port in (8765, 5173):
        for pid in listeners(port):
            process = processes.get(pid)
            if pid in own_tree or not process or not is_service(process, port):
                raise RuntimeError(f"Port {port} is occupied by another project or unknown process {pid}, refusing to stop:")
            seeds.add(pid)
    # Includes duplicate launchers whose daemon already failed to bind the port.
    seeds.update(p.pid for p in processes.values() if p.pid not in own_tree and is_launcher(p))
    groups = {processes[pid].group for pid in seeds}
    # Let daemon shutdown manage engines. Match service commands explicitly:
    # older engines may share the launcher's group and must not be killed here.
    services = {pid: p for pid, p in processes.items() if p.group in groups and p.group != os.getpgrp()}
    targets = {}
    for pid in descendants(seeds, services) - own_tree:
        process = services.get(pid)
        if not process:
            continue
        log_tail = process.command.startswith(("tail -f ", "tail -F ")) and str(ROOT / "logs/") in process.command
        if pid in seeds or is_service(process) or log_tail:
            targets[pid] = process
    return targets


def signal_targets(targets: dict[int, Process], sig: int) -> None:
    current = process_table()
    own_tree = descendants({os.getpid()}, current)
    for pid, original in targets.items():
        # Compare start time and command as well as PID to reject PID reuse.
        live = current.get(pid)
        if pid > 1 and pid not in own_tree and live and live.group != os.getpgrp() and (live.started, live.command) == (original.started, original.command):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass


def stop_services(targets: dict[int, Process]) -> None:
    # Old start.sh cleanup reads shared PID files. Remove them before signalling
    # any old launcher, and do not start a replacement until all old ones exit.
    for name in ("daemon.pid", "web.pid"):
        (ROOT / ".pids" / name).unlink(missing_ok=True)
    signal_targets(targets, signal.SIGTERM)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        current = process_table()
        remaining = {pid: p for pid, p in targets.items() if pid in current
                     and (current[pid].started, current[pid].command) == (p.started, p.command)}
        if not remaining:
            if listeners(8765) or listeners(5173):
                raise RuntimeError("Port still in use after stop, refusing to start duplicate background")
            return
        time.sleep(.5)
    raise RuntimeError("Old service has not exited; process not forcibly killed, please check restart logs")


def run_preflight_command(command, **kwargs):
    # Build output is not a second diagnostic stream. Keep just the failure
    # tail, and let subprocess timeouts/ownership cleanup bound the attempt.
    directory = ROOT / 'tmp/restart-checks'
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryFile(dir=directory) as output:
        try:
            subprocess.run(command, stdout=output, stderr=subprocess.STDOUT, check=True, **kwargs)
        except BaseException:
            size = output.seek(0, os.SEEK_END)
            output.seek(max(0, size - 64 * 1024))
            logger.error('重启预检失败：%s\n%s', command[0], output.read().decode('utf-8', errors='replace'))
            raise


def preflight() -> None:
    for tool in ("bash", "uv", "node", "lsof", "ps"):
        if not shutil.which(tool):
            raise RuntimeError(f"Missing {tool}, keeping old service")
    if not (shutil.which("corepack") or shutil.which("yarn")):
        raise RuntimeError("Missing Yarn/Corepack, keeping old service")
    run_preflight_command(["bash", "-n", str(ROOT / "start.sh")], timeout=5)
    run_preflight_command(["uv", "run", "--no-sync", "--directory", str(ROOT / "apps/daemon"),
                           "python", "-c", "import main; assert main.app"], timeout=30)
    if not (ROOT / "apps/web/node_modules/.bin/vite").exists():
        raise RuntimeError("Frontend dependency missing, keeping old service; please install dependencies first")
    # Build before shutdown so broken frontend/toolchain code preserves the old
    # service. start.sh can reuse this build without another failure window.
    yarn = ["corepack", "yarn"] if shutil.which("corepack") else ["yarn"]
    run_preflight_command([*yarn, "build"], cwd=ROOT / "apps/landing",
                          env={**os.environ, "LANDING_BASE": "/landing/"}, timeout=120)


def health_ready() -> bool:
    try:
        with urllib.request.urlopen("http://127.0.0.1:8765/api/health", timeout=2) as response:
            return response.status == 200 and json.load(response).get("status") == "ok"
    except (OSError, ValueError):
        return False


def cleanup_failed_start(child) -> None:
    import psutil
    from engines.core.process_cleanup import _reap

    # This launcher got a fresh session. Inspect individual identities rather
    # than signalling a group that might have been reused after launcher exit.
    started = getattr(child, "_workstep_started", None)
    if started is None:
        try:
            started = psutil.Process(child.pid).create_time()
        except psutil.NoSuchProcess:
            return
    with restart_deadline(10):
        owned = []
        for process in psutil.process_iter():
            try:
                if (process.pid != os.getpid() and process.create_time() >= started
                        and os.getpgid(process.pid) == child.pid and os.getsid(process.pid) == child.pid):
                    owned.append(process)
            except (psutil.NoSuchProcess, ProcessLookupError, psutil.AccessDenied):
                continue
        _reap(owned)
        child.wait(timeout=3)


def start_services() -> int:
    started = time.time()
    child = subprocess.Popen(COMMAND, cwd=ROOT, stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
                             start_new_session=True,
                             env={**os.environ, "WORKSTEP_SKIP_LANDING_BUILD": "1",
                                  "WORKSTEP_FOLLOW_LOGS": "0"})
    # psutil creation times may have coarser precision than time.time().
    child._workstep_started = int(started)
    try:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError(f"New launcher {child.pid} exited ({child.returncode}); check daemon.log/web.log")
            tree = descendants({child.pid}, process_table())
            daemon, web = listeners(8765), listeners(5173)
            if daemon and web and daemon <= tree and web <= tree and health_ready():
                logger.info('重启成功：新启动器 %s，后台 %s，前端 %s', child.pid, sorted(daemon), sorted(web))
                return child.pid
            time.sleep(.5)
        raise RuntimeError(f"New launcher {child.pid} failed readiness check; see daemon.log/web.log")
    except BaseException:
        try:
            cleanup_failed_start(child)
        except Exception as exc:
            logger.warning('本次启动清理失败，保留归属记录供下次回收', exc_info=True)
        raise


def worker(lock_fd=None) -> None:
    time.sleep(2)  # Allow the Action acknowledgement to finish.
    (ROOT / ".pids").mkdir(exist_ok=True)
    lock_file = os.fdopen(lock_fd, "a") if lock_fd is not None else (ROOT / ".pids/restart.lock").open("a")
    with lock_file as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("A restart is already in progress, please do not click repeatedly")
        with restart_deadline(), restart_ownership():
            preflight()
            targets = discover_targets()
            logger.info('停止本项目旧服务：%s；独立执行器：%s', sorted(targets), os.getpid())
            stop_services(targets)
            start_services()


def main() -> None:
    if "--check" in sys.argv:
        print(json.dumps({"root": str(ROOT), "targets": [vars(p) for p in discover_targets().values()],
                          "worker_pid": os.getpid()}, ensure_ascii=False, indent=2))
        return
    (ROOT / ".pids").mkdir(exist_ok=True)
    if "--worker" in sys.argv:
        lock_fd = int(sys.argv[sys.argv.index("--lock-fd") + 1]) if "--lock-fd" in sys.argv else None
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps/daemon"))
        from services.runtime_logging import install_runtime_logging
        install_runtime_logging(ROOT / "logs", 'restart-action.log', backups=0)
        worker(lock_fd)
        return
    log_path = ROOT / "logs/restart-action.log"
    log_path.parent.mkdir(exist_ok=True)
    with (ROOT / ".pids/restart.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("A restart is already in progress, please do not click repeatedly")
        # Replace the inode: old launchers can still hold writable descriptors
        # until shutdown, but cannot append to or seek inside this attempt's log.
        temporary = log_path.with_suffix(".log.tmp")
        with temporary.open("wb", buffering=0) as log:
            temporary.replace(log_path)
            child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--worker",
                                      "--lock-fd", str(lock.fileno())],
                                     cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log,
                                     stderr=subprocess.STDOUT, start_new_session=True,
                                     close_fds=True, pass_fds=(lock.fileno(),))
    print(f"已提交重启（执行器 {child.pid}）；此处不代表成功，最终结果见 {log_path}")


if __name__ == "__main__":
    main()
