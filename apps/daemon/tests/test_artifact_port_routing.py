"""Artifact-port routing across forward and feedback workflow connections."""

import re
from pathlib import Path

import pytest

from engines.core.events import InternalEvent
from engines.core.registry import ENGINE_REGISTRY
from models import StepRun, Task, TaskStep, WorkflowRun, init_db
from services.task_runner import TaskRunner
from services.artifact_rounds import ArtifactRound
from services.artifact_routing import (
    empty_routing_state,
    route_artifact_round,
    source_for_connection,
)
from services.pipeline import DAGScheduler, Step
from services.workflow_definition import WorkflowDefinition
from streaming.bus import EventBus


OUTPUT_PATH_RE = re.compile(r"output path: `([^`]+)`")


def test_legacy_manifest_routes_only_an_unambiguous_declared_output(tmp_path):
    artifact = ArtifactRound(
        round=1,
        path=tmp_path,
        manifest={
            "artifacts": [
                {"name": "draft", "path": "draft.md", "size": 5},
                {"name": "review", "path": "review.md", "size": 6},
            ],
        },
    )
    connection = {"id": "edge", "from": "write", "fromPort": 1}

    assert source_for_connection(
        connection,
        artifact,
        {"name": "review", "type": "md"},
    ) == {
        "edge_id": "edge",
        "kind": "solid",
        "step": "write",
        "output_port": 1,
        "round": 1,
        "name": "review",
        "path": str(tmp_path / "review.md"),
        "size": 6,
    }
    assert source_for_connection(connection, artifact) is None


def test_modern_empty_output_does_not_fall_back_to_artifact_list(tmp_path):
    artifact = ArtifactRound(
        round=1,
        path=tmp_path,
        manifest={
            "outputs": [],
            "artifacts": [{"name": "draft", "path": "draft.md", "size": 5}],
        },
    )

    assert source_for_connection(
        {"id": "edge", "from": "write", "fromPort": 0},
        artifact,
        {"name": "draft", "type": "md"},
    ) is None


def test_stage_return_limit_overrides_default(tmp_path):
    step = Step(
        key="test",
        label="测试",
        outputs=[{"name": "Bug列表", "type": "md"}],
        max_return_rounds=1,
        outgoing_connections=[{
            "id": "feedback",
            "from": "test",
            "fromPort": 0,
            "to": "develop",
            "toPort": 0,
            "kind": "dashed",
        }],
    )
    round_path = tmp_path / "1"
    round_path.mkdir()
    artifact = ArtifactRound(
        round=1,
        path=round_path,
        manifest={
            "outputs": [{
                "port": 0,
                "name": "Bug列表",
                "path": "Bug列表.md",
                "size": 4,
                "nonempty": True,
            }],
        },
    )

    first = route_artifact_round(
        step=step,
        artifact_round=artifact,
        routing_state=empty_routing_state(),
    )
    second = route_artifact_round(
        step=step,
        artifact_round=artifact,
        routing_state=first.state,
    )

    assert len(first.feedback_edges) == 1
    assert len(second.exhausted_edges) == 1


