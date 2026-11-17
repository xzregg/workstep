"""Tool safety and harness filesystem integration."""

from typing import Any

import pytest


async def _noop(event):
    return None


@pytest.mark.anyio
async def test_pydantic_ai_reads_files_through_harness(tmp_path):
    from pydantic_ai.models.test import TestModel

    from engines.pydantic_ai import PydanticAIEngine

    (tmp_path / "a").write_text("harness filesystem", encoding="utf-8")
    engine = PydanticAIEngine()
    result, _ = await engine._run_agent(
        prompt="读一下那个文件",
        cwd=str(tmp_path),
        add_dirs=None,
        model=TestModel(call_tools=["read_file"]),
        on_event=_noop,
    )
    assert "harness filesystem" in str(result.output)


@pytest.mark.anyio
async def test_pydantic_ai_lists_files_through_harness(tmp_path):
    from pydantic_ai.models.test import TestModel

    from engines.pydantic_ai import PydanticAIEngine

    (tmp_path / "visible.txt").write_text("ok", encoding="utf-8")
    engine = PydanticAIEngine()
    result, _ = await engine._run_agent(
        prompt="列出目录",
        cwd=str(tmp_path),
        add_dirs=None,
        model=TestModel(call_tools=["list_directory"]),
        on_event=_noop,
    )
    assert "visible.txt" in str(result.output)


