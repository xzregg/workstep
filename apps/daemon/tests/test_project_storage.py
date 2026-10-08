"""Storage API, portable project identity, and event-loop responsiveness."""
import asyncio
import json
import threading
from pathlib import Path

import pytest
from tests.test_api_contracts import api_context


@pytest.mark.anyio
async def test_storage_api_migrates_without_blocking_health(api_context, monkeypatch):
    import main
    import services.project as project_module
    from models import Task, StepRun, WorkflowRun
    client, tmp_path = api_context
    root = tmp_path / "storage"
    root.mkdir()
    created = await client.post("/api/project/init", json={"path": str(root)})
    assert created.status_code == 200
    project_id = created.json()["id"]
    project = main.project_manager.get_project_by_id(project_id)
    await main.project_manager.run_db(project_id, lambda p: Task.create(id="preserved", title="saved", cwd=str(root), created_at=1, updated_at=1))
    (project.workstep_dir / "uploads").mkdir()
    (project.workstep_dir / "uploads/image.png").write_bytes(b"image")
    (project.workstep_dir / "uploads/project.json").write_text("attachment")
    (project.workstep_dir / "MEMORY.md").write_text("memory")
    snapshot_path = str(project.workstep_dir / "artifacts/prior/result.md")
    def seed_snapshot(p):
        run = WorkflowRun.create(id="prior", task="preserved", status="succeeded", workflow_schema_version=1)
        StepRun.create(id="prior-step", run=run, step_key="build", attempt=1, status="succeeded",
                       input_snapshot_json=json.dumps({"ports": [{"sources": [{"path": snapshot_path}]}]}))
    await main.project_manager.run_db(project_id, seed_snapshot)
    entered = threading.Event()
    release = threading.Event()
    original_copy = project_module.shutil.copytree
    def slow_copy(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return original_copy(*args, **kwargs)
    monkeypatch.setattr(project_module.shutil, "copytree", slow_copy)
    pending = asyncio.create_task(client.put(f"/api/project/{project_id}/storage", json={"follow_project": False}))
    assert await asyncio.to_thread(entered.wait, 2)
    try:
        assert (await asyncio.wait_for(client.get("/api/health"), 0.5)).status_code == 200
        assert not pending.done()
    finally:
        release.set()
    result = await pending
    assert result.status_code == 200, result.text
    assert not result.json()["follow_project"]
    assert not (root / ".workstep/workstep.db").exists()
    assert (project.workstep_dir / "uploads/project.json").read_text() == "attachment"
    assert (await client.get(f"/api/project/{project_id}/storage")).json() == result.json()
    assert await main.project_manager.run_db(project_id, lambda p: Task.get_by_id("preserved").title) == "saved"
    snapshot = await main.project_manager.run_db(project_id, lambda p: json.loads(StepRun.get_by_id("prior-step").input_snapshot_json))
    assert snapshot["ports"][0]["sources"][0]["path"] == str(project.workstep_dir / "artifacts/prior/result.md")
    from api.fs_paths import _resolve_project_file
    assert _resolve_project_file(".workstep/uploads/image.png", project_id).read_bytes() == b"image"
    preview = await client.get("/api/fs/preview", params={"project_id": project_id, "path": ".workstep/MEMORY.md"})
    assert preview.status_code == 200
    assert preview.json()["content"] == "memory"
    assert preview.json()["relative_path"] == ".workstep/MEMORY.md"
    reset = await client.put(f"/api/project/{project_id}/storage", json={"follow_project": True})
    assert reset.status_code == 200
    assert (root / ".workstep/uploads/image.png").read_bytes() == b"image"


@pytest.mark.anyio
async def test_external_init_reopens_and_missing_data_does_not_reset(api_context):
    import main
    client, tmp_path = api_context
    root = tmp_path / "external-init"
    root.mkdir()
    created = await client.post("/api/project/init", json={"path": str(root), "follow_project": False})
    assert created.status_code == 200
    project = main.project_manager.get_project_by_id(created.json()["id"])
    identity = json.loads((root / ".workstep/project.json").read_text())
    assert identity == {"id": project.id, "follow_project": False}
    directory = project.workstep_dir
    main.project_manager.unregister(project.id)
    reopened = await client.post("/api/project/init", json={"path": str(root)})
    assert reopened.status_code == 200 and reopened.json()["id"] == identity["id"]
    assert not reopened.json()["follow_project"]
    main.project_manager.unregister(identity["id"])
    directory.rename(directory.with_name(directory.name + "-missing"))
    missing = await client.post("/api/project/init", json={"path": str(root)})
    assert missing.status_code == 400
    assert not directory.exists()


@pytest.mark.anyio
async def test_failed_storage_copy_keeps_original_project(api_context, monkeypatch):
    import main
    import services.project as project_module
    client, tmp_path = api_context
    root = tmp_path / "rollback"
    root.mkdir()
    project_id = (await client.post("/api/project/init", json={"path": str(root)})).json()["id"]
    project = main.project_manager.get_project_by_id(project_id)
    source = project.workstep_dir
    (source / "MEMORY.md").write_text("retain")
    def fail(*args, **kwargs):
        raise OSError("disk full")
    monkeypatch.setattr(project_module.shutil, "copytree", fail)
    with pytest.raises(OSError, match="disk full"):
        await main.project_manager.set_storage(project_id, False)
    assert project.follow_project and not project.storage_changing
    assert (source / "MEMORY.md").read_text() == "retain"
    assert await main.project_manager.run_db(project_id, lambda p: p.db.execute_sql("SELECT 1").fetchone()) == (1,)


@pytest.mark.anyio
async def test_external_project_copy_conflict_and_other_project_files_are_rejected(api_context):
    import shutil
    import main
    from api.fs_paths import _resolve_project_file
    from fastapi import HTTPException
    client, tmp_path = api_context
    roots = []
    for name in ("one", "two"):
        root = tmp_path / name
        root.mkdir()
        result = await client.post("/api/project/init", json={"path": str(root), "follow_project": False})
        roots.append((root, main.project_manager.get_project_by_id(result.json()["id"])))
    first_root, first = roots[0]
    _, second = roots[1]
    copied = tmp_path / "copied"
    shutil.copytree(first_root, copied)
    conflict = await client.post("/api/project/init", json={"path": str(copied)})
    assert conflict.status_code == 400 and "ID" in conflict.json()["detail"]
    with pytest.raises(HTTPException) as error:
        _resolve_project_file(str(second.workstep_dir / "workstep.db"), first.id)
    assert error.value.status_code == 403
    with pytest.raises(HTTPException):
        _resolve_project_file(".workstep/../" + second.id + "/workstep.db", first.id)


@pytest.mark.anyio
async def test_external_images_and_harness_files_use_project_data_root(api_context):
    import main
    from agent_assistants.base import extract_uploaded_images
    from engines.pydantic_ai.coder import ProjectDataFileSystem
    client, tmp_path = api_context
    root = tmp_path / "image-data"
    root.mkdir()
    result = await client.post("/api/project/init", json={"path": str(root), "follow_project": False})
    project = main.project_manager.get_project_by_id(result.json()["id"])
    uploads = project.workstep_dir / "uploads"
    uploads.mkdir()
    (uploads / "image.png").write_bytes(b"image")
    images = await asyncio.to_thread(extract_uploaded_images, project, str(root), "![image](.workstep/uploads/image.png)")
    assert len(images) == 1
    artifacts = project.workstep_dir / "artifacts"
    artifacts.mkdir()
    files = ProjectDataFileSystem(root_dir=project.workstep_dir, protected_patterns=["MEMORY.md"]).get_toolset().wrapped
    await files.write_file(str(artifacts / "result.md"), "result")
    assert (artifacts / "result.md").read_text() == "result"
    with pytest.raises(Exception):
        await files.write_file(str(root.parent / "escape.md"), "escape")
    assert not (root.parent / "escape.md").exists()


@pytest.mark.anyio
async def test_slow_storage_sql_keeps_health_responsive(api_context, monkeypatch):
    import main
    client, tmp_path = api_context
    root = tmp_path / "slow-storage-sql"
    root.mkdir()
    project_id = (await client.post("/api/project/init", json={"path": str(root)})).json()["id"]
    project = main.project_manager.get_project_by_id(project_id)
    entered, release = threading.Event(), threading.Event()
    original = project.db.execute_sql
    def slow_sql(sql, *args, **kwargs):
        if sql.startswith('SELECT') and '"tasks"' in sql:
            entered.set()
            assert release.wait(3)
        return original(sql, *args, **kwargs)
    monkeypatch.setattr(project.db, "execute_sql", slow_sql)
    pending = asyncio.create_task(client.put(f"/api/project/{project_id}/storage", json={"follow_project": False}))
    assert await asyncio.to_thread(entered.wait, 2)
    try:
        assert (await asyncio.wait_for(client.get("/api/health"), 0.5)).status_code == 200
        assert not pending.done()
    finally:
        release.set()
    assert (await pending).status_code == 200
