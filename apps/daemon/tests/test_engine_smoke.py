"""Regression tests for the production engine smoke-test helper."""

from scripts.engine_smoke import response_text


def test_engine_smoke_collects_current_agent_message_events():
    events = [
        {
            "type": "agent_message_chunk",
            "data": {"content": {"text": "WORKSTEP_"}},
        },
        {
            "type": "agent_message_chunk",
            "data": {"content": {"text": "SMOKE_OK"}},
        },
    ]

    assert response_text(events) == "WORKSTEP_SMOKE_OK"
