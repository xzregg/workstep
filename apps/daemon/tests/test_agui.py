"""Tests for the AG-UI translation layer (engines/core/agui.py)."""

import pytest

from engines.core.agui import AGUIContext, to_agui_events
from engines.core.events import (
    InternalEvent,
    agent_message_chunk,
    agent_thought_chunk,
    a2ui_event,
    map_legacy_event,
    tool_call_event,
    tool_call_update_event,
    usage_update_event,
)


def _ctx(**overrides):
    defaults = dict(
        task_id="task-1",
        step_key="step-a",
        message_id="msg-1",
        channel="execution",
        engine="codex",
        model="gpt-5",
        event_sequence=3,
        timestamp=1234,
    )
    defaults.update(overrides)
    return AGUIContext(**defaults)


def test_agent_message_chunk_maps_to_text_message_chunk():
    events = to_agui_events(agent_message_chunk("hello"), _ctx())
    assert len(events) == 1
    event = events[0]
    assert event["type"] == "TEXT_MESSAGE_CHUNK"
    assert event["role"] == "assistant"
    assert event["delta"] == "hello"
    assert event["messageId"] == "msg-1"
    assert event["task_id"] == "task-1"
    assert event["step_key"] == "step-a"
    assert event["channel"] == "execution"
    assert event["engine"] == "codex"
    assert event["model"] == "gpt-5"
    assert event["sequence"] == 3
    assert event["timestamp"] == 1234


def test_user_message_chunk_and_thought_chunk():
    user = to_agui_events(InternalEvent(type="user_message_chunk", data={"content": {"text": "hi"}}), _ctx())[0]
    assert user["type"] == "TEXT_MESSAGE_CHUNK"
    assert user["role"] == "user"
    assert user["delta"] == "hi"

    thought = to_agui_events(agent_thought_chunk("think"), _ctx())[0]
    assert thought["type"] == "REASONING_MESSAGE_CHUNK"
    assert thought["delta"] == "think"


def test_live_message_maps_to_user_chunk():
    event = to_agui_events(
        InternalEvent(type="live_message", data={"message_id": "live-1", "status": "delivered"}),
        _ctx(),
    )[0]
    assert event["type"] == "TEXT_MESSAGE_CHUNK"
    assert event["role"] == "user"
    assert event["status"] == "delivered"


def test_tool_call_maps_to_start_plus_args():
    events = to_agui_events(
        tool_call_event("t1", "read", kind="read", raw_input={"path": "a.py"}),
        _ctx(),
    )
    assert [e["type"] for e in events] == ["TOOL_CALL_START", "TOOL_CALL_ARGS"]
    start, args = events
    assert start["toolCallId"] == "t1"
    assert start["name"] == "read"
    assert start["kind"] == "read"
    assert start["status"] == "pending"
    assert args["args"] == {"path": "a.py"}


def test_tool_call_update_progress_and_result():
    progress = to_agui_events(
        tool_call_update_event("t1", "in_progress", raw_input="echo "),
        _ctx(),
    )[0]
    assert progress["type"] == "TOOL_CALL_CHUNK"
    assert progress["status"] == "in_progress"

    result = to_agui_events(
        tool_call_update_event("t1", "completed", raw_output="done"),
        _ctx(),
    )[0]
    assert result["type"] == "TOOL_CALL_RESULT"
    assert result["output"] == "done"
    assert result["isError"] is False

    failed = to_agui_events(
        tool_call_update_event("t1", "failed", raw_output="boom"),
        _ctx(),
    )[0]
    assert failed["type"] == "TOOL_CALL_RESULT"
    assert failed["isError"] is True


def test_status_maps_to_run_events():
    started = to_agui_events(InternalEvent(type="status", data={"status": "running"}), _ctx())[0]
    assert started["type"] == "RUN_STARTED"
    assert started["threadId"] == "task-1"
    assert started["runId"] == "task-1::step-a"

    done = to_agui_events(InternalEvent(type="status", data={"status": "done"}), _ctx())[0]
    assert done["type"] == "RUN_FINISHED"

    failed = to_agui_events(InternalEvent(type="status", data={"status": "failed"}), _ctx())[0]
    assert failed["type"] == "RUN_ERROR"
    assert failed["status"] == "failed"


def test_status_step_level_maps_to_custom():
    event = to_agui_events(
        InternalEvent(type="status", data={"status": "awaiting_review", "step_key": "step-a"}),
        _ctx(),
    )[0]
    assert event["type"] == "CUSTOM"
    assert event["name"] == "workstep.status"
    assert event["value"]["status"] == "awaiting_review"


def test_message_lifecycle_maps_to_text_message_events():
    started = to_agui_events(
        InternalEvent(
            type="message_started",
            data={"prompt": "p", "artifact_round": 2},
        ),
        _ctx(),
    )[0]
    assert started["type"] == "TEXT_MESSAGE_START"
    assert started["role"] == "assistant"
    assert started["prompt"] == "p"
    assert started["artifact_round"] == 2

    snapshot = to_agui_events(
        InternalEvent(type="message_snapshot", data={"content": "full"}),
        _ctx(),
    )[0]
    assert snapshot["type"] == "TEXT_MESSAGE_CONTENT"
    assert snapshot["content"] == "full"

    completed = to_agui_events(
        InternalEvent(type="message_completed", data={"status": "succeeded"}),
        _ctx(),
    )[0]
    assert completed["type"] == "TEXT_MESSAGE_END"
    assert completed["status"] == "succeeded"


