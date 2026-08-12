"""WorkStep internal tool injection into engines and the coordinator."""

import uuid
from types import SimpleNamespace

import pytest

from engines.core.base import BaseLLMEngine, EngineCapabilities
from engines.core.events import InternalEvent
from models import CoordinatorTurn, Message, Task, init_db
from models.fields import utc_now
from services.tool_registry import workstep_tools_instruction
from streaming.bus import EventBus


def test_capabilities_default_workstep_tools_false():
    caps = EngineCapabilities(
        supports_coordinator=True,
        supports_resume=False,
        supports_tool_disable=True,
        supports_native_schema=False,
        supports_live_stage_message=False,
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


class PromptCapturingEngine(BaseLLMEngine):
    calls: list[str] = []

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


@pytest.mark.anyio
async def test_spawn_coordinator_injects_workstep_docs_when_capable():
    PromptCapturingEngine.calls.clear()
    engine = WorkstepToolsEngine()
    async for _ in engine.spawn_coordinator("问题", cwd="/project"):
        pass
    prompt = PromptCapturingEngine.calls[-1]
    assert "问题" in prompt
    assert "workstep_list_projects" in prompt
    assert "confirm='yes'" in prompt


@pytest.mark.anyio
async def test_spawn_coordinator_keeps_prompt_unchanged_without_capability():
    PromptCapturingEngine.calls.clear()
    engine = PromptCapturingEngine()
    async for _ in engine.spawn_coordinator("问题", cwd="/project"):
        pass
    prompt = PromptCapturingEngine.calls[-1]
    assert "workstep" not in prompt.lower()


@pytest.mark.anyio
async def test_spawn_coordinator_does_not_duplicate_existing_docs():
    PromptCapturingEngine.calls.clear()
    engine = WorkstepToolsEngine()
    docs = workstep_tools_instruction()
    async for _ in engine.spawn_coordinator(f"{docs}\n\n问题", cwd="/project"):
        pass
    prompt = PromptCapturingEngine.calls[-1]
    assert prompt.count("WorkStep internal tools") == 1


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

    async def fake_stream_agent_run(self, agent, *, prompt, on_event, message_history=None):
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
    tool = captured["agent"]._function_toolset.tools["workstep_call"]
    description = tool.function_schema.description or ""
    assert "workstep_list_projects" in description
    assert "confirm='yes'" in description


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
        supports_resume=False,
    )


def _plain_engine():
    return SimpleNamespace(
        capabilities=SimpleNamespace(supports_workstep_tools=False),
        supports_resume=False,
    )


def test_assemble_context_injects_workstep_docs_when_engine_capable(
    monkeypatch, tmp_path
):
    from services import coordinator as coordinator_module
    from services.coordinator import CoordinatorModule

    monkeypatch.setattr(coordinator_module, "create_engine", lambda _id: _capable_engine())
    coordinator = CoordinatorModule(EventBus(), None, None)
    db, task, turn = _make_turn(tmp_path, "pydantic_ai")
    try:
        prompt, _ = coordinator._assemble_context(
            _context_project(tmp_path), task, turn
        )
        assert "workstep_list_projects" in prompt
        assert "confirm='yes'" in prompt
    finally:
        db.close()


def test_assemble_context_omits_workstep_docs_without_capability(
    monkeypatch, tmp_path
):
    from services import coordinator as coordinator_module
    from services.coordinator import CoordinatorModule

    monkeypatch.setattr(coordinator_module, "create_engine", lambda _id: _plain_engine())
    coordinator = CoordinatorModule(EventBus(), None, None)
    db, task, turn = _make_turn(tmp_path, "claude")
    try:
        prompt, _ = coordinator._assemble_context(
            _context_project(tmp_path), task, turn
        )
        assert "workstep_list_projects" not in prompt
    finally:
        db.close()
