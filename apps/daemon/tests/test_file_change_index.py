import json
import asyncio
import threading

import pytest

from agent_assistants.event_journal import TurnEventJournal
from tests.test_api_contracts import api_context, _create_test_workflow


def edit(journal, ref, call_id, path, diff):
    journal.record(ref, {"type": "tool_call", "data": {
        "tool_call_id": call_id, "kind": "edit", "raw_input": {"path": path, "diff": diff},
    }})
    journal.record(ref, {"type": "tool_call_update", "data": {
        "tool_call_id": call_id, "status": "completed",
    }})


def test_new_journal_index_has_counts_and_offsets_but_no_patch_text(tmp_path, monkeypatch):
    journal = TurnEventJournal()
    ref = journal.start(tmp_path, "session", "message")
    edit(journal, ref, "a", "src/a.py", "@@ -1 +1,2 @@\n-secret_old\n+secret_new\n+extra\n")
    edit(journal, ref, "b", "src/b.py", "@@ -1 +1 @@\n-other_old\n+other_new\n")
    journal.finish(ref)
    try:
        index = journal.resolve(tmp_path, ref).with_suffix(".changes.json")
        assert index.exists()
        payload = index.read_text()
        assert "secret_old" not in payload and "secret_new" not in payload
        monkeypatch.setattr(journal, "_read", lambda *_: (_ for _ in ()).throw(AssertionError("full read")))
        summary = journal.file_changes(ref)
        assert summary["files"][0] == {"path": "src/a.py", "added": 2, "removed": 1, "has_patch": True}
        detail = journal.file_changes(ref, file_path="src/a.py")
        assert "secret_old" in detail["patch"]
        assert "other_old" not in detail["patch"]
        assert summary.get("patch") is None
    finally:
        journal.close()


def test_index_filters_unsuccessful_edits_merges_aliases_and_suppresses_partial_patches(tmp_path):
    journal = TurnEventJournal()
    ref = journal.start(tmp_path, "mixed", "message")
    edit(journal, ref, "absolute", str(tmp_path / "a.py"), "@@ -1 +1 @@\n-old\n+new\n")
    edit(journal, ref, "relative", "./a.py", "@@ -1 +1 @@\n-old2\n+new2\n")
    edit(journal, ref, "unknown", "a.py", "")
    for call_id, status in [("read", "completed"), ("failed", "failed"), ("pending", "in_progress")]:
        journal.record(ref, {"type": "tool_call", "data": {"tool_call_id": call_id,
            "kind": "read" if call_id == "read" else "edit", "raw_input": {"path": f"{call_id}.py"}}})
        journal.record(ref, {"type": "tool_call_update", "data": {"tool_call_id": call_id, "status": status}})
    journal.finish(ref)
    try:
        files = journal.file_changes(ref, project_root=tmp_path)["files"]
        assert files == [{"path": str(tmp_path / "a.py"), "added": None, "removed": None, "has_patch": False}]
        assert journal.file_changes(ref, project_root=tmp_path, file_path="a.py")["patch"] is None
    finally:
        journal.close()


def test_index_rebuilds_corrupt_metadata_and_follows_journal_moves(tmp_path):
    journal = TurnEventJournal()
    ref = journal.start(tmp_path, "task-owner", "message")
    edit(journal, ref, "a", "a.py", "@@ -1 +1 @@\n-old\n+new\n")
    moved = journal.move_to_conversation(ref, "engine-session")
    journal.finish(moved)
    try:
        path = journal.resolve(tmp_path, moved)
        assert not journal.resolve(tmp_path, ref).with_suffix(".changes.json").exists()
        target = path.with_suffix(".changes.json")
        payload = json.loads(target.read_text())
        payload["files"] = [{"path": "a.py"}]
        target.write_text(json.dumps(payload))
        assert journal.file_changes(moved)["files"][0]["added"] == 1
        assert "-old\n+new" in journal.file_changes(moved, file_path="a.py")["patch"]
    finally:
        journal.close()


