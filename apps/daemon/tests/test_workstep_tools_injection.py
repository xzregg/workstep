"""WorkStep internal tool injection into engines and the coordinator."""

import uuid
from types import SimpleNamespace

import pytest

from engines.core.acp_base import AcpEngineBase
from engines.core.base import BaseLLMEngine, EngineCapabilities
from engines.core.events import InternalEvent
from models import CoordinatorTurn, Message, Task, init_db
from models.fields import utc_now
from streaming.bus import EventBus


def test_capabilities_default_workstep_tools_false():
    caps = EngineCapabilities(
        supports_coordinator=True,
        supports_resume=False,
        supports_tool_disable=True,
        supports_native_schema=False,
        supports_live_step_message=False,
    )
    assert caps.supports_workstep_tools is False


def test_engines_advertise_workstep_tools_capability():
    from engines.claude_agent_sdk import ClaudeAgentSDKEngine
    from engines.claude_code import ClaudeCodeEngine
    from engines.codex import CodexEngine
    from engines.codex_sdk import CodexSDKEngine
    from engines.pydantic_ai import PydanticAIEngine

    assert PydanticAIEngine().capabilities.supports_workstep_tools is True
    for cls in (
        ClaudeAgentSDKEngine,
        ClaudeCodeEngine,
        CodexEngine,
        CodexSDKEngine,
    ):
        assert cls().capabilities.supports_workstep_tools is False


@pytest.mark.anyio
async def test_codex_sdk_coordinator_accepts_host_history_kwargs(monkeypatch):
    """The common coordinator caller may pass history kwargs to every engine."""
    from engines.codex_sdk import CodexSDKEngine

    captured = {}

    async def fake_spawn_with_sandbox(self, **kwargs):
        captured.update(kwargs)
        yield InternalEvent(type="status", data={"status": "done"})

    monkeypatch.setattr(
        CodexSDKEngine,
        "_spawn_with_sandbox",
        fake_spawn_with_sandbox,
    )

    events = [
        event
        async for event in CodexSDKEngine().spawn_coordinator(
            "问题",
            cwd="/project",
            message_history=[{"role": "user", "content": "旧消息"}],
            report_engine_state=True,
        )
    ]

    assert [event.type for event in events] == ["status"]
    assert captured["session_id"] is None
    assert "message_history" not in captured
    assert "report_engine_state" not in captured

    async for _ in CodexSDKEngine().spawn_coordinator(
        "第二问", cwd="/project", session_id="existing-session", workstep_tools=True,
    ):
        pass
    assert captured["prompt"] == "第二问"


class PromptCapturingEngine(AcpEngineBase):
    calls: list[str] = []
    spawn_kwargs: list[dict] = []

    @staticmethod
    def is_installed():
        return True

    @staticmethod
    def get_version():
        return "test"

    @staticmethod
    def resolve_binary():
        return "test"

    async def spawn(self, prompt, cwd, model=None, add_dirs=None, session_id=None, **kwargs):
        type(self).calls.append(prompt)
        type(self).spawn_kwargs.append(kwargs)
        yield InternalEvent(type="text_delta", data={"delta": "ok"})

    async def stop(self):
        pass

    async def inject_response(self, tool_use_id, content):
        pass

    @property
    def supports_resume(self):
        return False

    @property
    def supports_interactive(self):
        return False

    def build_resume_params(self, session_id):
        return {}


class WorkstepToolsEngine(PromptCapturingEngine):
    @property
    def supports_workstep_tools(self):
        return True


class ResumableWorkstepToolsEngine(WorkstepToolsEngine):
    @property
    def supports_resume(self):
        return True


@pytest.mark.anyio
async def test_resumed_coordinator_does_not_repeat_bootstrap_guard():
    ResumableWorkstepToolsEngine.calls.clear()
    engine = ResumableWorkstepToolsEngine()
    async for _ in engine.spawn_coordinator(
        "第二问", cwd="/project", session_id="existing-session", workstep_tools=True,
    ):
        pass
    assert ResumableWorkstepToolsEngine.calls[-1] == "第二问"


