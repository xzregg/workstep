"""Task-local configuration through real API, routing, reviews and recovery.

Only the engine transport is scripted. No runtime/configuration method is mocked.
"""

import asyncio
from collections import Counter
from copy import deepcopy
import json
from pathlib import Path
import re
import threading
import time
from uuid import uuid4

import pytest

from engines.core.acp_base import AcpEngineBase
from engines.core.events import InternalEvent
from engines.core.registry import ENGINE_REGISTRY
from models import Message, ReviewRun, StepRun, Task, TaskStep, WorkflowRun
from tests.test_api_contracts import api_context  # Shared isolated real application fixture.


def output_paths(prompt, cwd):
    paths = re.findall(r"output path: `([^`]+)`", prompt)
    if "## Current outputs" in prompt:
        paths += re.findall(r"^- .+?: `([^`]+)`$", prompt.split("## Current outputs", 1)[1], re.M)
    return list(dict.fromkeys((Path(cwd) / value).resolve() for value in paths))


class Script:
    def __init__(self):
        self.calls = []
        self.feedback_rounds = 0
        self.reject_reviews = 0
        self.failures = 0
        self.resume = True
        self.block = None
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    def select(self, stage=None, channel="execution"):
        return [call for call in self.calls if call["channel"] == channel
                and (stage is None or call["stage"] == stage)]

    def engine(self, engine_id):
        script = self

        class Engine(AcpEngineBase):
            ENGINE_ID = engine_id
            SYSTEM_PROMPT_MODE = "body"

            @staticmethod
            def is_installed(): return True

            @staticmethod
            def get_version(): return "test"

            @staticmethod
            def resolve_binary(): return None

            @property
            def supports_resume(self): return script.resume

            @property
            def supports_interactive(self): return False

            def build_resume_params(self, session_id): return {"session_id": session_id}

            async def stop(self):
                self.stopped = True
                self.wake.set()

            async def spawn(self, prompt, cwd, session_id=None, **kwargs):
                self.stopped = False
                self.wake = asyncio.Event()
                paths = output_paths(prompt, cwd)
                names = {path.name for path in paths}
                stage = next((key for name, key in (
                    ("PRD.md", "requirements"), ("API.md", "develop"),
                    ("BugList.md", "test"), ("Delivery.md", "publish"),
                    ("Extra.md", "extra"), ("SourceNew.md", "source_new"),
                ) if name in names), "unknown")
                # Dedicated reviewer adapter also recognizes resumed reviews whose system role is not repeated.
                channel = "review" if engine_id == "claude" else "execution"
                active = session_id or f"{engine_id}-{uuid4()}"
                call = {"engine": engine_id, "stage": stage, "channel": channel,
                        "prompt": prompt, "session": active, "resumed": bool(session_id),
                        "model": kwargs.get("model"), "paths": paths}
                script.calls.append(call)
                ordinal = len(script.select(stage, channel))
                yield InternalEvent(type="session_started", data={"session_id": active})
                if script.block == (stage, channel, ordinal):
                    script.entered.set()
                    waiter = asyncio.create_task(script.release.wait())
                    stopped = asyncio.create_task(self.wake.wait())
                    try:
                        await asyncio.wait({waiter, stopped}, return_when=asyncio.FIRST_COMPLETED)
                    finally:
                        for pending in (waiter, stopped):
                            pending.cancel()
                        await asyncio.gather(waiter, stopped, return_exceptions=True)
                    if self.stopped:
                        return
                if channel == "review":
                    passed = script.reject_reviews <= 0
                    script.reject_reviews -= int(not passed)
                    response = json.dumps({"passed": passed, "score": 100 if passed else 40,
                        "summary": "accepted" if passed else "TASK_REVIEW_BUG", "issues": []})
                else:
                    if stage == "develop" and script.failures:
                        script.failures -= 1
                        yield InternalEvent(type="error", data={"message": "network unavailable"})
                        return

                    def write():
                        wanted = None
                        if stage == "test":
                            wanted = "BugList.md" if ordinal <= script.feedback_rounds else "Report.md"
                        for path in paths:
                            assert path.is_relative_to(Path(cwd).resolve())
                            if wanted and path.name != wanted:
                                continue
                            path.parent.mkdir(parents=True, exist_ok=True)
                            path.write_text(f"{stage}:{ordinal}:{engine_id}", encoding="utf-8")

                    await asyncio.to_thread(write)
                    response = f"{stage} done"
                yield InternalEvent(type="agent_message_chunk", data={"content": {"text": response}})
                yield InternalEvent(type="status", data={"status": "done"})

        return Engine


