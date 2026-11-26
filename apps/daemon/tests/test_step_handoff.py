"""CLI → HTTP → runtime smart handoff and continuation contracts."""
import asyncio
import json
import threading
import time
from pathlib import Path
from contextlib import nullcontext
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from cli import build_parser, dispatch
from engines.core.registry import ENGINE_REGISTRY
from models import Message, Task, TaskStep, StepRun, WorkflowRun, init_db
from models.fields import utc_now
from services.remote_access import ActorSnapshot, actor_context
from services.tool_registry import WorkstepClient
from services.workflow_runtime import WorkflowRuntime
from services.project_database import ProjectDatabaseExecutor
from streaming.bus import EventBus
from engines.core.acp_base import AcpEngineBase
from engines.core.events import InternalEvent


class RuntimeFakeEngine(AcpEngineBase):
    @staticmethod
    def is_installed():
        return True

    @staticmethod
    def get_version():
        return "fake"

    @staticmethod
    def resolve_binary():
        return "fake"

    async def spawn(self, prompt, cwd, **kwargs):
        yield InternalEvent(type="agent_message_chunk", data={"content": {"text": "done"}})
        yield InternalEvent(type="status", data={"status": "done"})

    async def stop(self):
        return None

    async def inject_response(self, tool_use_id, content):
        return None

    @property
    def supports_resume(self):
        return False

    @property
    def supports_interactive(self):
        return False

    def build_resume_params(self, session_id):
        return {}



