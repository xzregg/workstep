"""Native permission choices, inheritance and cold metadata discovery."""

import json
import subprocess
import sys

import pytest

from engines.codex import CodexEngine
from engines.core.permissions import encode_permission_selection


def test_native_permission_values_are_engine_bound_and_field_validated():
    value = encode_permission_selection("codex", {
        "sandbox_mode": "workspace-write", "approval_policy": "on-request",
    })
    assert CodexEngine.permission_config_overrides(value) == {
        "sandbox_mode": "workspace-write", "approval_policy": "on-request",
    }
    from engines.claude_code import ClaudeCodeEngine
    with pytest.raises(ValueError, match="引擎"):
        ClaudeCodeEngine.permission_config_overrides(value)
    for invalid in ({"provider_id": "unrelated"}, {"sandbox_mode": "invented"}):
        with pytest.raises(ValueError):
            CodexEngine.permission_config_overrides(encode_permission_selection("codex", invalid))


def test_permission_options_follow_saved_engine_settings(monkeypatch):
    settings = {"sandbox_mode": "read-only", "approval_policy": "on-request"}
    monkeypatch.setattr(CodexEngine, "get_config_values", lambda self: settings)
    options = CodexEngine().permission_config_options()
    assert {item["id"]: item["currentValue"] for item in options} == {"sandbox_mode": settings["sandbox_mode"]}
    assert options[0]["type"] == "select"
    assert all("value" in option and "name" in option
               for field in options for option in field["options"])
    assert CodexEngine.permission_config_overrides("") == {}
    settings["sandbox_mode"] = "workspace-write"
    assert CodexEngine().permission_config_options()[0]["currentValue"] == "workspace-write"


def test_native_default_is_not_inherit():
    from engines.claude_code import ClaudeCodeEngine
    value = encode_permission_selection("claude", {"permission_mode": "manual"})
    assert ClaudeCodeEngine.permission_config_overrides(value) == {"permission_mode": "manual"}
    assert ClaudeCodeEngine.permission_config_overrides("") == {}


def test_legacy_values_retain_the_old_adapter_translation():
    assert CodexEngine.permission_config_overrides("workspace-write") == {"sandbox_mode": "workspace-write"}
    from engines.pydantic_ai import PydanticAIEngine
    assert PydanticAIEngine.permission_config_overrides("read-only") == {"sandbox": "read-only"}
    value = encode_permission_selection("pydantic_ai", {"permission_mode": "read-only"})
    assert PydanticAIEngine.permission_config_overrides(value) == {"permission_mode": "read-only"}


def test_fresh_process_can_discover_every_builtin_permission_schema():
    script = """
import json
from engines.core.registry import list_all_engines
import asyncio
from engines.core.permissions import encode_permission_selection
async def check():
    result = {}
    for key, cls in list_all_engines().items():
        engine = cls()
        result[key] = engine.permission_config_options()
        await engine.set_permission_mode('')
        for field in result[key]:
            for option in field.get('options', []):
                value = encode_permission_selection(key, {field['id']: option['value']})
                await engine.set_permission_mode(value)
        await engine.set_permission_mode('')
    return result
print(json.dumps(asyncio.run(check())))
"""
    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    options = json.loads(result.stdout)
    assert len(options) >= 11
    assert [item["id"] for item in options["codex"]] == ["sandbox_mode"]
    assert [option["value"] for option in options["pydantic_ai"][0]["options"]] == ["full", "auto", "read-only"]


