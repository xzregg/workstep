"""Cross-run snapshots must share message bodies without losing checkpoints."""

import sqlite3

import pytest

from engines.pydantic_ai import PydanticAIEngine


@pytest.mark.anyio
async def test_fifty_turn_snapshots_store_each_message_once(tmp_path):
    from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart
    from pydantic_ai_harness.step_persistence import ContinuableSnapshot

    store = PydanticAIEngine._harness_store(tmp_path)
    history = []
    for turn in range(50):
        history.extend([
            ModelRequest(parts=[UserPromptPart(f"question {turn}: " + "q" * 2048)]),
            ModelResponse(parts=[TextPart(f"answer {turn}: " + "a" * 2048)]),
        ])
        await store.save_snapshot(ContinuableSnapshot(
            run_id=f"turn-{turn}", step_index=1,
            conversation_id="conversation", messages=list(history),
        ))

    with sqlite3.connect(tmp_path / ".workstep" / "harness_runs.db") as conn:
        assert conn.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0] == 50
        assert conn.execute("SELECT COUNT(*) FROM snapshot_messages").fetchone()[0] == 100
        body_bytes = conn.execute("SELECT SUM(length(message)) FROM snapshot_messages").fetchone()[0]
        assert body_bytes < 300_000

    # Reopen the store, including an early checkpoint, rather than checking SQL alone.
    restarted = PydanticAIEngine._harness_store(tmp_path)
    first = await restarted.latest_snapshot(run_id="turn-0")
    last = await restarted.latest_snapshot(run_id="turn-49")
    assert len(first.messages) == 2
    assert last.messages == history
    from pydantic_ai_harness.conversation_search import SnapshotHistorySource
    source = SnapshotHistorySource(restarted)
    assert await source.run_history(run_id="turn-0") == first.messages
    assert await source.run_history(run_id="turn-49") == history


@pytest.mark.anyio
async def test_engine_fifty_runs_restore_history_and_share_bodies(tmp_path):
    from pydantic_ai.messages import ModelRequest, ModelResponse, UserPromptPart
    from pydantic_ai.models.function import FunctionModel

    turns_seen = []

    async def respond(messages, info):
        prompts = [
            p.content for m in messages if isinstance(m, ModelRequest)
            for p in m.parts if isinstance(p, UserPromptPart)
        ]
        turns_seen.append(prompts)
        yield f"answer {len(prompts)}: " + "a" * 2048

    async def record(event):
        pass

    model = FunctionModel(stream_function=respond)
    for turn in range(50):
        # A fresh engine instance each turn must restore the SQLite history.
        await PydanticAIEngine()._run_agent(
            prompt=f"question {turn}", cwd=str(tmp_path), add_dirs=None,
            model=model, on_event=record, session_id="fifty-turns",
        )
    assert [len(prompts) for prompts in turns_seen] == list(range(1, 51))
    assert turns_seen[-1][0] == "question 0"
    restored = await PydanticAIEngine._harness_continue_history(tmp_path, "fifty-turns")
    assert sum(isinstance(m, ModelResponse) for m in restored) == 50
    with sqlite3.connect(tmp_path / ".workstep" / "harness_runs.db") as conn:
        assert conn.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0] == 50
        # Includes workspace/instruction records in addition to user/model messages.
        assert conn.execute("SELECT COUNT(*) FROM snapshot_messages").fetchone()[0] <= 160
        body_bytes = conn.execute("SELECT SUM(length(message)) FROM snapshot_messages").fetchone()[0]
        repeated_bytes = conn.execute(
            "SELECT SUM(length(m.message)) FROM snapshot_message_refs r "
            "JOIN snapshot_messages m ON m.sha256 = r.sha256"
        ).fetchone()[0]
        assert repeated_bytes > body_bytes * 20


