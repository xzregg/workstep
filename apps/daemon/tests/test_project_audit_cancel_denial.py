"""A rejected cancellation remains attributable to its project actor."""

import asyncio
import json
import threading
import time

import pytest

from services.remote_access import ActorSnapshot, actor_context
from tests.test_api_contracts import api_context


@pytest.mark.anyio
async def test_cancelling_idle_task_records_denial(api_context, monkeypatch):
    import main
    from models import ProjectAuditEvent, Task
    from models.fields import utc_now

    client, tmp_path = api_context
    project_dir = tmp_path / "cancel-idle-audit"
    project_dir.mkdir()
    project_id = (await client.post(
        "/api/project/init", json={"path": str(project_dir)},
    )).json()["id"]
    task_id = "idle-task"
    await main.project_manager.run_db(project_id, lambda _project: Task.create(
        id=task_id, title="Idle task", cwd=str(project_dir),
        created_at=utc_now(), updated_at=utc_now(),
    ))
    actor = ActorSnapshot(actor_id="operator-1", username="operator",
                          user_name="Operator", device_id="device-1",
                          device_name="Laptop", source="local")
    with actor_context(actor):
        response = await client.post(f"/api/task/cancel?project_id={project_id}",
                                     json={"task_id": task_id})
    assert response.status_code == 200
    assert response.json() == {"cancelled": False}

    audits = await main.project_manager.run_db(project_id, lambda _project: list(
        ProjectAuditEvent.select().where(ProjectAuditEvent.task_id == task_id)
    ))
    assert len(audits) == 1
    assert (audits[0].action, audits[0].result, audits[0].actor_username,
            json.loads(audits[0].metadata_json)) == (
        "task.cancel", "denied", "operator", {"reason_code": "not_running"},
    )

    project = main.project_manager.get_project_by_id(project_id)
    original_execute = project.db.execute_sql
    entered = threading.Event()

    def slow_audit(sql, *args, **kwargs):
        if (sql.lstrip().upper().startswith("INSERT")
                and "project_audit_events" in sql and not entered.is_set()):
            entered.set()
            time.sleep(0.8)
        return original_execute(sql, *args, **kwargs)

    monkeypatch.setattr(project.db, "execute_sql", slow_audit)
    with actor_context(actor):
        pending = asyncio.create_task(client.post(
            f"/api/task/cancel?project_id={project_id}",
            json={"task_id": task_id},
        ))
        assert await asyncio.to_thread(entered.wait, 2)
        before = time.monotonic()
        health = await client.get("/api/health")
        assert health.status_code == 200
        assert time.monotonic() - before < 0.5
        assert (await pending).json() == {"cancelled": False}