@pytest.mark.anyio
@pytest.mark.parametrize("mode,tool,approved,asks", [
    ("full", "run_command", False, 0),
    ("auto", "run_command", False, 0),
    ("auto", "risk_command", False, 1),
    ("read-only", "run_command", False, 1),
    ("read-only", "run_command", True, 1),
    ("read-only", "write_file", False, 1),
    ("read-only", "write_file", True, 1),
])
async def test_official_pydantic_permissions_gate_execution(tmp_path, mode, tool, approved, asks):
    from pydantic_ai.models.function import DeltaToolCall, FunctionModel
    from engines.pydantic_ai import PydanticAIEngine
    engine = PydanticAIEngine()
    await engine.set_permission_mode(encode_permission_selection("pydantic_ai", {"permission_mode": mode}))
    requests = []
    async def consent(event, on_event):
        assert not (tmp_path / "approved.txt").exists()
        requests.append(event)
        option = next(item for item in event.data["options"]
                      if item["kind"] == ("allow_once" if approved else "reject_once"))
        return {"outcome": {"option_id": option["option_id"]}}
    engine.request_interaction = consent
    calls = 0
    results = []
    async def model(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            args = {"path": "approved.txt", "content": "ok"} if tool == "write_file" else {"command": "git push" if tool == "risk_command" else "date +%Y"}
            yield {0: DeltaToolCall(name="run_command" if tool == "risk_command" else tool, tool_call_id="native", json_args=json.dumps(args))}
        else:
            results.extend(str(part.content) for msg in messages for part in msg.parts if part.part_kind == "tool-return")
            yield "done"
    async def noop(event): pass
    await engine._run_agent(prompt="probe", cwd=str(tmp_path), add_dirs=None,
        model=FunctionModel(stream_function=model), on_event=noop, permission_mode=mode)
    assert len(requests) == asks
    if tool == "write_file":
        assert (tmp_path / "approved.txt").exists() is approved
    elif asks == 0 or approved:
        assert any("202" in result for result in results), results


@pytest.mark.anyio
async def test_inherit_clears_prepared_policy_and_follows_saved_settings(monkeypatch):
    from engines.pydantic_ai import PydanticAIEngine
    settings = {"permission_mode": "read-only", "sandbox": "workspace-write"}
    monkeypatch.setattr(PydanticAIEngine, "get_config_values", lambda self: dict(settings))
    engine = PydanticAIEngine()
    await engine.set_permission_mode(encode_permission_selection("pydantic_ai", {"permission_mode": "full"}))
    assert engine.runtime_permission_decision() is True
    await engine.set_permission_mode("")
    assert engine.native_permission_mode() == "read-only"
    assert engine.runtime_permission_decision() is None
    settings["permission_mode"] = "full"
    await engine.set_permission_mode("")
    assert engine.native_permission_mode() == "full"


@pytest.mark.anyio
async def test_slow_permission_config_does_not_block_event_loop(monkeypatch):
    import asyncio
    import time
    started = asyncio.Event()
    from engines.codex import CodexEngine
    loop = asyncio.get_running_loop()
    def slow(self):
        loop.call_soon_threadsafe(started.set)
        time.sleep(0.2)
        return {"sandbox_mode": "read-only"}
    monkeypatch.setattr(CodexEngine, "get_config_values", slow)
    pending = asyncio.create_task(CodexEngine().set_permission_mode(""))
    await asyncio.wait_for(started.wait(), 1)
    before = loop.time()
    await asyncio.sleep(0.01)
    assert loop.time() - before < 0.1
    assert not pending.done()
    await pending


def test_saved_legacy_pydantic_config_remains_restrictive_in_new_process(tmp_path):
    import os
    config = tmp_path / "config"
    config.mkdir()
    (config / "config.json").write_text(json.dumps({"pydantic_ai_engine": {"sandbox": "read-only"}}))
    script = """
import asyncio
from engines.pydantic_ai import PydanticAIEngine
async def main():
    engine = PydanticAIEngine()
    assert engine.get_config_values()['permission_mode'] == 'read-only'
    await engine.set_permission_mode('')
    assert engine.native_permission_mode() == 'read-only'
    assert engine.runtime_permission_decision() is None
    assert [item['value'] for item in engine.permission_config_options()[0]['options']] == ['full', 'auto', 'read-only']
asyncio.run(main())
"""
    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True,
        timeout=20, env=dict(os.environ, WORKSTEP_CONFIG_DIR=str(config)))
    assert result.returncode == 0, result.stderr


