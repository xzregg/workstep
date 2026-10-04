"""Retry persistence keeps the execution's identity and task/step boundary."""

import asyncio
import threading
import time
from datetime import timedelta

import httpx
import pytest
from fastapi import FastAPI

from models import Message, Task, TaskStep, WorkflowRun, init_db
from models.fields import utc_now
from services.messages import create_task_message
from services.pipeline import Step
from services.project_database import ProjectDatabaseExecutor
from services.task_runner import TaskRunner
from services.task_step_start import StartedStepState
from streaming.bus import EventBus


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["valid", "valid_slow", "other_task", "other_step", "other_channel", "user"])
async def test_retried_execution_rechecks_scope_and_uses_current_run_actor(tmp_path, monkeypatch, source):
    import services.step_execution_messages as execution

    db = await asyncio.to_thread(init_db, str(tmp_path / "workstep.db"))
    executor = ProjectDatabaseExecutor(db, "project-test")

    def seed():
        now = utc_now()
        task = Task.create(id="own", title="重试", cwd=str(tmp_path), created_at=now, updated_at=now)
        other = Task.create(id="other", title="其他任务", cwd=str(tmp_path), created_at=now, updated_at=now)
        old = create_task_message(
            task=other if source == "other_task" else task,
            channel="review" if source == "other_channel" else "execution",
            step_key="other-step" if source == "other_step" else "build",
            role="user" if source == "user" else "assistant", engine="old-engine",
            content="旧正文", position=1, run_status="failed",
            initiated_by_user_id="old-user", initiated_by_username="old",
            created_at=now - timedelta(minutes=1),
        )
        run = WorkflowRun.create(
            id="new-run", task=task, workflow_schema_version=1, status="running", started_at=now,
            initiated_by_user_id="new-user", initiated_by_username="new",
            initiated_by_device_id="new-device", initiated_by_device_name="新电脑",
        )
        task.active_workflow_run_id = run.id
        task.save()
        task_step = TaskStep.create(task=task, step_key="build", status="running")
        return task, old.id, StartedStepState(task_step, None, None, None, None, None, {}, None)

    task, message_id, state = await executor.run(seed)
    runner = TaskRunner(EventBus(), source_project_id="project-test", database_executor=executor,
                        retry_message_ids={"build": message_id})
    monkeypatch.setattr(execution, "assemble_prompt", lambda *args: "重试提示")
    slow_query_started = threading.Event()
    if source == "valid_slow":
        original = execution.attributed_actor_message_fields

        def slow_attribution(*args, **kwargs):
            slow_query_started.set()
            time.sleep(.2)
            return original(*args, **kwargs)

        monkeypatch.setattr(execution, "attributed_actor_message_fields", slow_attribution)
    try:
        async def start():
            return await runner._execution_messages.start(
                task=task, step=Step(key="build", label="Build", engine="new-engine"),
                artifacts_dir=tmp_path / ".workstep" / "artifacts", user_input="",
                input_snapshot={}, state=state, review_feedback="", engine=None, resolved_model="model-new",
            )

        if source == "valid_slow":
            pending = asyncio.create_task(start())
            assert await asyncio.to_thread(slow_query_started.wait, 1)
            app = FastAPI()

            @app.get("/health")
            async def health():
                return {"status": "ok"}

            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                assert (await asyncio.wait_for(client.get("/health"), .1)).status_code == 200
            assert not pending.done()
            assert (await pending).message_id == message_id
        elif source == "valid":
            assert (await start()).message_id == message_id
        else:
            with pytest.raises(Message.DoesNotExist):
                await start()

        def snapshot():
            row = Message.get_by_id(message_id)
            return (row.engine, row.content, row.author_id, row.author_username,
                    row.author_type, row.initiated_by_user_id,
                    row.initiated_by_username, row.author_device_id)

        values = await executor.run(snapshot)
        if source.startswith("valid"):
            assert values == ("new-engine", "", "new-engine", "new-engine", "assistant",
                              "new-user", "new", "new-device")
        else:
            assert values[0:2] == ("old-engine", "旧正文")
            assert values[5:7] == ("old-user", "old")
    finally:
        await runner.close()
        await asyncio.to_thread(executor.close)
        await asyncio.to_thread(db.close)