def node(key, outputs, inputs=()):
    return {"id": key, "type": key, "title": key, "engine": "codex",
            "prompt": f"SOURCE_{key}", "review": {"mode": "skip"},
            "inputs": [{"name": value, "type": "md"} for value in inputs],
            "outputs": [{"name": value, "type": "md"} for value in outputs]}


def edge(source, target, output=0, input_=0, kind="solid"):
    return {"from": source, "fromPort": output, "to": target, "toPort": input_, "kind": kind}


class Scenario:
    def __init__(self, client, script, pid, task_id, workflow_id, source):
        self.client, self.script = client, script
        self.pid, self.task_id, self.workflow_id = pid, task_id, workflow_id
        self.source = source
        self.url = f"/api/task/{task_id}/workflow?project_id={pid}"

    @property
    def runtime(self):
        import main
        return main.workflow_runtime

    async def db(self, operation):
        import main
        return await main.project_manager.run_db(self.pid, operation)

    async def config(self):
        response = await self.client.get(self.url)
        assert response.status_code == 200, response.text
        return response.json()

    async def save(self, edit, expected=200):
        config = await self.config()
        edited = deepcopy(config["workflow"])
        edit(edited)
        response = await self.client.put(self.url, json={"workflow": edited, "revision": config["revision"]})
        assert response.status_code == expected, response.text
        return response.json()

    async def source_update(self, edit):
        import main
        updated = deepcopy(self.source)
        edit(updated)
        await self.db(lambda project: main.project_manager.update_workflow(project, self.workflow_id, steps=updated))
        self.source = updated

    async def idle(self):
        async with asyncio.timeout(8):
            while self.task_id in self.runtime._runners:
                await asyncio.sleep(.01)
        return await self.db(lambda _project: Task.get_by_id(self.task_id).status)

    async def start(self, step=None, **kwargs):
        if step:
            handle = await self.runtime.restart_from_step(self.pid, self.task_id, step, **kwargs)
        else:
            handle = await self.runtime.start(self.pid, self.task_id, **kwargs)
        await asyncio.wait_for(self.runtime.wait(handle), 8)
        return await self.idle()

    async def unchanged_source(self):
        response = await self.client.get(f"/api/workflow/{self.workflow_id}?project_id={self.pid}")
        assert response.json()["steps"] == self.source


@pytest.fixture
async def scenario(api_context, monkeypatch):
    from services.config import config_store
    client, directory = api_context
    monkeypatch.setattr(config_store, "get_user_name", lambda: "Scenario Tester")
    script = Script()
    for engine_id in ("codex", "codex_sdk", "claude"):
        monkeypatch.setitem(ENGINE_REGISTRY, engine_id, script.engine(engine_id))
    project_dir = directory / "scenario"
    project_dir.mkdir()
    pid = (await client.post("/api/project/init", json={"path": str(project_dir)})).json()["id"]
    source = {"nodes": [node("requirements", ["PRD"]),
        node("develop", ["API", "Notes"], ["PRD", "BugList"]),
        node("test", ["Report", "BugList"], ["API"]),
        node("publish", ["Delivery"], ["Report", "Extra"])],
        "connections": [edge("requirements", "develop"), edge("develop", "test"),
                        edge("test", "publish"), edge("test", "develop", 1, 1, "dashed")]}
    response = await client.post(f"/api/workflow/create?project_id={pid}", json={"name": "ScenarioFlow", "steps": source})
    assert response.status_code == 200, response.text
    workflow_id = response.json()["id"]
    task_id = (await client.post(f"/api/task/create?project_id={pid}", json={
        "title": "ScenarioTask", "description": "REQUIREMENT_CONTEXT", "workflow_id": workflow_id,
        "auto_start": False})).json()["id"]
    return Scenario(client, script, pid, task_id, workflow_id, source)


