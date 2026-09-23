"""Nuitka sidecar entry point for the WorkStep FastAPI daemon."""

from __future__ import annotations

import argparse
import asyncio
import os
import socket
import sys
from pathlib import Path


def valid_port(value: str) -> int:
    try:
        port = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("port must be an integer") from exc
    if not 0 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be between 0 and 65535")
    return port


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="WorkStep FastAPI sidecar")
    parser.add_argument(
        "--port",
        type=valid_port,
        default=0,
        help="Local port; 0 asks the OS to choose a free port (default: 0)",
    )
    return parser.parse_args(argv)


def bind_server_socket(host: str, port: int) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind((host, port))
        sock.listen(2048)
        return sock
    except BaseException:
        sock.close()
        raise


def ready_line(port: int) -> str:
    return f"PORT:{port}"


def _bundle_dir() -> Path:
    if "__compiled__" in globals():
        return Path(sys.argv[0]).resolve().parent
    source_dir = Path(__file__).resolve().parent
    packaged_root = source_dir.parent
    if (packaged_root / "web_dist").is_dir():
        return packaged_root
    return source_dir


def _daemon_dir() -> Path:
    configured = os.environ.get("WORKSTEP_DAEMON_DIR")
    if configured:
        return Path(configured).resolve()
    packaged = Path(__file__).resolve().parent / "daemon"
    if packaged.is_dir():
        return packaged
    return Path(__file__).resolve().parents[2] / "daemon"


def prepare_engine_package_dir() -> Path:
    """Expose a writable, update-stable site directory for optional engines."""
    configured = os.environ.get("WORKSTEP_ENGINE_PACKAGE_DIR", "").strip()
    package_dir = (
        Path(configured).expanduser()
        if configured
        else Path.home() / ".workstep" / "runtime" / "python-packages"
    )
    package_dir.mkdir(parents=True, exist_ok=True)
    resolved = str(package_dir.resolve())
    os.environ["WORKSTEP_ENGINE_PACKAGE_DIR"] = resolved
    if resolved in sys.path:
        sys.path.remove(resolved)
    sys.path.insert(0, resolved)
    return package_dir.resolve()


def prepare_cli_environment(host: str, port: int) -> None:
    """Expose the bundled CLI location and live daemon endpoint to engines."""
    os.environ["WORKSTEP_DAEMON_DIR"] = str(_daemon_dir())
    os.environ["WORKSTEP_CLI_PYTHON"] = sys.executable
    os.environ["WORKSTEP_DAEMON_URL"] = f"http://{host}:{port}"


def _load_app(host: str, port: int):
    os.environ["WORKSTEP_HOST"] = host
    os.environ["WORKSTEP_PORT"] = str(port)
    os.environ.setdefault("WORKSTEP_WEB_DIST", str(_bundle_dir() / "web_dist"))
    prepare_cli_environment(host, port)

    if "__compiled__" in globals():
        from daemon_entry import app  # type: ignore[import-not-found]  # noqa: PLC0415
    else:
        daemon_dir = _daemon_dir()
        if str(daemon_dir) not in sys.path:
            sys.path.insert(0, str(daemon_dir))
        # The daemon intentionally resolves bundled static assets and template
        # defaults relative to its project root, matching `uvicorn main:app`
        # in development.
        os.chdir(daemon_dir)
        from main import app  # noqa: PLC0415

    return app


async def _serve(app, sock: socket.socket, port: int) -> int:
    import uvicorn

    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        log_level="info",
        access_log=False,
    )
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve(sockets=[sock]))
    while not server.started and not task.done():
        await asyncio.sleep(0.02)
    if task.done():
        await task
        return 1
    print(ready_line(port), flush=True)
    await task
    return 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    host = "127.0.0.1"
    try:
        sock = bind_server_socket(host, args.port)
    except OSError as exc:
        print(f"ERROR:cannot bind {host}:{args.port}: {exc}", file=sys.stderr, flush=True)
        return 2

    port = sock.getsockname()[1]
    try:
        if os.environ.get("WORKSTEP_DESKTOP_RUNTIME") == "1":
            prepare_engine_package_dir()
        app = _load_app(host, port)
        return asyncio.run(_serve(app, sock, port))
    finally:
        sock.close()
