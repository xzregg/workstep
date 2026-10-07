import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


SERVER_PATH = Path(__file__).resolve().parents[1] / "backend" / "server.py"
SERVER_SPEC = importlib.util.spec_from_file_location("workstep_desktop_server", SERVER_PATH)
assert SERVER_SPEC and SERVER_SPEC.loader
server = importlib.util.module_from_spec(SERVER_SPEC)
SERVER_SPEC.loader.exec_module(server)
bind_server_socket = server.bind_server_socket
parse_args = server.parse_args
ready_line = server.ready_line


@pytest.fixture(autouse=True)
def isolate_runtime_environment(monkeypatch):
    for name in (
        "PATH", "PYTHONPATH", "NPM_CONFIG_PREFIX", "UV_INSTALL_DIR",
        "UV_PYTHON_INSTALL_DIR", "WORKSTEP_ENGINE_PACKAGE_DIR",
        "WORKSTEP_DAEMON_DIR", "WORKSTEP_CLI_PYTHON", "WORKSTEP_DAEMON_URL",
    ):
        if name in os.environ:
            monkeypatch.setenv(name, os.environ[name])
        else:
            monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(sys, "path", list(sys.path))


def test_default_port_prefers_the_fixed_port():
    args = parse_args([])

    assert args.port == 8766


def test_port_can_be_changed_from_the_command_line():
    args = parse_args(["--port", "43123"])

    assert args.port == 43123


@pytest.mark.parametrize("value", ["-1", "65536", "abc"])
def test_invalid_port_is_rejected(value):
    with pytest.raises(SystemExit):
        parse_args(["--port", value])


def test_ephemeral_socket_reports_the_actual_bound_port():
    sock = bind_server_socket("127.0.0.1", 0)
    try:
        actual_port = sock.getsockname()[1]

        assert 1 <= actual_port <= 65535
        assert ready_line(actual_port) == f"PORT:{actual_port}"
    finally:
        sock.close()


def test_packaged_source_layout_resolves_daemon_and_web_assets(tmp_path, monkeypatch):
    monkeypatch.delenv("WORKSTEP_DAEMON_DIR", raising=False)
    app_dir = tmp_path / "app"
    daemon_dir = app_dir / "daemon"
    web_dist = tmp_path / "web_dist"
    daemon_dir.mkdir(parents=True)
    web_dist.mkdir()
    fake_server = app_dir / "server.py"
    fake_server.touch()
    monkeypatch.setattr(server, "__file__", str(fake_server))

    assert server._daemon_dir() == daemon_dir
    assert server._bundle_dir() == tmp_path


def test_cli_environment_uses_bundled_python_daemon_and_actual_port(tmp_path, monkeypatch):
    monkeypatch.delenv("WORKSTEP_DAEMON_DIR", raising=False)
    app_dir = tmp_path / "app"
    daemon_dir = app_dir / "daemon"
    daemon_dir.mkdir(parents=True)
    fake_server = app_dir / "server.py"
    fake_server.touch()
    monkeypatch.setattr(server, "__file__", str(fake_server))
    monkeypatch.setattr(server.sys, "executable", str(tmp_path / "python" / "python.exe"))

    server.prepare_cli_environment("127.0.0.1", 43123)

    assert server.os.environ["WORKSTEP_DAEMON_DIR"] == str(daemon_dir)
    assert server.os.environ["WORKSTEP_CLI_PYTHON"] == str(tmp_path / "python" / "python.exe")
    assert server.os.environ["WORKSTEP_DAEMON_URL"] == "http://127.0.0.1:43123"


def test_engine_packages_use_a_writable_user_directory(tmp_path, monkeypatch):
    package_dir = tmp_path / "runtime" / "python-packages"
    monkeypatch.setenv("WORKSTEP_ENGINE_PACKAGE_DIR", str(package_dir))

    resolved = server.prepare_engine_package_dir()

    assert resolved == package_dir
    assert package_dir.is_dir()
    assert sys.path[0] == str(package_dir)


