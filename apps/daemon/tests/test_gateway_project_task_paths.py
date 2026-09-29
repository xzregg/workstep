"""Project ticket task responses do not reveal host working directories."""

import asyncio
import base64
import json

import pytest
from fastapi import HTTPException

from models import Task
from models.fields import utc_now
from services.gateway_client.bridge import ManagedHttpBridge
from services.remote_access import ActorSnapshot, actor_context
from tests.test_api_contracts import api_context
from workstep_gateway_protocol import FrameType, ProxyFrame


@pytest.mark.anyio
async def test_project_task_list_and_detail_hide_host_cwd(api_context, monkeypatch):
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "visible"
    project_dir.mkdir()
    response = await client.post("/api/project/init", json={"path": str(project_dir)})
    assert response.status_code == 200
    project_id = response.json()["id"]

    def seed(_project):
        now = utc_now()
        for task_id, cwd in (
            ("root-task", project_dir),
            ("child-task", project_dir / "src"),
            ("legacy-outside-task", tmp_path / "secret"),
        ):
            Task.create(id=task_id, title=task_id, cwd=str(cwd),
                        created_at=now, updated_at=now)

    await main.project_manager.run_db(project_id, seed)
    private_dir = tmp_path / "private"
    private_dir.mkdir()
    private_response = await client.post("/api/project/init", json={"path": str(private_dir)})
    assert private_response.status_code == 200
    private_id = private_response.json()["id"]
    await main.project_manager.run_db(private_id, lambda _: Task.create(
        id="private-task", title="Private", cwd=str(private_dir),
        created_at=utc_now(), updated_at=utc_now(),
    ))
    local = await client.get(f"/api/task/root-task?project_id={project_id}")
    assert local.status_code == 200
    assert local.json()["cwd"] == str(project_dir)
    monkeypatch.setattr(main.gateway_client, "managed_config", object())

    async def request(path):
        frames = []

        async def capture(frame):
            frames.append(frame)

        bridge = ManagedHttpBridge(main.app, path, {
            "method": "GET", "path": path, "query": f"project_id={project_id}",
            "headers": [], "user_id": "worker", "username": "worker",
            "project_id": project_id, "access_level": "read",
        }, capture, "device-1")
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id=path, type=FrameType.http_request,
                                     payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, timeout=3)
        raw = b"".join(base64.b64decode(frame.payload["data"])
                       for frame in frames if frame.payload.get("phase") == "body")
        assert frames[0].payload["status"] == 200
        return json.loads(raw)

    listing = await request("/api/task/list")
    by_id = {task["id"]: task for task in listing["tasks"]}
    assert by_id["root-task"]["cwd"] == "."
    assert by_id["child-task"]["cwd"] == "src"
    assert by_id["legacy-outside-task"]["cwd"] == ""
    assert str(tmp_path) not in json.dumps(listing)
    detail = await request("/api/task/root-task")
    assert detail["cwd"] == "."
    assert str(tmp_path) not in json.dumps(detail)

    import api.task as task_api

    actor = ActorSnapshot(actor_id="worker", user_name="worker", device_id="device-1",
                          device_name="Device", source="managed", project_id=project_id,
                          access_level="read")
    with actor_context(actor):
        for call in (
            lambda: task_api.list_tasks(pid=private_id),
            lambda: task_api.get_task("private-task", pid=private_id),
            lambda: task_api.get_task_artifacts("private-task", pid=private_id),
        ):
            with pytest.raises(HTTPException) as denied:
                await call()
            assert denied.value.status_code == 403