@pytest.mark.anyio
@pytest.mark.parametrize("prepare_first", [False, True])
async def test_cli_provider_handoff_and_resume(tmp_path, monkeypatch, prepare_first):
    import main
    import api.task as task_api
    prompts = []
    branch_values = []
    class Engine(RuntimeFakeEngine):
        ENGINE_ID = "handoff-test"
        def resolve_provider_id(self, provider_id=None):
            return provider_id or "provider-b"
        async def spawn(self, prompt, **kwargs):
            prompts.append(prompt)
            relative_branch = branch_file.relative_to(tmp_path)
            assert str(relative_branch) in prompt
            branch_values.append((Path(kwargs["cwd"]) / relative_branch).read_text(encoding="utf-8"))
            async for event in super().spawn(prompt, **kwargs):
                yield event
    monkeypatch.setitem(ENGINE_REGISTRY, Engine.ENGINE_ID, Engine)
    db = init_db(str(tmp_path / "workstep.db"))
    now = utc_now()
    task = Task.create(id="t", title="合并任务", description="审核后合并", cwd=str(tmp_path),
                       engine=Engine.ENGINE_ID, workflow_id="flow", created_at=now, updated_at=now)
    project = SimpleNamespace(id="p", path=tmp_path, workstep_dir=tmp_path / ".workstep",
        steps={"nodes": [
            {"id": 1, "type": "build", "outputs": [{"name": "branchName", "type": "text"}]},
            {"id": 2, "type": "merge", "engine": Engine.ENGINE_ID,
             "inputs": [{"name": "branchName"}],
             "prompt": "读取 branchName，遵循审核与分支约束", "config": {}}],
             "connections": [{"from": 1, "fromPort": 0, "to": 2, "toPort": 0}]})
    project.workflow_by_id = lambda wid: {"steps": project.steps}
    executor = ProjectDatabaseExecutor(db, "p")
    class Manager:
        async def run_db(self, pid, operation):
            assert pid == "p"
            return await executor.run(lambda: operation(project))
        def activate_project_by_id(self, pid):
            assert pid == "p"
            return nullcontext(project)
    runtime = WorkflowRuntime(EventBus(), Manager())
    monkeypatch.setattr(main, "workflow_runtime", runtime)
    async def scoped(pid, tid):
        assert (pid, tid) == ("p", "t")
    monkeypatch.setattr(task_api, "_require_scoped_task", scoped)
    monkeypatch.setattr(task_api, "_project", lambda pid: project)
    app = FastAPI()
    app.include_router(task_api.router)
    client = WorkstepClient(transport=httpx.ASGITransport(app=app))
    async def call(operation, *extra):
        args = build_parser().parse_args(["task", operation, "--project", "p", "--task", "t",
                                          "--step", "merge", "--json", *extra])
        return await dispatch(args, client)
    from services.artifact_rounds import step_round_dir, write_round_manifest
    root = project.workstep_dir / "artifacts"
    branch_dir = step_round_dir(root, "flow", task.id, "build", 1)
    branch_dir.mkdir(parents=True)
    branch_file = branch_dir / "branchName.txt"
    branch_file.write_text("task/original", encoding="utf-8")
    write_round_manifest(artifacts_root=root, workflow_id="flow", task_id=task.id,
        step_key="build", artifact_round=1, status="passed", eligible_for_downstream=True,
        outputs=[{"name": "branchName", "type": "text"}])
    parent = WorkflowRun.create(id="parent", task=task, status="failed", workflow_schema_version=1, started_at=now)
    task.active_workflow_run_id = parent.id
    task.save()
    StepRun.create(id="build-run", run=parent, step_key="build", attempt=1, artifact_round=1, status="succeeded")
    TaskStep.create(task=task, step_key="build", status="passed")
    TaskStep.create(task=task, step_key="merge", status="failed", engine=Engine.ENGINE_ID,
                    session_id="old", session_provider="provider-a")
    Message.create(id="history", task=task, channel="execution", step_key="merge", sequence=1,
                   role="assistant", content="已审核 branchName.txt，分支 task/original", engine=Engine.ENGINE_ID,
                   run_status="succeeded", position=1, created_at=now)
    try:
        with actor_context(ActorSnapshot(actor_id="u", user_name="tester", device_id="d", device_name="device", source="browser")):
            blocked = await call("step-start", "--content", "继续")
            assert blocked["ok"] is False
            assert StepRun.select().where(StepRun.step_key == "merge").count() == 0
            assert Message.select().count() == 1
            assert blocked["status"] == "needs_confirmation"
            invalid = await client.call("workstep_handoff_step", {"project_id": "p", "task_id": "t", "step_key": "missing", "confirm": "yes"})
            readonly = ActorSnapshot(actor_id="u", user_name="tester", device_id="d", device_name="device",
                                     source="browser", project_id="p", access_level="read")
            with actor_context(readonly):
                assert (await call("step-handoff"))["ok"] is False
            assert invalid["ok"] is False
            assert "does not exist" in invalid["error"]
            step = TaskStep.get(TaskStep.step_key == "merge")
            step.status = "running"
            step.save()
            assert (await call("step-handoff"))["ok"] is False
            step.status = "failed"
            step.save()
            import services.step_execution_config as handoffs
            original_append = handoffs.append_handoff_log
            def broken(*args, **kwargs):
                raise OSError("handoff disk unavailable")
            with monkeypatch.context() as patch:
                patch.setattr(handoffs, "append_handoff_log", broken)
                failed = await call("step-start", "--content", "继续", "--handoff", "smart", "--request-id", "failed-1")
                assert failed["status"] == "failed"
                assert "disk unavailable" in failed["error"]
                assert Message.select().count() == 1
                assert TaskStep.get(TaskStep.step_key == "merge").session_id == "old"
            if prepare_first:
                started = threading.Event()
                def slow(*args, **kwargs):
                    started.set()
                    time.sleep(.2)
                    return original_append(*args, **kwargs)
                with monkeypatch.context() as patch:
                    patch.setattr(handoffs, "append_handoff_log", slow)
                    preparation = asyncio.create_task(call("step-handoff"))
                    assert await asyncio.to_thread(started.wait, 1)
                    before = asyncio.get_running_loop().time()
                    await asyncio.sleep(.02)
                    assert asyncio.get_running_loop().time() - before < .1
                    assert not preparation.done()
                    prepared = await preparation
                assert prepared["status"] == "prepared"
                repeated = await call("step-handoff")
                assert repeated["handoff_id"] == prepared["handoff_id"]
            with pytest.raises(ValueError, match="Task not found"):
                await runtime.handoff_step("p", "missing", "merge")
            empty_task = Task.create(id="empty", title="empty", cwd=str(tmp_path), workflow_id="flow",
                                     created_at=now, updated_at=now)
            TaskStep.create(task=empty_task, step_key="merge", status="failed", engine=Engine.ENGINE_ID,
                            session_id="empty-old", session_provider="provider-a")
            with pytest.raises(ValueError, match="No execution history"):
                await runtime.handoff_step("p", "empty", "merge")
            options = ("--content", "继续", "--handoff", "smart", "--request-id", "resume-1")
            accepted, concurrent = await asyncio.gather(call("step-start", *options), call("step-start", *options))
            assert concurrent["run_id"] == accepted["run_id"]
            assert accepted["status"] == "queued"
            assert accepted["handoff"]["status"] == "prepared"
            duplicate = await call("step-start", *options)
            assert duplicate["run_id"] == accepted["run_id"]
            for _ in range(500):
                if task.id not in runtime._runners:
                    break
                await asyncio.sleep(.01)
            assert len(prompts) == 1
            assert branch_values == ["task/original"]
            assert "workstep_context_handoff" in prompts[0]
            assert "branchName.txt" in prompts[0]
            assert branch_file.read_text() == "task/original"
            merge_run = StepRun.get(StepRun.step_key == "merge")
            assert json.loads(merge_run.input_rounds_json)["build"] == 1
            assert "branchName.txt" in merge_run.input_snapshot_json
            assert TaskStep.get(TaskStep.step_key == "build").status == "passed"
            conflict = await call("step-start", "--content", "different", "--handoff", "smart", "--request-id", "resume-1")
            assert conflict["ok"] is False
            assert TaskStep.get(TaskStep.step_key == "merge").session_provider == "provider-b"
            restored_runtime = WorkflowRuntime(EventBus(), Manager())
            monkeypatch.setattr(main, "workflow_runtime", restored_runtime)
            assert (await call("step-start", *options))["run_id"] == accepted["run_id"]
            message = Message.get_by_id(accepted["message_id"])
            data = json.loads(message.prompt_json)
            data.pop("step_start_result")
            message.prompt_json = json.dumps(data)
            message.save()
            unknown = await call("step-start", *options)
            assert unknown["status"] == "unknown"
            assert unknown["ok"] is False
            await restored_runtime.shutdown()
            assert len(prompts) == 1
    finally:
        await runtime.shutdown()
        executor.close()
        db.close()