def test_plan_interaction_usage_map_to_custom():
    plan = to_agui_events(
        InternalEvent(type="plan", data={"entries": [{"content": "x", "priority": "high", "status": "pending"}]}),
        _ctx(),
    )[0]
    assert plan["type"] == "CUSTOM"
    assert plan["name"] == "workstep.plan"
    assert plan["value"]["entries"][0]["content"] == "x"

    interaction = to_agui_events(
        InternalEvent(type="interaction_request", data={"interaction_id": "i1", "method": "elicitation/create"}),
        _ctx(),
    )[0]
    assert interaction["name"] == "workstep.interaction_request"

    usage = to_agui_events(usage_update_event({"input_tokens": 10, "output_tokens": 5}), _ctx())[0]
    assert usage["name"] == "workstep.usage"
    assert usage["value"]["total_tokens"] == 15


def test_subagent_engine_state_compacted_error_custom():
    for event_type, expected in (
        ("subagent", "workstep.subagent"),
        ("engine_state", "workstep.engine_state"),
        ("compacted", "workstep.compacted"),
        ("error", "workstep.error"),
        ("session_started", "workstep.session_started"),
    ):
        event = to_agui_events(InternalEvent(type=event_type, data={"k": "v"}), _ctx())[0]
        assert event["type"] == "CUSTOM"
        assert event["name"] == expected


def test_compacted_custom_preserves_context_and_summary():
    event = to_agui_events(
        InternalEvent(
            type="compacted",
            data={"summary": "保留任务目标", "metadata": {"post_tokens": 300}},
        ),
        _ctx(session_id="session-1"),
    )[0]

    assert event == {
        "type": "CUSTOM",
        "name": "workstep.compacted",
        "value": {"summary": "保留任务目标", "metadata": {"post_tokens": 300}},
        "messageId": "msg-1",
        "task_id": "task-1",
        "step_key": "step-a",
        "channel": "execution",
        "session_id": "session-1",
        "engine": "codex",
        "model": "gpt-5",
        "sequence": 3,
        "timestamp": 1234,
    }


def test_a2ui_event_maps_to_a2ui_surface_custom():
    payload = {
        "version": "v0.9.1",
        "createSurface": {"surfaceId": "flow-choice", "catalogId": "basic"},
    }
    event = to_agui_events(a2ui_event(payload), _ctx(channel="flow_gen", session_id="s1"))[0]
    assert event["type"] == "CUSTOM"
    assert event["name"] == "a2ui.surface"
    assert event["value"]["createSurface"]["surfaceId"] == "flow-choice"
    assert event["session_id"] == "s1"
    assert event["channel"] == "flow_gen"


def test_assistant_channel_run_ids_use_session_id():
    event = to_agui_events(
        InternalEvent(type="status", data={"status": "running"}),
        _ctx(channel="flow_gen", session_id="s1", task_id=None, step_key=None),
    )[0]
    assert event["type"] == "RUN_STARTED"
    assert event["threadId"] == "s1"
    assert event["runId"] == "s1"


def test_unknown_event_passthrough_custom():
    event = to_agui_events(InternalEvent(type="mystery_event", data={"x": 1}), _ctx())[0]
    assert event["type"] == "CUSTOM"
    assert event["name"] == "workstep.mystery_event"


def test_internal_event_object_and_dict_both_accepted():
    internal = InternalEvent(type="agent_message_chunk", data={"content": {"text": "x"}})
    obj_events = to_agui_events(internal, _ctx())
    dict_events = to_agui_events(internal.to_dict(), _ctx())
    assert obj_events == dict_events


def test_legacy_events_map_to_acp_vocabulary():
    legacy = {"type": "text_delta", "data": {"delta": "hi"}, "timestamp": 1}
    mapped = map_legacy_event(legacy)
    assert mapped["type"] == "agent_message_chunk"
    assert mapped["data"]["content"]["text"] == "hi"
    agui = to_agui_events(mapped, _ctx())[0]
    assert agui["type"] == "TEXT_MESSAGE_CHUNK"
    assert agui["delta"] == "hi"

    legacy_tool = {"type": "tool_use", "data": {"id": "t1", "name": "read", "input": {"path": "a"}}}
    mapped_tool = map_legacy_event(legacy_tool)
    assert mapped_tool["type"] == "tool_call"
    assert mapped_tool["data"]["tool_call_id"] == "t1"
    assert mapped_tool["data"]["title"] == "read"
    assert mapped_tool["data"]["raw_input"] == {"path": "a"}

    legacy_result = {"type": "tool_result", "data": {"tool_use_id": "t1", "content": "ok"}}
    mapped_result = map_legacy_event(legacy_result)
    assert mapped_result["type"] == "tool_call_update"
    assert mapped_result["data"]["status"] == "completed"
    assert mapped_result["data"]["raw_output"] == "ok"

    legacy_usage = {"type": "usage", "data": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3}}
    mapped_usage = map_legacy_event(legacy_usage)
    assert mapped_usage["type"] == "usage_update"
    assert mapped_usage["data"]["total_tokens"] == 3


def test_legacy_replay_full_pipeline():
    """老 events_json → 兼容映射 → AG-UI 翻译，端到端不破。"""
    legacy_events = [
        {"type": "thinking_delta", "data": {"delta": "reason"}},
        {"type": "text_delta", "data": {"delta": "answer"}},
        {"type": "tool_use", "data": {"id": "t1", "name": "bash", "input": {"command": "ls"}}},
        {"type": "tool_result", "data": {"tool_use_id": "t1", "content": "files", "is_error": False}},
    ]
    agui_types = []
    for event in legacy_events:
        agui_types.extend(
            e["type"] for e in to_agui_events(map_legacy_event(event), _ctx())
        )
    assert agui_types == [
        "REASONING_MESSAGE_CHUNK",
        "TEXT_MESSAGE_CHUNK",
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_RESULT",
    ]
