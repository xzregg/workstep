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
    assert [field.key for field in engine.config_schema()] == ['permission_mode', 'thinking_effort']
    assert engine.supported_provider_protocols() == set()
    assert engine.supports_process_reuse
    assert engine.supports_thinking_effort
    assert engine.supports_live_step_message
    assert engine.supports_vision
    assert engine.supports_tool_approval
    assert engine.supports_manual_compaction
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
    monkeypatch.setattr(AntigravityEngine, '_spawn_with_live_interrupt', capture)
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
    monkeypatch.setattr(AntigravityEngine, '_spawn_with_live_interrupt', capture)
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
    monkeypatch.setattr(AntigravityEngine, '_spawn_with_live_interrupt', capture)
    engine = AntigravityEngine()
    for plan in [True, False]:
        async for _ in engine.spawn('hello', '/tmp', plan_mode=plan):
            pass
    assert seen == [(['/managed/agy', 'acp'], None), (['/managed/agy', 'acp', '--dangerously-skip-permissions'], True)]


@pytest.mark.asyncio
async def test_thinking_effort_config_persists_and_resolves_for_assistants(monkeypatch):
    import engines.antigravity as module
    values = {}
    monkeypatch.setattr(module.config_store, 'get', lambda key, default=None: values.get(key, default))
    monkeypatch.setattr(module.config_store, 'set', lambda key, value: values.__setitem__(key, value))
    engine = AntigravityEngine()
    assert engine.get_config_values()['thinking_effort'] == ''
    await engine.save_config_values({'thinking_effort': 'high'})
    assert engine.get_config_values()['thinking_effort'] == 'high'
    assert module.config_store.get_engine_thinking_effort('antigravity') == 'high'
    await engine.save_config_values({'thinking_effort': 'auto'})
    assert engine.get_config_values()['thinking_effort'] == ''
    assert module.config_store.get_engine_thinking_effort('antigravity') == ''
    await engine.save_config_values({'thinking_effort': 'xhigh'})
    assert engine.get_config_values()['thinking_effort'] == 'xhigh'
    await engine.save_config_values({}, clear={'thinking_effort': True})
    assert engine.get_config_values()['thinking_effort'] == ''
    with pytest.raises(ValueError, match='thinking effort'):
        await engine.save_config_values({'thinking_effort': 'ultra'})


@pytest.mark.asyncio
async def test_list_models_populates_per_model_thought_levels(monkeypatch):
    monkeypatch.setattr(AntigravityEngine, "resolve_binary", staticmethod(lambda: "/fixture/agy"))
    levels_by_model = {
        "gemini-4-neon": ["low", "medium", "high", "xhigh"],
        "claude-sonnet-5-5": ["low", "medium", "high"],
        "gpt-oss-120b-medium": None,
    }
    closed = []

    def tl_option(levels):
        if levels is None:
            return []
        return [SimpleNamespace(id="thought_level", options=[SimpleNamespace(value=v, name=v) for v in levels])]

    class Client:
        async def initialize(self, **kwargs):
            return SimpleNamespace()

        async def new_session(self, **kwargs):
            return SimpleNamespace(
                session_id="s-models",
                config_options=[
                    SimpleNamespace(
                        id="model",
                        options=[
                            SimpleNamespace(value=mid, name=mid, description=None)
                            for mid in levels_by_model
                        ],
                    ),
                    *tl_option(["low", "medium", "high", "xhigh"]),
                ],
            )

        async def set_config_option(self, *, config_id, session_id, value):
            assert config_id == "model" and session_id == "s-models"
            return SimpleNamespace(config_options=tl_option(levels_by_model[value]))

        async def close_session(self, *, session_id):
            closed.append(session_id)

    @asynccontextmanager
    async def process(handler, *cmd, **kwargs):
        yield Client(), object()

    monkeypatch.setattr("engines.core.acp_base.acp.spawn_agent_process", process)
    models = await AntigravityEngine().list_models("/tmp")
    assert {m.id: m.supported_reasoning_efforts for m in models} == levels_by_model
    assert closed == ["s-models"]


@pytest.mark.asyncio
async def test_configure_session_thinking_effort_uses_thought_level_and_clamps():
    engine = AntigravityEngine()
    engine._active_permission_config = {"permission_mode": "default", "thinking_effort": "medium"}
    calls = []

    class Client:
        async def set_config_option(self, **kwargs):
            calls.append(kwargs)

    four_levels = [SimpleNamespace(id="thought_level", options=[SimpleNamespace(value=v) for v in ("low", "medium", "high", "xhigh")])]
    three_levels = [SimpleNamespace(id="thought_level", options=[SimpleNamespace(value=v) for v in ("low", "medium", "high")])]
    no_levels = [SimpleNamespace(id="model", options=[])]

    await engine._configure_session_thinking_effort(Client(), "s1", None, four_levels)
    await engine._configure_session_thinking_effort(Client(), "s1", "auto", four_levels)
    await engine._configure_session_thinking_effort(Client(), "s1", "minimal", four_levels)
    await engine._configure_session_thinking_effort(Client(), "s1", "xhigh", three_levels)
    await engine._configure_session_thinking_effort(Client(), "s1", "high", no_levels)
    assert [(c["config_id"], c["value"]) for c in calls] == [
        ("thought_level", "medium"),
        ("thought_level", "low"),
        ("thought_level", "high"),
    ]


