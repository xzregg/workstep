"""Persistent install location for optional Python engines."""

import importlib.abc
import importlib.machinery
import importlib.metadata
import os
import sys
from pathlib import Path


_MANAGED_ENGINE_MODULES = frozenset({
    "claude_agent_sdk",
    "codex_cli_bin",
    "cursor_sdk",
    "deepseek_harness",
    "deepseek_harness_runtime",
    "openai_codex",
    "qoder_agent_sdk",
})


class _ManagedEnginePackageFinder(importlib.abc.MetaPathFinder):
    _workstep_engine_finder = True

    def __init__(self, package_dir: Path):
        self.package_dir = package_dir

    def find_spec(self, fullname, path=None, target=None):
        if path is not None or fullname.partition(".")[0] not in _MANAGED_ENGINE_MODULES:
            return None
        return importlib.machinery.PathFinder.find_spec(
            fullname, [str(self.package_dir)], target
        )


def managed_package_version(name: str) -> str:
    configured = os.environ.get("WORKSTEP_ENGINE_PACKAGE_DIR", "").strip()
    normalized = name.lower().replace("-", "_").replace(".", "_")
    if configured:
        package_dir = Path(configured).expanduser()
        for distribution in importlib.metadata.distributions(path=[str(package_dir)]):
            candidate = str(distribution.metadata.get("Name") or "")
            if candidate.lower().replace("-", "_").replace(".", "_") == normalized:
                return distribution.version
    return importlib.metadata.version(name)


def prepare_engine_package_dir() -> Path:
    configured = os.environ.get("WORKSTEP_ENGINE_PACKAGE_DIR", "").strip()
    config_dir = Path(os.environ.get("WORKSTEP_CONFIG_DIR") or Path.home() / ".workstep")
    package_dir = Path(configured).expanduser() if configured else config_dir / "runtime" / "python-packages"
    package_dir = package_dir.resolve()
    package_dir.mkdir(parents=True, exist_ok=True)
    os.environ["WORKSTEP_ENGINE_PACKAGE_DIR"] = str(package_dir)
    if str(package_dir) in sys.path:
        sys.path.remove(str(package_dir))
    # Optional engines must not replace dependencies locked by the daemon
    # environment (for example logfire's OpenTelemetry packages).
    sys.path.append(str(package_dir))
    sys.meta_path[:] = [
        finder for finder in sys.meta_path
        if not getattr(finder, "_workstep_engine_finder", False)
    ]
    sys.meta_path.insert(0, _ManagedEnginePackageFinder(package_dir))
    return package_dir
