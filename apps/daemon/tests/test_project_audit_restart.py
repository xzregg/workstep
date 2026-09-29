"""Restarting a workflow records the new run in the project audit trail."""

import asyncio
import json
import threading
import time

import pytest
from httpx import ASGITransport, AsyncClient

from engines.core.registry import ENGINE_REGISTRY
from models import ProjectAuditEvent, Task, TaskStep, WorkflowRun
from models.fields import utc_now
from services.project import ProjectManager
from services.remote_access import ActorSnapshot, actor_context
from services.workflow_runtime import WorkflowRuntime
from streaming.bus import EventBus
from tests.test_workflow_runtime import RuntimeFakeEngine


@pytest.mark.anyio
async def test_restarting_step_records_actor_and_child_run(tmp_path, monkeypatch):
    manager = ProjectManager()
    project = manager.init_project(tmp_path / "audit-restart")
    project.steps = {
        "nodes": [{"id": 1, "type": "do", "title": "Do",
                   "engine": "audit-restart-fake", "prompt": "Do"}],
        "connections": [],
    }

    def create_task(_project):
        now = utc_now()
        task = Task.create(id="audit-restart-task", title="Audit restart",
                           cwd=str(project.path), engine="audit-restart-fake",
                           created_at=now, updated_at=now)
        TaskStep.create(task=task, step_key="do", status="pending",
                        engine="audit-restart-fake")
        return task.id

    task_id = await manager.run_db(project.id, create_task)
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["audit-restart-fake"] = RuntimeFakeEngine
    runtime = WorkflowRuntime(EventBus(), manager)
    actor = ActorSnapshot(actor_id="restart-user", username="alice",
                          user_name="Alice", device_id="device-1",
                          device_name="Laptop", source="browser")
    try:
        with actor_context(actor):
            first = await runtime.start(project.id, task_id, "")
            await runtime.wait(first)
            restarted = await runtime.restart_from_step(project.id, task_id, "do")
            await runtime.wait(restarted)

        def read_audit(_project):
            return [
                (row.action, row.result, row.actor_username,
                 row.initiated_by_username, json.loads(row.metadata_json))
                for row in ProjectAuditEvent.select().where(
                    ProjectAuditEvent.task_id == task_id
                )
            ]

        audits = await manager.run_db(project.id, read_audit)
        restart = [row for row in audits if row[0] == "task.restart"]
        assert len(restart) == 1
        assert restart[0][1:4] == ("succeeded", "alice", "alice")
        assert restart[0][4] == {
            "step_key": "do", "workflow_run_id": restarted.id,
        }

        with actor_context(actor):
            resumed = await runtime.resume_step_with_message(
                project.id, task_id, "do", "Continue work"
            )
            await asyncio.gather(*tuple(runtime._active_tasks))
        audits = await manager.run_db(project.id, read_audit)
        resume = [row for row in audits if row[0] == "task.resume"]
        assert len(resume) == 1
        assert resume[0][1:4] == ("succeeded", "alice", "alice")
        assert resume[0][4] == {
            "step_key": "do", "workflow_run_id": resumed["run_id"],
        }

        original_execute = project.db.execute_sql
        entered = threading.Event()

        def slow_audit_insert(sql, *args, **kwargs):
            if (sql.lstrip().upper().startswith("INSERT")
                    and "project_audit_events" in sql and not entered.is_set()):
                entered.set()
                time.sleep(0.8)
            return original_execute(sql, *args, **kwargs)

        monkeypatch.setattr(project.db, "execute_sql", slow_audit_insert)
        with actor_context(actor):
            pending = asyncio.create_task(
                runtime.restart_from_step(project.id, task_id, "do")
            )
            assert await asyncio.to_thread(entered.wait, 2)
            from main import app

            async with AsyncClient(transport=ASGITransport(app=app),
                                   base_url="http://test") as client:
                before = time.monotonic()
                health = await client.get("/api/health")
                assert health.status_code == 200
                assert time.monotonic() - before < 0.5
            second = await pending
            await runtime.wait(second)
        monkeypatch.setattr(project.db, "execute_sql", original_execute)

        def fail_audit(**_kwargs):
            raise RuntimeError("audit write failed")

        monkeypatch.setattr("services.project_audit.record_project_audit", fail_audit)
        with actor_context(actor):
            with pytest.raises(RuntimeError, match="audit write failed"):
                await runtime.restart_from_step(project.id, task_id, "do")

        def read_runs(_project):
            task = Task.get_by_id(task_id)
            return task.active_workflow_run_id, [
                (run.id, run.status) for run in WorkflowRun.select()
            ]

        active_run_id, runs = await manager.run_db(project.id, read_runs)
        assert active_run_id == second.id
        assert len(runs) == 4
        assert next(status for run_id, status in runs if run_id == second.id) == "succeeded"
    finally:
        await runtime.shutdown()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        manager.close_all()
