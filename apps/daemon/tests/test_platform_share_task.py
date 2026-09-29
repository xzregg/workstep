"""The managed share route is task scoped and keeps Peewee off the event loop."""

import asyncio
import base64
import hashlib
import json
import threading
import time

import pytest

from services.gateway_client.bridge import ManagedHttpBridge
from tests.test_api_contracts import _create_test_workflow, api_context
from tests.test_gateway_share_ticket import _ticket
from workstep_gateway_protocol import FrameType, ProxyFrame


@pytest.mark.anyio
async def test_platform_share_task_read_scope_and_slow_db_health(api_context, monkeypatch):
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "shared-task"
    project_dir.mkdir()
    project_id = (await client.post("/api/project/init", json={
        "path": str(project_dir),
    })).json()["id"]
    workflow_id = (await _create_test_workflow(client, project_id))["id"]
    created = await client.post(f"/api/task/create?project_id={project_id}", json={
        "title": "Visible title", "description": "Visible description",
        "workflow_id": workflow_id, "auto_start": False,
    })
    assert created.status_code == 200, created.text
    task_id = created.json()["id"]
    monkeypatch.setattr(main.gateway_client, "managed_config", object())
    ticket, key, fingerprint = _ticket(task_id=task_id,
                                       host_project_id=project_id)

    entered = threading.Event()
    project = main.project_manager.get_project_by_id(project_id)
    original_execute = project.db.execute_sql

    def slow_execute(sql, *args, **kwargs):
        if sql.lstrip().upper().startswith("SELECT") and '"tasks"' in sql:
            entered.set()
            time.sleep(0.7)
        return original_execute(sql, *args, **kwargs)

    monkeypatch.setattr(project.db, "execute_sql", slow_execute)

    async def request_share(credential):
        frames = []

        async def capture(frame):
            frames.append(frame)

        bridge = ManagedHttpBridge(main.app, "share-task", {
            "method": "GET", "path": "/api/platform-share/task", "query": "",
            "headers": [], "share_ticket": credential,
        }, capture, "device-1", gateway_key=key,
            gateway_fingerprint=fingerprint, gateway_id="gateway-1")
        bridge.start_task()
        await bridge.feed(ProxyFrame(
            stream_id="share-task", type=FrameType.http_request,
            payload={"phase": "end"},
        ))
        await asyncio.wait_for(bridge._task, timeout=3)
        body = b"".join(base64.b64decode(frame.payload["data"])
                        for frame in frames if frame.payload.get("phase") == "body")
        return frames[0].payload["status"], json.loads(body) if body else None

    pending = asyncio.create_task(request_share(ticket))
    assert await asyncio.to_thread(entered.wait, 2)
    started = time.monotonic()
    health = await client.get("/api/health")
    assert health.status_code == 200
    assert time.monotonic() - started < 0.5
    status, body = await pending
    assert status == 200
    assert body["id"] == task_id
    assert body["title"] == "Visible title"
    assert body["description"] == "Visible description"
    assert "cwd" not in body
    assert "engine" not in body
    assert body["steps"]
    assert all(set(step) == {"step_key", "status", "has_history"}
               for step in body["steps"])