@pytest.mark.anyio
async def test_new_upstream_round_replaces_recovered_input_pin(tmp_path):
    """A reworked producer must move downstream off the round pinned at recovery."""
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="refresh-input-round-task",
        title="刷新输入轮次",
        cwd=str(tmp_path),
        workflow_id="flow",
        created_at=1,
        updated_at=1,
    )
    run = WorkflowRun.create(
        id="refresh-input-round-run",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    connection = {
        "id": "write-to-review",
        "from": "write",
        "fromPort": 0,
        "to": "review",
        "toPort": 0,
        "kind": "solid",
    }
    write = Step(
        key="write",
        label="编写",
        outputs=[{"name": "初稿", "type": "md"}],
        outgoing_connections=[connection],
    )
    review = Step(
        key="review",
        label="审校",
        inputs=[{"name": "初稿", "type": "md"}],
        depends_on=["write"],
        incoming_connections=[connection],
    )
    runner = TaskRunner(
        EventBus(),
        input_rounds_by_step={"review": {"write": 2}},
    )
    try:
        await runner._apply_artifact_routes(
            task=task,
            step=write,
            scheduler=DAGScheduler([write, review]),
            workflow_run=run,
            artifacts_dir=tmp_path / "artifacts",
            artifact_round=3,
            manifest={
                "outputs": [{
                    "port": 0,
                    "name": "初稿",
                    "path": "初稿.md",
                    "size": 12,
                    "nonempty": True,
                }],
            },
            completed=set(),
            failed=set(),
        )

        assert runner._input_rounds_by_step["review"]["write"] == 3
    finally:
        db.close()


class ArtifactWritingEngine:
    def __init__(self, stage: str, calls: dict[str, list[str]]):
        self.stage = stage
        self.calls = calls

    @property
    def supports_resume(self):
        return False

    async def spawn(self, prompt, cwd, **kwargs):
        self.calls[self.stage].append(prompt)
        paths = [path for path in OUTPUT_PATH_RE.findall(prompt)]
        if self.stage == "develop":
            for path in paths:
                from pathlib import Path

                target = Path(path)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(
                    "API v1" if target.name == "API文档.md" else "实现完成",
                    encoding="utf-8",
                )
        elif self.stage == "test":
            from pathlib import Path

            test_attempt = len(self.calls[self.stage])
            wanted = "Bug列表.md" if test_attempt == 1 else "测试报告.md"
            target = next(Path(path) for path in paths if Path(path).name == wanted)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("BUG-1" if test_attempt == 1 else "全部通过", encoding="utf-8")
        elif self.stage == "publish":
            from pathlib import Path

            target = Path(paths[0])
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("交付完成", encoding="utf-8")
        else:
            from pathlib import Path

            for path in paths:
                target = Path(path)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(f"{self.stage} output", encoding="utf-8")
        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": f"{self.stage} done"}},
        )

    async def stop(self):
        return None


