"""Turn event journal behavior through its public interface."""

import asyncio

from agent_assistants.event_journal import TurnEventJournal


def test_journal_recovers_snapshot_without_exposing_thoughts_in_summary(tmp_path):
    journal = TurnEventJournal()
    ref = journal.start(tmp_path, "session-1", "message-1")

    journal.record(ref, {
        "type": "agent_message_chunk",
        "data": {"content": {"text": "部分回复"}},
    })
    journal.record(ref, {
        "type": "agent_thought_chunk",
        "data": {"content": {"text": "很长的思考过程"}},
    })
    journal.record(ref, {
        "type": "tool_call",
        "data": {"tool_call_id": "tool-1", "title": "读取文件"},
    })
    journal.sync(ref, durable=True)

    snapshot = journal.snapshot(ref)
    assert snapshot["content"] == "部分回复"
    assert snapshot["summary"]["thought_characters"] == 7
    assert snapshot["summary"]["tool_count"] == 1
    assert "很长的思考过程" not in str(snapshot["summary"])

    timeline = journal.timeline(ref)
    assert [event["type"] for event in timeline["events"]] == [
        "agent_message_chunk",
        "agent_thought_chunk",
        "tool_call",
    ]
    assert timeline["complete"] is True


def test_journal_ignores_an_incomplete_trailing_line(tmp_path):
    journal = TurnEventJournal()
    ref = journal.start(tmp_path, "session-1", "message-1")
    journal.record(ref, {"type": "usage_update", "data": {"used": 10}})
    journal.sync(ref, durable=True)

    path = journal.resolve(tmp_path, ref)
    with path.open("ab") as handle:
        handle.write(b'{"seq":999')

    timeline = journal.timeline(ref)
    assert len(timeline["events"]) == 1
    assert timeline["events"][0]["type"] == "usage_update"


async def test_journal_flushes_a_quiet_tail_after_the_buffer_interval(tmp_path):
    journal = TurnEventJournal(flush_interval=0.01)
    ref = journal.start(tmp_path, "session-quiet", "message-quiet")

    journal.record(ref, {"type": "agent_message_chunk", "data": {"content": {"text": "tail"}}})
    await asyncio.sleep(0.03)

    path = journal.resolve(tmp_path, ref)
    assert '"agent_message_chunk"' in path.read_text(encoding="utf-8")
