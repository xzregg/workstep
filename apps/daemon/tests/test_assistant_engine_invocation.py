"""The engine invocation module owns streaming and assistant interaction results."""

import asyncio
from types import SimpleNamespace

import pytest

from engines.core.events import InternalEvent


@pytest.mark.anyio
async def test_engine_invocation_streams_events_and_tracks_active_engine():
    from agent_assistants.engine_invocation import run_engine_turn

    class Engine:
        capabilities = SimpleNamespace(supports_thinking_effort=False)
        supports_resume = False
        supports_message_history = False

        async def spawn(self, prompt, cwd, model, session_id, **kwargs):
            assert (prompt, cwd, model, session_id) == ("hello", "/tmp", None, None)
            assert running["turn-1"] is self
            yield InternalEvent(type="session_started", data={"session_id": "engine-1"})
            yield InternalEvent(
                type="agent_message_chunk", data={"content": {"text": "reply"}}
            )

    running = {}
    received = []
    text, events, session_id = await run_engine_turn(
        "fake", None, "/tmp", "hello", None,
        on_event=lambda event: _record(received, event),
        run_key="turn-1",
        running_engines=running,
        engine_factory=lambda _engine_id: Engine(),
        settings_store=SimpleNamespace(),
    )
    assert (text, session_id) == ("reply", "engine-1")
    assert [item["type"] for item in events] == [
        "session_started", "agent_message_chunk",
    ]
    assert [event.type for event in received] == [
        "session_started", "agent_message_chunk",
    ]
    assert running == {}


async def _record(received, event):
    await asyncio.sleep(0)
    received.append(event)


@pytest.mark.anyio
@pytest.mark.parametrize("engine_id,global_config", [
    ("codex_sdk", {"approval_mode": "auto_review"}),
    ("claude_agent_sdk", {"permission_mode": "bypassPermissions"}),
    ("qoder_sdk", {"permission_mode": "auto"}),
    ("opencode", {"permission_mode": "allow"}),
    ("hermes", {}), ("pydantic_ai", {}),
])
@pytest.mark.parametrize("assistant_mode", ["auto", "ask"])
async def test_assistant_permission_selection_controls_backend_consent(
    monkeypatch, engine_id, global_config, assistant_mode,
):
    from agent_assistants.engine_invocation import run_engine_turn
    from engines.core.acp_base import AcpEngineBase
    from engines.core.interactions import elicitation_request

    manual_requests = []

    async def respond(*args):
        manual_requests.append(args)
        return {"action": "decline"}

    monkeypatch.setattr(
        "agent_assistants.engine_invocation.intervention_manager.request_response", respond,
    )

    class Engine(AcpEngineBase):
        ENGINE_ID = engine_id
        supports_resume = False
        supports_message_history = False

        @staticmethod
        def is_installed():
            return True

        @staticmethod
        def get_version():
            return "test"

        @staticmethod
        def resolve_binary():
            return "test"

        async def spawn(self, **kwargs):
            config = self.merge_config_overrides(global_config, kwargs.get("config_overrides"))
            self.configure_interaction_policy(config)
            queue = asyncio.Queue()
            event = elicitation_request(
                interaction_id="consent", message="Allow Chrome?",
                requested_schema={"type": "object", "properties": {}},
            )
            pending = asyncio.create_task(self.request_interaction(event, queue.put))
            try:
                await asyncio.sleep(0)
                while not queue.empty():
                    yield queue.get_nowait()
                response = await pending
                yield InternalEvent(type="agent_message_chunk", data={
                    "content": {"text": response["action"]},
                })
            finally:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)

    text, events, _ = await asyncio.wait_for(run_engine_turn(
        engine_id, None, "/tmp", "hello", None,
        engine_factory=lambda _: Engine(), settings_store=SimpleNamespace(),
        permission_mode=assistant_mode,
    ), 2)
    assert text == ("accept" if assistant_mode == "auto" else "decline")
    assert len(manual_requests) == (0 if assistant_mode == "auto" else 1)
    assert any(event["type"] == "interaction_request" for event in events) == (assistant_mode == "ask")