@pytest.mark.anyio
async def test_spawn_coordinator_keeps_readonly_guard_without_tools():
    """No tools loaded: the seam keeps the read-only coordinator guard."""
    PromptCapturingEngine.calls.clear()
    PromptCapturingEngine.spawn_kwargs.clear()
    engine = WorkstepToolsEngine()
    async for _ in engine.spawn_coordinator("问题", cwd="/project"):
        pass
    prompt = PromptCapturingEngine.calls[-1]
    assert "问题" in prompt
    assert "Do not call tools" in prompt
    assert "workstep" not in prompt.lower()


@pytest.mark.anyio
async def test_spawn_coordinator_tools_guard_when_workstep_tools_enabled():
    """WorkStep tools enabled: the seam lets the coordinator call them."""
    PromptCapturingEngine.calls.clear()
    PromptCapturingEngine.spawn_kwargs.clear()
    engine = WorkstepToolsEngine()
    async for _ in engine.spawn_coordinator(
        "问题", cwd="/project", workstep_tools=True
    ):
        pass
    prompt = PromptCapturingEngine.calls[-1]
    assert "问题" in prompt
    assert "workstep_call" in prompt
    assert "Do not call tools" not in prompt
    assert PromptCapturingEngine.spawn_kwargs[-1].get("workstep_tools") is True


@pytest.mark.anyio
async def test_spawn_coordinator_tools_guard_without_native_capability():
    """CLI engines (no native hosting) still get the tools guard, but the
    unknown ``workstep_tools`` kwarg is not forwarded to their spawn."""
    PromptCapturingEngine.calls.clear()
    PromptCapturingEngine.spawn_kwargs.clear()
    engine = PromptCapturingEngine()
    async for _ in engine.spawn_coordinator(
        "问题", cwd="/project", workstep_tools=True
    ):
        pass
    prompt = PromptCapturingEngine.calls[-1]
    assert "问题" in prompt
    assert "Do not call tools" not in prompt
    assert "workstep" in prompt
    assert "workstep_tools" not in PromptCapturingEngine.spawn_kwargs[-1]


@pytest.mark.anyio
async def test_spawn_coordinator_keeps_prompt_unchanged_without_capability():
    """Engines without tool support never get tool text in the prompt."""
    PromptCapturingEngine.calls.clear()
    engine = PromptCapturingEngine()
    async for _ in engine.spawn_coordinator("问题", cwd="/project"):
        pass
    prompt = PromptCapturingEngine.calls[-1]
    assert "workstep" not in prompt.lower()


@pytest.mark.anyio
async def test_pydantic_ai_registers_workstep_call_tool(monkeypatch):
    from pydantic_ai.models.test import TestModel

    from engines.pydantic_ai import PydanticAIEngine

    captured = {}

    class FakeUsage:
        input_tokens = 1
        output_tokens = 1
        total_tokens = 2
        cache_write_tokens = 0
        cache_read_tokens = 0
        requests = 1
        cost = None

        def __add__(self, other):
            return self

    class FakeResult:
        usage = FakeUsage()

        def all_messages(self):
            return []

    async def fake_stream_agent_run(self, agent, *, prompt, on_event, message_history=None, conversation_id=None):
        captured["agent"] = agent
        return FakeResult()

    monkeypatch.setattr(
        PydanticAIEngine, "_stream_agent_run", fake_stream_agent_run
    )
    engine = PydanticAIEngine()
    await engine._run_agent(
        prompt="普通问题",
        cwd="/tmp",
        add_dirs=None,
        model=TestModel(),
        on_event=lambda event: None,
        workstep_tools=True,
    )
    tool = captured["agent"]._function_toolset.tools["workstep_call"]
    description = tool.function_schema.description or ""
    assert "workstep_list_projects" in description
    assert "confirm='yes'" in description


@pytest.mark.anyio
async def test_pydantic_ai_skips_workstep_call_without_flag(monkeypatch):
    from pydantic_ai.models.test import TestModel

    from engines.pydantic_ai import PydanticAIEngine

    captured = {}

    class FakeResult:
        usage = None

        def all_messages(self):
            return []

    async def fake_stream_agent_run(self, agent, *, prompt, on_event, message_history=None, conversation_id=None):
        captured["agent"] = agent
        return FakeResult()

    monkeypatch.setattr(
        PydanticAIEngine, "_stream_agent_run", fake_stream_agent_run
    )
    engine = PydanticAIEngine()
    await engine._run_agent(
        prompt="普通问题",
        cwd="/tmp",
        add_dirs=None,
        model=TestModel(),
        on_event=lambda event: None,
    )
    tools = captured["agent"]._function_toolset.tools
    assert "workstep_call" not in tools