@pytest.mark.anyio
@pytest.mark.parametrize("engine", ["codex", "codex_sdk"])
@pytest.mark.parametrize("topology", ["inline", "parallel", "disconnected"])
@pytest.mark.parametrize("returns", [1, 2])
@pytest.mark.parametrize("resume", [False, True])
async def test_task_overrides_survive_artifact_rework_matrix(scenario, engine, topology, returns, resume):
    s = scenario
    s.script.resume = resume
    assert await s.db(lambda _p: Task.get_by_id(s.task_id).workflow_overrides_json) is None

    def customize(flow):
        flow["nodes"][1].update(engine=engine, prompt="TASK_DEVELOP", model="task-model")
        flow["nodes"][1]["outputs"].append({"name": "TaskExtra", "type": "md"})
        flow["nodes"].append(node("extra", ["Extra"], ["TaskExtra"]))
        if topology == "disconnected":
            flow["nodes"][-1]["autoStart"] = False
        if topology == "inline":
            flow["connections"].remove(edge("test", "publish"))
            flow["connections"] += [edge("test", "extra"), edge("extra", "publish")]
        elif topology == "parallel":
            flow["connections"] += [edge("develop", "extra", 2), edge("extra", "publish", 0, 1)]

    await s.save(customize)
    await s.unchanged_source()
    await s.source_update(lambda f: [n.update(prompt=f"NEW_SOURCE_{n['type']}") for n in f["nodes"]])
    s.script.feedback_rounds = returns
    assert await s.start("requirements") == "completed"
    calls = s.script.select()
    counts = Counter(call["stage"] for call in calls)
    assert counts["requirements"] == counts["publish"] == 1
    assert counts["develop"] == counts["test"] == returns + 1
    if topology == "parallel":
        # A branch can be cancelled before reaching its engine when feedback rewinds it.
        assert 1 <= counts["extra"] <= returns + 1
        assert f"/develop/{returns + 1}/TaskExtra.md" in s.script.select("extra")[-1]["prompt"], s.script.select("extra")[-1]["prompt"]
    else:
        assert counts["extra"] == (0 if topology == "disconnected" else 1)
    developers = s.script.select("develop")
    assert {call["engine"] for call in developers} == {engine}
    assert {call["model"] for call in developers} == {"task-model"}
    assert "TASK_DEVELOP" in developers[0]["prompt"]
    assert all("NEW_SOURCE_develop" not in call["prompt"] for call in developers)
    assert "NEW_SOURCE_test" in s.script.select("test")[0]["prompt"]
    assert len({call["session"] for call in developers}) == (1 if resume else returns + 1)
    assert "PRD.md" in developers[0]["prompt"]
    for call in developers[1:]:
        # Unchanged PRD stays in the resumed session, feedback is sent incrementally.
        assert "BugList.md" in call["prompt"]
    assert all(any(path.name == "TaskExtra.md" and path.exists() for path in call["paths"]) for call in developers)
    rounds = await s.db(lambda _p: [row.artifact_round for row in StepRun.select().join(WorkflowRun)
        .where((WorkflowRun.task == s.task_id) & (StepRun.step_key == "develop")).order_by(StepRun.artifact_round)])
    assert rounds == list(range(1, returns + 2))
    if topology == "disconnected":
        assert await s.start("extra", step_followup="MANUAL_EXTRA") == "completed"
        assert len(s.script.select("extra")) == 1
        statuses = await s.db(lambda _p: {row.step_key: row.status for row in TaskStep.select().where(TaskStep.task == s.task_id)})
        assert all(statuses[key] == "passed" for key in ("requirements", "develop", "test", "publish"))
    await s.unchanged_source()


@pytest.mark.anyio
async def test_manual_review_of_feedback_artifact_reworks_customized_stage(scenario):
    s = scenario

    def customize(flow):
        flow["nodes"][1].update(engine="codex_sdk", prompt="TASK_DEVELOP")
        flow["nodes"][2]["review"] = {"mode": "manual", "auto": False}

    await s.save(customize)
    s.script.feedback_rounds = 1
    assert await s.start() == "paused"
    for ordinal in (1, 2):
        review_id = await s.db(lambda _p: ReviewRun.get((ReviewRun.task == s.task_id) & (ReviewRun.status == "pending")).id)
        response = await s.client.post(f"/api/task/{s.task_id}/steps/test/review/approve?project_id={s.pid}",
            json={"review_run_id": review_id})
        assert response.status_code == 200, response.text
        assert await s.idle() == ("paused" if ordinal == 1 else "completed")
    assert len(s.script.select("develop")) == 2
    assert all(call["engine"] == "codex_sdk" for call in s.script.select("develop"))
    assert "BugList.md" in s.script.select("develop")[1]["prompt"]
    assert len(s.script.select("publish")) == 1
    await s.unchanged_source()


