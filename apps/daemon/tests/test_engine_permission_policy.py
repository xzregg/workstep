"""Engine-owned permissions must survive custom worker discovery and execution."""

import json
from types import SimpleNamespace

import pytest

from .test_custom_engines import ADAPTER, custom_environment


def test_project_engine_catalog_keeps_permission_choices_without_native_policy():
    from services.project_scope import workspace_engine_catalog

    result = workspace_engine_catalog([{
        "id": "custom", "permission_modes": ["auto", "ask"],
        "permission_policy": {"overrides": {"auto": {"native_field": "value"}}},
    }])[0]
    assert result["permission_modes"] == ["auto", "ask"]
    assert "permission_policy" not in result


@pytest.mark.asyncio
async def test_custom_engine_maps_permissions_and_plan_without_central_registration(custom_environment):
    from agent_assistants.engine_invocation import run_engine_turn
    from engines.core.custom_proxy import make_custom_engine
    from services.custom_engines import custom_engine_manager as manager

    adapter = ADAPTER.replace(
        'from engines.core.custom_sdk import CustomEngineBase',
        'import json\nfrom engines.core.permissions import EnginePermissionPolicy\n'
        'from engines.core.custom_sdk import CustomEngineBase',
    ).replace(
        '    ENGINE_ID = "example_custom"',
        '''    ENGINE_ID = "example_custom"
    SUPPORTS_SERVICE_TIER = True
    PERMISSION_POLICY = EnginePermissionPolicy(
        overrides={"read-only": {"access": "inspect"},
                   "danger-full-access": {"access": "unrestricted"},
                   "ask": {"consent": "manual"}, "auto": {"consent": "allow"}},
        plan_overrides={"access": "inspect", "plan_only": True},
        consent_key="consent", consent_values={"allow": True, "manual": None},
    )''',
    ).replace(
        'yield agent_message_chunk("WORKSTEP_ENGINE_OK")',
        'yield agent_message_chunk(json.dumps({"mode": self.runtime_permission_mode(), '
        '"config": kwargs.get("config_overrides"), "prompt": prompt}))',
    )
    (custom_environment / "engine.py").write_text(adapter)
    info = (await manager.inspect(str(custom_environment)))["engine"]
    cls = make_custom_engine(custom_environment, info)
    assert "danger-full-access" in cls.permission_modes()
    for mode, plan, expected in [
        ("danger-full-access", False, {"access": "unrestricted"}),
        ("read-only", False, {"access": "inspect"}),
        ("ask", False, {"consent": "manual"}),
        ("auto", False, {"consent": "allow"}),
        ("danger-full-access", True, {"access": "inspect", "plan_only": True}),
    ]:
        engine = cls()
        try:
            text, _, _ = await run_engine_turn(
                "example_custom", None, str(custom_environment), "hello", None,
                engine_factory=lambda _: engine, settings_store=SimpleNamespace(),
                permission_mode=mode, plan_mode=plan, service_tier="priority",
                config_overrides={"provider_id": "preserved"},
            )
            result = json.loads(text)
            assert result["mode"] == mode
            assert result["config"] == {"provider_id": "preserved", "service_tier": "priority", **expected}
        finally:
            await engine.stop()


@pytest.mark.asyncio
async def test_undeclared_custom_permission_fails_before_starting_worker(custom_environment):
    from agent_assistants.engine_invocation import run_engine_turn
    from engines.core.custom_proxy import make_custom_engine
    from services.custom_engines import custom_engine_manager as manager

    info = (await manager.inspect(str(custom_environment)))["engine"]
    engine = make_custom_engine(custom_environment, info)()
    try:
        with pytest.raises(ValueError, match="read-only"):
            await run_engine_turn(
                "example_custom", None, str(custom_environment), "hello", None,
                engine_factory=lambda _: engine, settings_store=SimpleNamespace(),
                permission_mode="read-only",
            )
        assert engine._worker is None
    finally:
        await engine.stop()


