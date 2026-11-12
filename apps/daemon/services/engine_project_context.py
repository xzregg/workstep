"""Task-local project identity when an assistant executes in a work copy."""
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

_context = ContextVar('engine_project_context', default=None)


@contextmanager
def engine_project_context(execution_root: Path, project_root: Path, data_root: Path):
    # The workspace resolves these paths in its I/O worker before entering.
    token = _context.set((execution_root, project_root, data_root))
    try:
        yield
    finally:
        _context.reset(token)


def project_context_for(cwd: str | Path):
    value = _context.get()
    return value if value and Path(cwd).resolve().is_relative_to(value[0]) else None