@pytest.mark.anyio
@pytest.mark.parametrize("limit", ["return", "review"])
async def test_task_specific_rework_limits_are_enforced(scenario, limit):
    s = scenario

    def customize(flow):
        flow["nodes"][1].update(engine="codex_sdk", prompt="TASK_LIMIT")
        if limit == "return":
            flow["nodes"][2]["maxReturnRounds"] = 1
        else:
            flow["nodes"][1]["review"] = {"mode": "auto", "auto": True,
                "engine": "claude", "prompt": "TASK_REVIEW", "maxRetries": 1}
    await s.save(customize)
    s.script.feedback_rounds = 2 if limit == "return" else 0
    s.script.reject_reviews = 5 if limit == "review" else 0
    assert await s.start() == "paused"
    assert len(s.script.select("develop")) == 2
    assert all(call["engine"] == "codex_sdk" for call in s.script.select("develop"))
    assert not s.script.select("publish")
    if limit == "review":
        assert await s.db(lambda _p: ReviewRun.select().where((ReviewRun.task == s.task_id)
            & (ReviewRun.mode == "manual") & (ReviewRun.status == "pending")).count()) == 1
    else:
        error = await s.db(lambda _p: TaskStep.get((TaskStep.task == s.task_id) & (TaskStep.step_key == "test")).error)
        assert "上限 1" in error
    await s.unchanged_source()


@pytest.mark.anyio
@pytest.mark.parametrize("channel", ["execution", "review"])
async def test_stop_stage_and_review_then_edit_task_and_rerun(scenario, channel):
    s = scenario

    def customize(flow):
        flow["nodes"][1].update(engine="codex_sdk", prompt="TASK_BEFORE_STOP")
        if channel == "review":
            flow["nodes"][1]["review"] = {"mode": "auto", "auto": True, "engine": "claude", "prompt": "TASK_REVIEW"}
    await s.save(customize)
    s.script.block = ("develop", channel, 1)
    handle = await s.runtime.start(s.pid, s.task_id)
    await asyncio.wait_for(s.script.entered.wait(), 3)
    assert await s.runtime.cancel_step(s.pid, s.task_id, "develop")
    await asyncio.wait_for(s.runtime.wait(handle), 8)
    assert await s.idle() == "paused"
    assert await s.db(lambda _p: ReviewRun.select().where((ReviewRun.task == s.task_id)
        & ReviewRun.status.in_(["running", "pending"])).count()) == 0

    def edit(flow):
        flow["nodes"][1]["prompt"] = "TASK_AFTER_STOP"
        flow["nodes"].append(node("extra", ["Extra"], ["Report"]))
        flow["connections"] += [edge("test", "extra")]
    await s.save(edit)
    s.script.block = None
    assert await s.start("develop") == "completed"
    assert "TASK_AFTER_STOP" in s.script.select("develop")[-1]["prompt"]
    assert s.script.select("develop")[-1]["engine"] == "codex_sdk"
    assert len(s.script.select("extra")) == 1
    await s.unchanged_source()


@pytest.mark.anyio
async def test_task_and_other_task_inherit_source_addition_without_cross_contamination(scenario):
    s = scenario
    await s.save(lambda f: f["nodes"][1].update(engine="codex_sdk", prompt="TASK_ONLY"))
    assert await s.start() == "completed"

    def add_source(flow):
        flow["nodes"][1]["prompt"] = "SOURCE_V2"
        flow["nodes"].append(node("source_new", ["SourceNew"], ["Delivery"]))
        flow["connections"].append(edge("publish", "source_new"))
    await s.source_update(add_source)
    config = await s.config()
    assert {n["type"] for n in config["workflow"]["nodes"]} == {"requirements", "develop", "test", "publish", "source_new"}
    assert await s.start("develop") == "completed"
    assert s.script.select("develop")[-1]["engine"] == "codex_sdk"
    assert len(s.script.select("source_new")) == 1

    other = (await s.client.post(f"/api/task/create?project_id={s.pid}", json={"title": "ControlTask",
        "workflow_id": s.workflow_id, "auto_start": False})).json()["id"]
    before = len(s.script.select("develop"))
    handle = await s.runtime.start(s.pid, other)
    await asyncio.wait_for(s.runtime.wait(handle), 8)
    other_call = s.script.select("develop")[before]
    assert other_call["engine"] == "codex" and "SOURCE_V2" in other_call["prompt"]
    assert "TASK_ONLY" not in other_call["prompt"]
    assert await s.db(lambda _p: Task.get_by_id(other).workflow_overrides_json) is None
    await s.unchanged_source()