def test_antigravity_maps_invoke_subagent_and_update_steps_events():
    from acp import schema

    engine = AntigravityEngine()
    start = engine.normalize_event(engine._map_notification(schema.ToolCallStart(
        sessionUpdate="tool_call",
        toolCallId="sub-1",
        title="Run invoke_subagent",
        kind="other",
        status="in_progress",
        rawInput={"TypeName": "research", "Role": "Quick Checker", "Prompt": "Inspect repo", "Model": "flash_lite"},
    )))
    assert start is not None and start.type == "subagent"
    assert start.data["task_id"] == "sub-1"
    assert start.data["status"] == "running"
    assert start.data["stage"] == "started"
    assert start.data["agent_name"] == "Quick Checker"
    assert start.data["task_type"] == "research"
    assert start.data["prompt"] == "Inspect repo"

    done = engine.normalize_event(engine._map_notification(schema.ToolCallProgress(
        sessionUpdate="tool_call_update",
        toolCallId="sub-1",
        status="completed",
        rawOutput="All checks passed",
    )))
    assert done is not None and done.type == "subagent"
    assert done.data["task_id"] == "sub-1"
    assert done.data["status"] == "completed"
    assert done.data["stage"] == "notification"
    assert done.data["agent_name"] == "Quick Checker"
    assert done.data["prompt"] == "Inspect repo"
    assert done.data["result"] == "All checks passed"

    plan = engine.normalize_event(engine._map_notification(schema.ToolCallStart(
        sessionUpdate="tool_call",
        toolCallId="plan-1",
        title="Run update_steps",
        kind="other",
        status="in_progress",
        rawInput={"steps": [
            {"title": "Check config", "status": "done"},
            {"title": "Wire events", "status": "in_progress"},
            {"title": "Run tests", "status": "pending"},
        ]},
    )))
    assert plan is not None and plan.type == "plan"
    assert plan.data["entries"] == [
        {"content": "Check config", "priority": "medium", "status": "completed"},
        {"content": "Wire events", "priority": "medium", "status": "in_progress"},
        {"content": "Run tests", "priority": "medium", "status": "pending"},
    ]


@pytest.mark.parametrize("raw_text,expected", [
    (
        "\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h4m13s.\n",
        "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h4m13s.",
    ),
    (
        "\n⚠ Third-party quota reached. Please switch to Gemini models or upgrade your subscription to increase your limits. Resets in 47m27s.\n",
        "Third-party quota reached. Please switch to Gemini models or upgrade your subscription to increase your limits. Resets in 47m27s.",
    ),
    (
        "⚠ Model quota exceeded. Resets in 10m.",
        "Model quota exceeded. Resets in 10m.",
    ),
])
def test_antigravity_maps_inline_quota_warning_chunks_to_error_events(raw_text, expected):
    from acp import schema

    engine = AntigravityEngine()
    event = engine._map_notification(schema.AgentMessageChunk(
        sessionUpdate="agent_message_chunk",
        content=schema.TextContentBlock(type="text", text=raw_text),
    ))
    assert event is not None
    assert event.type == "error"
    assert event.data["message"] == expected


@pytest.mark.parametrize("normal_text", [
    " ⚠",
    " ⚠️",
    "\n⚠ 注意：请先备份数据库\n",
    "已完成代码修改，日志中出现过 Individual quota reached 报错。",
    "\n⚠ Individual quota reached.\n第二行正文\n",
])
def test_antigravity_keeps_normal_warning_prose_as_message_chunks(normal_text):
    from acp import schema

    engine = AntigravityEngine()
    event = engine._map_notification(schema.AgentMessageChunk(
        sessionUpdate="agent_message_chunk",
        content=schema.TextContentBlock(type="text", text=normal_text),
    ))
    assert event is not None
    assert event.type == "agent_message_chunk"
    assert event.data["content"]["text"] == normal_text


def test_antigravity_skips_immediate_retry_for_quota_errors():
    engine = AntigravityEngine()
    assert engine._execution_retry_delays(
        "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h4m13s."
    ) == ()
    assert engine._execution_retry_delays(
        "Third-party quota reached. Please switch to Gemini models or upgrade your subscription to increase your limits. Resets in 47m27s."
    ) == ()
    assert engine._execution_retry_delays("transient transport failure") == (0,)
