"""Rejected task starts retain a bounded, attributable audit result."""

import asyncio
import json
from datetime import timedelta

import pytest

from services.remote_access import ActorSnapshot, actor_context
from tests.test_api_contracts import api_context
from tests.test_workflow_runtime import RuntimeFakeEngine


@pytest.mark.anyio
async def test_task_start_audits_and_scheduled_state_are_consistent(
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

    original_start = main.workflow_runtime.start

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

    def cleanup_failure(_task_id):
        raise RuntimeError("schedule cleanup failed")

    from engines.core.registry import ENGINE_REGISTRY
    from models import TaskStep

    project = main.project_manager.get_project_by_id(project_id)
    project.steps = {
        "nodes": [{"id": 1, "type": "do", "title": "Do",
                   "engine": "audit-schedule-fake", "prompt": "Do"}],
        "connections": [],
    }
    monkeypatch.setitem(ENGINE_REGISTRY, "audit-schedule-fake", RuntimeFakeEngine)

    def schedule_task(_project):
        task = Task.get_by_id(task_id)
        task.engine = "audit-schedule-fake"
        task.scheduled_start_at = utc_now() + timedelta(hours=1)
        task.scheduled_start_state = "pending"
        task.save()
        TaskStep.create(task=task, step_key="do", status="pending",
                        engine="audit-schedule-fake")

    await main.project_manager.run_db(project_id, schedule_task)
    monkeypatch.setattr(main.workflow_runtime, "start", original_start)
    monkeypatch.setattr(main.task_service, "clear_scheduled_start", cleanup_failure)
    with actor_context(actor):
        cleanup = await client.post(f"/api/task/run?project_id={project_id}",
                                    json={"task_id": task_id, "prompt": "Start"})
        await asyncio.gather(*tuple(main.workflow_runtime._active_tasks))
    assert cleanup.status_code == 200, cleanup.text

    def read_task_and_audits(_project):
        task = Task.get_by_id(task_id)
        return (task.scheduled_start_at, task.scheduled_start_state,
                ProjectAuditEvent.select().where(
                    ProjectAuditEvent.task_id == task_id,
                    ProjectAuditEvent.result == "failed",
                ).count())

    assert await main.project_manager.run_db(
        project_id, read_task_and_audits,
    ) == (None, None, 1)

    from services import workflow_start
    from models import WorkflowRun

    def create_initial_step(_project):
        task = Task.create(
            id="start-from-step-audit-failure", title="Initial step",
            cwd=str(project_dir), engine="audit-schedule-fake",
            scheduled_start_at=utc_now() + timedelta(hours=1),
            scheduled_start_state="pending",
            created_at=utc_now(), updated_at=utc_now(),
        )
        TaskStep.create(task=task, step_key="do", status="pending",
                        engine="audit-schedule-fake")

    await main.project_manager.run_db(project_id, create_initial_step)

    def fail_audit(**_kwargs):
        raise ValueError("audit write failed")

    monkeypatch.setattr(workflow_start, "record_project_audit", fail_audit)
    with actor_context(actor):
        with pytest.raises(ValueError, match="audit write failed"):
            await main.workflow_runtime.restart_from_step(
                project_id, "start-from-step-audit-failure", "do",
            )

    def inspect_initial_step(_project):
        task = Task.get_by_id("start-from-step-audit-failure")
        return (task.status, task.scheduled_start_at is not None,
                WorkflowRun.select().where(WorkflowRun.task == task).count())

    assert await main.project_manager.run_db(
        project_id, inspect_initial_step,
    ) == ("ready", True, 0)