@pytest.mark.anyio
async def test_coordinator_starts_task_added_stage_using_effective_configuration(scenario):
    from agent_assistants.coordinator_actions import CoordinatorActionService
    from models import CoordinatorTurn
    from models.fields import utc_now
    import main
    s = scenario

    def add(flow):
        extra = node("extra", ["Extra"])
        extra.update(engine="codex_sdk", prompt="TASK_EXTRA_COORDINATOR")
        flow["nodes"].append(extra)
    await s.save(add)
    assert await s.start("requirements") == "completed"
    service = CoordinatorActionService(main.project_manager, s.runtime)

    def propose(project):
        task = Task.get_by_id(s.task_id)
        now = utc_now()
        user = Message.create(id=str(uuid4()), task=task, channel="coordinator", step_key="coordinator",
            role="user", content="start extra", sequence=100, position=0, created_at=now)
        assistant = Message.create(id=str(uuid4()), task=task, channel="coordinator", step_key="coordinator",
            role="assistant", content="proposal", sequence=101, position=1, created_at=now)
        turn = CoordinatorTurn.create(id=str(uuid4()), task=task, user_message=user,
            assistant_message=assistant, idempotency_key=str(uuid4()), status="succeeded", created_at=now)
        proposal = service.create_proposal(task, turn, assistant, {"proposal": {"type": "rerun_from_step",
            "target_step_key": "extra", "payload": {"content": "COORDINATOR_DYNAMIC_INPUT"}}}, project=project)
        assert proposal is not None
        return proposal.id
    proposal_id = await s.db(propose)
    key = str(uuid4())
    result = await service.confirm_action(s.pid, s.task_id, proposal_id, key)
    assert result["status"] == "succeeded"
    assert await s.idle() == "completed"
    assert len(s.script.select("extra")) == 1
    call = s.script.select("extra")[0]
    assert call["engine"] == "codex_sdk"
    assert "TASK_EXTRA_COORDINATOR" in call["prompt"] and "COORDINATOR_DYNAMIC_INPUT" in call["prompt"]
    await service.confirm_action(s.pid, s.task_id, proposal_id, key)
    assert len(s.script.select("extra")) == 1  # Idempotent confirmation cannot start it twice.
    await s.unchanged_source()


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["auto", "manual"])
async def test_task_review_override_reject_resume_and_engine_stays_local(scenario, mode):
    s = scenario

    def customize(flow):
        flow["nodes"][1].update(engine="codex_sdk", prompt="TASK_DEVELOP", review={
            "mode": mode, "auto": mode == "auto", "engine": "claude", "prompt": "TASK_REVIEW", "maxRetries": 2})

    await s.save(customize)
    s.script.reject_reviews = 1 if mode == "auto" else 0
    assert await s.start() == ("completed" if mode == "auto" else "paused")
    if mode == "manual":
        def pending(_p):
            return ReviewRun.get((ReviewRun.task == s.task_id) & (ReviewRun.status == "pending")).id
        # A source edit while waiting must not overwrite this task's review/engine.
        await s.source_update(lambda f: f["nodes"][1].update(engine="codex", prompt="SOURCE_CHANGED"))
        response = await s.client.post(f"/api/task/{s.task_id}/steps/develop/review/reject?project_id={s.pid}",
            json={"review_run_id": await s.db(pending), "comment": "MANUAL_BUG"})
        assert response.status_code == 200, response.text
        assert await s.idle() == "paused"
        assert "MANUAL_BUG" in s.script.select("develop")[-1]["prompt"]
        response = await s.client.post(f"/api/task/{s.task_id}/steps/develop/review/approve?project_id={s.pid}",
            json={"review_run_id": await s.db(pending)})
        assert response.status_code == 200, response.text
        assert await s.idle() == "completed"
    developers = s.script.select("develop")
    assert len(developers) == 2
    assert {call["engine"] for call in developers} == {"codex_sdk"}
    if mode == "auto":
        assert "TASK_REVIEW_BUG" in developers[1]["prompt"]
        assert all(call["engine"] == "claude" and "TASK_REVIEW" in call["prompt"] for call in s.script.select(channel="review"))
    await s.unchanged_source()


@pytest.mark.anyio
async def test_task_quick_engine_persists_across_followup_reset_and_sync(scenario):
    s = scenario
    assert await s.start() == "completed"
    original_session = s.script.select("develop")[-1]["session"]
    response = await s.client.patch(f"/api/task/{s.task_id}/step/develop/config?project_id={s.pid}",
        json={"engine": "codex_sdk", "model": "task-model", "config": {}, "context_mode": "full"})
    assert response.status_code == 200, response.text
    await s.runtime.resume_step_with_message(s.pid, s.task_id, "develop", "CHANGE_TO_B")
    assert await s.idle() == "completed"
    first_b = s.script.select("develop")[-1]
    assert first_b["engine"] == "codex_sdk" and first_b["session"] != original_session
    assert "CHANGE_TO_B" in first_b["prompt"]
    assert await s.start("develop") == "completed"
    assert s.script.select("develop")[-1]["session"] == first_b["session"]
    assert await s.start("develop", reset_session=True) == "completed"
    reset = s.script.select("develop")[-1]
    assert reset["engine"] == "codex_sdk" and reset["session"] != first_b["session"]
    before = len(s.script.calls)
    config = await s.config()
    response = await s.client.post(f"/api/task/{s.task_id}/workflow/sync?project_id={s.pid}", json={"revision": config["revision"]})
    assert response.status_code == 200, response.text
    assert not response.json()["has_overrides"] and len(s.script.calls) == before
    assert await s.start("develop") == "completed"
    assert s.script.select("develop")[-1]["engine"] == "codex"
    assert s.script.select("develop")[-1]["session"] != reset["session"]
    await s.unchanged_source()