def test_desktop_runtime_uses_config_home_and_exposes_packages_to_child_python(tmp_path, monkeypatch):
    config = tmp_path / "home with spaces" / ".workstep"
    monkeypatch.setenv("WORKSTEP_CONFIG_DIR", str(config))
    monkeypatch.delenv("WORKSTEP_ENGINE_PACKAGE_DIR", raising=False)
    monkeypatch.setenv("NPM_CONFIG_PREFIX", str(tmp_path / "host-global"))
    monkeypatch.setattr(sys, "path", list(sys.path))
    server.prepare_runtime_environment()

    runtime = config / "runtime"
    assert os.environ["NPM_CONFIG_PREFIX"] == str(runtime / "npm")
    assert os.environ["UV_INSTALL_DIR"] == str(runtime / "base/bin")
    assert os.environ["UV_PYTHON_INSTALL_DIR"] == str(runtime / "base/python")
    package_dir = runtime / "python-packages"
    (package_dir / "workstep_runtime_fixture.py").write_text("VALUE = 42\n")
    result = subprocess.run(
        [sys.executable, "-c", "import workstep_runtime_fixture; assert workstep_runtime_fixture.VALUE == 42"],
        capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 0, result.stderr


def test_desktop_runtime_defaults_to_home_and_finds_managed_cli_first(tmp_path, monkeypatch):
    monkeypatch.setattr(server.Path, "home", lambda: tmp_path)
    monkeypatch.delenv("WORKSTEP_CONFIG_DIR", raising=False)
    monkeypatch.delenv("WORKSTEP_ENGINE_PACKAGE_DIR", raising=False)
    monkeypatch.setattr(sys, "path", list(sys.path))
    original_path = os.environ.get("PATH", "")
    server.prepare_runtime_environment()
    server.prepare_runtime_environment()
    prefix = tmp_path / ".workstep/runtime/npm"
    cli_dir = prefix if os.name == "nt" else prefix / "bin"
    cli = cli_dir / ("workstep-fixture.cmd" if os.name == "nt" else "workstep-fixture")
    cli.write_text("@echo fixture\n" if os.name == "nt" else "#!/bin/sh\necho fixture\n")
    cli.chmod(0o755)
    assert shutil.which(cli.name) == str(cli)
    assert os.environ["PATH"].split(os.pathsep).count(str(cli_dir)) == 1
    assert os.environ["PATH"].endswith(original_path)


def test_desktop_runtime_preserves_custom_python_package_directory(tmp_path, monkeypatch):
    monkeypatch.setenv("WORKSTEP_CONFIG_DIR", str(tmp_path / "config"))
    package_dir = tmp_path / "custom-packages"
    monkeypatch.setenv("WORKSTEP_ENGINE_PACKAGE_DIR", str(package_dir))
    monkeypatch.setattr(sys, "path", list(sys.path))
    server.prepare_runtime_environment()
    assert sys.path[0] == str(package_dir)
    assert os.environ["PYTHONPATH"].split(os.pathsep)[0] == str(package_dir)


def test_desktop_local_npm_install_update_and_restart_use_managed_directory(tmp_path, monkeypatch):
    npm = shutil.which("npm")
    if npm is None:
        pytest.skip("npm is needed for the offline CLI install check")
    monkeypatch.setenv("WORKSTEP_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.delenv("WORKSTEP_ENGINE_PACKAGE_DIR", raising=False)
    monkeypatch.setenv("NPM_CONFIG_CACHE", str(tmp_path / "npm-cache"))
    server.prepare_runtime_environment()
    npm = shutil.which("npm")
    package = tmp_path / "package"
    package.mkdir()
    for version in ("1.0.0", "2.0.0"):
        (package / "package.json").write_text(json.dumps({
            "name": "workstep-runtime-fixture", "version": version,
            "bin": {"workstep-runtime-fixture": "cli.js"},
        }))
        (package / "cli.js").write_text(f'#!/usr/bin/env node\nconsole.log("{version}");\n')
        result = subprocess.run(
            [npm, "install", "-g", "--offline", "--ignore-scripts", "--install-links", str(package)],
            capture_output=True, text=True, timeout=30, shell=os.name == "nt",
        )
        assert result.returncode == 0, result.stderr
        # Repeat initialization as at the next launch, without reinstalling.
        server.prepare_runtime_environment()
        cli = shutil.which("workstep-runtime-fixture")
        assert cli is not None
        assert Path(cli).is_relative_to(tmp_path / "config/runtime/npm")
        result = subprocess.run([cli], capture_output=True, text=True, timeout=10, shell=os.name == "nt")
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == version


def test_desktop_main_prepares_runtime_before_loading_daemon(tmp_path, monkeypatch):
    monkeypatch.setenv("WORKSTEP_DESKTOP_RUNTIME", "1")
    monkeypatch.setenv("WORKSTEP_CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("WORKSTEP_ENGINE_PACKAGE_DIR", raising=False)

    def load_app(host, port):
        assert os.environ["NPM_CONFIG_PREFIX"] == str(tmp_path / "runtime/npm")
        assert sys.path[0] == str(tmp_path / "runtime/python-packages")
        return object()

    async def serve(app, sock, port):
        return 0

    monkeypatch.setattr(server, "_load_app", load_app)
    monkeypatch.setattr(server, "_serve", serve)
    assert server.main([]) == 0


def test_occupied_port_falls_back_without_connecting_to_existing_service():
    occupied = bind_server_socket("127.0.0.1", 0)
    preferred = occupied.getsockname()[1]
    try:
        fallback = bind_server_socket("127.0.0.1", preferred)
        try:
            assert fallback.getsockname()[1] != preferred
            assert fallback.getsockname()[1] > 0
        finally:
            fallback.close()
    finally:
        occupied.close()


def test_available_requested_port_is_reused():
    first = bind_server_socket("127.0.0.1", 0)
    preferred = first.getsockname()[1]
    first.close()
    second = bind_server_socket("127.0.0.1", preferred)
    try:
        assert second.getsockname()[1] == preferred
    finally:
        second.close()


def test_desktop_listener_accepts_lan_connections(monkeypatch):
    seen = {}

    def bind(host, port):
        seen.update(host=host, port=port)
        raise OSError("stop after observing bind")

    monkeypatch.setattr(server, "bind_server_socket", bind)

    assert server.main(["--port", "8766"]) == 2
    assert seen == {"host": "0.0.0.0", "port": 8766}
