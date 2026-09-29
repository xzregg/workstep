"""A project ticket cannot cancel or pause another project's running task."""

import asyncio
import base64
import json
import threading
import time
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient

from models import Task
from models.fields import utc_now
from schemas.task import CoordinatorChatRequest, RunTaskRequest
from services.gateway_client.bridge import ManagedHttpBridge
from services.remote_access import ActorSnapshot, actor_context
from tests.test_api_contracts import api_context
from workstep_gateway_protocol import FrameType, ProxyFrame


@pytest.mark.anyio
async def test_project_proxy_task_actions_are_project_scoped(
    api_context, monkeypatch,
):
    import main

    client, tmp_path = api_context
    project_ids = []
    for name in ("visible-task", "private-task"):
        project_dir = tmp_path / name
        project_dir.mkdir()
        initialized = await client.post("/api/project/init", json={"path": str(project_dir)})
        assert initialized.status_code == 200
        project_ids.append(initialized.json()["id"])
    visible, private = project_ids

    def seed(task_id, cwd):
        now = utc_now()
        Task.create(id=task_id, title=task_id, cwd=str(cwd),
                    created_at=now, updated_at=now)

    await main.project_manager.run_db(
        visible, lambda _project: seed("visible-task-id", tmp_path / "visible-task")
    )
    await main.project_manager.run_db(
        private, lambda _project: seed("private-task-id", tmp_path / "private-task")
    )
    cancel = AsyncMock(return_value=True)
    monkeypatch.setattr(main.workflow_runtime, "cancel", cancel)
    monkeypatch.setattr(main.gateway_client, "managed_config", object())

    async def request(path, task_id, *, method="POST", query_project=visible,
                      level="edit", body=None, extra_headers=None):
        frames = []

        async def capture(frame):
            frames.append(frame)

        bridge = ManagedHttpBridge(main.app, "project-task-action", {
            "method": method, "path": path, "query": f"project_id={query_project}",
            "headers": [["content-type", "application/json"], *(extra_headers or [])],
            "user_id": "worker", "username": "worker", "project_id": visible,
            "access_level": level,
        }, capture, "device-1")
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id="project-task-action", type=FrameType.http_request,
            payload={"phase": "body", "data": base64.b64encode(json.dumps(
                {"task_id": task_id} if body is None else body,
            ).encode()).decode()}))
        await bridge.feed(ProxyFrame(stream_id="project-task-action", type=FrameType.http_request,
            payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, timeout=3)
        return frames[0].payload["status"]

    for path in ("/api/task/cancel", "/api/task/pause"):
        assert await request(path, "private-task-id") == 404
        assert await request(path, "visible-task-id", query_project=private) == 403
        assert await request(path, "visible-task-id", level="read") == 403
        assert await request(path, "visible-task-id") == 200
    assert cancel.await_count == 2

    live_message = AsyncMock(return_value={"message_id": "message-1", "status": "queued"})
    monkeypatch.setattr(main.workflow_runtime, "send_step_message", live_message)
    private_step = "/api/task/private-task-id/step/dev/message"
    visible_step = "/api/task/visible-task-id/step/dev/message"
    assert await request(private_step, "private-task-id", body={"content": "escape"}) == 404
    assert await request(visible_step, "visible-task-id", body={"content": "hello"}) == 200
    live_message.assert_awaited_once()

    update_config = AsyncMock(return_value={"engine": "claude"})
    reset_config = AsyncMock(return_value={"engine": "claude"})
    update_coordinator = AsyncMock(return_value={"engine": "claude"})
    monkeypatch.setattr(main.workflow_runtime, "update_step_execution_config", update_config)
    monkeypatch.setattr(main.workflow_runtime, "reset_step_execution_config", reset_config)
    monkeypatch.setattr(main.coordinator_module, "update_config", update_coordinator)
    for method, suffix, body in (
        ("PATCH", "", {"description": "Updated"}),
        ("PATCH", "/scheduled-start", {"scheduled_start_at": None}),
        ("PATCH", "/coordinator-config", {"engine": "claude"}),
        ("PATCH", "/step/dev/config", {"engine": "claude"}),
        ("DELETE", "/step/dev/config", {}),
    ):
        private_path = f"/api/task/private-task-id{suffix}"
        visible_path = f"/api/task/visible-task-id{suffix}"
        assert await request(visible_path, "visible-task-id", method=method,
                             body=body, level="read") == 403
        assert await request(visible_path, "visible-task-id", method=method,
                             body=body, query_project=private) == 403
        assert await request(private_path, "private-task-id", method=method,
                             body=body) == 404
        assert await request(visible_path, "visible-task-id", method=method,
                             body=body) == 200
    update_config.assert_awaited_once()
    reset_config.assert_awaited_once()
    update_coordinator.assert_awaited_once()

    stop_coordinator = AsyncMock(return_value=True)
    cancel_step = AsyncMock(return_value=True)
    resume_step = AsyncMock(return_value={"status": "queued"})
    restart_step = AsyncMock(return_value={"status": "queued"})
    retry_message = AsyncMock(return_value={"status": "queued"})
    complete_message = AsyncMock(return_value=None)
    monkeypatch.setattr(main.coordinator_module, "stop_current", stop_coordinator)
    monkeypatch.setattr(main.workflow_runtime, "cancel_step", cancel_step)
    monkeypatch.setattr(main.workflow_runtime, "resume_step_with_message", resume_step)
    monkeypatch.setattr(main.workflow_runtime, "restart_step_with_fresh_session", restart_step)
    monkeypatch.setattr(main.workflow_runtime, "retry_failed_message", retry_message)
    monkeypatch.setattr(main.workflow_runtime, "complete_failed_step", complete_message)
    for suffix, body in (
        ("/coordinator/stop", {}),
        ("/step/dev/cancel", {}),
        ("/step/dev/resume", {"content": "Continue"}),
        ("/step/dev/restart", {}),
        ("/messages/message-1/retry", {}),
        ("/messages/message-1/set-complete", {
            "artifact_round": 1, "schedule_downstream": False,
        }),
    ):
        private_path = f"/api/task/private-task-id{suffix}"
        visible_path = f"/api/task/visible-task-id{suffix}"
        assert await request(visible_path, "visible-task-id", body=body,
                             level="read") == 403
        assert await request(visible_path, "visible-task-id", body=body,
                             query_project=private) == 403
        assert await request(private_path, "private-task-id", body=body) == 404
        assert await request(visible_path, "visible-task-id", body=body) == 200
    for operation in (stop_coordinator, cancel_step, resume_step, restart_step,
                      retry_message, complete_message):
        operation.assert_awaited_once()

    review_history = "/api/task/visible-task-id/reviews"
    assert await request(review_history, "visible-task-id", method="GET",
                         level="read") == 200
    assert await request("/api/task/private-task-id/reviews", "private-task-id",
                         method="GET") == 404
    decide_review = AsyncMock(return_value=None)
    monkeypatch.setattr(main.workflow_runtime, "decide_review", decide_review)
    for decision in ("approve", "reject", "force-approve", "terminate",
                     "complete-task", "set-complete"):
        suffix = f"/steps/dev/review/{decision}"
        body = {"review_run_id": "review-1", "schedule_downstream": False}
        assert await request(f"/api/task/visible-task-id{suffix}", "visible-task-id",
                             body=body, level="read") == 403
        assert await request(f"/api/task/visible-task-id{suffix}", "visible-task-id",
                             body=body, query_project=private) == 403
        assert await request(f"/api/task/private-task-id{suffix}", "private-task-id",
                             body=body) == 404
        assert await request(f"/api/task/visible-task-id{suffix}", "visible-task-id",
                             body=body) == 200
    assert decide_review.await_count == 6

    confirm_action = AsyncMock(return_value={"status": "confirmed"})
    cancel_action = AsyncMock(return_value={"status": "cancelled"})
    monkeypatch.setattr(main.coordinator_module, "confirm_action", confirm_action)
    monkeypatch.setattr(main.coordinator_module, "cancel_action", cancel_action)
    for action in ("confirm", "cancel"):
        suffix = f"/actions/proposal-1/{action}"
        headers = [["idempotency-key", "proposal-1"]]
        assert await request(f"/api/task/visible-task-id{suffix}", "visible-task-id",
                             body={}, extra_headers=headers, level="read") == 403
        assert await request(f"/api/task/visible-task-id{suffix}", "visible-task-id",
                             body={}, extra_headers=headers, query_project=private) == 403
        assert await request(f"/api/task/private-task-id{suffix}", "private-task-id",
                             body={}, extra_headers=headers) == 404
        assert await request(f"/api/task/visible-task-id{suffix}", "visible-task-id",
                             body={}, extra_headers=headers) == 200
    confirm_action.assert_awaited_once()
    cancel_action.assert_awaited_once()

    import api.task as task_api

    start_run = AsyncMock()
    monkeypatch.setattr(main.workflow_runtime, "start", start_run)
    actor = ActorSnapshot(actor_id="worker", user_name="worker", device_id="device-1",
                          device_name="Device", source="managed", project_id=visible,
                          access_level="edit")
    with actor_context(actor), pytest.raises(HTTPException) as denied:
        await task_api.run_task(
            RunTaskRequest(task_id="private-task-id", prompt="escape"), pid=private,
        )
    assert denied.value.status_code == 403
    start_run.assert_not_awaited()

    submit_coordinator = AsyncMock()
    monkeypatch.setattr(main.coordinator_module, "submit_message", submit_coordinator)
    with actor_context(actor), pytest.raises(HTTPException) as denied:
        await task_api.chat_with_coordinator(
            "private-task-id", CoordinatorChatRequest(content="escape"),
            pid=private, idempotency_key="scope-check",
        )
    assert denied.value.status_code == 403
    submit_coordinator.assert_not_awaited()

    from api import task_context

    entered = threading.Event()
    run_db = task_context._run_db

    async def slow_scope_lookup(project_id, operation):
        def delayed_operation():
            entered.set()
            time.sleep(0.7)
            return operation()

        return await run_db(project_id, delayed_operation)

    monkeypatch.setattr(task_context, "_run_db", slow_scope_lookup)
    pending = asyncio.create_task(request("/api/task/cancel", "private-task-id"))
    assert await asyncio.to_thread(entered.wait, 2)
    started = time.monotonic()
    async with AsyncClient(transport=ASGITransport(app=main.app),
                           base_url="http://test") as health_client:
        assert (await health_client.get("/api/health")).status_code == 200
    assert time.monotonic() - started < 0.5
    assert await pending == 404
