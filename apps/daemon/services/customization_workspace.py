"""One Runtime project root for ordinary customization conversations."""
import asyncio
import threading
from pathlib import Path

_lock = threading.RLock()


def workspace_root() -> Path:
    from services.config import CONFIG_DIR
    from services.project_scope import projects_root
    restricted = projects_root()
    return restricted / 'runtime' if restricted else CONFIG_DIR / 'runtime' / 'workspace'


def runtime_project(manager, root: Path):
    """Called in a worker; serialize first registration across creation entry points."""
    root = root.resolve()
    with _lock:
        root.mkdir(parents=True, exist_ok=True)
        project = manager.get_project(root)
        if project is None:
            project = manager.init_project(root, name='Runtime')
    return project


async def ensure_default_workspace(manager):
    """Prepare the fixed workspace at startup without blocking the event loop."""
    return await asyncio.to_thread(lambda: runtime_project(manager, workspace_root()))
