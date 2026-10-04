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


async def test_concurrent_db_thread_record_during_flush_does_not_lose_events(tmp_path, monkeypatch):
    import threading
    from pathlib import Path

    journal = TurnEventJournal(flush_interval=10)
    ref = await journal.astart(tmp_path, "session-concurrent", "message-concurrent")
    await journal.arecord(ref, {"type": "status", "data": {"index": 1}})
    target = journal.resolve(tmp_path, ref)
    entered, release, record_started = threading.Event(), threading.Event(), threading.Event()
    original = Path.open

    def slow_open(path, mode="r", *args, **kwargs):
        if path == target and mode == "ab" and not entered.is_set():
            entered.set()
            release.wait(2)
        return original(path, mode, *args, **kwargs)

    def record_from_db_thread():
        record_started.set()
        journal.record(ref, {"type": "status", "data": {"index": 2}})

    monkeypatch.setattr(Path, "open", slow_open)
    flush = asyncio.create_task(journal.async_flush(ref))
    record = None
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        record = asyncio.create_task(asyncio.to_thread(record_from_db_thread))
        assert await asyncio.to_thread(record_started.wait, 1)
        await asyncio.sleep(0.02)
    finally:
        release.set()
        await flush
        if record is not None:
            await record
    try:
        timeline = await journal.atimeline(ref)
        assert [event["data"]["index"] for event in timeline["events"]] == [1, 2]
        assert [event["seq"] for event in timeline["events"]] == [1, 2]
    finally:
        await journal.aclose()


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


def test_async_question_survives_journal_summary_and_agui_replay(tmp_path):
    journal = TurnEventJournal()
    ref = journal.start(tmp_path, "session-question", "message-question")
    journal.record(ref, {
        "type": "async_question",
        "data": {
            "source_item_id": "call-1",
            "questions": [{"title": "处理方式？", "options": ["复制差异块"]}],
        },
    })
    journal.finish(ref)

    summary_events = journal.snapshot(ref)["events"]
    assert len(summary_events) == 1
    mapped = to_agui_events(summary_events[0])
    assert mapped[0]["type"] == "CUSTOM"
    assert mapped[0]["name"] == "workstep.async_question"
    assert mapped[0]["value"]["questions"][0]["options"] == ["复制差异块"]


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
    ref = await journal.astart(tmp_path, "session-quiet", "message-quiet")

    await journal.arecord(ref, {"type": "agent_message_chunk", "data": {"content": {"text": "tail"}}})
    await asyncio.sleep(0.03)

    path = journal.resolve(tmp_path, ref)
    assert '"agent_message_chunk"' in path.read_text(encoding="utf-8")
    await journal.aclose()


async def test_slow_scheduled_journal_flush_keeps_event_loop_responsive(tmp_path, monkeypatch):
    import threading

    journal = TurnEventJournal(flush_interval=0.01)
    ref = await journal.astart(tmp_path, "session-timer", "message-timer")
    entered, release = threading.Event(), threading.Event()
    original = journal.sync
    loop_thread = threading.get_ident()
    threads = []

    def slow_sync(*args, **kwargs):
        threads.append(threading.get_ident())
        entered.set()
        release.wait(2)
        return original(*args, **kwargs)

    monkeypatch.setattr(journal, "sync", slow_sync)
    try:
        started = time.monotonic()
        await journal.arecord(ref, {"type": "agent_message_chunk", "data": {"text": "tail"}})
        assert await asyncio.to_thread(entered.wait, 1)
        await asyncio.sleep(0.01)
        assert time.monotonic() - started < 0.5
        assert threads[0] != loop_thread
    finally:
        release.set()
        await journal.aclose()


def test_journal_summary_keeps_first_output_and_elapsed_times(tmp_path):
    journal = TurnEventJournal()
    ref = journal.start(tmp_path, "session-ttft", "message-ttft")

    journal.record(ref, {
        "type": "status",
        "data": {"status": "running"},
        "timestamp": "2026-09-17T00:00:00.000000+00:00",
    })
    journal.record(ref, {
        "type": "agent_thought_chunk",
        "data": {"content": {"text": "thinking"}},
        "timestamp": "2026-09-17T00:00:00.500000+00:00",
    })
    journal.record(ref, {
        "type": "agent_message_chunk",
        "data": {"content": {"text": "answer"}},
        "timestamp": "2026-09-17T00:00:01.000000+00:00",
    })
    journal.record(ref, {
        "type": "status",
        "data": {"status": "done"},
        "timestamp": "2026-09-17T00:00:02.000000+00:00",
    })

    summary = journal.snapshot(ref)["summary"]
    assert summary["first_output_at"] == "2026-09-17T00:00:00.500000+00:00"
    assert summary["elapsed_ms"] == 2000
