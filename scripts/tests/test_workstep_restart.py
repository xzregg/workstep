"""Restart discovery and shutdown tests never signal a real WorkStep process."""

import importlib.util
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from unittest.mock import Mock

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "workstep_restart.py"


@pytest.fixture
def restart(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("workstep_restart_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    return module


def table(restart):
    processes = {
        100: restart.Process(100, 1, "old", "sh start.sh 8765 dev"),
        101: restart.Process(101, 100, "old", "uv run --no-sync uvicorn main:app --port 8765"),
        102: restart.Process(102, 101, "old", "/venv/bin/uvicorn main:app --port 8765"),
        200: restart.Process(200, 1, "duplicate", "bash start.sh 8765 dev"),
        300: restart.Process(300, 102, "worker", "python workstep_restart.py --worker"),
        301: restart.Process(301, 300, "worker-child", "ps"),
        350: restart.Process(350, 102, "engine", "codex app-server"),
        400: restart.Process(400, 1, "other", "sh start.sh 8700 dev"),
    }
    return {pid: restart.Process(p.pid, p.parent, p.started, p.command,
                                300 if pid in {300, 301} else 100)
            for pid, p in processes.items()}


def configure(restart, monkeypatch, processes):
    monkeypatch.setattr(restart, "process_table", lambda: processes)
    monkeypatch.setattr(restart.os, "getpid", lambda: 300)
    monkeypatch.setattr(restart.os, "getpgrp", lambda: 300)
    monkeypatch.setattr(restart, "listeners", lambda port: {102} if port == 8765 else set())
    monkeypatch.setattr(restart, "process_cwd", lambda pid: restart.ROOT / "apps/daemon" if pid in {101, 102} else restart.ROOT)


def test_stale_pid_file_discovers_listener_ancestors_and_duplicate_launchers(restart, monkeypatch):
    (restart.ROOT / ".pids").mkdir()
    (restart.ROOT / ".pids/daemon.pid").write_text("99999")
    configure(restart, monkeypatch, table(restart))
    targets = restart.discover_targets()
    assert set(targets) == {100, 101, 102, 200}
    assert 300 not in targets and 301 not in targets and 400 not in targets
    assert 350 not in targets


def test_foreign_port_owner_aborts_before_any_shutdown(restart, monkeypatch):
    configure(restart, monkeypatch, table(restart))
    monkeypatch.setattr(restart, "process_cwd", lambda pid: Path("/other/project"))
    kill = Mock()
    monkeypatch.setattr(restart.os, "kill", kill)
    with pytest.raises(RuntimeError, match="其他项目"):
        restart.discover_targets()
    kill.assert_not_called()


def test_standalone_daemon_can_restart_without_a_launcher(restart, monkeypatch):
    processes = {102: restart.Process(102, 1, "old", "uvicorn main:app --port 8765", 100)}
    configure(restart, monkeypatch, processes)
    assert set(restart.discover_targets()) == {102}


def test_restart_lock_rejects_duplicate_clicks_before_shutdown(restart, monkeypatch):
    monkeypatch.setattr(restart.time, "sleep", lambda _: None)
    monkeypatch.setattr(restart.fcntl, "flock", Mock(side_effect=BlockingIOError))
    stop = Mock()
    monkeypatch.setattr(restart, "stop_services", stop)
    with pytest.raises(RuntimeError, match="已有重启"):
        restart.worker()
    stop.assert_not_called()


def test_old_launcher_cleanup_cannot_read_stale_pid_files(restart, monkeypatch):
    processes = table(restart)
    configure(restart, monkeypatch, processes)
    (restart.ROOT / ".pids").mkdir()
    stale_file = restart.ROOT / ".pids/daemon.pid"
    stale_file.write_text("99999")
    targets = restart.discover_targets()
    def terminate(pid, sig):
        assert not stale_file.exists()
        assert pid in targets and sig == signal.SIGTERM
        processes.pop(pid)
    monkeypatch.setattr(restart.os, "kill", terminate)
    monkeypatch.setattr(restart, "listeners", lambda port: set())
    restart.stop_services(targets)
    assert 300 in processes and 350 in processes


def test_pid_reuse_and_worker_are_never_signalled(restart, monkeypatch):
    processes = table(restart)
    configure(restart, monkeypatch, processes)
    old = processes[102]
    processes[102] = restart.Process(102, 1, "new", "unrelated process")
    kill = Mock()
    monkeypatch.setattr(restart.os, "kill", kill)
    restart.signal_targets({102: old, 300: processes[300]}, restart.signal.SIGTERM)
    kill.assert_not_called()


def test_preflight_failure_never_stops_the_old_service(restart, monkeypatch):
    monkeypatch.setattr(restart.time, "sleep", lambda _: None)
    monkeypatch.setattr(restart, "preflight", Mock(side_effect=RuntimeError("启动检查失败")))
    stop = Mock()
    monkeypatch.setattr(restart, "stop_services", stop)
    with pytest.raises(RuntimeError, match="启动检查失败"):
        restart.worker()
    stop.assert_not_called()


def test_detached_worker_survives_its_launching_process_group(tmp_path):
    # A harmless marker child uses exactly the restart detachment contract.
    marker = tmp_path / "survived"
    child = "import time,pathlib; time.sleep(.3); pathlib.Path(%r).write_text('ok')" % str(marker)
    parent = "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c',%r],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); print(p.pid,flush=True); time.sleep(10)" % child
    launcher = subprocess.Popen([sys.executable, "-c", parent], stdout=subprocess.PIPE,
                                text=True, start_new_session=True)
    try:
        assert int(launcher.stdout.readline()) > 1
        os.killpg(launcher.pid, signal.SIGTERM)
        launcher.wait(timeout=5)
    finally:
        if launcher.poll() is None:
            launcher.terminate()
            launcher.wait(timeout=5)
        launcher.stdout.close()
    deadline = time.monotonic() + 5
    while not marker.exists() and time.monotonic() < deadline:
        time.sleep(.05)
    assert marker.read_text() == "ok"


def test_startup_requires_new_listener_to_belong_to_new_launcher(restart, monkeypatch):
    configure(restart, monkeypatch, table(restart))
    child = Mock(pid=500)
    child.poll.return_value = 1
    monkeypatch.setattr(restart.subprocess, "Popen", Mock(return_value=child))
    with pytest.raises(RuntimeError, match="启动器.*退出"):
        restart.start_services()


def test_startup_accepts_only_ready_new_daemon_and_frontend(restart, monkeypatch):
    processes = {
        500: restart.Process(500, 1, "new", "bash start.sh 8765 dev"),
        501: restart.Process(501, 500, "new", "uvicorn main:app --port 8765"),
        502: restart.Process(502, 500, "new", "node node_modules/.bin/vite"),
    }
    configure(restart, monkeypatch, processes)
    monkeypatch.setattr(restart, "listeners", lambda port: {501} if port == 8765 else {502})
    child = Mock(pid=500)
    child.poll.return_value = None
    monkeypatch.setattr(restart.subprocess, "Popen", Mock(return_value=child))
    monkeypatch.setattr(restart, "health_ready", lambda: True)
    assert restart.start_services() == 500


def test_startup_does_not_accept_an_old_healthy_listener(restart, monkeypatch):
    configure(restart, monkeypatch, table(restart))
    child = Mock(pid=500)
    child.poll.side_effect = [None, 1]
    monkeypatch.setattr(restart.subprocess, "Popen", Mock(return_value=child))
    monkeypatch.setattr(restart, "listeners", lambda port: {102})
    monkeypatch.setattr(restart, "health_ready", lambda: True)
    monkeypatch.setattr(restart.time, "sleep", lambda _: None)
    with pytest.raises(RuntimeError, match="启动器.*退出"):
        restart.start_services()


@pytest.mark.parametrize("mode,ports", [("dev", [8765, 5173]), ("prod", [8765])])
@pytest.mark.parametrize("shutdown", ["term", "force", "blocked"])
def test_start_releases_occupied_ports_before_continuing(tmp_path, mode, ports, shutdown):
    source = (SCRIPT.parents[1] / "start.sh").read_text()
    functions = source.split("# === 工具函数 ===", 1)[1].split("# === 预检查 ===", 1)[0]
    precheck = source.split("# === 预检查 ===", 1)[1].split("# 检查依赖", 1)[0]
    # Shell functions intercept every signal and port probe; no real process is touched.
    harness = r'''set -e
RED=
GREEN=
YELLOW=
BLUE=
NC=
PORT=8765
MODE=$1
SHUTDOWN=$2
STATE=$3
lsof() {
    case "$*" in
        *:8765*) port=8765 ;;
        *:5173*) port=5173 ;;
        *) return 1 ;;
    esac
    [ -f "$STATE/$port" ] || return 1
    cat "$STATE/$port"
}
kill() {
    echo "$*" >> "$STATE/signals"
    case "$*" in
        *87650*) port=8765 ;;
        *51730*) port=5173 ;;
        *) exit 90 ;;
    esac
    if [ "$SHUTDOWN" = term ] || { [ "$SHUTDOWN" = force ] && [ "$1" = -9 ]; }; then
        rm -f "$STATE/$port"
    fi
}
sleep() { :; }
'''
    (tmp_path / "8765").write_text("87650\n")
    (tmp_path / "5173").write_text("51730\n")
    result = subprocess.run(
        ["bash", "-c", harness + functions + precheck + '\necho CONTINUED',
         "bash", mode, shutdown, str(tmp_path)],
        capture_output=True, text=True, timeout=5,
    )
    signals = (tmp_path / "signals").read_text() if (tmp_path / "signals").exists() else ""
    if shutdown == "blocked":
        assert result.returncode != 0
        assert "CONTINUED" not in result.stdout
        assert "无法释放端口" in result.stdout
    else:
        assert result.returncode == 0, result.stderr
        assert "CONTINUED" in result.stdout
        for port in ports:
            assert not (tmp_path / str(port)).exists()
            assert str(port * 10) in signals
        assert ("-9" in signals) == (shutdown == "force")
        if mode == "prod":
            assert (tmp_path / "5173").exists()