@pytest.mark.anyio
async def test_inflight_configuration_is_frozen_then_new_stage_runs_after_stop(scenario):
    s = scenario
    await s.save(lambda f: f["nodes"][1].update(engine="codex_sdk", prompt="TASK_V1"))
    s.script.block = ("develop", "execution", 1)
    handle = await s.runtime.start(s.pid, s.task_id)
    await asyncio.wait_for(s.script.entered.wait(), 3)
    assert (await s.config())["editable"] is False
    await s.save(lambda f: f["nodes"].append(node("extra", ["Extra"])), expected=409)
    await s.source_update(lambda f: f["nodes"][2].update(prompt="SOURCE_TEST_V2"))
    s.script.release.set()
    await asyncio.wait_for(s.runtime.wait(handle), 8)
    assert "SOURCE_TEST_V2" not in s.script.select("test")[0]["prompt"]
    assert await s.idle() == "completed"

    def add(flow):
        flow["nodes"].append(node("extra", ["Extra"], ["Report"]))
        flow["connections"].remove(edge("test", "publish"))
        flow["connections"] += [edge("test", "extra"), edge("extra", "publish")]
    await s.save(add)
    assert await s.start("develop") == "completed"
    assert "SOURCE_TEST_V2" in s.script.select("test")[-1]["prompt"]
    assert len(s.script.select("extra")) == 1
    assert s.script.select("develop")[-1]["engine"] == "codex_sdk"
    await s.unchanged_source()


@pytest.mark.anyio
@pytest.mark.parametrize("channel", ["execution", "review"])
async def test_daemon_recovery_preserves_task_engine_and_only_restarts_interrupted_work(scenario, channel):
    from services.workflow_runtime import WorkflowRuntime
    import main
    s = scenario

    def customize(flow):
        flow["nodes"][1].update(engine="codex_sdk", prompt="TASK_RECOVERY")
        if channel == "review":
            flow["nodes"][1]["review"] = {"mode": "auto", "auto": True, "engine": "claude", "prompt": "TASK_REVIEW"}
    await s.save(customize)
    s.script.feedback_rounds = 1 if channel == "execution" else 0
    s.script.block = ("develop", channel, 2 if channel == "execution" else 1)
    await s.runtime.start(s.pid, s.task_id)
    await asyncio.wait_for(s.script.entered.wait(), 3)
    before = len(s.script.select("develop"))
    await s.runtime.shutdown()
    assert await s.db(lambda _p: WorkflowRun.get_by_id(Task.get_by_id(s.task_id).active_workflow_run_id).status) == "running"
    replacement = WorkflowRuntime(s.runtime._event_bus, main.project_manager)
    main.workflow_runtime = replacement
    s.script.block = None
    try:
        assert await replacement.recover_running_workflows() == 1
        assert await s.idle() == "completed"
        assert len(s.script.select("requirements")) == 1
        assert len(s.script.select("develop")) == before + (1 if channel == "execution" else 0)
        assert all(call["engine"] == "codex_sdk" for call in s.script.select("develop"))
        if channel == "review":
            assert len(s.script.select(channel="review")) == 2
            assert all("TASK_REVIEW" in call["prompt"] for call in s.script.select(channel="review"))
        await s.unchanged_source()
    finally:
        await replacement.shutdown()


@pytest.mark.anyio
async def test_network_failure_retry_uses_task_engine_without_duplicate_message(scenario):
    s = scenario
    await s.save(lambda f: f["nodes"][1].update(engine="codex_sdk", prompt="TASK_NETWORK"))
    s.script.failures = 2  # Exhaust the engine's automatic retry, then use the failed-message button.
    assert await s.start() == "paused"
    failed_id = await s.db(lambda _p: Message.select().where((Message.task == s.task_id)
        & (Message.step_key == "develop") & (Message.channel == "execution") & (Message.run_status == "failed")).get().id)
    assert len(s.script.select("develop")) == 2
    await s.runtime.retry_failed_message(s.pid, s.task_id, failed_id)
    assert await s.idle() == "completed"
    assert {call["engine"] for call in s.script.select("develop")} == {"codex_sdk"}
    assert await s.db(lambda _p: Message.get_by_id(failed_id).run_status) == "succeeded"
    assert await s.db(lambda _p: Message.select().where((Message.task == s.task_id)
        & (Message.step_key == "develop") & (Message.channel == "execution") & (Message.role == "assistant")).count()) == 1
    await s.unchanged_source()


