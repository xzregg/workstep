"""Project-local audit records preserve actors without message content."""

import json
import asyncio
import threading
import time
import sqlite3

import pytest
from httpx import ASGITransport, AsyncClient
from fastapi import HTTPException
from starlette.requests import Request

from models import init_db
from services.remote_access import ActorSnapshot, actor_context


def test_project_audit_keeps_actor_and_initiator_snapshot(tmp_path):
    from models import ProjectAuditEvent
    from services.project_audit import record_project_audit

    db = init_db(str(tmp_path / "workstep.db"))
    try:
        actor = ActorSnapshot(
            actor_id="user-1", username="alice", user_name="Alice Display",
            device_id="device-1", device_name="Laptop", source="managed",
        )
        with actor_context(actor):
            first = record_project_audit(
                project_id="project-1", task_id="task-1",
                action="task.start", result="succeeded", mode="managed",
                metadata={"source": "manual"}, event_id="audit-1",
            )
            second = record_project_audit(
                project_id="project-1", task_id="task-1",
                action="task.start", result="succeeded", mode="managed",
                metadata={"source": "manual"}, event_id="audit-1",
            )
        assert first.id == second.id == "audit-1"
        assert ProjectAuditEvent.select().count() == 1
        assert (first.actor_id, first.actor_username, first.actor_name,
                first.actor_type, first.device_id) == (
                    "user-1", "alice", "Alice Display", "user", "device-1",
                )
        assert (first.initiated_by_user_id, first.initiated_by_username) == (
            "user-1", "alice",
        )
        assert json.loads(first.metadata_json) == {"source": "manual"}
    finally:
        db.close()


@pytest.mark.anyio
async def test_project_audit_api_uses_db_executor_and_keeps_health_responsive(
    tmp_path, monkeypatch,
):
    import main
    from services.project import ProjectManager
    from services.project_audit import record_project_audit

    manager = ProjectManager()
    project = manager.init_project(tmp_path / "project")
    monkeypatch.setattr(main, "project_manager", manager)
    await manager.run_db(project.id, lambda _project: record_project_audit(
        project_id=project.id, action="task.start", result="succeeded",
        task_id="task-1", event_id="audit-api",
    ))
    original = project.db.execute_sql
    entered = threading.Event()

    def slow_audit_query(sql, *args, **kwargs):
        if 'FROM "project_audit_events"' in sql and not entered.is_set():
            entered.set()
            time.sleep(0.8)
        return original(sql, *args, **kwargs)

    monkeypatch.setattr(project.db, "execute_sql", slow_audit_query)
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        audit = asyncio.create_task(client.get(
            "/api/project-audit", params={"project_id": project.id},
        ))
        assert await asyncio.to_thread(entered.wait, 2)
        before = time.monotonic()
        health = await client.get("/api/health")
        assert health.status_code == 200
        assert time.monotonic() - before < 0.5
        response = await audit
        assert response.status_code == 200
        assert response.json()["items"][0]["id"] == "audit-api"
    manager.close_all()


def test_project_audit_rejects_message_content_in_metadata(tmp_path):
    from services.project_audit import record_project_audit

    db = init_db(str(tmp_path / "workstep.db"))
    try:
        with pytest.raises(ValueError, match="metadata"):
            record_project_audit(
                project_id="project-1", action="task.start", result="denied",
                metadata={"content": "secret prompt"},
            )
    finally:
        db.close()


def test_existing_project_audit_table_gains_upload_state(tmp_path):
    from models import ProjectAuditEvent

    path = tmp_path / "workstep.db"
    with sqlite3.connect(path) as connection:
        connection.execute("""CREATE TABLE project_audit_events (
            id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT,
            action TEXT, result TEXT, mode TEXT, actor_id TEXT,
            actor_username TEXT, actor_name TEXT, actor_type TEXT,
            device_id TEXT, device_name TEXT, initiated_by_user_id TEXT,
            initiated_by_username TEXT, metadata_json TEXT,
            created_at DATETIME, uploaded_at DATETIME
        )""")
        connection.execute(
            "INSERT INTO project_audit_events "
            "(id, project_id, action, result, mode, actor_type, metadata_json, created_at) "
            "VALUES ('old-audit', 'project-1', 'task.start', 'succeeded', "
            "'local', 'system', '{}', '2026-01-01T00:00:00Z')"
        )
    db = init_db(str(path))
    try:
        row = ProjectAuditEvent.get_by_id("old-audit")
        assert row.upload_status == "pending"
        assert row.upload_error is None
    finally:
        db.close()


def test_project_audit_query_pages_and_filters_task(tmp_path):
    from services.project_audit import list_project_audit, record_project_audit

    db = init_db(str(tmp_path / "workstep.db"))
    try:
        for index in range(3):
            record_project_audit(
                project_id="project-1", task_id=f"task-{index % 2}",
                action="task.start", result="succeeded", event_id=f"audit-{index}",
            )
        first = list_project_audit("project-1", limit=2)
        assert len(first["items"]) == 2
        assert first["next_before"] == first["items"][-1]["id"]
        second = list_project_audit("project-1", limit=2, before=first["next_before"])
        assert len(second["items"]) == 1
        assert {item["id"] for item in first["items"] + second["items"]} == {
            "audit-0", "audit-1", "audit-2",
        }
        filtered = list_project_audit("project-1", task_id="task-0")
        assert {item["task_id"] for item in filtered["items"]} == {"task-0"}
        assert filtered["next_before"] is None
    finally:
        db.close()


@pytest.mark.anyio
async def test_project_audit_rejects_gateway_remote_reader():
    from api.project_audit import get_project_audit

    request = Request({
        "type": "http", "method": "GET", "path": "/api/project-audit",
        "headers": [], "gateway_remote_actor": object(),
    })
    with pytest.raises(HTTPException) as denied:
        await get_project_audit(request, project_id="guessed-project")
    assert denied.value.status_code == 403
