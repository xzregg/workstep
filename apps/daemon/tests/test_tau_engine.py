"""Builtin Tau is discoverable without installing or importing its optional SDK."""
import importlib.metadata
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest


def test_builtin_discovery_does_not_require_tau_sdk(tmp_path, monkeypatch):
    from engines import tau
    from engines.core import registry
    monkeypatch.setattr(tau, 'dependency_path', lambda: tmp_path / 'missing')
    def absent(*args, **kwargs):
        raise importlib.metadata.PackageNotFoundError('tau-ai')
    monkeypatch.setattr(tau, 'managed_package_version', absent)
    discovered = registry._discover_engine_classes()
    assert discovered['tau'] is tau.TauEngine
    assert not tau.TauEngine.is_installed()
    assert tau.TauEngine.install_command()
    assert tau.TauEngine.RUNTIME_PACKAGE.name == 'tau-ai'


async def test_install_is_explicit_and_uses_optional_package_directory(tmp_path, monkeypatch):
    from engines import tau
    from engines.core.base import EngineInstallResult
    prepare = lambda: tmp_path
    install = AsyncMock(return_value=EngineInstallResult(True, 'installed'))
    monkeypatch.setattr(tau, 'prepare_engine_package_dir', prepare)
    monkeypatch.setattr(tau, 'install_python_package', install)
    assert (await tau.TauEngine().install()).success
    install.assert_awaited_once_with('tau-ai')


def test_previous_custom_config_and_session_location_survive(monkeypatch, tmp_path):
    from engines import tau
    from services.config import config_store
    monkeypatch.setattr(tau, 'CONFIG_DIR', tmp_path)
    with config_store._lock:
        monkeypatch.setattr(config_store, '_cache', {
            'custom_engine_config': {'tau': {'read_timeout': 450, 'permission_mode': 'deny'}}})
    engine = tau.TauEngine()
    assert engine.get_config_values()['read_timeout'] == 450
    assert engine.get_config_values()['permission_mode'] == 'deny'
    assert engine.session_path('existing-session') == tmp_path / 'runtime/engines/tau-sessions/existing-session.jsonl'


async def test_builtin_configuration_can_be_saved_without_custom_proxy(monkeypatch):
    from engines import tau
    from services.config import config_store
    saved = []
    monkeypatch.setattr(config_store, 'set', lambda key, value: saved.append((key, value)))
    engine = tau.TauEngine()
    await engine.save_config_values({'read_timeout': 450, 'permission_mode': 'deny'})
    key, values = saved[-1]
    assert key == 'tau_engine'
    assert values['read_timeout'] == 450
    assert values['permission_mode'] == 'deny'
    with pytest.raises(ValueError):
        await engine.save_config_values({'read_timeout': 0})


def test_tau_is_not_a_shipped_python_dependency():
    import tomllib
    daemon = Path(__file__).parents[1]
    config = tomllib.loads((daemon / 'pyproject.toml').read_text())
    dependencies = config['project']['dependencies']
    assert not any(dep.lower().startswith(('tau-ai', 'tau_ai')) for dep in dependencies)


def test_runtime_manager_recognizes_previously_installed_custom_sdk(tmp_path, monkeypatch):
    from engines.tau import TauEngine
    from services import engine_runtime
    def missing(*args):
        raise importlib.metadata.PackageNotFoundError('tau-ai')
    monkeypatch.setattr(engine_runtime, 'managed_package_version', missing)
    monkeypatch.setattr(engine_runtime, 'list_all_engines', lambda: {'tau': TauEngine})
    monkeypatch.setattr(TauEngine, 'get_version', staticmethod(lambda: '0.4.12'))
    manager = engine_runtime.EngineRuntimeManager(tmp_path)
    assert manager.installed_version(TauEngine.RUNTIME_PACKAGE) == '0.4.12'
