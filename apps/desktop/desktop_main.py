"""WorkStep Desktop — native window + bundled FastAPI daemon.

Bundles the daemon (``apps/daemon``) and the compiled web build
(``apps/web/dist``) into a single desktop app via PyInstaller + pywebview.

Run modes:
    python desktop_main.py               # start daemon + open native window
    python desktop_main.py --serve-only  # start daemon without a window (smoke tests)
    python desktop_main.py --port 9000   # override the default port (8765)
"""

from __future__ import annotations

import argparse
import logging
import logging.handlers
import os
import socket
import sys
import threading
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, urlparse

logger = logging.getLogger("workstep.desktop")

DEFAULT_PORT = 8765
DEFAULT_HOST = "127.0.0.1"
HEALTH_TIMEOUT_S = 30.0


@dataclass(frozen=True)
class ProtocolRequest:
    action: str
    raw_url: str


def parse_workstep_url(value: str) -> ProtocolRequest:
    """Validate a WorkStep deep link before forwarding it to the local UI."""
    parsed = urlparse(value)
    if parsed.scheme.lower() != "workstep":
        raise ValueError("Only workstep:// links are accepted")
    action = parsed.netloc.lower()
    if action == "open" and not parsed.path.rstrip("/"):
        return ProtocolRequest(action="open", raw_url=value)
    if action == "remote-project" and parsed.path.startswith("/v1/"):
        return ProtocolRequest(action="remote-project", raw_url=value)
    raise ValueError("Unsupported WorkStep link")


def local_path_for_protocol_url(value: str) -> str:
    request = parse_workstep_url(value)
    if request.action == "open":
        return "/"
    return f"/?workstep_url={quote(request.raw_url, safe='')}"


# --- path helpers ---


def is_frozen() -> bool:
    return getattr(sys, "frozen", False)


def bundle_root() -> Path:
    """PyInstaller data root (``_MEIPASS``) in a frozen build, repo root in dev."""
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parents[2]


def web_dist_dir() -> Path:
    if is_frozen():
        return bundle_root() / "web_dist"
    return Path(__file__).resolve().parents[2] / "apps" / "web" / "dist"


def ensure_daemon_on_path() -> None:
    """Make ``main``/``settings``/``api``/``services`` importable from source."""
    if not is_frozen():
        daemon_dir = Path(__file__).resolve().parents[1] / "daemon"
        if str(daemon_dir) not in sys.path:
            sys.path.insert(0, str(daemon_dir))


# --- logging ---


def _setup_logging(verbose: bool) -> None:
    log_dir = Path.home() / ".workstep" / "logs"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        log_dir = Path.cwd()
    handlers: list[logging.Handler] = [
        logging.handlers.RotatingFileHandler(
            log_dir / "desktop.log",
            maxBytes=5 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
    ]
    if verbose:
        handlers.append(logging.StreamHandler())
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=handlers,
    )


# --- port / health helpers ---


def _bind(host: str, port: int) -> socket.socket | None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((host, port))
    except OSError:
        sock.close()
        return None
    sock.listen(2048)
    return sock


def _daemon_healthy(host: str, port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/api/health", timeout=1.5) as resp:
            return resp.status == 200
    except Exception:
        return False


def _wait_healthy(host: str, port: int, timeout: float = HEALTH_TIMEOUT_S) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _daemon_healthy(host, port):
            return True
        time.sleep(0.2)
    return False


# --- daemon server ---


def _start_server(app, host: str, port: int, sock: socket.socket):
    import uvicorn

    config = uvicorn.Config(app, host=host, port=port, log_level="info", access_log=False)
    server = uvicorn.Server(config)
    thread = threading.Thread(
        target=server.run,
        kwargs={"sockets": [sock]},
        name="workstep-daemon",
        daemon=True,
    )
    thread.start()
    return server, thread


# --- window ---


def _open_window(host: str, port: int, server, thread, path: str = "/") -> None:
    import webview

    url = f"http://{host}:{port}{path}"
    window = webview.create_window(
        "WorkStep",
        url,
        width=1440,
        height=900,
        min_size=(1024, 700),
    )

    def _shutdown() -> None:
        logger.info("Window closed; shutting down daemon")
        if server is not None:
            server.should_exit = True
            if thread is not None:
                thread.join(timeout=10)

    window.events.closed += _shutdown
    logger.info("Opening desktop window at %s", url)
    webview.start(debug=False)


# --- main ---


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="WorkStep Desktop")
    parser.add_argument("--serve-only", action="store_true",
                        help="Start the daemon without a window (smoke tests)")
    parser.add_argument("--port", type=int, default=None,
                        help=f"Port override (default {DEFAULT_PORT})")
    parser.add_argument("--host", default=None,
                        help=f"Bind host (default {DEFAULT_HOST})")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="Also log to stdout")
    parser.add_argument("protocol_url", nargs="?", help="A workstep:// deep link")
    args = parser.parse_args(argv)

    local_path = "/"
    if args.protocol_url:
        try:
            local_path = local_path_for_protocol_url(args.protocol_url)
        except ValueError as exc:
            parser.error(str(exc))

    _setup_logging(args.verbose or args.serve_only)
    ensure_daemon_on_path()

    host = args.host or os.environ.get("WORKSTEP_HOST") or DEFAULT_HOST
    port = args.port or DEFAULT_PORT

    # Point the daemon at the bundled web build — must happen before `main` is imported.
    web_dist = web_dist_dir()
    os.environ["WORKSTEP_WEB_DIST"] = str(web_dist)
    if not web_dist.exists():
        logger.error("Web build not found at %s — run `npm run build` in apps/web first", web_dist)
        return 1

    server = None
    thread = None

    if args.port is None and not args.serve_only and _daemon_healthy(host, port):
        # Single-instance: an already-running WorkStep daemon owns the default port.
        logger.info("Reusing already-running daemon on %s:%d", host, port)
    else:
        sock = _bind(host, port)
        if sock is None and args.port is not None:
            logger.error("Port %d is already in use", port)
            return 1
        if sock is None:
            sock = _bind(host, 0)
            if sock is None:
                logger.error("Unable to bind a local port")
                return 1
            port = sock.getsockname()[1]
            logger.info("Port %d busy; using %d instead", DEFAULT_PORT, port)

        os.environ["WORKSTEP_PORT"] = str(port)
        os.environ["WORKSTEP_HOST"] = host

        # Imported here so the env vars above are visible to `settings.py`.
        from main import app  # noqa: PLC0415

        server, thread = _start_server(app, host, port, sock)
        if not _wait_healthy(host, port):
            logger.error("Daemon did not become healthy on %s:%d", host, port)
            if server is not None:
                server.should_exit = True
                thread.join(timeout=5)
            return 1
        logger.info("Daemon ready at http://%s:%d", host, port)

    if args.serve_only:
        if server is None:
            logger.info("External daemon on %s:%d — nothing to serve; exiting", host, port)
            return 0
        try:
            while thread is not None and thread.is_alive():
                time.sleep(1)
        except KeyboardInterrupt:
            logger.info("Interrupted; shutting down")
        server.should_exit = True
        thread.join(timeout=10)
        return 0

    _open_window(host, port, server, thread, local_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