@pytest.mark.anyio
async def test_nonempty_feedback_output_reworks_target_before_forward_branch(tmp_path):
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="artifact-routing-task",
        title="研发任务",
        description="PRD：实现订单查询接口",
        cwd=str(tmp_path),
        workflow_id="flow",
        created_at=1,
        updated_at=1,
    )
    workflow = {
        "nodes": [
            {
                "id": 1,
                "type": "requirements",
                "title": "需求",
                "engine": "requirements-engine",
                "outputs": [{"name": "PRD", "type": "md"}],
            },
            {
                "id": 2,
                "type": "develop",
                "title": "开发",
                "engine": "develop-engine",
                "inputs": [{"name": "PRD"}, {"name": "Bug列表"}],
                "outputs": [
                    {"name": "API文档", "type": "md"},
                    {"name": "开发修复结果", "type": "md"},
                ],
            },
            {
                "id": 3,
                "type": "test",
                "title": "测试",
                "engine": "test-engine",
                "inputs": [{"name": "API文档"}, {"name": "开发修复结果"}],
                "outputs": [
                    {"name": "测试报告", "type": "md"},
                    {"name": "Bug列表", "type": "md"},
                ],
            },
            {
                "id": 4,
                "type": "publish",
                "title": "交付",
                "engine": "publish-engine",
                "inputs": [{"name": "测试报告"}],
                "outputs": [{"name": "成品", "type": "md"}],
            },
        ],
        "connections": [
            {"from": 1, "fromPort": 0, "to": 2, "toPort": 0, "kind": "solid"},
            {"from": 2, "fromPort": 0, "to": 3, "toPort": 0, "kind": "solid"},
            {"from": 2, "fromPort": 1, "to": 3, "toPort": 1, "kind": "solid"},
            {"from": 3, "fromPort": 0, "to": 4, "toPort": 0, "kind": "solid"},
            {"from": 3, "fromPort": 1, "to": 2, "toPort": 1, "kind": "dashed"},
        ],
    }
    run = WorkflowRun.create(
        id="artifact-routing-run",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    calls = {"requirements": [], "develop": [], "test": [], "publish": []}
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY.update({
        "requirements-engine": lambda: ArtifactWritingEngine("requirements", calls),
        "develop-engine": lambda: ArtifactWritingEngine("develop", calls),
        "test-engine": lambda: ArtifactWritingEngine("test", calls),
        "publish-engine": lambda: ArtifactWritingEngine("publish", calls),
    })
    try:
        await TaskRunner(EventBus()).run_pipeline(
            task,
            WorkflowDefinition.load(workflow).compile().to_steps_config(),
            tmp_path / "artifacts",
            workflow_run=run,
        )

        assert Task.get_by_id(task.id).status == "ready"
        assert {row.step_key: row.status for row in TaskStep.select()} == {
            "requirements": "passed",
            "develop": "passed",
            "test": "passed",
            "publish": "passed",
        }
        attempts = {
            key: StepRun.select().where(
                (StepRun.run == run) & (StepRun.step_key == key)
            ).count()
            for key in ("requirements", "develop", "test", "publish")
        }
        assert attempts == {
            "requirements": 1, "develop": 2, "test": 2, "publish": 1,
        }
        assert "PRD：实现订单查询接口" in calls["develop"][1]
        assert "PRD.md" in calls["develop"][1]
        assert "Bug列表.md" in calls["develop"][1]
        assert "Execution type: `feedback`" in calls["develop"][1]
        assert "测试报告.md" in calls["publish"][0]
        assert "Bug列表.md" not in calls["publish"][0]
        run = WorkflowRun.get_by_id(run.id)
        assert '"connection-4": 1' in run.routing_state_json
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_feedback_connection_stops_after_three_returns(tmp_path):
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="return-limit-task",
        title="返工上限",
        cwd=str(tmp_path),
        workflow_id="flow",
        created_at=1,
        updated_at=1,
    )
    workflow = {
        "nodes": [
            {
                "id": 1, "type": "develop", "title": "开发",
                "engine": "develop-engine",
                "outputs": [{"name": "修复结果", "type": "md"}],
            },
            {
                "id": 2, "type": "test", "title": "测试",
                "engine": "always-feedback-engine",
                "inputs": [{"name": "修复结果"}],
                "outputs": [{"name": "Bug列表", "type": "md"}],
            },
        ],
        "connections": [
            {"from": 1, "fromPort": 0, "to": 2, "toPort": 0, "kind": "solid"},
            {"from": 2, "fromPort": 0, "to": 1, "toPort": 0, "kind": "dashed"},
        ],
    }
    run = WorkflowRun.create(
        id="return-limit-run",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    calls = {"develop": [], "test": []}

    class AlwaysFeedbackEngine(ArtifactWritingEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            from pathlib import Path

            self.calls[self.stage].append(prompt)
            target = Path(OUTPUT_PATH_RE.findall(prompt)[0])
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("仍有缺陷", encoding="utf-8")
            yield InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": "test done"}},
            )

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY.update({
        "develop-engine": lambda: ArtifactWritingEngine("develop", calls),
        "always-feedback-engine": lambda: AlwaysFeedbackEngine("test", calls),
    })
    try:
        await TaskRunner(EventBus()).run_pipeline(
            task,
            WorkflowDefinition.load(workflow).compile().to_steps_config(),
            tmp_path / "artifacts",
            workflow_run=run,
        )

        assert Task.get_by_id(task.id).status == "paused"
        test_step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "test")
        )
        assert test_step.status == "failed"
        assert "3 次" in test_step.error
        assert len(calls["develop"]) == 4
        assert len(calls["test"]) == 4
        run = WorkflowRun.get_by_id(run.id)
        assert '"connection-1": 3' in run.routing_state_json
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_review_rejection_cannot_bypass_artifact_feedback_route(tmp_path):
    """Canvas feedback waits for an approved artifact; review rejection retries locally."""
    import json
    from pathlib import Path

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="review-before-route-task",
        title="审核与返回解耦",
        cwd=str(tmp_path),
        workflow_id="flow",
        created_at=1,
        updated_at=1,
    )
    workflow = {
        "nodes": [
            {
                "id": 1, "type": "develop", "title": "开发",
                "engine": "develop-engine",
                "outputs": [{"name": "修复结果", "type": "md"}],
            },
            {
                "id": 2, "type": "test", "title": "测试",
                "engine": "test-engine",
                "inputs": [{"name": "修复结果"}],
                "outputs": [
                    {"name": "测试报告", "type": "md"},
                    {"name": "Bug列表", "type": "md"},
                ],
                "review": {
                    "mode": "auto", "auto": True, "maxRetries": 1,
                    "engine": "review-engine", "prompt": "检查测试产物",
                },
            },
        ],
        "connections": [
            {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
            {
                "from": 2, "fromPort": 1, "to": 1, "toPort": 0,
                "kind": "dashed",
            },
        ],
    }
    run = WorkflowRun.create(
        id="review-before-route-run",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    calls = {"develop": [], "test": [], "review": []}

    class TestThenPassEngine(ArtifactWritingEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            self.calls[self.stage].append(prompt)
            wanted = "Bug列表.md" if len(self.calls[self.stage]) <= 2 else "测试报告.md"
            target = next(
                Path(value)
                for value in OUTPUT_PATH_RE.findall(prompt)
                if Path(value).name == wanted
            )
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("非空", encoding="utf-8")
            yield InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": "test done"}},
            )

    class RejectOnceReviewEngine(ArtifactWritingEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            self.calls[self.stage].append(prompt)
            passed = len(self.calls[self.stage]) > 1
            yield InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": json.dumps({
                    "passed": passed,
                    "score": 90 if passed else 40,
                    "summary": "通过" if passed else "测试产物需重试",
                    "issues": [] if passed else [{
                        "severity": "error",
                        "category": "quality",
                        "description": "格式不完整",
                        "suggestion": "重新生成",
                    }],
                }, ensure_ascii=False)}},
            )

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY.update({
        "develop-engine": lambda: ArtifactWritingEngine("develop", calls),
        "test-engine": lambda: TestThenPassEngine("test", calls),
        "review-engine": lambda: RejectOnceReviewEngine("review", calls),
    })
    try:
        await TaskRunner(EventBus()).run_pipeline(
            task,
            WorkflowDefinition.load(workflow).compile().to_steps_config(),
            tmp_path / "artifacts",
            workflow_run=run,
        )

        assert Task.get_by_id(task.id).status == "ready"
        assert len(calls["develop"]) == 2
        assert len(calls["test"]) == 3
        assert len(calls["review"]) == 3
        run = WorkflowRun.get_by_id(run.id)
        assert '"connection-1": 1' in run.routing_state_json
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_missing_output_skips_only_its_connected_branch(tmp_path):
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="branch-routing-task",
        title="分支路由",
        cwd=str(tmp_path),
        workflow_id="flow",
        created_at=1,
        updated_at=1,
    )
    workflow = {
        "nodes": [
            {
                "id": 1, "type": "choose", "title": "选择",
                "engine": "choose-engine",
                "outputs": [
                    {"name": "路径A", "type": "md"},
                    {"name": "路径B", "type": "md"},
                ],
            },
            {
                "id": 2, "type": "branch_a", "title": "A",
                "engine": "branch-a-engine",
                "inputs": [{"name": "路径A"}],
                "outputs": [{"name": "结果A", "type": "md"}],
            },
            {
                "id": 3, "type": "branch_b", "title": "B",
                "engine": "branch-b-engine",
                "inputs": [{"name": "路径B"}],
                "outputs": [{"name": "结果B", "type": "md"}],
            },
        ],
        "connections": [
            {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
            {"from": 1, "fromPort": 1, "to": 3, "toPort": 0},
        ],
    }
    run = WorkflowRun.create(
        id="branch-routing-run",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    calls = {"choose": [], "branch_a": [], "branch_b": []}

    class FirstOutputOnlyEngine(ArtifactWritingEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            from pathlib import Path

            self.calls[self.stage].append(prompt)
            target = Path(OUTPUT_PATH_RE.findall(prompt)[0])
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("选择 A", encoding="utf-8")
            yield InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": "choose done"}},
            )

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY.update({
        "choose-engine": lambda: FirstOutputOnlyEngine("choose", calls),
        "branch-a-engine": lambda: ArtifactWritingEngine("branch_a", calls),
        "branch-b-engine": lambda: ArtifactWritingEngine("branch_b", calls),
    })
    try:
        await TaskRunner(EventBus()).run_pipeline(
            task,
            WorkflowDefinition.load(workflow).compile().to_steps_config(),
            tmp_path / "artifacts",
            workflow_run=run,
        )

        assert Task.get_by_id(task.id).status == "ready"
        statuses = {row.step_key: row.status for row in TaskStep.select()}
        assert statuses == {
            "choose": "passed",
            "branch_a": "passed",
            "branch_b": "skipped",
        }
        assert len(calls["branch_a"]) == 1
        assert calls["branch_b"] == []
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_manual_approval_routes_the_approved_artifact_port(tmp_path):
    from contextlib import nullcontext
    from types import SimpleNamespace

    from models import ReviewRun
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="manual-route-task",
        title="人工审核路由",
        cwd=str(tmp_path),
        created_at=1,
        updated_at=1,
    )
    workflow = {
        "nodes": [
            {
                "id": 1, "type": "source", "title": "来源",
                "engine": "source-engine",
                "outputs": [{"name": "有效产物", "type": "md"}],
                "review": {"mode": "manual", "auto": False, "maxRetries": 1},
            },
            {
                "id": 2, "type": "target", "title": "下游",
                "engine": "target-engine",
                "inputs": [{"name": "有效产物"}],
                "outputs": [{"name": "结果", "type": "md"}],
            },
        ],
        "connections": [
            {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
        ],
    }
    project = SimpleNamespace(
        id="manual-route-project",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps=workflow,
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

    calls = {"source": [], "target": []}
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY.update({
        "source-engine": lambda: ArtifactWritingEngine("source", calls),
        "target-engine": lambda: ArtifactWritingEngine("target", calls),
    })
    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
    try:
        first = await runtime.start(project.id, task.id, "")
        await runtime.wait(first)
        review = ReviewRun.get(ReviewRun.task == task)
        assert review.status == "pending"
        assert calls["target"] == []

        resumed = await runtime.decide_review(
            project.id,
            task.id,
            "source",
            review.id,
            "approve",
        )
        await runtime.wait(resumed)

        assert Task.get_by_id(task.id).status == "ready"
        assert len(calls["target"]) == 1
        assert "有效产物.md" in calls["target"][0]
    finally:
        await runtime.shutdown()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_manual_approval_of_feedback_artifact_resumes_target_rework(tmp_path):
    from contextlib import nullcontext
    from types import SimpleNamespace

    from models import ReviewRun
    from services.workflow_runtime import WorkflowRuntime

    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="manual-feedback-task",
        title="人工审核返回产物",
        description="PRD：修复订单接口",
        cwd=str(tmp_path),
        workflow_id="flow",
        created_at=1,
        updated_at=1,
    )
    workflow = {
        "nodes": [
            {
                "id": 1, "type": "develop", "title": "开发",
                "engine": "develop-engine",
                "inputs": [{"name": "PRD"}, {"name": "Bug列表"}],
                "outputs": [{"name": "修复结果", "type": "md"}],
            },
            {
                "id": 2, "type": "test", "title": "测试",
                "engine": "test-engine",
                "inputs": [{"name": "修复结果"}],
                "outputs": [
                    {"name": "测试报告", "type": "md"},
                    {"name": "Bug列表", "type": "md"},
                ],
                "review": {"mode": "manual", "auto": False, "maxRetries": 1},
            },
            {
                "id": 3, "type": "publish", "title": "交付",
                "engine": "publish-engine",
                "inputs": [{"name": "测试报告"}],
                "outputs": [{"name": "成品", "type": "md"}],
            },
        ],
        "connections": [
            {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
            {"from": 2, "fromPort": 0, "to": 3, "toPort": 0},
            {
                "from": 2, "fromPort": 1, "to": 1, "toPort": 1,
                "kind": "dashed",
            },
        ],
    }
    project = SimpleNamespace(
        id="manual-feedback-project",
        path=tmp_path,
        workstep_dir=tmp_path / ".workstep",
        steps=workflow,
        workflow_by_id=(
            lambda workflow_id: {"steps": workflow}
            if workflow_id == "flow" else None
        ),
    )

    class ProjectManagerStub:
        def activate_project_by_id(self, project_id):
            assert project_id == project.id
            return nullcontext(project)

    calls = {"develop": [], "test": [], "publish": []}
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY.update({
        "develop-engine": lambda: ArtifactWritingEngine("develop", calls),
        "test-engine": lambda: ArtifactWritingEngine("test", calls),
        "publish-engine": lambda: ArtifactWritingEngine("publish", calls),
    })
    runtime = WorkflowRuntime(EventBus(), ProjectManagerStub())
    try:
        first = await runtime.start(project.id, task.id, "")
        await runtime.wait(first)
        first_review = (
            ReviewRun.select()
            .where((ReviewRun.task == task) & (ReviewRun.status == "pending"))
            .get()
        )

        resumed = await runtime.decide_review(
            project.id,
            task.id,
            "test",
            first_review.id,
            "approve",
        )
        await runtime.wait(resumed)

        assert len(calls["develop"]) == 2
        assert len(calls["test"]) == 2
        assert "Bug列表.md" in calls["develop"][1]
        assert "Execution type: `feedback`" in calls["develop"][1]
        second_review = (
            ReviewRun.select()
            .where((ReviewRun.task == task) & (ReviewRun.status == "pending"))
            .get()
        )
        assert second_review.id != first_review.id

        finished = await runtime.decide_review(
            project.id,
            task.id,
            "test",
            second_review.id,
            "approve",
        )
        await runtime.wait(finished)

        assert Task.get_by_id(task.id).status == "ready"
        assert len(calls["publish"]) == 1
    finally:
        await runtime.shutdown()
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_forward_and_feedback_outputs_in_same_round_pause_as_conflict(tmp_path):
    db = init_db(str(tmp_path / "workstep.db"))
    task = Task.create(
        id="route-conflict-task",
        title="路由冲突",
        cwd=str(tmp_path),
        workflow_id="flow",
        created_at=1,
        updated_at=1,
    )
    workflow = {
        "nodes": [
            {
                "id": 1, "type": "develop", "title": "开发",
                "engine": "develop-engine",
                "outputs": [{"name": "开发结果", "type": "md"}],
            },
            {
                "id": 2, "type": "test", "title": "测试",
                "engine": "both-outputs-engine",
                "inputs": [{"name": "开发结果"}],
                "outputs": [
                    {"name": "测试报告", "type": "md"},
                    {"name": "Bug列表", "type": "md"},
                ],
            },
            {
                "id": 3, "type": "publish", "title": "交付",
                "engine": "publish-engine",
                "inputs": [{"name": "测试报告"}],
            },
        ],
        "connections": [
            {"from": 1, "fromPort": 0, "to": 2, "toPort": 0},
            {"from": 2, "fromPort": 0, "to": 3, "toPort": 0},
            {"from": 2, "fromPort": 1, "to": 1, "toPort": 0, "kind": "dashed"},
        ],
    }
    run = WorkflowRun.create(
        id="route-conflict-run",
        task=task,
        status="running",
        workflow_schema_version=1,
        workflow_snapshot_json="{}",
        started_at=1,
    )
    calls = {"develop": [], "test": [], "publish": []}

    class BothOutputsEngine(ArtifactWritingEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            from pathlib import Path

            self.calls[self.stage].append(prompt)
            for value in OUTPUT_PATH_RE.findall(prompt):
                target = Path(value)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("非空", encoding="utf-8")
            yield InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": "test done"}},
            )

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY.update({
        "develop-engine": lambda: ArtifactWritingEngine("develop", calls),
        "both-outputs-engine": lambda: BothOutputsEngine("test", calls),
        "publish-engine": lambda: ArtifactWritingEngine("publish", calls),
    })
    try:
        await TaskRunner(EventBus()).run_pipeline(
            task,
            WorkflowDefinition.load(workflow).compile().to_steps_config(),
            tmp_path / "artifacts",
            workflow_run=run,
        )

        assert Task.get_by_id(task.id).status == "paused"
        test_step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "test")
        )
        assert test_step.status == "failed"
        assert "路由冲突" in test_step.error
        assert len(calls["develop"]) == 1
        assert len(calls["test"]) == 1
        assert calls["publish"] == []
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()
