"""The reusable channel chat response adapter keeps replies isolated."""

import asyncio
from types import SimpleNamespace

from agent_assistants.base import AssistantConfig, SCOPE_CHAT, assistant_registry
from agent_assistants.channel_chat import ChannelChatModule
from services.channels.responder import ChatSessionResponder
from services.project import ProjectManager
from streaming.bus import EventBus


def test_selected_assistant_uses_its_own_runtime_prompt():
    bus = EventBus()
    manager = ProjectManager()
    base_module = ChannelChatModule(bus, manager)
    assistant_registry.register(AssistantConfig(
        name="channel-specialist",
        channel="specialist",
        scope=SCOPE_CHAT,
        system_prompt="SPECIALIST PROMPT",
    ))
    responder = ChatSessionResponder(bus, manager, base_module)
    selected = responder._module_for("channel-specialist")
    assert selected is not base_module
    assert selected._config.name == "channel-specialist"
    assert selected._config.system_prompt == "SPECIALIST PROMPT"


async def test_responder_ignores_other_message_completion(tmp_path):
    bus = EventBus()
    manager = ProjectManager()

    class FakeModule:
        def create_session(self, *args, **kwargs):
            return {"id": "session-1"}

        def submit_message(self, *args, **kwargs):
            return SimpleNamespace(
                session_id="session-1",
                turn_id="turn-1",
                assistant_message_id="answer-1",
                status="queued",
            )

        def start_queued_turn(self, turn_id):
            async def publish():
                common = {"project_id": project.id, "session_id": "session-1"}
                await bus.publish({**common, "type": "TEXT_MESSAGE_CHUNK", "messageId": "other", "delta": "wrong"})
                await bus.publish({**common, "type": "RUN_FINISHED", "messageId": "other"})
                await bus.publish({**common, "type": "TEXT_MESSAGE_CHUNK", "messageId": "answer-1", "delta": "right"})
                await bus.publish({**common, "type": "RUN_FINISHED", "messageId": "answer-1"})
            asyncio.create_task(publish())

    project = manager.init_project(tmp_path / "reply-filter-project")
    responder = ChatSessionResponder(bus, manager, FakeModule())
    session_id, reply = await responder(
        project.id, "session-1", "hello", "channel_chat", ""
    )
    assert session_id == "session-1"
    assert reply == "right"
    manager.close_all()