def test_legacy_log_builds_index_once_and_invalidates_after_append(tmp_path, monkeypatch):
    from agent_assistants import file_change_index

    journal = TurnEventJournal()
    ref = journal.start(tmp_path, "legacy", "message")
    edit(journal, ref, "a", "a.py", "@@ -1 +1 @@\n-a\n+b\n")
    journal.finish(ref)
    index = journal.resolve(tmp_path, ref).with_suffix(".changes.json")
    index.unlink(missing_ok=True)
    calls = 0
    original = file_change_index.build_index

    def count(*args, **kwargs):
        nonlocal calls
        calls += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(file_change_index, "build_index", count)
    try:
        assert journal.file_changes(ref)["files"][0]["added"] == 1
        journal.file_changes(ref, file_path="a.py")
        assert calls == 1
        path = journal.resolve(tmp_path, ref)
        with path.open("a") as handle:
            for event in [
                {"type": "tool_call", "data": {"tool_call_id": "b", "kind": "edit", "raw_input": {"path": "b.py"}}},
                {"type": "tool_call_update", "data": {"tool_call_id": "b", "status": "completed"}},
            ]:
                handle.write(json.dumps(event) + "\n")
        assert len(journal.file_changes(ref)["files"]) == 2
        assert calls == 2
    finally:
        journal.close()


@pytest.mark.anyio
async def test_file_index_api_is_scoped_and_slow_old_log_build_keeps_health_responsive(api_context, monkeypatch):
    import main
    from models import Message
    from models.fields import utc_now
    from agent_assistants import file_change_index

    client, tmp_path = api_context
    directory = tmp_path / "file-index-api"
    directory.mkdir()
    project_id = (await client.post("/api/project/init", json={"path": str(directory)})).json()["id"]
    await _create_test_workflow(client, project_id)
    async def create_task():
        return (await client.post(f"/api/task/create?project_id={project_id}",
            json={"title": "FileIndex", "cwd": str(directory)})).json()["id"]
    task_id = await create_task()
    other_id = await create_task()
    project = main.project_manager.get_project_by_id(project_id)
    def seed(_project):
        journal = main.task_service._event_journal
        ref = journal.start(project.workstep_dir, f"task-{task_id}", "indexed-message")
        edit(journal, ref, "a", "a.py", "@@ -1 +1 @@\n-before_private\n+after_private\n")
        journal.finish(ref)
        Message.create(id="indexed-message", task=task_id, step_key="build", role="assistant",
                       content="done", position=1, created_at=utc_now(), event_log_path=ref.relative_path)
        return journal.resolve(project.workstep_dir, ref)
    log = await main.project_manager.run_db(project_id, seed)
    index = log.with_suffix(".changes.json")
    index.unlink()
    entered, release = threading.Event(), threading.Event()
    original = file_change_index.build_index
    def slow_build(path):
        entered.set()
        assert release.wait(3)
        return original(path)
    monkeypatch.setattr(file_change_index, "build_index", slow_build)
    url = f"/api/task/{task_id}/messages/indexed-message/events"
    params = {"project_id": project_id, "file_changes": "true"}
    pending = asyncio.create_task(client.get(url, params=params))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        assert (await asyncio.wait_for(client.get("/api/health"), 0.5)).status_code == 200
    finally:
        release.set()
        response = await pending
    assert response.status_code == 200, response.text
    assert response.json()["files"] == [{"path": "a.py", "added": 1, "removed": 1, "has_patch": True}]
    assert "before_private" not in response.text
    monkeypatch.setattr(file_change_index, "build_index", lambda *_: pytest.fail("must use cached byte ranges"))
    detail = await client.get(url, params={**params, "file_path": "a.py"})
    assert detail.status_code == 200
    assert "before_private" in detail.json()["patch"]
    assert (await client.get(url, params={**params, "file_path": "../not-edited"})).status_code == 404
    assert (await client.get(f"/api/task/{other_id}/messages/indexed-message/events", params=params)).status_code == 404
    def verify_database(_project):
        message = Message.get_by_id("indexed-message")
        assert "before_private" not in (message.events_json or "")
        assert "before_private" not in (message.event_summary_json or "")
    await main.project_manager.run_db(project_id, verify_database)
    assert (await client.request("DELETE", "/api/task/delete", params={"project_id": project_id},
                                 json={"task_id": task_id})).status_code == 200
    assert not log.exists() and not index.exists()
