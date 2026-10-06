import asyncio
import pytest
from pydantic_ai import Agent
from pydantic_ai.models.function import DeltaToolCall, FunctionModel
from engines.pydantic_ai import PydanticAIEngine
from engines.core.agui import to_agui_events

@pytest.fixture
def anyio_backend():
    return "asyncio"

@pytest.mark.anyio
async def test_live_messages_cover_whole_run_and_repeated_names(tmp_path):
    collected = []
    async def on_event(event):
        collected.append(event)
    from engines.pydantic_ai.coder import WorkStepCoder
    from pydantic_ai_harness.subagents import SubAgents
    capability = PydanticAIEngine()._make_subagent_capability(on_event)
    coder = WorkStepCoder(tmp_path, subagent_capability=capability)
    shared = next(c for c in coder.capabilities if isinstance(c, SubAgents)).shared_capabilities
    requests = 0
    async def model(messages, info):
        nonlocal requests
        requests += 1
        if requests % 2:
            yield "Checking files"
            yield {0: DeltaToolCall(name="read_file", json_args="{}", tool_call_id="read")}
        else:
            assert not any(e.data["stage"] == "finished" for e in collected)
            yield "Found "
            yield "the answer"
    agent = Agent(FunctionModel(stream_function=model), name="explorer", capabilities=shared)
    @agent.tool_plain
    def read_file():
        assert any(e.data.get("event", {}).get("data", {}).get("content", {}).get("text") == "Checking files" for e in collected)
        assert collected[-1].data["status"] == "running"
        return "file contents"
    await agent.run("inspect")
    assert collected[0].data["prompt"] == "inspect"
    assert collected[0].data["agent_name"] == "explorer"
    assert collected[-1].data["result"] == "Found the answer"
    first_id = collected[0].data["task_id"]
    assert sum(e.data["stage"] == "started" for e in collected) == 1
    assert sum(e.data["stage"] == "finished" for e in collected) == 1
    assert collected[-1].data["status"] == "completed"
    nested = [e.data["event"] for e in collected if "event" in e.data]
    assert {e["type"] for e in nested} >= {"agent_message_chunk", "tool_call", "tool_call_update"}
    assert "Found the answer" in "".join(e["data"].get("content", {}).get("text", "") for e in nested)
    frames = [to_agui_events(e)[0] for e in collected]
    assert all(e["type"] == "CUSTOM" for e in frames)
    assert any(e["value"].get("events", [{}])[0].get("type") == "TEXT_MESSAGE_CHUNK" for e in frames)
    from agent_assistants.event_journal import TurnEventJournal
    journal = TurnEventJournal()
    ref = journal.start(tmp_path, "parent", "message")
    for event in collected:
        journal.record(ref, event.to_dict())
    journal.finish(ref)
    replay = journal.timeline(ref, cursor=0, limit=30000)["events"]
    assert [to_agui_events(e)[0]["value"] for e in replay] == [e["value"] for e in frames]
    assert journal.snapshot(ref).get("content", "") == ""
    collected.clear()
    await agent.run("inspect again")
    assert collected[0].data["task_id"] != first_id

@pytest.mark.anyio
@pytest.mark.parametrize("cancelled", [False, True])
async def test_failure_and_cancellation(cancelled):
    collected = []
    async def on_event(event):
        collected.append(event)
    async def model(messages, info):
        yield "Working"
        if cancelled:
            raise asyncio.CancelledError()
        raise RuntimeError("sub-agent crashed")
    agent = Agent(FunctionModel(stream_function=model), name="explorer",
                  capabilities=[PydanticAIEngine()._make_subagent_capability(on_event)])
    with pytest.raises(asyncio.CancelledError if cancelled else RuntimeError):
        await agent.run("inspect")
    assert collected[0].data["stage"] == "started"
    assert collected[-1].data["stage"] == "finished"
    assert collected[-1].data["status"] == ("stopped" if cancelled else "failed")


@pytest.mark.anyio
async def test_main_agent_tool_round_text_is_commentary():
    """工具轮次的中间引导文本转为思考通道，最终回答保持可见文本。"""
    events = []
    async def collect(event):
        events.append(event)
    requests = 0
    async def model(messages, info):
        nonlocal requests
        requests += 1
        if requests == 1:
            yield "Let me check files."
            yield {0: DeltaToolCall(name="read_file", json_args="{}", tool_call_id="read")}
        else:
            yield "The fix is complete."
    agent = Agent(FunctionModel(stream_function=model))
    @agent.tool_plain
    def read_file():
        return "contents"
    await PydanticAIEngine()._stream_agent_run(agent, prompt="fix", on_event=collect)
    text = [e for e in events if e.type == "agent_message_chunk"]
    thought = [e for e in events if e.type == "agent_thought_chunk"]
    # 中间引导文本已转为思考
    assert len(thought) == 1
    assert thought[0].data["content"]["text"] == "Let me check files."
    # 最终回答保留为可见文本
    assert len(text) == 1
    assert text[0].data.get("phase") == "final_answer"
    assert text[0].data["content"]["text"] == "The fix is complete."


@pytest.mark.anyio
async def test_main_agent_interrupted_text_remains_process():
    """中断运行的部分输出归入思考通道，不成为最终回答。"""
    events = []
    async def collect(event):
        events.append(event)
    async def model(messages, info):
        yield "Still checking"
        raise RuntimeError("interrupted")
    agent = Agent(FunctionModel(stream_function=model))
    with pytest.raises(RuntimeError):
        await PydanticAIEngine()._stream_agent_run(agent, prompt="fix", on_event=collect)
    assert events
    thought = [e for e in events if e.type == "agent_thought_chunk"]
    assert len(thought) == 1
    assert thought[0].data["content"]["text"] == "Still checking"
    # 不应有可见文本事件
    assert not any(e.type == "agent_message_chunk" for e in events)
