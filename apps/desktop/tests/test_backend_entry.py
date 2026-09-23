import importlib.util
from pathlib import Path
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


def test_default_port_requests_an_available_ephemeral_port():
    args = parse_args([])

    assert args.port == 0


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