def _context_project(tmp_path):
    return SimpleNamespace(
        id="project-1",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps={
            "nodes": [{"id": 1, "type": "do", "title": "Do", "engine": "claude"}],
            "connections": [],
        },
    )


def _make_turn(tmp_path, engine_id):
    db = init_db(str(tmp_path / f"ctx-{engine_id}.db"))
    task = Task.create(
        id=f"task-{engine_id}",
        title="Ctx",
        cwd=str(tmp_path),
        engine=engine_id,
        created_at=1,
        updated_at=1,
    )
    now = utc_now()
    user_msg = Message.create(
        id=str(uuid.uuid4()),
        task=task, channel="coordinator", step_key="do", sequence=1,
        role="user", content="协调问题", position=0,
        started_at=now, created_at=now,
    )
    assistant_msg = Message.create(
        id=str(uuid.uuid4()),
        task=task, channel="coordinator", step_key="do", sequence=2,
        role="assistant", content="", position=1,
        started_at=now, created_at=now,
    )
    turn = CoordinatorTurn.create(
        id=f"turn-{engine_id}",
        task=task,
        user_message=user_msg,
        assistant_message=assistant_msg,
        idempotency_key=f"k-{engine_id}",
        status="running",
        engine=engine_id,
        created_at=now,
    )
    return db, task, turn


def _capable_engine():
    return SimpleNamespace(
        capabilities=SimpleNamespace(supports_workstep_tools=True),
        supports_message_history=False,
        supports_resume=False,
    )


def _plain_engine():
    return SimpleNamespace(
        capabilities=SimpleNamespace(supports_workstep_tools=False),
        supports_message_history=False,
        supports_resume=False,
    )


def test_assemble_context_injects_cli_instruction_without_capability(
    monkeypatch, tmp_path
):
    """无原生工具能力的引擎（Codex CLI / Claude Code 等）拿到 workstep CLI
    用法，协调器不再被限制为只读。"""
    from agent_assistants import coordinator_context as coordinator_module
    from agent_assistants.coordinator_context import assemble_context

    monkeypatch.setattr(coordinator_module, "create_engine", lambda _id: _plain_engine())
    db, task, turn = _make_turn(tmp_path, "claude")
    try:
        prompt, _ = assemble_context(
            _context_project(tmp_path), task, turn
        )
        assert "WorkStep CLI" in prompt
        assert "workstep project list" in prompt
        assert "workstep task list" in prompt
    finally:
        db.close()


@pytest.mark.anyio
async def test_invoke_engine_forwards_workstep_tools_to_spawner(monkeypatch):
    from agent_assistants import base as base_module
    from agent_assistants.base import invoke_engine

    seen = {}

    async def fake_spawner(engine, *, workstep_tools=False, config_overrides=None):
        seen["workstep_tools"] = workstep_tools
        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": "ok"}},
        )

    monkeypatch.setattr(
        base_module, "create_engine", lambda _id: _capable_engine()
    )
    text, _events, _session_id = await invoke_engine(
        "pydantic_ai",
        None,
        "/tmp",
        "问题",
        None,
        None,
        spawner=fake_spawner,
        workstep_tools=True,
    )
    assert seen["workstep_tools"] is True
    assert text == "ok"


@pytest.mark.anyio
async def test_invoke_engine_forwards_to_spawner_without_native_capability(monkeypatch):
    """助手配置开启工具时，spawner 一律收到 workstep_tools=True；
    是否注入原生工具由引擎能力自行决定，不再是只读降级依据。"""
    from agent_assistants import base as base_module
    from agent_assistants.base import invoke_engine

    seen = {}

    async def fake_spawner(engine, *, workstep_tools=False, config_overrides=None):
        seen["workstep_tools"] = workstep_tools
        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": "ok"}},
        )

    monkeypatch.setattr(
        base_module, "create_engine", lambda _id: _plain_engine()
    )
    text, _events, _session_id = await invoke_engine(
        "claude",
        None,
        "/tmp",
        "问题",
        None,
        None,
        spawner=fake_spawner,
        workstep_tools=True,
    )
    assert seen["workstep_tools"] is True
    assert text == "ok"
