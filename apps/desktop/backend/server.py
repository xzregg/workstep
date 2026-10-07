"""Nuitka sidecar entry point for the WorkStep FastAPI daemon."""

from __future__ import annotations

import argparse
import asyncio
import errno
import os
import shutil
import socket
import subprocess
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
        default=8765,
        help="Local port; 0 asks the OS to choose a free port (default: 8765; falls back if occupied)",
    )
    return parser.parse_args(argv)


def bind_server_socket(host: str, port: int) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        try:
            sock.bind((host, port))
        except OSError as exc:
            if not port or exc.errno != errno.EADDRINUSE:
                raise
            sock.bind((host, 0))
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
        else _config_dir() / "runtime" / "python-packages"
    )
    package_dir.mkdir(parents=True, exist_ok=True)
    resolved = str(package_dir.resolve())
    os.environ["WORKSTEP_ENGINE_PACKAGE_DIR"] = resolved
    if resolved in sys.path:
        sys.path.remove(resolved)
    sys.path.insert(0, resolved)
    return package_dir.resolve()


def _config_dir() -> Path:
    configured = os.environ.get("WORKSTEP_CONFIG_DIR", "").strip()
    return (Path(configured).expanduser() if configured else Path.home() / ".workstep").resolve()


def _prepend_environment_paths(name: str, directories: list[Path]) -> None:
    values = [str(directory) for directory in directories]
    existing = os.environ.get(name, "").split(os.pathsep)
    managed = {os.path.normcase(value) for value in values}
    values.extend(value for value in existing if value and os.path.normcase(value) not in managed)
    os.environ[name] = os.pathsep.join(values)


def prepare_runtime_environment() -> None:
    """Keep desktop-managed installs in the same layout as container HOME."""
    runtime = _config_dir() / "runtime"
    npm_prefix = runtime / "npm"
    # npm puts Windows command shims directly in the global prefix.
    npm_bin = npm_prefix if os.name == "nt" else npm_prefix / "bin"
    base_bin = runtime / "base" / "bin"
    python_dir = runtime / "base" / "python"
    for directory in (npm_bin, base_bin, python_dir):
        directory.mkdir(parents=True, exist_ok=True)
    os.environ["NPM_CONFIG_PREFIX"] = str(npm_prefix)
    os.environ["UV_INSTALL_DIR"] = str(base_bin)
    os.environ["UV_PYTHON_INSTALL_DIR"] = str(python_dir)
    host_bins: list[Path] = []
    npm = shutil.which("npm")
    volta_home = Path(os.environ.get("VOLTA_HOME") or Path.home() / ".volta").expanduser()
    # Volta intercepts npm -g and ignores npm's configured prefix. Resolve its
    # real tools once before serving requests, retaining existing host CLIs.
    if npm and Path(npm).parent.resolve() == (volta_home / "bin").resolve():
        volta = shutil.which("volta")
        if volta is None:
            raise RuntimeError("Cannot resolve Volta-managed npm without volta")
        for tool in ("npm", "node"):
            result = subprocess.run(
                [volta, "which", tool], capture_output=True, text=True,
                check=True, timeout=5, cwd=Path.home(),
            )
            binary = Path(result.stdout.strip())
            if not binary.is_absolute() or not binary.is_file():
                raise RuntimeError(f"Volta returned an invalid {tool} executable")
            if binary.parent not in host_bins:
                host_bins.append(binary.parent)
    _prepend_environment_paths("PATH", [npm_bin, base_bin, *host_bins])
    package_dir = prepare_engine_package_dir()
    _prepend_environment_paths("PYTHONPATH", [package_dir])


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
            prepare_runtime_environment()
        app = _load_app(host, port)
        return asyncio.run(_serve(app, sock, port))
    finally:
        sock.close()
