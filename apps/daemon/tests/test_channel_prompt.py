"""Channel rules persist while source metadata follows the current turn."""

from types import SimpleNamespace

import pytest

from agent_assistants.channel_chat import ChannelChatModule, SYSTEM_PROMPT
from engines.core.acp_base import AcpEngineBase
from engines.codex_sdk import CodexSDKEngine
from streaming.bus import EventBus


@pytest.mark.parametrize("resumed", [False, True])
@pytest.mark.parametrize("supports_resume", [False, True])
def test_channel_background_on_normal_and_rebuilt_turns(monkeypatch, resumed, supports_resume):
    module = ChannelChatModule(EventBus(), None, register=False)
    monkeypatch.setattr(module, "get_system_prompt", lambda _: "Project rules")
    monkeypatch.setattr("agent_assistants.channel_chat.build_channel_background", lambda _: "Current sender: Alice")
    monkeypatch.setattr("agent_assistants.chat_session.create_engine", lambda _: SimpleNamespace(supports_resume=supports_resume))
    session = SimpleNamespace(
        project_id="project", engine="codex", resolved_session_id="native" if resumed else None,
        extra={}, messages=[{"role": "user", "content": "Hello"}],
    )
    for prompt in (module._build_prompt(session), module._build_rebuild_prompt(session)):
        assert prompt.count("Current sender: Alice") == 1
        assert "Hello" in prompt
        assert SYSTEM_PROMPT not in prompt
        assert "Project rules" not in prompt
    rules = module._engine_system_prompt(session)
    prepared = AcpEngineBase._prepare_system_prompt(
        SimpleNamespace(SYSTEM_PROMPT_MODE="body", supports_resume=supports_resume),
        {"prompt": module._build_prompt(session), "session_id": session.resolved_session_id},
        rules, each_turn=module._system_prompt_each_turn(),
    )
    assert (SYSTEM_PROMPT in prepared["prompt"]) == (not resumed or not supports_resume)


async def test_channel_codex_resume_keeps_saved_rules_and_new_background(monkeypatch, tmp_path):
    module = ChannelChatModule(EventBus(), None, register=False)
    monkeypatch.setattr(module, "get_system_prompt", lambda _: "Project rules")
    engine = CodexSDKEngine()
    rules = module._engine_system_prompt(SimpleNamespace(project_id="project"))
    monkeypatch.setattr("engines.codex_sdk.config_store.get_codex_sdk_config", lambda: {})
    for sender in ("Alice", "Bob"):
        prepared = await engine._prepare_prompt_input(
            {"prompt": f"Current sender: {sender}\n\nHello", "session_id": "native", "cwd": str(tmp_path)},
            rules, each_turn=module._system_prompt_each_turn(),
        )
        assert prepared["system_prompt"] == ""
        assert sender in prepared["prompt"]


def test_channel_compact_remains_native_command(monkeypatch):
    module = ChannelChatModule(EventBus(), None, register=False)
    assert module._with_channel_background(None, "/compact") == "/compact"
