"""Project-only Gateway tickets can edit workflows only in their bound project."""

import asyncio
import base64
import json

import pytest
from fastapi import HTTPException

from schemas.project import UpdateWorkflowRequest
from services.gateway_client.bridge import ManagedHttpBridge
from services.remote_access import ActorSnapshot, actor_context
from tests.test_api_contracts import api_context
from workstep_gateway_protocol import FrameType, ProxyFrame


@pytest.mark.anyio
async def test_project_proxy_workflow_crud_is_project_scoped(api_context, monkeypatch):
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "workflow-scope"
    project_dir.mkdir()
    initialized = await client.post("/api/project/init", json={"path": str(project_dir)})
    assert initialized.status_code == 200
    visible = initialized.json()["id"]
    private_dir = tmp_path / "private-workflow"
    private_dir.mkdir()
    initialized_private = await client.post(
        "/api/project/init", json={"path": str(private_dir)}
    )
    assert initialized_private.status_code == 200
    private = initialized_private.json()["id"]
    private_flow = await client.post(
        f"/api/workflow/create?project_id={private}", json={"name": "Private"}
    )
    assert private_flow.status_code == 200
    private_flow_id = private_flow.json()["id"]
    monkeypatch.setattr(main.gateway_client, "managed_config", object())

    async def request(method, path, body=None, *, query_project=visible, level="edit"):
        frames = []

        async def capture(frame):
            frames.append(frame)

        bridge = ManagedHttpBridge(main.app, "project-workflow", {
            "method": method, "path": path, "query": f"project_id={query_project}",
            "headers": [["content-type", "application/json"]],
            "user_id": "worker", "username": "worker", "project_id": visible,
            "access_level": level,
        }, capture, "device-1")
        bridge.start_task()
        if body is not None:
            await bridge.feed(ProxyFrame(stream_id="project-workflow", type=FrameType.http_request,
                payload={"phase": "body", "data": base64.b64encode(json.dumps(body).encode()).decode()}))
        await bridge.feed(ProxyFrame(stream_id="project-workflow", type=FrameType.http_request,
            payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, timeout=3)
        raw = b"".join(base64.b64decode(frame.payload["data"])
                       for frame in frames if frame.payload.get("phase") == "body")
        return frames[0].payload["status"], json.loads(raw) if raw else None

    assert (await request("GET", "/api/workflow/list", level="read"))[0] == 200
    assert (await request("GET", "/api/workflow/list", query_project=private))[0] == 403
    guessed_path = f"/api/workflow/{private_flow_id}"
    assert (await request("GET", guessed_path))[0] == 404
    assert (await request("PUT", guessed_path, {"name": "Escape"}))[0] == 404
    assert (await request("DELETE", guessed_path))[0] == 404
    create_path = "/api/workflow/create"
    assert (await request("POST", create_path, {"name": "FlowA"}, level="read"))[0] == 403
    assert (await request("POST", create_path, {"name": "FlowA"},
                          query_project=private))[0] == 403
    code, first = await request("POST", create_path, {"name": "FlowA"})
    assert code == 200 and first["name"] == "FlowA"
    code, second = await request("POST", create_path, {"name": "FlowB"})
    assert code == 200 and second["name"] == "FlowB"

    detail_path = f"/api/workflow/{first['id']}"
    assert (await request("GET", detail_path, level="read"))[0] == 200
    assert (await request("GET", detail_path, query_project=private))[0] == 403
    assert (await request("PUT", detail_path, {"name": "Renamed"}, level="read"))[0] == 403
    assert (await request("PUT", detail_path, {"name": "Renamed"},
                          query_project=private))[0] == 403
    code, updated = await request("PUT", detail_path, {"name": "Renamed"})
    assert code == 200 and updated["name"] == "Renamed"

    action_path = detail_path + "/actions"
    action = {"action_id": "start-services", "title": "Start", "script_path": "start.sh",
              "script_content": "#!/bin/sh\necho ready\n", "cwd_mode": "task",
              "require_confirmation": True}
    assert (await request("POST", action_path, action, level="read"))[0] == 403
    assert (await request("POST", action_path, action, query_project=private))[0] == 403
    assert (await request("POST", action_path, action))[0] == 200

    reorder_path = "/api/workflow/reorder"
    order = {"ordered_ids": [second["id"], first["id"]]}
    assert (await request("POST", reorder_path, order, level="read"))[0] == 403
    assert (await request("POST", reorder_path, order, query_project=private))[0] == 403
    assert (await request("POST", reorder_path, order))[0] == 200
    assert (await request("DELETE", detail_path, level="read"))[0] == 403
    assert (await request("DELETE", detail_path, query_project=private))[0] == 403
    assert (await request("DELETE", detail_path))[0] == 200
    restore_path = detail_path + "/restore"
    assert (await request("POST", restore_path, level="read"))[0] == 403
    assert (await request("POST", restore_path, query_project=private))[0] == 403
    code, restored = await request("POST", restore_path)
    assert code == 200 and restored["id"] == first["id"]
    private_after = await main.project_manager.run_db(
        private, lambda project: next(
            workflow for workflow in project.workflows if workflow["id"] == private_flow_id
        )
    )
    assert private_after["name"] == "Private"

    import api.workflow as workflow_api

    actor = ActorSnapshot(actor_id="worker", user_name="worker", device_id="device-1",
                          device_name="Device", source="managed", project_id=visible,
                          access_level="edit")
    with actor_context(actor):
        for call in (
            lambda: workflow_api.list_workflows(pid=private),
            lambda: workflow_api.get_workflow(private_flow_id, pid=private),
            lambda: workflow_api.update_workflow(
                private_flow_id, UpdateWorkflowRequest(name="Escape"), pid=private,
            ),
        ):
            with pytest.raises(HTTPException) as denied:
                await call()
            assert denied.value.status_code == 403
