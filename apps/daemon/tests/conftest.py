"""Test configuration."""

import sys
from pathlib import Path

# Add daemon root to path so tests can import main, settings, etc.
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
import copy
import json


@pytest.fixture
def preview_directory(tmp_path, monkeypatch):
    """File API tests explicitly authorize their isolated filesystem workspace."""
    from services.config import config_store
    import api.fs_paths as fs_paths
    # Keep the machine's broad /tmp tree from authorizing unrelated test files.
    monkeypatch.setattr(fs_paths, '_temporary_preview_roots', lambda: (tmp_path / 'system-temp',))
    monkeypatch.setattr(config_store, '_cache', {
        **config_store._load(), 'default_project_directory': str(tmp_path),
    })
    return tmp_path


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


@pytest.fixture(autouse=True)
def _isolate_test_config(_isolate_workstep_config, tmp_path_factory):
    """Keep persisted account/bot settings from leaking into later tests.

    The session fixture remains the safe base for module/session fixtures;
    each test receives its own copy, including any higher-scope setup.
    """
    import services.config as config_mod
    store = config_mod.config_store
    initial = copy.deepcopy(store._load())
    previous = (config_mod.CONFIG_DIR, config_mod.CONFIG_FILE, store._cache,
                store._managed_gateway_id, store._managed_provider_guard)
    directory = tmp_path_factory.mktemp('test-config')
    path = directory / 'config.json'
    path.write_text(json.dumps(initial), encoding='utf-8')
    config_mod.CONFIG_DIR, config_mod.CONFIG_FILE, store._cache = directory, path, None
    try:
        yield
    finally:
        (config_mod.CONFIG_DIR, config_mod.CONFIG_FILE, store._cache,
         store._managed_gateway_id, store._managed_provider_guard) = previous
