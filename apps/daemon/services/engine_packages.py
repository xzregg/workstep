"""Persistent install location for optional Python engines."""

import os
import sys
from pathlib import Path


def prepare_engine_package_dir() -> Path:
    configured = os.environ.get("WORKSTEP_ENGINE_PACKAGE_DIR", "").strip()
    config_dir = Path(os.environ.get("WORKSTEP_CONFIG_DIR") or Path.home() / ".workstep")
    package_dir = Path(configured).expanduser() if configured else config_dir / "runtime" / "python-packages"
    package_dir = package_dir.resolve()
    package_dir.mkdir(parents=True, exist_ok=True)
    os.environ["WORKSTEP_ENGINE_PACKAGE_DIR"] = str(package_dir)
    if str(package_dir) in sys.path:
        sys.path.remove(str(package_dir))
    sys.path.insert(0, str(package_dir))
    return package_dir
