#!/usr/bin/env python3
"""Restart the checkout from a detached worker; never trust stale PID files."""

import fcntl
import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(os.environ.get("WORKSTEP_PROJECT_ROOT", Path(__file__).resolve().parents[1])).resolve()
COMMAND = ["bash", "start.sh", "8765", "dev"]


@dataclass(frozen=True)
class Process:
    pid: int
    parent: int
    started: str
    command: str
    group: int = 0


def process_table() -> dict[int, Process]:
    output = subprocess.check_output(["ps", "-axo", "pid=,ppid=,pgid=,lstart=,command="], text=True)
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
        raise RuntimeError(f"无法检查端口 {port}: {result.stderr}")
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
                raise RuntimeError(f"端口 {port} 被其他项目或未知进程 {pid} 占用，拒绝停止")
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
        log_tail = process.command.startswith("tail -f ") and str(ROOT / "logs/") in process.command
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
                raise RuntimeError("停止后端口仍被占用，拒绝启动重复后台")
            return
        time.sleep(.5)
    raise RuntimeError("旧服务尚未退出；未强制杀进程，请检查重启日志")


def preflight() -> None:
    for tool in ("bash", "uv", "node", "lsof", "ps"):
        if not shutil.which(tool):
            raise RuntimeError(f"缺少 {tool}，保留旧服务")
    if not (shutil.which("corepack") or shutil.which("yarn")):
        raise RuntimeError("缺少 Yarn/Corepack，保留旧服务")
    subprocess.run(["bash", "-n", str(ROOT / "start.sh")], check=True)
    subprocess.run(["uv", "run", "--no-sync", "--directory", str(ROOT / "apps/daemon"),
                    "python", "-c", "import main; assert main.app"], check=True, timeout=30)
    if not (ROOT / "apps/web/node_modules/.bin/vite").exists():
        raise RuntimeError("前端依赖缺失，保留旧服务；请先安装依赖")
    # Build before shutdown so broken frontend/toolchain code preserves the old
    # service. start.sh can reuse this build without another failure window.
    yarn = ["corepack", "yarn"] if shutil.which("corepack") else ["yarn"]
    subprocess.run([*yarn, "build"], cwd=ROOT / "apps/landing",
                   env={**os.environ, "LANDING_BASE": "/landing/"}, check=True, timeout=120)


def health_ready() -> bool:
    try:
        with urllib.request.urlopen("http://127.0.0.1:8765/api/health", timeout=2) as response:
            return response.status == 200 and json.load(response).get("status") == "ok"
    except (OSError, ValueError):
        return False


def start_services() -> int:
    child = subprocess.Popen(COMMAND, cwd=ROOT, stdin=subprocess.DEVNULL,
                             start_new_session=True,
                             env={**os.environ, "WORKSTEP_SKIP_LANDING_BUILD": "1"})
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError(f"新启动器 {child.pid} 退出（{child.returncode}）；查看 daemon.log/web.log")
        tree = descendants({child.pid}, process_table())
        daemon, web = listeners(8765), listeners(5173)
        if daemon and web and daemon <= tree and web <= tree and health_ready():
            print(f"重启成功：新启动器 {child.pid}，后台 {sorted(daemon)}，前端 {sorted(web)}", flush=True)
            return child.pid
        time.sleep(.5)
    raise RuntimeError(f"新启动器 {child.pid} 未通过就绪检查；查看 daemon.log/web.log")


def worker() -> None:
    time.sleep(2)  # Allow the Action acknowledgement to finish.
    (ROOT / ".pids").mkdir(exist_ok=True)
    with (ROOT / ".pids/restart.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("已有重启正在执行，请勿重复点击")
        preflight()
        targets = discover_targets()
        print(f"停止本项目旧服务：{sorted(targets)}；独立执行器：{os.getpid()}", flush=True)
        stop_services(targets)
        start_services()


def main() -> None:
    if "--check" in sys.argv:
        print(json.dumps({"root": str(ROOT), "targets": [vars(p) for p in discover_targets().values()],
                          "worker_pid": os.getpid()}, ensure_ascii=False, indent=2))
        return
    (ROOT / ".pids").mkdir(exist_ok=True)
    if "--worker" in sys.argv:
        worker()
        return
    log_path = ROOT / "logs/restart-action.log"
    log_path.parent.mkdir(exist_ok=True)
    with log_path.open("ab", buffering=0) as log:
        child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--worker"],
                                 cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log,
                                 stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
    print(f"已提交重启（执行器 {child.pid}）；此处不代表成功，最终结果见 {log_path}")


if __name__ == "__main__":
    main()