@pytest.mark.anyio
async def test_late_parallel_branch_reexecutes_with_latest_custom_output(scenario, monkeypatch):
    import main
    s = scenario

    def customize(flow):
        flow["nodes"][1].update(engine="codex_sdk", prompt="TASK_PARALLEL")
        flow["nodes"][1]["outputs"].append({"name": "TaskExtra", "type": "md"})
        flow["nodes"].append(node("extra", ["Extra"], ["TaskExtra"]))
        flow["connections"] += [edge("develop", "extra", 2), edge("extra", "publish", 0, 1)]
    await s.save(customize)
    s.script.feedback_rounds = 1
    s.script.block = ("extra", "execution", 1)
    handle = await s.runtime.start(s.pid, s.task_id)
    await asyncio.wait_for(s.script.entered.wait(), 3)
    async with asyncio.timeout(3):
        while await s.db(lambda _p: TaskStep.get((TaskStep.task == s.task_id) & (TaskStep.step_key == "develop")).status) != "rework":
            await asyncio.sleep(.01)
    database = main.project_manager.get_project_by_id(s.pid).db
    execute = database.execute_sql
    entered = threading.Event()

    def slow_reconciliation(sql, params=None, commit=None):
        if sql.startswith(f'UPDATE "{TaskStep._meta.table_name}"') and "rework_waiting" in (params or ()):
            entered.set()
            time.sleep(.3)
        return execute(sql, params)
    monkeypatch.setattr(database, "execute_sql", slow_reconciliation)
    s.script.release.set()
    assert await asyncio.to_thread(entered.wait, 3)
    started = time.monotonic()
    assert (await s.client.get("/api/health")).status_code == 200
    assert time.monotonic() - started < .15
    await asyncio.wait_for(s.runtime.wait(handle), 8)
    assert await s.idle() == "completed"
    assert len(s.script.select("extra")) == 2
    assert "/develop/2/TaskExtra.md" in s.script.select("extra")[-1]["prompt"]
    assert "/extra/2/Extra.md" in s.script.select("publish")[0]["prompt"]


@pytest.mark.anyio
async def test_task_added_workflow_dispatch_and_child_task_configuration(scenario):
    s = scenario
    target = await s.client.post(f"/api/workflow/create?project_id={s.pid}",
        json={"name": "TargetFlow", "steps": s.source})
    assert target.status_code == 200, target.text
    target_id = target.json()["id"]

    def add_dispatch(flow):
        flow["nodes"][1].update(engine="codex_sdk", prompt="PARENT_ONLY")
        flow["nodes"].append({"id": "handoff", "type": "handoff", "title": "Handoff", "kind": "task_dispatch",
            "inputs": [{"name": "Delivery", "type": "md"}], "dispatch": {
                "targetProjectId": s.pid, "targetWorkflowId": target_id,
                "targetStartStepKey": "publish", "startMode": "immediate"}})
        flow["connections"].append(edge("publish", "handoff"))
    await s.save(add_dispatch)
    assert await s.start() == "completed"
    child = await s.db(lambda _p: Task.get(Task.source_task_id == s.task_id).id)
    async with asyncio.timeout(8):
        while child in s.runtime._runners:
            await asyncio.sleep(.01)
    statuses, delta = await s.db(lambda _p: (
        {row.step_key: row.status for row in TaskStep.select().where(TaskStep.task == child)},
        Task.get_by_id(child).workflow_overrides_json))
    assert statuses == {"requirements": "skipped", "develop": "skipped", "test": "skipped", "publish": "passed"}
    assert delta is None
    assert len(s.script.select("publish")) == 2
    assert s.script.select("publish")[-1]["engine"] == "codex"
    response = await s.client.patch(f"/api/task/{child}/step/publish/config?project_id={s.pid}",
        json={"engine": "codex_sdk", "model": "child-model", "config": {}})
    assert response.status_code == 200, response.text
    handle = await s.runtime.restart_from_step(s.pid, child, "publish")
    await asyncio.wait_for(s.runtime.wait(handle), 8)
    assert s.script.select("publish")[-1]["engine"] == "codex_sdk"
    assert "child-model" == s.script.select("publish")[-1]["model"]
    await s.unchanged_source()