@pytest.mark.anyio
async def test_platform_share_interaction_requires_mode_and_stays_on_ticket_task(api_context, monkeypatch):
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "interactive-share"
    project_dir.mkdir()
    project_id = (await client.post("/api/project/init", json={
        "path": str(project_dir),
    })).json()["id"]
    workflow_id = (await _create_test_workflow(client, project_id))["id"]
    created = await client.post(f"/api/task/create?project_id={project_id}", json={
        "title": "Interactive", "workflow_id": workflow_id, "auto_start": False,
    })
    task_id = created.json()["id"]
    monkeypatch.setattr(main.gateway_client, "managed_config", object())
    calls = []

    class Runtime:
        async def send_step_message(self, pid, tid, step, content):
            calls.append(("message", pid, tid, step, content))
            await asyncio.sleep(0.7)
            return {"message_id": "sent-1"}

        async def resume_step_with_message(self, pid, tid, step, content):
            calls.append(("resume", pid, tid, step, content))
            return {"message_id": "sent-2"}

        async def cancel_step(self, pid, tid, step):
            calls.append(("cancel", pid, tid, step))
            return True

    monkeypatch.setattr(main, "workflow_runtime", Runtime())

    async def write(path, mode="interactive", body=None, method="POST"):
        ticket, key, fingerprint = _ticket(task_id=task_id,
            host_project_id=project_id, mode=mode)
        frames = []
        async def capture(frame):
            frames.append(frame)
        bridge = ManagedHttpBridge(main.app, "share-write", {
            "method": method, "path": path, "query": "",
            "headers": [["content-type", "application/json"]],
            "share_ticket": ticket,
        }, capture, "device-1", gateway_key=key,
            gateway_fingerprint=fingerprint, gateway_id="gateway-1")
        bridge.start_task()
        if body is not None:
            await bridge.feed(ProxyFrame(stream_id="share-write", type=FrameType.http_request,
                payload={"phase": "body", "data": base64.b64encode(
                    json.dumps(body).encode()).decode()}))
        await bridge.feed(ProxyFrame(stream_id="share-write", type=FrameType.http_request,
                                     payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, timeout=3)
        response = b"".join(base64.b64decode(frame.payload["data"])
                            for frame in frames if frame.payload.get("phase") == "body")
        return frames[0].payload["status"], json.loads(response) if response else None

    route = "/api/platform-share/steps/build/message"
    assert (await write(route, "read_only", {"content": "hello"}))[0] == 403
    assert calls == []
    pending = asyncio.create_task(write(route, body={"content": "hello"}))
    await asyncio.sleep(0.05)
    started = time.monotonic()
    assert (await client.get("/api/health")).status_code == 200
    assert time.monotonic() - started < 0.5
    assert (await pending)[0] == 200
    assert calls[0] == ("message", project_id, task_id, "build", "hello")
    assert (await write("/api/platform-share/steps/build/resume",
                        body={"content": "again"}))[0] == 200
    assert (await write("/api/platform-share/steps/build/cancel"))[0] == 200
    assert calls[1:] == [("resume", project_id, task_id, "build", "again"),
                         ("cancel", project_id, task_id, "build")]
    assert (await write("/api/platform-share/steps/../message",
                        body={"content": "escape"}))[0] == 403

    from services.intervention import intervention_manager
    visible = asyncio.create_task(intervention_manager.request_response(
        "visible-interaction", task_id, "build", {
            "method": "session/request_permission", "options": [{
                "option_id": "allow_once", "name": "Allow once",
            }],
        },
    ))
    private = asyncio.create_task(intervention_manager.request_response(
        "private-interaction", "other-task", "build", {
            "method": "elicitation/create", "message": "Private question",
        },
    ))
    await asyncio.sleep(0)
    assert (await write("/api/platform-share/interventions", mode="read_only",
                        method="GET"))[0] == 403
    status, listing = await write("/api/platform-share/interventions", method="GET")
    assert status == 200
    assert [item["interaction_id"] for item in listing["interventions"]] == ["visible-interaction"]
    assert "Private question" not in json.dumps(listing)
    assert (await write("/api/platform-share/interventions/private-interaction/respond",
                        body={"data": {"action": "cancel"}}))[0] == 404
    assert (await write("/api/platform-share/interventions/visible-interaction/respond",
                        mode="read_only", body={"data": {"action": "cancel"}}))[0] == 403
    status, delivered = await write(
        "/api/platform-share/interventions/visible-interaction/respond",
        body={"data": {"outcome": {"outcome": "selected", "option_id": "allow_once"}}},
    )
    assert status == 200 and delivered == {"delivered": True}
    assert await visible == {"outcome": {"outcome": "selected", "option_id": "allow_once"}}
    intervention_manager.cancel("private-interaction")
    await private


@pytest.mark.anyio
async def test_platform_share_review_is_task_scoped_and_slow_sql_keeps_health(api_context, monkeypatch):
    import main
    from models import ReviewRun, StepRun, WorkflowRun
    from models.fields import utc_now

    client, tmp_path = api_context
    project_dir = tmp_path / "review-share"
    project_dir.mkdir()
    project_id = (await client.post("/api/project/init", json={
        "path": str(project_dir),
    })).json()["id"]
    workflow_id = (await _create_test_workflow(client, project_id))["id"]
    task_ids = []
    for title in ("Visible review", "Private review"):
        created = await client.post(f"/api/task/create?project_id={project_id}", json={
            "title": title, "workflow_id": workflow_id, "auto_start": False,
        })
        task_ids.append(created.json()["id"])

    def seed(_project):
        for index, task_id in enumerate(task_ids):
            run = WorkflowRun.create(id=f"review-run-{index}", task=task_id,
                                     workflow_schema_version=1)
            step = StepRun.create(id=f"review-step-{index}", run=run,
                                  step_key="build", attempt=1)
            ReviewRun.create(id=f"review-{index}", workflow_run=run, step_run=step,
                             task=task_id, step_key="build", mode="manual", status="pending",
                             report_json=json.dumps({"summary": f"summary-{index}"}),
                             started_at=utc_now())

    await main.project_manager.run_db(project_id, seed)
    monkeypatch.setattr(main.gateway_client, "managed_config", object())
    calls = []

    class Runtime:
        async def decide_review(self, pid, tid, step, review, decision, comment):
            calls.append((pid, tid, step, review, decision, comment))
            return None

    monkeypatch.setattr(main, "workflow_runtime", Runtime())

    async def request(path, *, method="GET", mode="interactive", body=None):
        ticket, key, fingerprint = _ticket(task_id=task_ids[0],
            host_project_id=project_id, mode=mode)
        frames = []
        async def capture(frame):
            frames.append(frame)
        bridge = ManagedHttpBridge(main.app, "share-review", {
            "method": method, "path": path, "query": "",
            "headers": [["content-type", "application/json"]],
            "share_ticket": ticket,
        }, capture, "device-1", gateway_key=key,
            gateway_fingerprint=fingerprint, gateway_id="gateway-1")
        bridge.start_task()
        if body is not None:
            await bridge.feed(ProxyFrame(stream_id="share-review", type=FrameType.http_request,
                payload={"phase": "body", "data": base64.b64encode(
                    json.dumps(body).encode()).decode()}))
        await bridge.feed(ProxyFrame(stream_id="share-review", type=FrameType.http_request,
                                     payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, timeout=3)
        content = b"".join(base64.b64decode(frame.payload["data"])
                           for frame in frames if frame.payload.get("phase") == "body")
        return frames[0].payload["status"], json.loads(content) if content else None

    project = main.project_manager.get_project_by_id(project_id)
    original_execute = project.db.execute_sql
    entered = threading.Event()

    def slow_execute(sql, *args, **kwargs):
        if sql.lstrip().upper().startswith("SELECT") and '"review_runs"' in sql:
            entered.set()
            time.sleep(0.7)
        return original_execute(sql, *args, **kwargs)

    monkeypatch.setattr(project.db, "execute_sql", slow_execute)
    pending = asyncio.create_task(request("/api/platform-share/reviews"))
    assert await asyncio.to_thread(entered.wait, 2)
    started = time.monotonic()
    assert (await client.get("/api/health")).status_code == 200
    assert time.monotonic() - started < 0.5
    status, reviews = await pending
    assert status == 200
    assert [review["id"] for review in reviews["reviews"]] == ["review-0"]
    assert "summary-1" not in json.dumps(reviews)

    route = "/api/platform-share/steps/build/review/approve"
    assert (await request(route, method="POST", mode="read_only",
                          body={"review_run_id": "review-0"}))[0] == 403
    assert (await request(route, method="POST",
                          body={"review_run_id": "review-1"}))[0] == 404
    status, result = await request(route, method="POST",
                                   body={"review_run_id": "review-0", "comment": "Looks good"})
    assert status == 200 and result["decision"] == "approve"
    assert calls == [(project_id, task_ids[0], "build", "review-0", "approve", "Looks good")]


@pytest.mark.anyio
async def test_platform_share_history_excludes_private_channel_and_slow_sql(api_context, monkeypatch):
    import main
    from models import Message
    from models.fields import utc_now

    client, tmp_path = api_context
    project_dir = tmp_path / "shared-history"
    project_dir.mkdir()
    project_id = (await client.post("/api/project/init", json={
        "path": str(project_dir),
    })).json()["id"]
    workflow_id = (await _create_test_workflow(client, project_id))["id"]
    created = await client.post(f"/api/task/create?project_id={project_id}", json={
        "title": "Shared history", "workflow_id": workflow_id, "auto_start": False,
    })
    assert created.status_code == 200
    task_id = created.json()["id"]

    def seed(_project):
        for index, channel, content in ((1, "execution", "Visible message"),
                                        (2, "coordinator", "Private planning")):
            Message.create(id=f"message-{index}", task=task_id, step_key="step-1",
                           channel=channel, sequence=index, position=index,
                           role="assistant", content=content, created_at=utc_now())

    await main.project_manager.run_db(project_id, seed)
    monkeypatch.setattr(main.gateway_client, "managed_config", object())
    ticket, key, fingerprint = _ticket(task_id=task_id, host_project_id=project_id)
    project = main.project_manager.get_project_by_id(project_id)
    original_execute = project.db.execute_sql
    entered = threading.Event()

    def slow_execute(sql, *args, **kwargs):
        if sql.lstrip().upper().startswith("SELECT") and '"message"' in sql:
            entered.set()
            time.sleep(0.7)
        return original_execute(sql, *args, **kwargs)

    monkeypatch.setattr(project.db, "execute_sql", slow_execute)

    async def read_history():
        frames = []

        async def capture(frame):
            frames.append(frame)

        bridge = ManagedHttpBridge(main.app, "share-history", {
            "method": "GET", "path": "/api/platform-share/history", "query": "",
            "headers": [], "share_ticket": ticket,
        }, capture, "device-1", gateway_key=key,
            gateway_fingerprint=fingerprint, gateway_id="gateway-1")
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id="share-history", type=FrameType.http_request,
                                     payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, timeout=3)
        body = b"".join(base64.b64decode(frame.payload["data"])
                        for frame in frames if frame.payload.get("phase") == "body")
        return frames[0].payload["status"], json.loads(body) if body else None

    pending = asyncio.create_task(read_history())
    assert await asyncio.to_thread(entered.wait, 2)
    started = time.monotonic()
    assert (await client.get("/api/health")).status_code == 200
    assert time.monotonic() - started < 0.5
    status, body = await pending
    assert status == 200
    assert [item["content"] for item in body["messages"]] == ["Visible message"]
    assert "Private planning" not in json.dumps(body)


@pytest.mark.anyio
async def test_platform_share_history_pages_execution_messages(api_context, monkeypatch):
    import main
    from models import Message
    from models.fields import utc_now

    client, tmp_path = api_context
    project_dir = tmp_path / "paged-history"
    project_dir.mkdir()
    project_id = (await client.post("/api/project/init", json={
        "path": str(project_dir),
    })).json()["id"]
    workflow_id = (await _create_test_workflow(client, project_id))["id"]
    created = await client.post(f"/api/task/create?project_id={project_id}", json={
        "title": "Paged history", "workflow_id": workflow_id, "auto_start": False,
    })
    task_id = created.json()["id"]

    def seed(_project):
        for index in range(105):
            Message.create(id=f"page-{index}", task=task_id, step_key="build",
                           channel="execution", sequence=index + 1, position=index + 1,
                           role="assistant", content=f"message-{index}",
                           events_json=(json.dumps([{"type": "agent_message_chunk",
                               "data": {"content": {"text": f"visible event {event_index}"}}}
                               for event_index in range(105)])
                               if index == 100 else None),
                           created_at=utc_now())
        Message.create(id="private-page", task=task_id, step_key="build",
                       channel="coordinator", sequence=106, position=106,
                       role="assistant", content="private",
                       events_json=json.dumps([{"type": "agent_message_chunk",
                           "data": {"content": {"text": "private event"}}}]),
                       created_at=utc_now())

    await main.project_manager.run_db(project_id, seed)
    monkeypatch.setattr(main.gateway_client, "managed_config", object())
    ticket, key, fingerprint = _ticket(task_id=task_id, host_project_id=project_id)

    async def read(path):
        frames = []
        async def capture(frame):
            frames.append(frame)
        bridge = ManagedHttpBridge(main.app, "page-history", {
            "method": "GET", "path": path, "query": "", "headers": [],
            "share_ticket": ticket,
        }, capture, "device-1", gateway_key=key,
            gateway_fingerprint=fingerprint, gateway_id="gateway-1")
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id="page-history", type=FrameType.http_request,
                                     payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, timeout=3)
        body = b"".join(base64.b64decode(frame.payload["data"])
                        for frame in frames if frame.payload.get("phase") == "body")
        return frames[0].payload["status"], json.loads(body) if body else None

    status, first = await read("/api/platform-share/history")
    assert status == 200
    assert len(first["messages"]) == 100
    assert first["messages"][0]["content"] == "message-5"
    assert first["next_offset"] == 100
    status, older = await read("/api/platform-share/history/100")
    assert status == 200
    assert [item["content"] for item in older["messages"]] == [
        f"message-{index}" for index in range(5)
    ]
    assert older["next_offset"] is None
    assert (await read("/api/platform-share/history/1000000"))[0] == 403
    status, detail = await read("/api/platform-share/events/page-100/0")
    assert status == 200
    assert len(detail["events"]) == 100
    assert detail["events"][0]["type"] == "TEXT_MESSAGE_CHUNK"
    assert detail["next_cursor"] == 100
    status, final_events = await read("/api/platform-share/events/page-100/100")
    assert status == 200
    assert len(final_events["events"]) == 5
    assert final_events["next_cursor"] is None
    assert (await read("/api/platform-share/events/private-page/0"))[0] == 404

    from services import history as history_service
    original_events = history_service.get_message_events
    entered = threading.Event()

    def slow_events(*args, **kwargs):
        entered.set()
        time.sleep(0.7)
        return original_events(*args, **kwargs)

    monkeypatch.setattr(history_service, "get_message_events", slow_events)
    pending = asyncio.create_task(read("/api/platform-share/events/page-100/0"))
    assert await asyncio.to_thread(entered.wait, 2)
    started = time.monotonic()
    assert (await client.get("/api/health")).status_code == 200
    assert time.monotonic() - started < 0.5
    assert (await pending)[0] == 200


