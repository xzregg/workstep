"""Slow artifact disks must not monopolize the project's database worker."""

import asyncio
import threading

import pytest

from tests.test_api_contracts import api_context, _create_test_workflow


@pytest.mark.anyio
@pytest.mark.parametrize("external_storage", [False, True])
async def test_task_delete_cleans_logs_and_indexes_without_blocking_health(
    api_context, monkeypatch, external_storage,
):
    import main
    import agent_assistants.event_journal as journal_module
    from services import config
    from services.project_storage import write_identity

    client, tmp_path = api_context
    directory = tmp_path / "delete-logs"
    directory.mkdir()
    project_id = (await client.post("/api/project/init", json={"path": str(directory)})).json()["id"]
    project = main.project_manager.get_project_by_id(project_id)
    if external_storage:
        monkeypatch.setattr(config, "CONFIG_DIR", tmp_path / "config")
        write_identity(directory, project_id, False)
    await _create_test_workflow(client, project_id)
    task_id = (await client.post(
        f"/api/task/create?project_id={project_id}",
        json={"title": "Delete logs", "cwd": str(directory)},
    )).json()["id"]
    logs = project.workstep_dir / "event_logs"
    target = logs / f"task-{task_id}"
    nested = target / "engine-session"
    nested.mkdir(parents=True)
    (nested / "message.jsonl").write_text("{}\n")
    (nested / "message.index.json").write_text("{}")
    sibling = logs / "task-other"
    sibling.mkdir()
    (sibling / "keep.jsonl").write_text("keep")
    await main.project_manager.run_db(project_id, lambda _: main.task_service.archive_task(task_id))
    assert target.exists(), "archiving must preserve logs"
    entered = threading.Event()
    release = threading.Event()
    original = journal_module.shutil.rmtree

    def slow_remove(path, *args, **kwargs):
        if path == target:
            entered.set()
            assert release.wait(3)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(journal_module.shutil, "rmtree", slow_remove)
    deletion = asyncio.create_task(client.request("DELETE", f"/api/task/delete?project_id={project_id}",
                                                json={"task_id": task_id}))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        assert (await asyncio.wait_for(client.get("/api/health"), 0.5)).status_code == 200
        assert not deletion.done()
    finally:
        release.set()
        response = await deletion
    assert response.status_code == 200, response.text
    assert not target.exists()
    assert (sibling / "keep.jsonl").read_text() == "keep"
    assert (await client.get(f"/api/task/{task_id}", params={"project_id": project_id})).status_code == 404


@pytest.mark.anyio
async def test_slow_artifact_scan_keeps_task_reads_and_preview_responsive(api_context, monkeypatch):
    from api import task as task_api

    client, tmp_path = api_context
    directory = tmp_path / "artifact-io"
    directory.mkdir()
    project_id = (await client.post("/api/project/init", json={"path": str(directory)})).json()["id"]
    await _create_test_workflow(client, project_id)
    task_id = (await client.post(
        f"/api/task/create?project_id={project_id}",
        json={"title": "Artifact IO", "cwd": str(directory)},
    )).json()["id"]
    artifact = directory / ".workstep" / "artifacts" / "default" / task_id / "build" / "result.md"
    artifact.parent.mkdir(parents=True)
    artifact.write_text("# Result")
    entered = threading.Event()
    release = threading.Event()
    original = task_api.list_task_artifacts

    def slow_scan(*args):
        entered.set()
        assert release.wait(3), "Test did not release artifact scan"
        return original(*args)

    monkeypatch.setattr(task_api, "list_task_artifacts", slow_scan)
    listing = asyncio.create_task(client.get(
        f"/api/task/{task_id}/artifacts", params={"project_id": project_id},
    ))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        health, detail, preview = await asyncio.wait_for(asyncio.gather(
            client.get("/api/health"),
            client.get(f"/api/task/{task_id}", params={"project_id": project_id}),
            client.get("/api/fs/preview", params={"project_id": project_id, "path": str(artifact)}),
        ), timeout=0.5)
        assert health.status_code == detail.status_code == preview.status_code == 200
        assert detail.json()["id"] == task_id
        assert preview.json()["content"] == "# Result"
        assert not listing.done()
    finally:
        release.set()
        response = await listing
    assert response.status_code == 200
    assert response.json()["artifacts"][0]["name"] == "result.md"