@pytest.mark.asyncio
async def test_custom_default_consent_uses_its_own_native_config(custom_environment):
    import asyncio
    from engines.core.custom_proxy import make_custom_engine
    from services.custom_engines import custom_engine_manager as manager

    adapter = ADAPTER.replace(
        'from engines.core.custom_sdk import CustomEngineBase',
        'from engines.core.permissions import EnginePermissionPolicy\n'
        'from engines.core.interactions import elicitation_request\n'
        'from engines.core.custom_sdk import CustomEngineBase',
    ).replace(
        '    ENGINE_ID = "example_custom"',
        '''    ENGINE_ID = "example_custom"
    PERMISSION_POLICY = EnginePermissionPolicy(
        consent_key="native_confirmation", consent_values={"yes": True, "no": False},
    )''',
    ).replace(
        'yield agent_message_chunk("WORKSTEP_ENGINE_OK")',
        '''self.configure_interaction_policy(kwargs.get("config_overrides") or {})
        async def publish(event):
            raise AssertionError("configured consent must resolve without a prompt")
        response = await self.request_interaction(elicitation_request(
            interaction_id="consent", message="Allow?",
            requested_schema={"type": "object", "properties": {}},
        ), publish)
        yield agent_message_chunk(response["action"])''',
    )
    (custom_environment / "engine.py").write_text(adapter)
    info = (await manager.inspect(str(custom_environment)))["engine"]
    for value, expected in [("yes", "accept"), ("no", "decline")]:
        engine = make_custom_engine(custom_environment, info)()
        async def collect():
            return [event async for event in engine.spawn(
                "hello", str(custom_environment), config_overrides={"native_confirmation": value},
            )]
        try:
            events = await asyncio.wait_for(collect(), 3)
            assert [e.data["content"]["text"] for e in events if e.type == "agent_message_chunk"] == [expected]
        finally:
            await engine.stop()


@pytest.mark.asyncio
async def test_custom_skill_and_compaction_declarations_survive_discovery(custom_environment):
    from engines.core.base import EngineSkillPolicy
    from engines.core.custom_proxy import make_custom_engine
    from services.custom_engines import custom_engine_manager as manager

    adapter = ADAPTER.replace(
        'from engines.core.base import EngineInstallResult',
        'from engines.core.base import EngineInstallResult, EngineSkillPolicy',
    ).replace(
        '    ENGINE_ID = "example_custom"',
        '    ENGINE_ID = "example_custom"\n'
        '    SKILL_POLICY = EngineSkillPolicy.PROJECT_REGISTRY\n'
        '    SUPPORTS_MANUAL_COMPACTION = False\n'
        '    SUPPORTS_SERVICE_TIER = True\n'
        '    SUPPORTS_HOST_SESSION_IDS = True',
    )
    (custom_environment / "engine.py").write_text(adapter)
    info = (await manager.inspect(str(custom_environment)))["engine"]
    engine = make_custom_engine(custom_environment, info)()
    assert engine.skill_policy is EngineSkillPolicy.PROJECT_REGISTRY
    assert engine.supports_controlled_skills is True
    assert engine.supports_manual_compaction is False
    assert engine.supports_service_tier is True
    assert engine.supports_host_session_ids is True
    assert "compact" not in [item["name"] for item in engine.input_commands()]
    events = [event async for event in engine.spawn_with_retry(
        prompt="/compact", cwd=str(custom_environment), session_id="session",
    )]
    assert events[0].type == "error"
    assert engine._worker is None


def test_every_builtin_owns_permission_declaration():
    from engines.core.registry import list_all_engines
    for engine_id, cls in list_all_engines().items():
        assert "PERMISSION_POLICY" in cls.__dict__, engine_id


@pytest.mark.parametrize("module,name", [
    ("cursor_sdk", "CursorSdkEngine"), ("openclaw", "OpenClawEngine"),
    ("deepseek_harness", "DeepSeekHarnessEngine"),
])
def test_engines_without_approval_bridge_do_not_advertise_modes(module, name):
    from importlib import import_module
    engine = getattr(import_module("engines." + module), name)()
    assert not engine.permission_modes()
    assert not engine.supports_manual_compaction


def test_session_allocation_and_service_tier_are_adapter_capabilities():
    from engines.pydantic_ai import PydanticAIEngine
    from engines.codex import CodexEngine
    from engines.codex_sdk import CodexSDKEngine
    assert PydanticAIEngine().supports_host_session_ids
    assert not CodexEngine().supports_host_session_ids
    assert CodexEngine().supports_service_tier
    assert CodexSDKEngine().supports_service_tier
    assert not PydanticAIEngine().supports_service_tier


@pytest.mark.asyncio
@pytest.mark.parametrize("module,name", [
    ("claude_code", "ClaudeCodeEngine"), ("claude_agent_sdk", "ClaudeAgentSDKEngine"),
    ("qoder_sdk", "QoderSDKEngine"),
])
async def test_native_plan_cannot_be_lifted_by_full_access_consent(module, name):
    from importlib import import_module
    engine = getattr(import_module("engines." + module), name)()
    await engine.set_permission_mode("danger-full-access")
    engine.configure_interaction_policy(engine.plan_config_overrides())
    assert engine.runtime_permission_decision() is False
