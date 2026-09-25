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
