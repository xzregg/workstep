from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from acp import schema

from engines.hermes import HermesEngine


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
        "name": "test",
        "description": "Run project tests",
        "input_hint": "optional path",
        "insert_text": "/test ",
        "action": "prompt",
    }
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
        "compact",
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
