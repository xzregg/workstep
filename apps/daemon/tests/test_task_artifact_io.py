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


@pytest.mark.anyio
@pytest.mark.parametrize("keep_workspace", [False, True])
async def test_delete_task_removes_artifacts_without_touching_other_tasks(
    api_context, monkeypatch, keep_workspace,
):
    import main
    client, tmp_path = api_context
    project_path = tmp_path / "delete-artifacts"
    project_path.mkdir()
    pid = (await client.post("/api/project/init", json={"path": str(project_path)})).json()["id"]
    await _create_test_workflow(client, pid)
    task = (await client.post("/api/task/create", params={"project_id": pid},
                              json={"title": "Delete me", "cwd": str(project_path)})).json()
    project = main.project_manager.get_project_by_id(pid)
    root = project.workstep_dir / "artifacts" / task["workflow_id"]
    owned = root / task["id"]
    owned.mkdir(parents=True)
    (owned / "step").mkdir()
    (owned / "step" / "result.md").write_text("output")
    legacy = project.workstep_dir / "artifacts" / "default" / task["id"]
    legacy.mkdir(parents=True)
    (legacy / "older.md").write_text("older output")
    sibling = root / "other-task"
    sibling.mkdir()
    (sibling / "keep.md").write_text("keep")
    if keep_workspace:
        (owned / ".worktrees").mkdir()
        (owned / ".worktrees" / "keep").write_text("workspace")
    from services import task_owned_storage

    entered = threading.Event()
    release = threading.Event()
    original = task_owned_storage.shutil.rmtree

    def slow_remove(path, *args, **kwargs):
        if path == owned / "step":
            entered.set()
            assert release.wait(3)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(task_owned_storage.shutil, "rmtree", slow_remove)
    deletion = asyncio.create_task(client.request(
        "DELETE", "/api/task/delete", params={"project_id": pid},
        json={"task_id": task["id"], "delete_workspace": not keep_workspace},
    ))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        assert (await asyncio.wait_for(client.get("/api/health"), .5)).status_code == 200
        assert not deletion.done()
    finally:
        release.set()
        response = await deletion
    assert response.status_code == 200, response.text
    assert not (owned / "step" / "result.md").exists()
    assert not legacy.exists()
    assert (sibling / "keep.md").read_text() == "keep"
    assert owned.exists() == keep_workspace
    if keep_workspace:
        assert (owned / ".worktrees" / "keep").read_text() == "workspace"


@pytest.mark.anyio
@pytest.mark.parametrize("delete_workspace", [False, True])
async def test_archiving_option_preserves_artifacts_and_events(api_context, monkeypatch, delete_workspace):
    import main
    from api import task_workspace_cleanup

    client, tmp_path = api_context
    directory = tmp_path / "archive-artifacts"
    directory.mkdir()
    pid = (await client.post("/api/project/init", json={"path": str(directory)})).json()["id"]
    await _create_test_workflow(client, pid)
    task = (await client.post("/api/task/create", params={"project_id": pid},
                              json={"title": "Archive me", "cwd": str(directory)})).json()
    project = main.project_manager.get_project_by_id(pid)
    owned = project.workstep_dir / "artifacts" / task["workflow_id"] / task["id"]
    owned.mkdir(parents=True)
    artifact = owned / "result.md"
    artifact.write_text("output")
    journal = project.workstep_dir / "event_logs" / f"task-{task['id']}" / "message.jsonl"
    journal.parent.mkdir(parents=True)
    journal.write_text("{}")
    calls = []

    async def cleanup(project_id, task_id, choice, *, force=False, operation):
        calls.append((project_id, task_id, choice, force, operation))

    monkeypatch.setattr(task_workspace_cleanup, "clean_task_workspaces", cleanup)
    result = await client.post("/api/task/archive", params={"project_id": pid},
                               json={"task_id": task["id"], "delete_workspace": delete_workspace})
    assert result.status_code == 200, result.text
    assert calls == ([(pid, task["id"], True, False, "archived")] if delete_workspace else [])
    assert artifact.read_text() == "output"
    assert journal.is_file()


@pytest.mark.anyio
async def test_archive_with_real_worktree_removes_branch_but_retains_artifact(api_context, monkeypatch):
    import subprocess

    import main
    from api import git as git_api
    from services.git import GitService
    from services.git.task_workspace import TaskGitWorkspace

    client, tmp_path = api_context
    directory = tmp_path / "archive-real-worktree"
    directory.mkdir()

    def git(*args):
        return subprocess.run(["git", "-C", str(directory), *args], check=True,
                              capture_output=True, text=True).stdout.strip()

    git("init", "-b", "main")
    (directory / ".gitignore").write_text(".workstep/\n")
    git("add", ".gitignore")
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial")
    pid = (await client.post("/api/project/init", json={"path": str(directory)})).json()["id"]
    await _create_test_workflow(client, pid)
    params = {"project_id": pid}
    task = (await client.post("/api/task/create", params=params,
                              json={"title": "Archive workspace", "cwd": str(directory)})).json()
    project = main.project_manager.get_project_by_id(pid)
    git_service = GitService(lambda: [{"id": pid, "name": "Archive", "path": str(directory)}], lambda: 2)
    monkeypatch.setattr(git_api, "git_service", git_service)
    try:
        job = await git_service.start_scan()
        while job["state"] == "running":
            await asyncio.sleep(.01)
        repository = git_service.snapshot["repositories"][0]["id"]
        worktree = (await TaskGitWorkspace(git_service, task["workflow_id"]).add(
            directory, task["id"], repository, "archive-test", "main",
        ))["worktrees"][0]
        artifact = project.workstep_dir / "artifacts" / task["workflow_id"] / task["id"] / "result.md"
        artifact.write_text("still needed")
        result = await client.post("/api/task/archive", params=params,
                                   json={"task_id": task["id"], "delete_workspace": True})
        assert result.status_code == 200, result.text
        from pathlib import Path
        assert not Path(worktree["path"]).exists()
        assert git("branch", "--list", worktree["branch"]) == ""
        assert artifact.read_text() == "still needed"
        assert (await client.get(f"/api/task/{task['id']}", params=params)).json()["archived"]
    finally:
        await git_service.close()
