"""Test configuration."""

import sys
from pathlib import Path

# Add daemon root to path so tests can import main, settings, etc.
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest


@pytest.fixture(scope="session", autouse=True)
def _isolate_workstep_config(tmp_path_factory):
    """Point the shared config store at a temp file for the whole session.

    Tests that initialize projects or write settings must never touch the
    real ``~/.workstep/config.json`` (e.g. leaving stale project entries
    behind after the run, or even when the run is interrupted).
    """
    import services.config as config_mod

    cfg_dir = tmp_path_factory.mktemp("workstep-config") / ".workstep"
    cfg_dir.mkdir(exist_ok=True)
    cfg_file = cfg_dir / "config.json"
    cfg_file.write_text("{}")

    orig_dir = config_mod.CONFIG_DIR
    orig_file = config_mod.CONFIG_FILE
    orig_cache = config_mod.config_store._cache
    config_mod.CONFIG_DIR = cfg_dir
    config_mod.CONFIG_FILE = cfg_file
    config_mod.config_store._cache = None
    try:
        yield
    finally:
        config_mod.CONFIG_DIR = orig_dir
        config_mod.CONFIG_FILE = orig_file
        config_mod.config_store._cache = orig_cache
