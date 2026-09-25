from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from acp import schema

from engines.hermes import HermesEngine
from engines.core.acp_base import AcpEngineBase
from engines.core.events import InternalEvent


@pytest.mark.anyio
async def test_hermes_inspection_discovers_and_caches_acp_commands(monkeypatch, tmp_path):
    calls = 0
    closed: list[str] = []

    class Client:
        async def initialize(self, **kwargs):
            return None

        async def new_session(self, **kwargs):
            await handler.session_update(
                "session-1",
                schema.AvailableCommandsUpdate(
                    sessionUpdate="available_commands_update",
                    availableCommands=[
                        schema.AvailableCommand(
                            name="plan",
                            description="Agent-native plan command",
                        ),
                        schema.AvailableCommand(
                            name="test",
                            description="Run project tests",
                            input={"hint": "optional path"},
                        ),
                        schema.AvailableCommand(
                            name="compact",
                            description="Agent-native context compaction",
                        ),
                    ],
                ),
            )
            return SimpleNamespace(session_id="session-1")

        async def close_session(self, session_id):
            closed.append(session_id)

    handler = None

    @asynccontextmanager
    async def fake_spawn(current_handler, *args, **kwargs):
        nonlocal calls, handler
        calls += 1
        handler = current_handler
        yield Client(), SimpleNamespace()

    monkeypatch.setattr("engines.core.acp_base.acp.spawn_agent_process", fake_spawn)

    first = await HermesEngine().inspect_capabilities(str(tmp_path))
    second = await HermesEngine().inspect_capabilities(str(tmp_path))

    plan = next(item for item in first["input_items"] if item["name"] == "plan")
    assert plan["action"] == "toggle_plan"
    assert first["input_items"][-1] == {
        "kind": "command",
        "name": "compact",
        "description": "Agent-native context compaction",
        "insert_text": "/compact ",
        "action": "prompt",
    }
    assert next(item for item in first["input_items"] if item["name"] == "test")["input_hint"] == "optional path"
    assert second["input_items"] == first["input_items"]
    assert calls == 1
    assert closed == ["session-1"]


@pytest.mark.anyio
async def test_hermes_inspection_timeout_returns_shared_skills(monkeypatch, tmp_path):
    skill_dir = tmp_path / ".workstep/skills/shared"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: shared\ndescription: Shared workflow skill\n---\n",
        encoding="utf-8",
    )

    class Client:
        async def initialize(self, **kwargs):
            return None

        async def new_session(self, **kwargs):
            return SimpleNamespace(session_id="session-timeout")

        async def close_session(self, session_id):
            return None

    @asynccontextmanager
    async def fake_spawn(*args, **kwargs):
        yield Client(), SimpleNamespace()

    monkeypatch.setattr("engines.core.acp_base.acp.spawn_agent_process", fake_spawn)
    monkeypatch.setattr(HermesEngine, "ACP_COMMAND_DISCOVERY_TIMEOUT", 0.01)

    result = await HermesEngine().inspect_capabilities(str(tmp_path))

    assert [item["name"] for item in result["input_items"]] == [
        "goal",
        "plan",
        "reasoning",
        "status",
        "shared",
        "workstep-cli",
    ]
    assert next(item for item in result["input_items"] if item["name"] == "shared") == {
        "kind": "skill",
        "name": "shared",
        "description": "Shared workflow skill",
        "insert_text": "/shared ",
        "action": "prompt",
    }


@pytest.mark.anyio
async def test_hermes_rejects_compact_when_agent_does_not_advertise_it(monkeypatch, tmp_path):
    async def no_native_commands(self, cwd):
        return []

    async def unexpected_spawn(*args, **kwargs):
        raise AssertionError("ACP process must not receive an unsupported command")
        yield

    monkeypatch.setattr(HermesEngine, "_inspect_acp_commands", no_native_commands)
    monkeypatch.setattr("engines.core.acp_base.acp.spawn_agent_process", unexpected_spawn)

    events = [event async for event in HermesEngine().spawn(
        prompt="/compact", cwd=str(tmp_path), session_id="existing-session",
    )]

    assert len(events) == 1
    assert events[0].type == "error"
    assert "未声明" in events[0].data["message"]


@pytest.mark.anyio
async def test_advertised_compact_is_sent_as_one_acp_prompt(monkeypatch, tmp_path):
    prompts = []

    class Engine(AcpEngineBase):
        COMMAND = ["fake-acp"]
        ENGINE_ID = "test-acp-compact"

        @staticmethod
        def is_installed():
            return True

        @staticmethod
        def get_version():
            return "test"

        @staticmethod
        def resolve_binary():
            return "fake-acp"

        async def _inspect_acp_commands(self, cwd):
            return [{"name": "compact", "action": "prompt"}]

    class Client:
        async def initialize(self, **kwargs):
            return None

        async def load_session(self, **kwargs):
            return None

        async def prompt(self, *, prompt, **kwargs):
            prompts.append(prompt)
            return SimpleNamespace(usage=None)

    @asynccontextmanager
    async def fake_spawn(*args, **kwargs):
        yield Client(), SimpleNamespace()

    monkeypatch.setattr("engines.core.acp_base.acp.spawn_agent_process", fake_spawn)

    events = [event async for event in Engine().spawn_with_retry(
        prompt="/compact", cwd=str(tmp_path), session_id="existing-session",
    )]

    assert len(prompts) == 1
    assert len(prompts[0]) == 1
    assert prompts[0][0].text == "/compact"
    assert not any(event.type == "error" for event in events)
    assert [event.type for event in events if event.type == "compacted"] == ["compacted"]


@pytest.mark.anyio
async def test_native_acp_compact_requires_unified_completion_event():
    class Engine(AcpEngineBase):
        ENGINE_ID = "test-acp-missing-compact-event"

        @staticmethod
        def is_installed():
            return True

        @staticmethod
        def get_version():
            return "test"

        @staticmethod
        def resolve_binary():
            return "fake-acp"

        async def spawn(self, **kwargs):
            yield InternalEvent(type="status", data={"status": "done"})

    events = [event async for event in Engine().spawn_with_retry(
        prompt="/compact", cwd="/tmp", session_id="existing-session",
    )]

    assert events[-1].type == "error"
    assert "压缩完成事件" in events[-1].data["message"]
