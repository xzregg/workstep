"""ACP session update 全量映射 + elicitation 模式 + 未知透传测试。"""

import asyncio

import pytest
from acp import schema

from engines.core.acp_base import AcpEngineBase, _StreamingClient
from engines.core.events import InternalEvent


def test_streaming_client_has_protocol_owner():
    from engines.core.acp_streaming_client import ACPStreamingClient

    assert _StreamingClient is ACPStreamingClient


def test_acp_notification_mapping_has_one_owner():
    from engines.core.acp_event_mapper import ACPEventMapper

    assert isinstance(_ProbeEngine(), ACPEventMapper)
    assert "_map_notification" not in AcpEngineBase.__dict__


class _ProbeEngine(AcpEngineBase):
    ENGINE_ID = "probe"
    COMMAND = ["probe"]

    @staticmethod
    def is_installed():
        return True

    @staticmethod
    def get_version():
        return "probe"

    @staticmethod
    def resolve_binary():
        return "probe"

    def get_permission_mode(self):
        return "ask"

    def get_command(self):
        return ["probe"]


def _map(update) -> InternalEvent | None:
    engine = _ProbeEngine()
    return engine._map_notification(update)


def _text_block(text: str):
    return schema.TextContentBlock(type="text", text=text)


def test_maps_agent_message_and_thought_chunks():
    message = _map(schema.AgentMessageChunk(
        sessionUpdate="agent_message_chunk", content=_text_block("hi")
    ))
    assert message.type == "agent_message_chunk"
    assert message.data == {"content": {"text": "hi"}}

    thought = _map(schema.AgentThoughtChunk(
        sessionUpdate="agent_thought_chunk", content=_text_block("think")
    ))
    assert thought.type == "agent_thought_chunk"
    assert thought.data == {"content": {"text": "think"}}


def test_maps_user_message_chunk():
    user = _map(schema.UserMessageChunk(
        sessionUpdate="user_message_chunk", content=_text_block("question")
    ))
    assert user.type == "user_message_chunk"
    assert user.data == {"content": {"text": "question"}}


def test_maps_tool_call_start():
    start = _map(schema.ToolCallStart(
        sessionUpdate="tool_call",
        toolCallId="t1",
        title="read",
        kind="read",
        rawInput={"path": "a.py"},
    ))
    assert start.type == "tool_call"
    assert start.data["tool_call_id"] == "t1"
    assert start.data["title"] == "read"
    assert start.data["kind"] == "read"
    assert start.data["raw_input"] == {"path": "a.py"}
    # ask 权限模式标注 needs_approval
    assert start.data.get("needs_approval") is True


def test_maps_tool_call_progress_states():
    progress = _map(schema.ToolCallProgress(
        sessionUpdate="tool_call_update",
        toolCallId="t1",
        status="in_progress",
        rawInput="echo ",
    ))
    assert progress.type == "tool_call_update"
    assert progress.data["status"] == "in_progress"
    assert progress.data["raw_input"] == "echo "

    completed = _map(schema.ToolCallProgress(
        sessionUpdate="tool_call_update",
        toolCallId="t1",
        status="completed",
        rawOutput="done",
    ))
    assert completed.data["status"] == "completed"
    assert completed.data["raw_output"] == "done"

    failed = _map(schema.ToolCallProgress(
        sessionUpdate="tool_call_update",
        toolCallId="t1",
        status="failed",
        rawOutput="boom",
    ))
    assert failed.data["status"] == "failed"


def test_maps_plan_snapshot_and_updates():
    plan = _map(schema.AgentPlanUpdate(
        sessionUpdate="plan",
        entries=[
            schema.PlanEntry(content="step1", priority="high", status="pending"),
        ],
    ))
    assert plan.type == "plan"
    assert plan.data["entries"][0]["content"] == "step1"

    plan_update = _map(schema.AgentPlanContentUpdate(
        sessionUpdate="plan_update",
        plan=schema.PlanUpdateItems(
            type="items",
            id="p1",
            entries=[schema.PlanEntry(content="step2", priority="medium", status="completed")],
        ),
    ))
    assert plan_update.type == "plan_update"
    assert plan_update.data["id"] == "p1"
    assert plan_update.data["entries"][0]["status"] == "completed"

    removed = _map(schema.AgentPlanRemovedUpdate(sessionUpdate="plan_removed", id="p1"))
    assert removed.type == "plan_removed"
    assert removed.data == {"id": "p1"}


def test_maps_usage_update():
    usage = _map(schema.UsageUpdate(
        sessionUpdate="usage_update",
        used=100,
        size=200,
        cost=schema.Cost(amount=0.01, currency="USD"),
    ))
    assert usage.type == "usage_update"
    assert usage.data["used"] == 100
    assert usage.data["size"] == 200
    assert usage.data["cost"] == {"amount": 0.01, "currency": "USD"}
    assert usage.data["total_tokens"] == 100