@pytest.mark.anyio
async def test_legacy_inline_snapshot_and_new_deduplicated_snapshot_coexist(tmp_path):
    from pydantic_ai.messages import ModelMessagesTypeAdapter, ModelRequest, UserPromptPart
    from pydantic_ai_harness.step_persistence import ContinuableSnapshot

    database = tmp_path / ".workstep" / "harness_runs.db"
    database.parent.mkdir()
    history = [ModelRequest(parts=[UserPromptPart("legacy context")])]
    with sqlite3.connect(database) as conn:
        conn.execute("""CREATE TABLE snapshots (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
            step_index INTEGER NOT NULL, conversation_id TEXT, parent_run_id TEXT,
            agent_name TEXT, timestamp TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'complete', messages TEXT NOT NULL
        )""")
        conn.execute(
            "INSERT INTO snapshots (run_id, step_index, conversation_id, timestamp, messages) VALUES (?, ?, ?, ?, ?)",
            ("old-run", 1, "legacy", "2026-01-01T00:00:00+00:00", ModelMessagesTypeAdapter.dump_json(history).decode()),
        )
    store = PydanticAIEngine._harness_store(tmp_path)
    assert (await store.latest_snapshot(run_id="old-run")).messages == history
    await store.save_snapshot(ContinuableSnapshot(
        run_id="new-run", step_index=1, conversation_id="legacy", messages=history,
    ))
    assert (await store.latest_snapshot(run_id="new-run")).messages == history
    assert (await store.latest_snapshot(run_id="old-run")).messages == history


def test_workspace_factory_selects_windows_without_constructing_posix(monkeypatch, tmp_path):
    from engines.pydantic_ai import coder

    monkeypatch.setattr(coder.sys, "platform", "win32")
    monkeypatch.setattr(coder, "WindowsWorkspace", lambda root: ("windows", root))
    def forbidden(root):
        raise AssertionError("POSIX workspace must not be constructed on Windows")
    monkeypatch.setattr(coder, "LocalWorkspace", forbidden)
    assert coder.local_workspace(tmp_path) == ("windows", tmp_path)


@pytest.mark.anyio
async def test_deleting_conversation_releases_only_unshared_messages(tmp_path):
    import asyncio
    from pydantic_ai.messages import ModelRequest, UserPromptPart
    from pydantic_ai_harness.step_persistence import ContinuableSnapshot, RunRecord

    store = PydanticAIEngine._harness_store(tmp_path)
    history = [ModelRequest(parts=[UserPromptPart("shared body")])]
    for name in ("first", "second"):
        await store.register_run(RunRecord(run_id=name, conversation_id=name))
        await store.save_snapshot(ContinuableSnapshot(
            run_id=name, step_index=1, conversation_id=name, messages=history, idempotency_key="checkpoint",
        ))
    engine = PydanticAIEngine()
    await asyncio.to_thread(engine.delete_session_persistence, "first", str(tmp_path))
    assert (await store.latest_snapshot(run_id="second")).messages == history
    await asyncio.to_thread(engine.delete_session_persistence, "second", str(tmp_path))
    with sqlite3.connect(tmp_path / ".workstep" / "harness_runs.db") as conn:
        assert conn.execute("SELECT COUNT(*) FROM snapshot_message_refs").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM snapshot_messages").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM snapshot_idempotency_keys").fetchone()[0] == 0


@pytest.mark.anyio
async def test_slow_snapshot_write_keeps_health_responsive(tmp_path, monkeypatch):
    import asyncio
    import threading
    from httpx import ASGITransport, AsyncClient
    from main import app
    from pydantic_ai.models.function import FunctionModel
    from pydantic_ai_harness.step_persistence import SqliteStepStore

    entered, release = threading.Event(), threading.Event()
    original = SqliteStepStore._sync_save_snapshot
    def slow_write(self, *args):
        entered.set()
        release.wait(2)
        return original(self, *args)
    monkeypatch.setattr(SqliteStepStore, "_sync_save_snapshot", slow_write)

    async def respond(messages, info):
        yield "saved"
    async def record(event):
        pass
    task = asyncio.create_task(PydanticAIEngine()._run_agent(
        prompt="save", cwd=str(tmp_path), add_dirs=None,
        model=FunctionModel(stream_function=respond), on_event=record, session_id="slow",
    ))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            assert (await asyncio.wait_for(client.get("/api/health"), .3)).status_code == 200
    finally:
        release.set()
        await task
