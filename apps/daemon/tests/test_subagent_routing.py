from types import SimpleNamespace as NS
import pytest
from engines.claude_agent_sdk import ClaudeAgentSDKEngine
from engines.qoder_sdk import QoderSDKEngine
from engines.claude_code import ClaudeCodeEngine

@pytest.mark.parametrize("engine", [ClaudeAgentSDKEngine, QoderSDKEngine, ClaudeCodeEngine])
def test_child_stream_is_nested_and_does_not_swallow_parent(engine):
    instance = engine()
    state = {}
    def send(parent, text):
        obj = dict(type="stream" if engine is QoderSDKEngine else "stream_event", parent_tool_use_id=parent,
                   event={"type": "content_block_delta", "delta": {"type": "text_delta", "text": text}})
        if engine is ClaudeCodeEngine:
            return instance._map_events(obj, state)
        return instance._map_message(NS(**obj), state)
    child = send("agent-tool", "child progress")
    assert len(child) == 1
    assert child[0].type == "subagent"
    assert child[0].data["event"]["data"]["content"]["text"] == "child progress"
    assert not state.get("emitted_text")
    parent = send(None, "parent answer")
    assert parent[0].type == "agent_message_chunk"
    assert parent[0].data["content"]["text"] == "parent answer"


def test_deepseek_child_messages_are_nested():
    from engines.deepseek_harness import DeepSeekHarnessEngine
    engine = DeepSeekHarnessEngine()
    engine._map_notification(NS(method="subagent.started", payload={"parentSessionId":"root", "childSessionId":"child"}), "root")
    events = engine._map_notification(NS(method="session.event", payload={"sessionId":"child", "event":{"type":"assistant/chunk", "data":{"chunk":{"type":"text-delta", "text":"checking"}}}}), "root")
    assert events[0].type == "subagent"
    assert events[0].data["event"]["data"]["content"]["text"] == "checking"


def test_codex_collaboration_snapshots_keep_child_status_and_message():
    from engines.core.plans import codex_subagent_events
    frames = codex_subagent_events({"receiver_thread_ids":["child"], "agents_states":{"child":{"status":"running", "message":"Reading files"}}})
    assert frames[0].data["task_id"] == "child"
    assert frames[0].data["status"] == "running"
    assert frames[0].data["summary"] == "Reading files"
