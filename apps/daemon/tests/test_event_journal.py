"""Turn event journal behavior through its public interface."""

import asyncio
import time

from agent_assistants.event_journal import TurnEventJournal
from engines.core.agui import to_agui_events


async def test_async_journal_io_does_not_block_the_event_loop(tmp_path, monkeypatch):
    """Slow journal storage must not delay unrelated daemon coroutines."""
    journal = TurnEventJournal()
    original_read = journal._read

    def slow_read(ref):
        time.sleep(0.25)
        return original_read(ref)

    monkeypatch.setattr(journal, "_read", slow_read)
    started = time.perf_counter()

    async def canary():
        await asyncio.sleep(0.02)
        return time.perf_counter() - started

    canary_task = asyncio.create_task(canary())
    ref = await journal.astart(tmp_path, "session-async", "message-async")
    elapsed = await canary_task
    await journal.aclose()

    assert ref.relative_path.endswith("message-async.jsonl")
    assert elapsed < 0.15


async def test_async_journal_preserves_record_order(tmp_path):
    journal = TurnEventJournal()
    ref = await journal.astart(tmp_path, "session-order", "message-order")

    await asyncio.gather(*(
        journal.arecord(ref, {"type": "status", "data": {"index": index}})
        for index in range(20)
    ))
    await journal.afinish(ref)
    timeline = await journal.atimeline(ref)
    await journal.aclose()

    assert [event["data"]["index"] for event in timeline["events"]] == list(range(20))


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


def test_commentary_survives_replay_without_becoming_response_content(tmp_path):
    journal = TurnEventJournal()
    ref = journal.start(tmp_path, "session-phases", "message-phases")
    for phase, item_id, content in [
        ("commentary", "progress-1", "我先定位。"),
        ("commentary", "progress-2", "正在核对。"),
        ("final_answer", "answer", "已完成。"),
    ]:
        journal.record(ref, {
            "type": "agent_message_chunk",
            "data": {"content": {"text": content}, "phase": phase, "source_item_id": item_id},
        })
    journal.finish(ref)
    restored = TurnEventJournal()
    snapshot = restored.snapshot(ref)
    assert snapshot["content"] == "已完成。"
    assert snapshot["summary"]["commentary_characters"] == 10
    assert snapshot["summary"]["thought_characters"] == 0
    replay = [mapped for event in restored.timeline(ref)["events"]
              for mapped in to_agui_events(event)]
    assert [(event.get("phase"), event.get("source_item_id"), event["delta"])
            for event in replay] == [
        ("commentary", "progress-1", "我先定位。"),
        ("commentary", "progress-2", "正在核对。"),
        ("final_answer", "answer", "已完成。"),
    ]


def test_journal_finish_cancels_unanswered_interactions(tmp_path):
    journal = TurnEventJournal()
    ref = journal.start(tmp_path, "session-stop", "message-stop")
    journal.record(ref, {
        "type": "interaction_request",
        "data": {
            "interaction_id": "permission-stop",
            "method": "session/request_permission",
        },
    })

    journal.finish(ref, {"type": "status", "data": {"status": "stopped"}})

    events = journal.timeline(ref)["events"]
    assert [event["type"] for event in events] == [
        "interaction_request",
        "interaction_response",
        "status",
    ]
    assert events[1]["data"] == {
        "interaction_id": "permission-stop",
        "method": "session/request_permission",
        "response": {"outcome": {"outcome": "cancelled"}},
    }


async def test_journal_flushes_a_quiet_tail_after_the_buffer_interval(tmp_path):
    journal = TurnEventJournal(flush_interval=0.01)
    ref = journal.start(tmp_path, "session-quiet", "message-quiet")

    journal.record(ref, {"type": "agent_message_chunk", "data": {"content": {"text": "tail"}}})
    await asyncio.sleep(0.03)

    path = journal.resolve(tmp_path, ref)
    assert '"agent_message_chunk"' in path.read_text(encoding="utf-8")
