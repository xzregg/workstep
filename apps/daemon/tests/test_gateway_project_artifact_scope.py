"""Project artifact listings keep host filesystem paths on the host."""

import asyncio
import base64
import json
import threading

from httpx import ASGITransport, AsyncClient

import pytest

from models import StepRun, Task, WorkflowRun
from models.fields import utc_now
from services.gateway_client.bridge import ManagedHttpBridge
from tests.test_api_contracts import api_context
from workstep_gateway_protocol import FrameType, ProxyFrame


@pytest.mark.anyio
async def test_project_proxy_artifacts_use_project_relative_paths(api_context, monkeypatch):
    import main

    client, tmp_path = api_context
    projects = []
    for name in ("visible-artifacts", "private-artifacts"):
        directory = tmp_path / name
        directory.mkdir()
        initialized = await client.post("/api/project/init", json={"path": str(directory)})
        assert initialized.status_code == 200
        projects.append((initialized.json()["id"], directory))
    (visible, visible_dir), (private, private_dir) = projects

    def seed(task_id, cwd):
        now = utc_now()
        Task.create(id=task_id, title=task_id, cwd=str(cwd),
                    created_at=now, updated_at=now)

    await main.project_manager.run_db(
        visible, lambda _project: seed("visible-artifact-task", visible_dir)
    )
    await main.project_manager.run_db(
        private, lambda _project: seed("private-artifact-task", private_dir)
    )
    round_dir = (visible_dir / ".workstep" / "artifacts" / "default"
                 / "visible-artifact-task" / "req" / "1")
    round_dir.mkdir(parents=True)
    artifact_file = round_dir / "prd.md"
    artifact_file.write_text("# PRD")
    (round_dir / "manifest.json").write_text(json.dumps({
        "round": 1, "status": "passed", "eligible_for_downstream": True,
        "artifacts": [{"name": "PRD", "path": "prd.md"}],
    }))
    snapshot = {"execution_type": "forward", "ports": [{
        "port": 0, "name": "PRD", "status": "ready", "sources": [
            {"name": "PRD", "path": str(artifact_file)},
            {"name": "Outside", "path": str(private_dir / "secret.md")},
        ],
    }]}

    def seed_snapshot(_project):
        task = Task.get_by_id("visible-artifact-task")
        run = WorkflowRun.create(
            id="artifact-scope-run", task=task, status="succeeded",
            workflow_schema_version=1, workflow_snapshot_json="{}",
        )
        StepRun.create(
            id="artifact-scope-step", run=run, step_key="build", attempt=1,
            artifact_round=1, input_snapshot_json=json.dumps(snapshot),
            status="succeeded",
        )

    await main.project_manager.run_db(visible, seed_snapshot)
    monkeypatch.setattr(main.gateway_client, "managed_config", object())

    async def request(task_id, *, query_project=visible, level="read"):
        frames = []

        async def capture(frame):
            frames.append(frame)

        bridge = ManagedHttpBridge(main.app, "project-artifacts", {
            "method": "GET", "path": f"/api/task/{task_id}/artifacts",
            "query": f"project_id={query_project}", "headers": [],
            "user_id": "worker", "username": "worker", "project_id": visible,
            "access_level": level,
        }, capture, "device-1")
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id="project-artifacts", type=FrameType.http_request,
            payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, timeout=3)
        raw = b"".join(base64.b64decode(frame.payload["data"])
                       for frame in frames if frame.payload.get("phase") == "body")
        return frames[0].payload["status"], json.loads(raw) if raw else None

    assert (await request("visible-artifact-task", query_project=private))[0] == 403
    assert (await request("private-artifact-task"))[0] == 404
    code, listing = await request("visible-artifact-task")
    assert code == 200
    prefix = ".workstep/artifacts/default/visible-artifact-task"
    assert listing["artifact_directory"] == prefix
    assert listing["artifacts"][0]["path"] == f"{prefix}/req/1/prd.md"
    sources = listing["input_snapshots"][0]["ports"][0]["sources"]
    assert sources == [{"name": "PRD", "path": f"{prefix}/req/1/prd.md"}]
    assert str(visible_dir) not in json.dumps(listing)
    assert str(private_dir) not in json.dumps(listing)

    from api import task as task_api

    entered = threading.Event()
    release = threading.Event()
    original = task_api.project_relative_artifact_listing

    def slow_projection(*args):
        entered.set()
        release.wait(2)
        return original(*args)

    monkeypatch.setattr(task_api, "project_relative_artifact_listing", slow_projection)
    pending = asyncio.create_task(request("visible-artifact-task"))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        async with AsyncClient(transport=ASGITransport(app=main.app),
                               base_url="http://test") as health_client:
            health = await asyncio.wait_for(health_client.get("/api/health"), timeout=0.2)
        assert health.status_code == 200
    finally:
        release.set()
        code, _ = await pending
    assert code == 200