def test_maps_session_and_config_updates():
    info = _map(schema.SessionInfoUpdate(sessionUpdate="session_info_update", title="t"))
    assert info.type == "session_info_update"
    assert info.data == {"title": "t"}

    commands = _map(schema.AvailableCommandsUpdate(
        sessionUpdate="available_commands_update",
        availableCommands=[schema.AvailableCommand(name="c", description="d")],
    ))
    assert commands.type == "available_commands_update"
    assert commands.data["available_commands"][0]["name"] == "c"

    config = _map(schema.ConfigOptionUpdate(
        sessionUpdate="config_option_update",
        configOptions=[
            schema.SessionConfigOptionSelect(
                type="select",
                id="model",
                name="model",
                currentValue="m1",
                options=[],
            )
        ],
    ))
    assert config.type == "config_option_update"
    assert config.data["config_options"][0]["id"] == "model"

    mode = _map(schema.CurrentModeUpdate(sessionUpdate="current_mode_update", currentModeId="default"))
    assert mode.type == "current_mode_update"
    assert mode.data == {"current_mode_id": "default"}


def test_maps_mcp_notification_and_elicitation_completed():
    mcp = _map(schema.MessageMcpNotification(connectionId="c1", method="ping", params={"a": 1}))
    assert mcp.type == "mcp_message"
    assert mcp.data["connection_id"] == "c1"
    assert mcp.data["method"] == "ping"
    assert mcp.data["params"] == {"a": 1}

    done = _map(schema.CompleteElicitationNotification(elicitationId="e1"))
    assert done.type == "elicitation_completed"
    assert done.data == {"elicitation_id": "e1"}


def test_unknown_update_passthrough_as_acp_raw():
    class UnknownUpdate:
        def __init__(self):
            self.session_update = "brand_new_update"

        def model_dump(self, by_alias=False, exclude_none=True):
            return {"session_update": "brand_new_update", "custom": 1}

    event = _map(UnknownUpdate())
    assert event is not None
    assert event.type == "acp_raw"
    assert event.data.get("custom") == 1


def test_unknown_update_is_not_silently_dropped():
    class TotallyUnknown:
        pass

    event = _map(TotallyUnknown())
    assert event is not None
    assert event.type == "acp_raw"


@pytest.mark.anyio
async def test_elicitation_url_mode_is_forwarded_to_the_user():
    handler = _StreamingClient()
    mode = schema.ElicitationUrlMode(root=schema.ElicitationUrlSessionMode(
        sessionId="s1",
        toolCallId="t1",
        elicitationId="url-1",
        url="https://example.com/authorize",
    ))

    task = asyncio.create_task(handler.create_elicitation("authorize", mode))
    event = await handler.updates.get()
    assert event.data["mode"] == "url"
    assert event.data["url"] == "https://example.com/authorize"
    handler.resolve_elicitation(event.data["interaction_id"], {"action": "accept"})
    result = await task
    assert result.action == "accept"


def test_engine_declares_acp_events_capability():
    engine = _ProbeEngine()
    capability = getattr(engine, "acp_events", None)
    assert capability is not None
    assert {"agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"} <= set(capability)


def test_client_capabilities_only_advertise_implemented_features():
    capabilities = _ProbeEngine._client_capabilities()

    assert capabilities.elicitation.form is not None
    assert capabilities.elicitation.url is not None
    assert capabilities.plan is not None
    assert capabilities.session.config_options.boolean is not None
    assert capabilities.fs.read_text_file is False
    assert capabilities.fs.write_text_file is False
    assert capabilities.terminal is False


def test_tool_call_mapping_preserves_rich_acp_fields():
    start = _map(schema.ToolCallStart(
        sessionUpdate="tool_call",
        toolCallId="t-rich",
        title="edit file",
        kind="edit",
        status="in_progress",
        content=[schema.FileEditToolCallContent(
            type="diff",
            path="app.py",
            oldText="old",
            newText="new",
            _meta={"renderer": "diff"},
        )],
        locations=[schema.ToolCallLocation(path="app.py", line=12)],
        rawInput={"path": "app.py"},
        _meta={"provider": "probe"},
    ))

    assert start.data["status"] == "in_progress"
    assert start.data["content"][0]["type"] == "diff"
    assert start.data["content"][0]["old_text"] == "old"
    assert start.data["locations"] == [{"path": "app.py", "line": 12}]
    assert start.data["_meta"] == {"provider": "probe"}

    progress = _map(schema.ToolCallProgress(
        sessionUpdate="tool_call_update",
        toolCallId="t-rich",
        content=[schema.ContentToolCallContent(
            type="content",
            content=_text_block("done"),
        )],
        locations=[schema.ToolCallLocation(path="app.py")],
        _meta={"provider": "probe"},
    ))
    assert progress.data["content"][0]["content"]["text"] == "done"
    assert progress.data["locations"] == [{"path": "app.py"}]
    assert progress.data["_meta"] == {"provider": "probe"}
