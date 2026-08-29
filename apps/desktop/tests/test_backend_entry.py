from pathlib import Path
import sys

import pytest


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from server import bind_server_socket, parse_args, ready_line


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
