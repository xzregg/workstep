"""Rejected task starts retain a bounded, attributable audit result."""

import json

import pytest

from services.remote_access import ActorSnapshot, actor_context
from tests.test_api_contracts import api_context


@pytest.mark.anyio
async def test_task_start_conflict_and_runtime_error_record_distinct_results(
    api_context, monkeypatch,
):
    import main
    from models import ProjectAuditEvent, Task
    from models.fields import utc_now

    client, tmp_path = api_context
    project_dir = tmp_path / "audit-start-conflict"
    project_dir.mkdir()
    project_id = (await client.post(
        "/api/project/init", json={"path": str(project_dir)},
    )).json()["id"]
    task_id = "already-active-task"
    await main.project_manager.run_db(project_id, lambda _project: Task.create(
        id=task_id, title="Already active", cwd=str(project_dir),
        created_at=utc_now(), updated_at=utc_now(),
    ))

    async def reject_active(_project_id, _task_id, _prompt):
        raise RuntimeError(f"Task is already queued or running: {_task_id}")

    monkeypatch.setattr(main.workflow_runtime, "start", reject_active)
    actor = ActorSnapshot(actor_id="operator-1", username="operator",
                          user_name="Operator", device_id="device-1",
                          device_name="Laptop", source="local")
    with actor_context(actor):
        response = await client.post(f"/api/task/run?project_id={project_id}",
                                     json={"task_id": task_id, "prompt": "Start"})
    assert response.status_code == 409

    audits = await main.project_manager.run_db(project_id, lambda _project: list(
        ProjectAuditEvent.select().where(ProjectAuditEvent.task_id == task_id)
    ))
    assert len(audits) == 1
    assert (audits[0].action, audits[0].result,
            audits[0].actor_username, json.loads(audits[0].metadata_json)) == (
        "task.start", "denied", "operator", {"reason_code": "already_active"},
    )

    async def worker_failure(_project_id, _task_id, _prompt):
        raise RuntimeError("worker failure")

    monkeypatch.setattr(main.workflow_runtime, "start", worker_failure)
    with actor_context(actor):
        failed = await client.post(f"/api/task/run?project_id={project_id}",
                                   json={"task_id": task_id, "prompt": "Start"})
    assert failed.status_code == 409
    outcomes = await main.project_manager.run_db(project_id, lambda _project: [
        (row.result, json.loads(row.metadata_json))
        for row in ProjectAuditEvent.select().where(
            ProjectAuditEvent.task_id == task_id
        )
    ])
    assert outcomes == [
        ("denied", {"reason_code": "already_active"}),
        ("failed", {"reason_code": "run_error"}),
    ]