@pytest.mark.anyio
async def test_platform_share_artifacts_are_task_scoped_and_hide_host_paths(api_context, monkeypatch):
    import main

    client, tmp_path = api_context
    project_dir = tmp_path / "shared-artifacts"
    project_dir.mkdir()
    project_id = (await client.post("/api/project/init", json={
        "path": str(project_dir),
    })).json()["id"]
    workflow_id = (await _create_test_workflow(client, project_id))["id"]
    task_ids = []
    for title in ("Shared", "Private"):
        created = await client.post(f"/api/task/create?project_id={project_id}", json={
            "title": title, "workflow_id": workflow_id, "auto_start": False,
        })
        task_ids.append(created.json()["id"])
    root = project_dir / ".workstep" / "artifacts" / workflow_id
    for task_id, content in zip(task_ids, ("visible bytes", "private bytes")):
        directory = root / task_id / "build"
        directory.mkdir(parents=True)
        (directory / "result.txt").write_text(content)
    monkeypatch.setattr(main.gateway_client, "managed_config", object())
    ticket, key, fingerprint = _ticket(task_id=task_ids[0], host_project_id=project_id)

    async def read(path, credential=ticket):
        frames = []
        async def capture(frame):
            frames.append(frame)
        bridge = ManagedHttpBridge(main.app, "share-artifacts", {
            "method": "GET", "path": path, "query": "", "headers": [],
            "share_ticket": credential,
        }, capture, "device-1", gateway_key=key,
            gateway_fingerprint=fingerprint, gateway_id="gateway-1")
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id="share-artifacts", type=FrameType.http_request,
                                     payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, timeout=3)
        body = b"".join(base64.b64decode(frame.payload["data"])
                        for frame in frames if frame.payload.get("phase") == "body")
        return frames[0].payload["status"], body

    status, body = await read("/api/platform-share/artifacts")
    assert status == 200
    assert str(project_dir).encode() not in body
    artifacts = json.loads(body)["artifacts"]
    assert len(artifacts) == 1
    artifact_id = artifacts[0]["id"]
    assert artifacts[0]["name"] == "result.txt"
    status, body = await read(f"/api/platform-share/artifacts/{artifact_id}/content")
    assert status == 200 and body == b"visible bytes"
    private_relative = f"{workflow_id}/{task_ids[1]}/build/result.txt"
    private_id = hashlib.sha256(private_relative.encode()).hexdigest()
    assert (await read(f"/api/platform-share/artifacts/{private_id}/content"))[0] == 404
    assert (await read("/api/platform-share/artifacts", ticket + "x"))[0] != 200

    from services import artifacts as artifact_service
    original_list = artifact_service.list_task_artifacts
    entered = threading.Event()

    def slow_list(project, task_id):
        entered.set()
        time.sleep(0.7)
        return original_list(project, task_id)

    monkeypatch.setattr(artifact_service, "list_task_artifacts", slow_list)
    pending = asyncio.create_task(read("/api/platform-share/artifacts"))
    assert await asyncio.to_thread(entered.wait, 2)
    started = time.monotonic()
    assert (await client.get("/api/health")).status_code == 200
    assert time.monotonic() - started < 0.5
    assert (await pending)[0] == 200
