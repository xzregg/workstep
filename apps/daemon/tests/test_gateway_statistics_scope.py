"""Shared statistics enforce project and authenticated account scope."""
import asyncio
import base64
import json
import threading

import pytest

from models import Task, ChatSession, ChatMessage
from models.fields import utc_now
from services.gateway_client.bridge import ManagedHttpBridge
from tests.test_api_contracts import api_context
from workstep_gateway_protocol import FrameType, ProxyFrame


@pytest.mark.anyio
async def test_shared_statistics_self_scope_and_slow_sql(api_context, monkeypatch):
    import main
    import api.statistics as statistics_api
    monkeypatch.setattr(statistics_api, "project_manager", main.project_manager)

    client, tmp_path = api_context
    directory = tmp_path / "shared"
    directory.mkdir()
    response = await client.post("/api/project/init", json={"path": str(directory)})
    project_id = response.json()["id"]

    def seed(project):
        now = utc_now()
        session = ChatSession.create(id="chat", project_id=project_id, workflow_id="",
            title="Chat", engine="codex", created_at=now, updated_at=now)
        for user, tokens in (("worker", 10), ("other", 900), (None, 800)):
            Task.create(id=f"task-{user}", title="Task", cwd=str(directory),
                creator_id=user, created_at=now, updated_at=now)
            ChatMessage.create(id=f"message-{user}", session=session, role="assistant",
                content="done", status="succeeded", author_type="assistant",
                initiated_by_user_id=user, usage_json=json.dumps({"total_tokens": tokens}),
                created_at=now)
    await main.project_manager.run_db(project_id, seed)
    monkeypatch.setattr(main.gateway_client, "managed_config", object())

    async def request(query, path="/api/statistics/overview"):
        frames = []
        async def capture(frame):
            frames.append(frame)
        bridge = ManagedHttpBridge(main.app, "stats", {
            "method": "GET", "path": path, "query": query, "headers": [],
            "user_id": "worker", "username": "worker", "project_id": project_id,
            "access_level": "read",
        }, capture, "device-1")
        bridge.start_task()
        await bridge.feed(ProxyFrame(stream_id="stats", type=FrameType.http_request,
                                     payload={"phase": "end"}))
        await asyncio.wait_for(bridge._task, timeout=5)
        raw = b"".join(base64.b64decode(frame.payload["data"])
                       for frame in frames if frame.payload.get("phase") == "body")
        return frames[0].payload["status"], json.loads(raw)

    query = f"project_id={project_id}&range=7d"
    status, report = await request(query)
    assert status == 200
    assert report["summary"]["task_count"] == 1
    assert report["summary"]["total_tokens"] == 10
    assert {row["author_id"] for row in report["users"]} == {"worker"}
    for invalid in ("", "project_id=private", query + "&actor_id=other", query + "&user_id=other"):
        assert (await request(invalid))[0] == 403
    assert (await request(f"project_id={project_id}", "/api/statistics/system"))[0] == 403
    monkeypatch.setattr(main.gateway_client, "managed_config", None)
    local = await client.get("/api/statistics/overview", params={"project_id": project_id})
    assert local.status_code == 200
    assert local.json()["summary"]["total_tokens"] == 1710

    monkeypatch.setattr(main.gateway_client, "managed_config", object())
    entered, release = threading.Event(), threading.Event()
    project = main.project_manager.get_project_by_id(project_id)
    execute = project.db.execute_sql
    def slow_sql(sql, params=None, *args, **kwargs):
        if 'FROM "tasks"' in sql:
            entered.set()
            assert release.wait(3)
        return execute(sql, params, *args, **kwargs)
    monkeypatch.setattr(project.db, "execute_sql", slow_sql)
    pending = asyncio.create_task(request(query))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        health = await asyncio.wait_for(client.get("/api/health"), timeout=.5)
        assert health.status_code == 200
        assert not pending.done()
    finally:
        release.set()
    assert (await pending)[0] == 200