def test_tool_error_value_matches_return_type():
    from engines.pydantic_ai import PydanticAIEngine

    exc = ValueError("文件不存在: x")
    text = PydanticAIEngine._tool_error_value(str, exc)
    assert isinstance(text, str)
    assert "文件不存在" in text

    items = PydanticAIEngine._tool_error_value(list[str], exc)
    assert isinstance(items, list)
    assert "文件不存在" in items[0]

    payload = PydanticAIEngine._tool_error_value(dict[str, Any], exc)
    assert payload == {"ok": False, "error": text}


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["danger-full-access", "workspace-write", "read-only"])
async def test_pydantic_command_policy_follows_session_permission(tmp_path, mode):
    import json
    from pydantic_ai.models.function import DeltaToolCall, FunctionModel
    from engines.pydantic_ai import PydanticAIEngine

    calls = 0
    async def model(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            yield {0: DeltaToolCall(
                name="run_command", tool_call_id="permission-probe",
                json_args=json.dumps({"command": "sh -c 'printf full-access-works'"}),
            )}
        else:
            yield "done"

    events = []
    async def record(event):
        events.append(event)

    await PydanticAIEngine()._run_agent(
        prompt="run the harmless permission probe", cwd=str(tmp_path), add_dirs=None,
        model=FunctionModel(stream_function=model), on_event=record,
        **PydanticAIEngine.permission_config_overrides(mode),
    )
    outputs = [event.data.get("raw_output", "") for event in events if event.type == "tool_call_update"]
    assert len(outputs) == 1
    if mode == "danger-full-access":
        assert "full-access-works" in outputs[0]
        assert "Command rejected" not in outputs[0]
    elif mode == "read-only":
        assert "Permission denied" in outputs[0]
    else:
        assert "Command rejected" in outputs[0]
        assert "not in the allowed list" in outputs[0]


@pytest.mark.anyio
@pytest.mark.parametrize("tool,args", [
    ("write_file", {"path": "blocked.txt", "content": "must not write"}),
    ("run_command", {"command": "python -c \"open('blocked.txt','w').write('bad')\""}),
])
async def test_pydantic_readonly_blocks_mutating_native_tools(tmp_path, tool, args):
    import json
    from pydantic_ai.models.function import DeltaToolCall, FunctionModel
    from engines.pydantic_ai import PydanticAIEngine

    calls = 0
    async def model(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            yield {0: DeltaToolCall(name=tool, tool_call_id="blocked", json_args=json.dumps(args))}
        else:
            yield "done"

    result, _ = await PydanticAIEngine()._run_agent(
        prompt="probe", cwd=str(tmp_path), add_dirs=None,
        model=FunctionModel(stream_function=model), on_event=_noop, sandbox="read-only",
    )
    assert not (tmp_path / "blocked.txt").exists()
    assert "Permission denied" in str(result.all_messages())


@pytest.mark.anyio
@pytest.mark.parametrize("approved", [False, True])
@pytest.mark.parametrize("tool", ["write_file", "run_command"])
async def test_pydantic_ask_waits_before_native_mutation(tmp_path, approved, tool):
    import json
    from pydantic_ai.models.function import DeltaToolCall, FunctionModel
    from engines.pydantic_ai import PydanticAIEngine

    engine = PydanticAIEngine()
    await engine.set_permission_mode("ask")
    requests = []
    async def consent(event, on_event):
        assert not (tmp_path / "approved.txt").exists()
        requests.append(event)
        option = next(item for item in event.data["options"]
                      if item["kind"] == ("allow_once" if approved else "reject_once"))
        return {"outcome": {"option_id": option["option_id"]}}
    engine.request_interaction = consent
    calls = 0
    async def model(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            args = ({"path": "approved.txt", "content": "ok"} if tool == "write_file" else
                    {"command": "python -c \"open('approved.txt','w').write('ok')\""})
            yield {0: DeltaToolCall(name=tool, tool_call_id="ask", json_args=json.dumps(args))}
        else:
            yield "done"
    await engine._run_agent(prompt="probe", cwd=str(tmp_path), add_dirs=None,
        model=FunctionModel(stream_function=model), on_event=_noop)
    assert len(requests) == 1
    assert (tmp_path / "approved.txt").exists() is approved


@pytest.mark.anyio
@pytest.mark.parametrize("plan_mode", [False, True])
async def test_pydantic_live_full_access_preserves_plan_ceiling(tmp_path, plan_mode):
    import json
    from pydantic_ai.models.function import DeltaToolCall, FunctionModel
    from engines.pydantic_ai import PydanticAIEngine

    engine = PydanticAIEngine()
    await engine.set_permission_mode("read-only")
    calls = 0
    async def model(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            yield {0: DeltaToolCall(name="write_file", tool_call_id="first",
                json_args=json.dumps({"path": "first.txt", "content": "blocked"}))}
        elif calls == 2:
            await engine.set_permission_mode("danger-full-access")
            yield {0: DeltaToolCall(name="run_command", tool_call_id="second",
                json_args=json.dumps({"command": "sh -c 'printf allowed > second.txt'"}))}
        else:
            yield "done"
    await engine._run_agent(prompt="probe", cwd=str(tmp_path), add_dirs=None,
        model=FunctionModel(stream_function=model), on_event=_noop,
        sandbox="read-only", plan_mode=plan_mode)
    assert not (tmp_path / "first.txt").exists()
    assert (tmp_path / "second.txt").exists() is (not plan_mode)


@pytest.mark.anyio
async def test_pydantic_connector_consent_respects_plan_even_with_full_access():
    from engines.pydantic_ai import PydanticAIEngine
    engine = PydanticAIEngine()
    await engine.set_permission_mode("danger-full-access")
    engine._active_plan_mode = True
    assert await engine._request_permission(_noop, tool_name="connector:example:write",
        title="write", kind="other", tool_input={}) is False


@pytest.mark.anyio
async def test_pydantic_readonly_allows_actual_file_reads(tmp_path):
    from pydantic_ai.models.test import TestModel
    from engines.pydantic_ai import PydanticAIEngine
    (tmp_path / "a").write_text("readonly content")
    result, _ = await PydanticAIEngine()._run_agent(prompt="read", cwd=str(tmp_path),
        add_dirs=None, sandbox="read-only", model=TestModel(call_tools=["read_file"]), on_event=_noop)
    assert "readonly content" in str(result.output)


@pytest.mark.anyio
async def test_pydantic_readonly_blocks_external_project_data(tmp_path, monkeypatch):
    import json
    from pydantic_ai.models.function import DeltaToolCall, FunctionModel
    import engines.pydantic_ai.engine as module
    from engines.pydantic_ai import PydanticAIEngine
    code = tmp_path / "code"
    code.mkdir()
    external = tmp_path / "external"
    external.mkdir()
    monkeypatch.setattr(module, "data_directory", lambda root: external)
    calls = 0
    async def model(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            assert any(tool.name == "project_data_write_file" for tool in info.function_tools)
            yield {0: DeltaToolCall(name="project_data_write_file", tool_call_id="external",
                json_args=json.dumps({"path": "blocked.txt", "content": "blocked"}))}
        else:
            yield "done"
    result, _ = await PydanticAIEngine()._run_agent(prompt="probe", cwd=str(code),
        add_dirs=None, sandbox="read-only", model=FunctionModel(stream_function=model), on_event=_noop)
    assert not (external / "blocked.txt").exists()
    assert "Permission denied" in str(result.all_messages())


@pytest.mark.anyio
async def test_pydantic_child_receives_same_permission_guard(tmp_path):
    from pydantic_ai import Agent
    from pydantic_ai.models.test import TestModel
    from pydantic_ai_harness.sub_agents import SubAgents
    from engines.pydantic_ai import PydanticAIEngine
    from engines.pydantic_ai.coder import WorkStepCoder
    from engines.pydantic_ai.permissions import ToolPermissions
    engine = PydanticAIEngine()
    await engine.set_permission_mode("read-only")
    guard = ToolPermissions(engine, _noop)
    coder = WorkStepCoder(tmp_path, permission_capability=guard)
    shared = next(item for item in coder.capabilities if isinstance(item, SubAgents)).shared_capabilities
    child = Agent(TestModel(call_tools=["write_file"]), capabilities=shared)
    @child.tool_plain
    async def write_file() -> str:
        raise AssertionError("child must not bypass parent permission")
    result = await child.run("probe")
    assert "Permission denied" in str(result.output)


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["workspace-write", "auto"])
async def test_pydantic_workspace_can_query_date(tmp_path, mode):
    import json
    import re
    from pydantic_ai.models.function import DeltaToolCall, FunctionModel
    from engines.pydantic_ai import PydanticAIEngine

    engine = PydanticAIEngine()
    await engine.set_permission_mode(mode)
    calls = 0
    async def model(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            yield {0: DeltaToolCall(name="run_command", tool_call_id="date-query",
                json_args=json.dumps({"command": "date -u +%Y-%m-%d"}))}
        else:
            yield "done"
    events = []
    async def collect(event):
        events.append(event)
    await engine._run_agent(prompt="query today's date", cwd=str(tmp_path), add_dirs=None,
        model=FunctionModel(stream_function=model), on_event=collect,
        **engine.permission_config_overrides(mode))
    outputs = [e.data.get("raw_output", "") for e in events if e.type == "tool_call_update"]
    assert len(outputs) == 1
    assert re.search(r"\b\d{4}-\d{2}-\d{2}\b", outputs[0]), outputs[0]
    assert "Command rejected" not in outputs[0]