@pytest.mark.anyio
async def test_native_full_cannot_bypass_active_plan(tmp_path):
    from pydantic_ai.models.function import DeltaToolCall, FunctionModel
    from engines.pydantic_ai import PydanticAIEngine
    engine = PydanticAIEngine()
    await engine.set_permission_mode(encode_permission_selection("pydantic_ai", {"permission_mode": "full"}))
    calls = 0
    async def model(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            yield {0: DeltaToolCall(name="write_file", tool_call_id="planned",
                json_args=json.dumps({"path": "blocked.txt", "content": "no"}))}
        else:
            yield "done"
    async def noop(event): pass
    await engine._run_agent(prompt="plan", cwd=str(tmp_path), add_dirs=None,
        model=FunctionModel(stream_function=model), on_event=noop, permission_mode="full", plan_mode=True)
    assert not (tmp_path / "blocked.txt").exists()


def test_new_steps_do_not_copy_legacy_pydantic_sandbox():
    from engines.pydantic_ai import PydanticAIEngine
    assert "sandbox" not in {field.key for field in PydanticAIEngine.step_config_schema()}


@pytest.mark.anyio
async def test_explicit_native_override_supersedes_old_step_sandbox(tmp_path, monkeypatch):
    from pydantic_ai.models.function import DeltaToolCall, FunctionModel
    from engines.pydantic_ai import PydanticAIEngine
    from engines.core.base import ProviderRuntimeConfig
    from services.config import config_store
    monkeypatch.setattr(config_store, "get_pydantic_ai_engine_config", lambda: {
        "provider_id": "test", "model": "test", "sandbox": "workspace-write", "permission_mode": "legacy"})
    monkeypatch.setattr(config_store, "get_provider", lambda _: {"base_url": "https://example.invalid"})
    monkeypatch.setattr(PydanticAIEngine, "resolve_provider_runtime", lambda self, **kw: ProviderRuntimeConfig(provider_id="test", model="test"))
    calls = 0
    async def model(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            yield {0: DeltaToolCall(name="write_file", tool_call_id="override",
                json_args=json.dumps({"path": "native.txt", "content": "ok"}))}
        else:
            yield "done"
    monkeypatch.setattr(PydanticAIEngine, "build_model", staticmethod(lambda **kw: FunctionModel(stream_function=model)))
    events = [event async for event in PydanticAIEngine().spawn("probe", cwd=str(tmp_path),
        config_overrides={"sandbox": "read-only", "permission_mode": "full"})]
    assert not [event for event in events if event.type == "error"]
    assert (tmp_path / "native.txt").read_text() == "ok"


@pytest.mark.anyio
async def test_saved_compatibility_choice_resolves_to_native_permission(monkeypatch):
    from engines.pydantic_ai import PydanticAIEngine
    from services.config import config_store
    monkeypatch.setattr(config_store, "get_pydantic_ai_engine_config", lambda: {
        "provider_id": "", "permission_mode": "legacy", "sandbox": "read-only"})
    engine = PydanticAIEngine()
    await engine.set_permission_mode(encode_permission_selection("pydantic_ai", {"permission_mode": "legacy"}))
    assert engine.native_permission_mode() == "read-only"
    assert engine.runtime_permission_decision() is None


def test_primary_engines_have_binary_defaults_before_catalog_initialization():
    script = """
from engines.codex import CodexEngine
from engines.codex_sdk import CodexSDKEngine
from engines.claude_code import ClaudeCodeEngine
from engines.claude_agent_sdk import ClaudeAgentSDKEngine
from engines.pydantic_ai import PydanticAIEngine
for cls in (CodexEngine, CodexSDKEngine, ClaudeCodeEngine, ClaudeAgentSDKEngine, PydanticAIEngine):
    assert cls.get_binary_override() is None
"""
    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr


def test_pydantic_only_advertises_three_native_modes_and_no_legacy_field():
    from engines.pydantic_ai import PydanticAIEngine
    fields = {field.key: field for field in PydanticAIEngine.config_schema()}
    assert "sandbox" not in fields
    assert [option.value for option in fields["permission_mode"].options] == ["full", "auto", "read-only"]


@pytest.mark.parametrize("sandbox,expected", [("read-only", "read-only"), ("workspace-write", "auto"), ("danger-full-access", "full")])
def test_old_global_permission_resolves_to_native_mode(sandbox, expected):
    from engines._config.pydantic_ai import get_pydantic_ai_engine_config
    from types import SimpleNamespace
    store = SimpleNamespace(get=lambda key, default=None: {"sandbox": sandbox, "permission_mode": "legacy"} if key == "pydantic_ai_engine" else default,
        get_engine_default_model=lambda _: "", get_coordinator_default_fast_model=lambda: "")
    assert get_pydantic_ai_engine_config(store)["permission_mode"] == expected


@pytest.mark.parametrize("engine_id,field", [("codex", "sandbox_mode"), ("codex_sdk", "sandbox")])
def test_codex_chat_advertises_one_radio_group_but_keeps_saved_approval_compatible(engine_id, field):
    from engines.core.registry import list_all_engines
    cls = list_all_engines()[engine_id]
    fields = cls().permission_config_options()
    assert [item["id"] for item in fields] == [field]
    assert [item["value"] for item in fields[0]["options"]] == ["read-only", "workspace-write", "danger-full-access"]
    approval = {"approval_policy": "on-request"} if engine_id == "codex" else {"approval_mode": "auto_review"}
    assert cls.permission_config_overrides(encode_permission_selection(engine_id, approval)) == approval
