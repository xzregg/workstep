from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from engines.antigravity import AntigravityEngine


def test_only_native_antigravity_engine_is_registered():
    from engines.core.registry import list_all_engines
    engines = list_all_engines()
    assert engines["antigravity"] is AntigravityEngine
    assert "antigravity_sdk" not in engines
    assert AntigravityEngine.RUNTIME_PACKAGE.kind == "native"
    assert AntigravityEngine.install_command() is None


def test_native_auth_has_no_key_gate(monkeypatch, tmp_path):
    binary = tmp_path / "agy"
    binary.write_text("fixture")
    monkeypatch.setattr(AntigravityEngine, "resolve_binary", staticmethod(lambda: str(binary)))
    engine = AntigravityEngine()
    assert engine.get_command() == [str(binary), "acp"]
    assert engine.is_configured()
    assert engine._is_acp_native
    assert [field.key for field in engine.config_schema()] == ['permission_mode']
    assert engine.supported_provider_protocols() == set()
    assert engine.supports_process_reuse
    assert not engine.supports_session_fork


def test_default_cli_location_and_override(monkeypatch, tmp_path):
    import engines.antigravity as module
    monkeypatch.setattr(module.Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.setattr(module.shutil, "which", lambda _: None)
    monkeypatch.delenv("ANTIGRAVITY_BIN", raising=False)
    binary = tmp_path / ".local" / "bin" / "agy"
    binary.parent.mkdir(parents=True)
    binary.write_text("fixture")
    monkeypatch.setattr(AntigravityEngine, "_binary_override", None)
    assert AntigravityEngine.resolve_binary() == str(binary)
    monkeypatch.setattr(AntigravityEngine, "_binary_override", str(tmp_path / "missing"))
    assert AntigravityEngine.resolve_binary() is None


@pytest.mark.asyncio
async def test_native_account_models_come_from_acp_and_keep_host_environment(monkeypatch):
    monkeypatch.setattr(AntigravityEngine, "resolve_binary", staticmethod(lambda: "/fixture/agy"))
    monkeypatch.setenv("ANTIGRAVITY_HOST_FIXTURE", "preserved")
    class Client:
        async def initialize(self, **kwargs): return SimpleNamespace()
        async def new_session(self, **kwargs):
            return SimpleNamespace(config_options=[SimpleNamespace(id="model", options=[
                SimpleNamespace(value="native-account-model", name="Account model", description=None)])])
    @asynccontextmanager
    async def process(handler, *cmd, **kwargs):
        assert cmd == ("/fixture/agy", "acp")
        assert kwargs["env"]["ANTIGRAVITY_HOST_FIXTURE"] == "preserved"
        yield Client(), object()
    monkeypatch.setattr("engines.core.acp_base.acp.spawn_agent_process", process)
    models = await AntigravityEngine().list_models("/tmp")
    assert [m.id for m in models] == ["native-account-model"]


@pytest.mark.asyncio
async def test_permission_setting_requires_confirmation_and_uses_native_flag(monkeypatch):
    from engines.core.permissions import encode_permission_selection
    import engines.antigravity as module
    values = {}
    monkeypatch.setattr(module.config_store, 'get', lambda key, default=None: values.get(key, default))
    monkeypatch.setattr(module.config_store, 'set', lambda key, value: values.__setitem__(key, value))
    monkeypatch.setattr(AntigravityEngine, 'resolve_binary', staticmethod(lambda: '/managed/agy'))
    engine = AntigravityEngine()
    assert engine.get_command() == ['/managed/agy', 'acp']
    assert engine.runtime_permission_decision() is None
    with pytest.raises(ValueError, match='confirmation'):
        await engine.save_config_values({'permission_mode':'bypassPermissions'})
    assert values == {}
    await engine.save_config_values({'permission_mode':'bypassPermissions'}, confirmed={'permission_mode':True})
    assert engine.get_command() == ['/managed/agy', 'acp', '--dangerously-skip-permissions']
    assert engine.runtime_permission_decision() is True
    await engine.set_permission_mode(encode_permission_selection('antigravity', {'permission_mode':'default'}))
    assert engine.get_command() == ['/managed/agy', 'acp']
    assert engine.runtime_permission_decision() is None
    await engine.set_permission_mode('danger-full-access')
    assert engine.get_command()[-1] == '--dangerously-skip-permissions'
    with pytest.raises(ValueError):
        await engine.save_config_values({'permission_mode':'not-a-mode'})


@pytest.mark.asyncio
async def test_step_permission_override_reaches_command_and_does_not_leak(monkeypatch):
    from engines.core.acp_base import AcpEngineBase
    from engines.core.events import InternalEvent
    import engines.antigravity as module
    monkeypatch.setattr(module.config_store, 'get', lambda key, default=None: 'default')
    monkeypatch.setattr(AntigravityEngine, 'resolve_binary', staticmethod(lambda: '/managed/agy'))
    seen = []
    async def capture(self, *args, **kwargs):
        seen.append((self.get_command(), self.runtime_permission_decision()))
        yield InternalEvent(type='status', data={'status':'done'})
    monkeypatch.setattr(AcpEngineBase, 'spawn', capture)
    engine = AntigravityEngine()
    async for _ in engine.spawn('hello', '/tmp', config_overrides={'permission_mode':'bypassPermissions'}):
        pass
    assert seen == [(['/managed/agy', 'acp', '--dangerously-skip-permissions'], True)]
    assert engine.get_command() == ['/managed/agy', 'acp']
    assert engine.runtime_permission_decision() is None
    await engine.set_permission_mode('danger-full-access')
    async for _ in engine.spawn('hello', '/tmp', config_overrides={'permission_mode':'default'}):
        pass
    assert seen[-1] == (['/managed/agy', 'acp'], None)
    assert engine.get_command()[-1] == '--dangerously-skip-permissions'


@pytest.mark.asyncio
async def test_slow_command_configuration_does_not_block_model_discovery(monkeypatch):
    import asyncio
    import threading
    import time
    started, finished = threading.Event(), threading.Event()
    def slow_command(self):
        started.set()
        time.sleep(.2)
        finished.set()
        return []
    monkeypatch.setattr(AntigravityEngine, 'get_command', slow_command)
    request = asyncio.create_task(AntigravityEngine().list_models('/tmp'))
    while not started.is_set():
        await asyncio.sleep(0)
    await asyncio.sleep(.01)
    assert not finished.is_set()
    assert await request == []


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["auto", "accept-edits", "plan"])
async def test_native_modes_keep_approval_bridge_and_plan_toggle(monkeypatch, mode):
    from engines.core.acp_base import AcpEngineBase
    from engines.core.events import InternalEvent
    from engines.core.permissions import encode_permission_selection
    import engines.antigravity as module
    values = {}
    monkeypatch.setattr(module.config_store, 'get', lambda key, default=None: values.get(key, default))
    monkeypatch.setattr(module.config_store, 'set', lambda key, value: values.__setitem__(key, value))
    monkeypatch.setattr(AntigravityEngine, 'resolve_binary', staticmethod(lambda: '/managed/agy'))
    engine = AntigravityEngine()
    assert engine.supports_plan_mode
    assert {o.value for o in engine.config_schema()[0].options} >= {'auto', 'accept-edits', 'plan'}
    await engine.save_config_values({'permission_mode': mode})
    await engine.set_permission_mode(encode_permission_selection('antigravity', {'permission_mode':mode}))
    calls = []
    class Client:
        async def set_config_option(self, **kwargs):
            calls.append(kwargs)
    async def capture(self, *args, **kwargs):
        assert self.get_command() == ['/managed/agy', 'acp']
        assert self.runtime_permission_decision() is None
        await self._configure_session_mode(Client(), 'session', kwargs.get('plan_mode'))
        yield InternalEvent(type='status', data={'status':'done'})
    monkeypatch.setattr(AcpEngineBase, 'spawn', capture)
    for plan in [None, True, False]:
        async for _ in engine.spawn('hello', '/tmp', plan_mode=plan):
            pass
    assert [c['value'] for c in calls] == [mode, 'plan', 'default' if mode == 'plan' else mode]
    assert all(c['config_id'] == 'mode' and c['session_id'] == 'session' for c in calls)


@pytest.mark.asyncio
async def test_plan_downgrades_full_access_and_restores_it(monkeypatch):
    from engines.core.acp_base import AcpEngineBase
    from engines.core.events import InternalEvent
    import engines.antigravity as module
    monkeypatch.setattr(module.config_store, 'get', lambda key, default=None: 'bypassPermissions')
    monkeypatch.setattr(AntigravityEngine, 'resolve_binary', staticmethod(lambda: '/managed/agy'))
    seen = []
    async def capture(self, *args, **kwargs):
        seen.append((self.get_command(), self.runtime_permission_decision()))
        yield InternalEvent(type='status', data={'status':'done'})
    monkeypatch.setattr(AcpEngineBase, 'spawn', capture)
    engine = AntigravityEngine()
    for plan in [True, False]:
        async for _ in engine.spawn('hello', '/tmp', plan_mode=plan):
            pass
    assert seen == [(['/managed/agy', 'acp'], None), (['/managed/agy', 'acp', '--dangerously-skip-permissions'], True)]
