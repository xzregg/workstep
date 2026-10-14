"""Synchronous memory I/O constrained to the project's data directory.

Call these complete work units from a worker thread, never the event loop.
"""

import errno
import os
import stat
import tempfile
from pathlib import Path


def resolve_memory_path(data_root: Path) -> Path:
    root = Path(data_root).resolve()
    try:
        path = (root / "MEMORY.md").resolve()
        path.relative_to(root)
    except (ValueError, RuntimeError) as exc:
        raise PermissionError("Memory file is outside the project data directory") from exc
    return path


def read_memory_bytes(data_root: Path) -> bytes | None:
    path = resolve_memory_path(data_root)
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except FileNotFoundError:
        return None
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise PermissionError("Memory file changed to a symbolic link") from exc
        raise
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        return None
    with os.fdopen(fd, "rb") as stream:
        return stream.read()


def write_memory_bytes(data_root: Path, content: bytes) -> None:
    path = resolve_memory_path(data_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=".MEMORY.md.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def delete_memory(data_root: Path) -> None:
    resolve_memory_path(data_root).unlink(missing_ok=True)