@pytest.mark.anyio
async def test_source_removes_overridden_stage_fails_explicitly_and_sync_repairs(scenario):
    from services.task_workflow import WorkflowConflict
    s = scenario
    await s.save(lambda f: f["nodes"][1].update(engine="codex_sdk", prompt="TASK_DELETED_TARGET"))

    def remove(flow):
        flow["nodes"] = [n for n in flow["nodes"] if n["type"] != "develop"]
        flow["connections"] = [e for e in flow["connections"] if "develop" not in (e["from"], e["to"])]
        flow["connections"].append(edge("requirements", "test"))
    await s.source_update(remove)
    config = await s.config()
    assert config["conflict"] and "develop" in config["conflict"]
    with pytest.raises(WorkflowConflict):
        await s.runtime.start(s.pid, s.task_id)
    assert not s.script.calls
    response = await s.client.post(f"/api/task/{s.task_id}/workflow/sync?project_id={s.pid}", json={"revision": config["revision"]})
    assert response.status_code == 200, response.text
    assert not response.json()["has_overrides"] and not response.json()["conflict"]
    assert not s.script.calls
    assert await s.start("requirements") == "completed"
    assert not s.script.select("develop")
    await s.unchanged_source()


@pytest.mark.anyio
@pytest.mark.parametrize("source", ["manual", "schedule", "scheduled_start"])
async def test_all_start_origins_use_task_configuration_and_two_input_entry_context(scenario, source):
    s = scenario
    response = await s.client.post(f"/api/task/create?project_id={s.pid}", json={
        "title": "EntryTask", "description": "ENTRY_TASK_CONTEXT", "workflow_id": s.workflow_id,
        "start_step_key": "publish", "auto_start": False})
    assert response.status_code == 200, response.text
    target = Scenario(s.client, s.script, s.pid, response.json()["id"], s.workflow_id, s.source)

    def customize(flow):
        flow["nodes"][3].update(engine="codex_sdk", prompt="TASK_ENTRY_PROMPT")
        flow["nodes"].append(node("extra", ["Extra"], ["Delivery"]))
        flow["connections"].append(edge("publish", "extra"))
    await target.save(customize)
    assert await target.start(source=source) == "completed"
    assert not s.script.select("requirements") and not s.script.select("develop") and not s.script.select("test")
    assert len(s.script.select("publish")) == len(s.script.select("extra")) == 1
    call = s.script.select("publish")[0]
    assert call["engine"] == "codex_sdk"
    assert "ENTRY_TASK_CONTEXT" in call["prompt"] and "TASK_ENTRY_PROMPT" in call["prompt"]
    assert "Report" in call["prompt"] and "Extra" in call["prompt"]
    statuses = await target.db(lambda _p: {row.step_key: row.status for row in TaskStep.select().where(TaskStep.task == target.task_id)})
    assert all(statuses[key] == "skipped" for key in ("requirements", "develop", "test"))
    await s.unchanged_source()


@pytest.mark.anyio
async def test_copy_task_copies_overrides_but_not_sessions_or_execution_history(scenario):
    s = scenario

    def customize(flow):
        flow["nodes"][1].update(engine="codex_sdk", prompt="TASK_COPY_PROMPT")
        flow["nodes"].append(node("extra", ["Extra"], ["Delivery"]))
        flow["connections"].append(edge("publish", "extra"))
    await s.save(customize)
    assert await s.start() == "completed"
    original_session = s.script.select("develop")[-1]["session"]
    response = await s.client.post(f"/api/task/copy?project_id={s.pid}",
        json={"task_id": s.task_id, "newTitle": "CopiedTask"})
    assert response.status_code == 200, response.text
    clone = Scenario(s.client, s.script, s.pid, response.json()["id"], s.workflow_id, s.source)
    config = await clone.config()
    assert config["has_overrides"]
    assert {n["type"] for n in config["workflow"]["nodes"]} == {"requirements", "develop", "test", "publish", "extra"}
    assert await clone.db(lambda _p: all(row.session_id is None and row.status == "pending"
        for row in TaskStep.select().where(TaskStep.task == clone.task_id)))
    assert await clone.db(lambda _p: not Message.select().where(Message.task == clone.task_id).exists())
    assert await clone.start() == "completed"
    call = s.script.select("develop")[-1]
    assert call["engine"] == "codex_sdk" and "TASK_COPY_PROMPT" in call["prompt"]
    assert call["session"] != original_session
    await clone.save(lambda f: f["nodes"][1].update(prompt="CLONE_ONLY"))
    original = await s.config()
    assert next(n for n in original["workflow"]["nodes"] if n["type"] == "develop")["prompt"] == "TASK_COPY_PROMPT"
    await s.unchanged_source()
