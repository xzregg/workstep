"""Tests for P3: DAGScheduler, prompt assembly, TaskRunner."""

import asyncio
import json
import re
import pytest
from pathlib import Path
from unittest.mock import patch

from services.pipeline import DAGScheduler, Step
from services.prompt import (
    SYSTEM_PROMPT,
    assemble_followup_prompt,
    assemble_prompt,
    assemble_retry_prompt,
)
from services.task_runner import TaskRunner
from engines.core.events import InternalEvent
from engines.core.acp_base import AcpEngineBase
from engines.core.interactions import elicitation_request
from streaming.bus import EventBus


# --- Step ---

def test_step_from_dict():
    s = Step.from_dict({
        "key": "req", "label": "需求", "engine": "claude",
        "prompt": "Write PRD", "dependsOn": [],
    })
    assert s.key == "req"
    assert s.engine == "claude"
    assert s.depends_on == []


def test_step_from_dict_legacy_id():
    """Supports 'id' as alias for 'key'."""
    s = Step.from_dict({"id": "do", "name": "执行", "prompt": "go"})
    assert s.key == "do"
    assert s.label == "执行"
    assert s.engine == "pydantic_ai"


# --- DAGScheduler ---

def test_dag_linear():
    steps = [
        Step(key="a", label="A", depends_on=[]),
        Step(key="b", label="B", depends_on=["a"]),
        Step(key="c", label="C", depends_on=["b"]),
    ]
    dag = DAGScheduler(steps)

    ready = dag.get_ready_steps(set())
    assert [s.key for s in ready] == ["a"]

    ready = dag.get_ready_steps({"a"})
    assert [s.key for s in ready] == ["b"]

    ready = dag.get_ready_steps({"a", "b"})
    assert [s.key for s in ready] == ["c"]

    ready = dag.get_ready_steps({"a", "b", "c"})
    assert ready == []


def test_dag_parallel_branch():
    """a → {b, c} → d (b and c can run in parallel)."""
    steps = [
        Step(key="a", label="A", depends_on=[]),
        Step(key="b", label="B", depends_on=["a"]),
        Step(key="c", label="C", depends_on=["a"]),
        Step(key="d", label="D", depends_on=["b", "c"]),
    ]
    dag = DAGScheduler(steps)

    # Initially only A is ready
    assert [s.key for s in dag.get_ready_steps(set())] == ["a"]

    # After A: B and C are both ready (parallel!)
    ready = dag.get_ready_steps({"a"})
    keys = sorted([s.key for s in ready])
    assert keys == ["b", "c"]

    # After A and B: C is still ready (it only depends on A, not B)
    ready = dag.get_ready_steps({"a", "b"})
    assert [s.key for s in ready] == ["c"]

    # After B and C: D is ready
    assert [s.key for s in dag.get_ready_steps({"a", "b", "c"})] == ["d"]


def test_dag_requires_each_solid_input_connection_to_be_activated():
    source = Step(
        key="test",
        label="测试",
        outputs=[{"name": "测试报告"}, {"name": "Bug列表"}],
        outgoing_connections=[
            {
                "id": "connection-0", "from": "test", "fromPort": 0,
                "to": "publish", "toPort": 0, "kind": "solid",
            },
            {
                "id": "connection-1", "from": "test", "fromPort": 1,
                "to": "develop", "toPort": 1, "kind": "dashed",
            },
        ],
    )
    publish = Step(
        key="publish",
        label="交付",
        depends_on=["test"],
        incoming_connections=[source.outgoing_connections[0]],
    )
    dag = DAGScheduler([source, publish])

    assert dag.get_ready_steps({"test"}, active_edges=set()) == []
    assert [
        step.key
        for step in dag.get_ready_steps(
            {"test"}, active_edges={"connection-0"}
        )
    ] == ["publish"]
    assert dag.get_ready_steps(
        {"test"}, active_edges={"connection-1"}
    ) == []


def test_dag_entry_step_accepts_each_boundary_input_as_task_context():
    c = Step(
        key="c",
        label="C",
        depends_on=["a", "b"],
        inputs=[{"name": "A2"}, {"name": "B1"}],
        incoming_connections=[
            {
                "id": "a2-to-c", "from": "a", "fromPort": 1,
                "to": "c", "toPort": 0, "kind": "solid",
            },
            {
                "id": "b1-to-c", "from": "b", "fromPort": 0,
                "to": "c", "toPort": 1, "kind": "solid",
            },
        ],
    )
    dag = DAGScheduler([
        Step(key="a", label="A"),
        Step(key="b", label="B"),
        c,
    ])

    assert dag.get_ready_steps({"a", "b"}, active_edges=set()) == []
    assert [
        step.key
        for step in dag.get_ready_steps(
            {"a", "b"},
            active_edges=set(),
            task_context_edges={"a2-to-c", "b1-to-c"},
        )
    ] == ["c"]


def test_dag_requires_all_three_connected_outputs_before_downstream_runs():
    connections = [
        {
            "id": f"connection-{port}",
            "from": "design",
            "fromPort": port,
            "to": "estimate",
            "toPort": 0,
            "kind": "solid",
        }
        for port in range(3)
    ]
    source = Step(
        key="design",
        label="方案设计",
        outputs=[
            {"name": "方案一", "type": "directory"},
            {"name": "方案二", "type": "directory"},
            {"name": "方案三", "type": "directory"},
        ],
        outgoing_connections=connections,
    )
    downstream = Step(
        key="estimate",
        label="工时评估",
        depends_on=["design"],
        incoming_connections=connections,
    )
    dag = DAGScheduler([source, downstream])

    assert dag.get_ready_steps(
        {"design"}, active_edges={"connection-0", "connection-1"}
    ) == []
    assert [step.key for step in dag.get_ready_steps(
        {"design"},
        active_edges={"connection-0", "connection-1", "connection-2"},
    )] == ["estimate"]


def test_dag_distinguishes_unselected_branch_from_missing_required_output():
    source = Step(
        key="source",
        label="来源",
        outputs=[
            {"name": "路径A", "type": "md"},
            {"name": "路径B", "type": "md"},
        ],
        outgoing_connections=[
            {
                "id": "edge-a",
                "from": "source",
                "fromPort": 0,
                "to": "branch-a",
                "toPort": 0,
                "kind": "solid",
            },
            {
                "id": "edge-b",
                "from": "source",
                "fromPort": 1,
                "to": "branch-b",
                "toPort": 0,
                "kind": "solid",
            },
        ],
    )
    branch_a = Step(
        key="branch-a",
        label="A",
        depends_on=["source"],
        incoming_connections=[source.outgoing_connections[0]],
    )
    branch_b = Step(
        key="branch-b",
        label="B",
        depends_on=["source"],
        incoming_connections=[source.outgoing_connections[1]],
    )
    dag = DAGScheduler([source, branch_a, branch_b])

    # A 已被选择时，B 是未选择的可选分支。
    assert [step.key for step in dag.get_skippable_steps(
        {"source"}, active_edges={"edge-a"}
    )] == ["branch-b"]
    assert dag.get_blocked_steps(
        {"source"}, active_edges={"edge-a"}
    ) == []

    # 来源没有激活任何正向输出时，不能把所有下游伪装成正常跳过。
    assert dag.get_skippable_steps({"source"}, active_edges=set()) == []
    assert {step.key for step in dag.get_blocked_steps(
        {"source"}, active_edges=set()
    )} == {"branch-a", "branch-b"}


def test_dag_running_excludes():
    """Running steps are excluded from ready list."""
    steps = [
        Step(key="a", label="A", depends_on=[]),
        Step(key="b", label="B", depends_on=[]),
    ]
    dag = DAGScheduler(steps)

    ready = dag.get_ready_steps(set(), running={"a"})
    assert [s.key for s in ready] == ["b"]


def test_dag_cycle_detection():
    steps = [
        Step(key="a", label="A", depends_on=["b"]),
        Step(key="b", label="B", depends_on=["a"]),
    ]
    with pytest.raises(ValueError, match="Cycle"):
        DAGScheduler(steps)


def test_dag_missing_dep():
    steps = [Step(key="a", label="A", depends_on=["nonexistent"])]
    with pytest.raises(ValueError, match="does not exist"):
        DAGScheduler(steps)


def test_dag_downstream():
    steps = [
        Step(key="a", label="A", depends_on=[]),
        Step(key="b", label="B", depends_on=["a"]),
        Step(key="c", label="C", depends_on=["a"]),
    ]
    dag = DAGScheduler(steps)
    ds = dag.get_downstream("a")
    assert sorted([s.key for s in ds]) == ["b", "c"]


def test_dag_topological_order():
    steps = [
        Step(key="c", label="C", depends_on=["b"]),
        Step(key="a", label="A", depends_on=[]),
        Step(key="b", label="B", depends_on=["a"]),
    ]
    dag = DAGScheduler(steps)
    order = dag.topological_order()
    assert order.index("a") < order.index("b") < order.index("c")


def test_dag_root_and_leaf():
    steps = [
        Step(key="a", label="A", depends_on=[]),
        Step(key="b", label="B", depends_on=["a"]),
        Step(key="c", label="C", depends_on=["a"]),
        Step(key="d", label="D", depends_on=["b", "c"]),
    ]
    dag = DAGScheduler(steps)
    assert [s.key for s in dag.root_steps] == ["a"]
    assert [s.key for s in dag.leaf_steps] == ["d"]


# --- Prompt assembly ---

def test_assemble_prompt_basic(tmp_path):
    from models import init_db, Task
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Test", description="Current task context",
        cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    step = Step(key="req", label="需求", prompt="Write a PRD")
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()

    prompt = assemble_prompt(task, step, artifacts_dir)
    assert SYSTEM_PROMPT in prompt
    assert "MEMORY" not in SYSTEM_PROMPT
    assert "You are" in SYSTEM_PROMPT
    assert all(ord(char) < 128 for char in SYSTEM_PROMPT)
    assert "## Task description\nCurrent task context" in prompt
    assert "## Task title\nTest" in prompt
    assert "You are executing one step in a WorkStep workflow." in prompt
    assert "## Step requirements\nWrite a PRD" in prompt
    assert not re.search(r"\bstage\b", prompt, re.IGNORECASE)
    assert "Write a PRD" in prompt
    assert f"artifacts/default/{task.id}/req" in prompt
    db.close()


def test_assemble_prompt_task_worktrees_keep_project_cwd(tmp_path):
    from models import Task, init_db
    import time

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id="task-123", title="Update B", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    workspace = tmp_path / ".workstep" / "worktrees" / task.id
    (workspace / "B").mkdir(parents=True)
    (workspace / "B" / ".git").write_text("gitdir: elsewhere")
    (workspace / "unrelated").mkdir()
    artifacts = tmp_path / ".workstep" / "artifacts"
    artifacts.mkdir()

    prompt = assemble_prompt(task, Step(key="build", label="Build", prompt="Edit code"), artifacts)
    assert f"Workspace directory: .workstep/worktrees/{task.id}" in prompt
    assert "Attached repositories: B." in prompt
    assert "Attached repositories: B, unrelated" not in prompt
    assert "The engine still starts in the project root" in prompt
    assert task.cwd == str(tmp_path)
    db.close()


def test_assemble_prompt_renders_step_template_variables(tmp_path):
    from models import init_db, Task
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()),
        title="修复登录问题",
        description="登录后偶发跳回首页",
        creator_name="小王",
        cwd=str(tmp_path),
        workflow_id="delivery",
        created_at=int(time.time()),
        updated_at=int(time.time()),
    )
    step = Step(
        key="develop",
        label="开发",
        prompt=(
            "请 {name}（{trigger_name}）处理 {task_title}。\n"
            "任务创建者：{creator_name} / {task_creator_name}\n"
            "任务：{task_description}\n"
            "步骤：{step_name}（{step_key}）\n"
            "全角变量：｛name｝\n"
            "工作区：{worktrees} / ｛worktrees｝\n"
            "未知变量：{custom_value}"
        ),
    )
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()

    prompt = assemble_prompt(task, step, artifacts_dir, trigger_name="小李")

    assert "请 小李（小李）处理 修复登录问题。" in prompt
    assert "任务创建者：小王 / 小王" in prompt
    assert "任务：登录后偶发跳回首页" in prompt
    assert "步骤：开发（develop）" in prompt
    assert "全角变量：小李" in prompt
    workspace = f".workstep/artifacts/delivery/{task.id}/.worktrees"
    assert f"工作区：{workspace} / {workspace}" in prompt
    assert "未知变量：{custom_value}" in prompt
    db.close()


def test_assemble_prompt_injects_project_memory(tmp_path):
    from models import init_db, Task
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Test", description="",
        cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    step = Step(key="req", label="需求", prompt="Write a PRD")
    artifacts_dir = tmp_path / ".workstep" / "artifacts"
    artifacts_dir.mkdir(parents=True)
    (tmp_path / ".workstep" / "MEMORY.md").write_text(
        "# 项目记忆\n\n## 约定\n使用中文注释", encoding="utf-8"
    )

    prompt = assemble_prompt(task, step, artifacts_dir)
    assert "## Project memory\n# 项目记忆" in prompt
    assert "使用中文注释" in prompt
    assert "Please view" not in prompt
    db.close()


def test_assemble_prompt_with_upstream(tmp_path):
    from models import init_db, Task
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Test", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    artifacts_dir = tmp_path / "artifacts"
    # Create upstream artifact
    req_dir = artifacts_dir / "default" / task.id / "req"
    req_dir.mkdir(parents=True)
    (req_dir / "prd.md").write_text("# PRD\nHello")

    step = Step(key="ui", label="UI", prompt="Design UI", depends_on=["req"])
    prompt = assemble_prompt(task, step, artifacts_dir)

    assert "Upstream artifacts" in prompt
    assert "prd.md" in prompt
    assert "Design UI" in prompt
    db.close()


def test_assemble_prompt_selects_latest_eligible_upstream_round(tmp_path):
    from models import init_db, Task
    from services.artifact_rounds import write_round_manifest
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Test", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    artifacts_dir = tmp_path / "artifacts"
    write_round_manifest(
        artifacts_root=artifacts_dir,
        workflow_id="default",
        task_id=task.id,
        step_key="req",
        artifact_round=1,
        status="passed",
        eligible_for_downstream=True,
    )
    write_round_manifest(
        artifacts_root=artifacts_dir,
        workflow_id="default",
        task_id=task.id,
        step_key="req",
        artifact_round=2,
        status="failed",
        eligible_for_downstream=False,
    )
    step = Step(key="ui", label="UI", prompt="Design UI", depends_on=["req"])

    prompt = assemble_prompt(task, step, artifacts_dir)

    assert "req (round 1)" in prompt
    assert "req/1/manifest.json" in prompt
    assert "req/2/manifest.json" not in prompt
    db.close()


def test_assemble_prompt_honours_explicit_upstream_round(tmp_path):
    from models import init_db, Task
    from services.artifact_rounds import write_round_manifest
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Test", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    artifacts_dir = tmp_path / "artifacts"
    for round_number in (1, 2):
        write_round_manifest(
            artifacts_root=artifacts_dir,
            workflow_id="default",
            task_id=task.id,
            step_key="req",
            artifact_round=round_number,
            status="passed",
            eligible_for_downstream=True,
        )
    step = Step(key="ui", label="UI", prompt="Design UI", depends_on=["req"])

    prompt = assemble_prompt(
        task,
        step,
        artifacts_dir,
        input_rounds={"req": 1},
        artifact_round=3,
    )

    assert "req (round 1)" in prompt
    assert "req/1/manifest.json" in prompt
    assert "req/2/manifest.json" not in prompt
    assert "ui/3" in prompt
    db.close()


def test_assemble_prompt_with_user_input(tmp_path):
    from models import init_db, Task
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Test", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    step = Step(key="do", label="Do", prompt="Do it")
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()

    prompt = assemble_prompt(task, step, artifacts_dir, user_input="Make it fast")
    assert "Make it fast" in prompt
    db.close()


def test_assemble_prompt_renders_dynamic_input_port_snapshot(tmp_path):
    from models import init_db, Task
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="研发任务", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    step = Step(
        key="develop",
        label="开发",
        prompt="完成本阶段工作",
        inputs=[{"name": "PRD"}, {"name": "Bug列表"}],
    )
    prd = tmp_path / "prd.md"
    bugs = tmp_path / "bugs.md"
    prd.write_text("需求", encoding="utf-8")
    bugs.write_text("BUG-1", encoding="utf-8")
    snapshot = {
        "execution_type": "feedback",
        "triggered_edges": ["connection-3"],
        "ports": [
            {
                "port": 0,
                "name": "PRD",
                "status": "ready",
                "sources": [{
                    "edge_id": "connection-0", "kind": "solid",
                    "step": "requirements", "output_port": 0,
                    "round": 1, "name": "PRD", "path": str(prd),
                    "size": prd.stat().st_size,
                }],
            },
            {
                "port": 1,
                "name": "Bug列表",
                "status": "ready",
                "sources": [{
                    "edge_id": "connection-3", "kind": "dashed",
                    "step": "test", "output_port": 1,
                    "round": 2, "name": "Bug列表", "path": str(bugs),
                    "size": bugs.stat().st_size,
                }],
            },
        ],
    }

    prompt = assemble_prompt(
        task,
        step,
        tmp_path / "artifacts",
        input_snapshot=snapshot,
    )

    assert "## Step execution context" in prompt
    assert "Execution reason: `feedback_revision`" in prompt
    assert "### Input: PRD" in prompt
    assert "### Input: Bug列表" in prompt
    assert "Input port" not in prompt
    assert "connection-0" not in prompt
    assert "connection-3" not in prompt
    assert "kind `solid`" not in prompt
    assert "kind `dashed`" not in prompt
    assert "Path: `prd.md`" in prompt
    assert "Path: `bugs.md`" in prompt
    assert "当前是首次开发" not in prompt
    assert "不是缺陷返工" not in prompt
    db.close()


def test_assemble_prompt_omits_inactive_feedback_input_and_its_outputs(tmp_path):
    from models import Task, init_db
    import time

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id="task", title="开发任务", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    step = Step(
        key="frontend", label="前端开发", prompt="实现前端功能",
        inputs=[
            {"name": "功能开发", "outputs": [
                {"name": "开发文档", "type": "md"},
                {"name": "分支名", "type": "md"},
            ]},
            {"name": "前端BUG 修复", "outputs": [
                {"name": "修复列表", "type": "md"},
            ]},
        ],
        outputs=[
            {"name": "开发文档", "type": "md"},
            {"name": "分支名", "type": "md"},
            {"name": "修复列表", "type": "md"},
        ],
        outgoing_connections=[
            {"fromPort": 0, "kind": "solid"},
            {"fromPort": 2, "kind": "solid"},
        ],
    )
    snapshot = {"execution_type": "forward", "ports": [
        {"port": 0, "name": "功能开发", "status": "ready", "sources": [
            {"name": "设计稿", "path": str(tmp_path / "design.html")},
        ]},
        {"port": 1, "name": "前端BUG 修复", "status": "inactive", "sources": []},
    ]}

    prompt = assemble_prompt(task, step, tmp_path / "artifacts", input_snapshot=snapshot)

    assert "### Input: 功能开发" in prompt
    assert "### Input: 前端BUG 修复" not in prompt
    assert "No artifact is available" not in prompt
    assert "开发文档" in prompt
    assert "分支名" in prompt
    assert "修复列表" not in prompt
    db.close()


def test_assemble_prompt_feedback_includes_only_feedback_port_outputs(tmp_path):
    from models import Task, init_db
    import time

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id="task", title="修复任务", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    step = Step(
        key="frontend", label="前端开发", prompt="处理任务",
        inputs=[
            {"name": "功能开发", "outputs": [{"name": "开发文档", "type": "md"}]},
            {"name": "前端BUG 修复", "outputs": [{"name": "修复列表", "type": "md"}]},
        ],
        outputs=[
            {"name": "开发文档", "type": "md"},
            {"name": "修复列表", "type": "md"},
        ],
    )
    snapshot = {"execution_type": "feedback", "ports": [
        {"port": 0, "name": "功能开发", "status": "inactive", "sources": []},
        {"port": 1, "name": "前端BUG 修复", "status": "ready", "sources": [
            {"kind": "dashed", "name": "Bug列表", "path": str(tmp_path / "bugs.md")},
        ]},
    ]}

    prompt = assemble_prompt(task, step, tmp_path / "artifacts", input_snapshot=snapshot)

    assert "### Input: 前端BUG 修复" in prompt
    assert "### Input: 功能开发" not in prompt
    assert "修复列表" in prompt
    assert "开发文档" not in prompt
    retry_prompt = assemble_retry_prompt(
        task, step, tmp_path / "artifacts", snapshot, artifact_round=2,
    )
    assert "修复列表" in retry_prompt
    assert "开发文档" not in retry_prompt
    followup_prompt = assemble_followup_prompt(
        task, step, tmp_path / "artifacts", "继续修复", input_snapshot=snapshot,
    )
    assert "修复列表" in followup_prompt
    assert "开发文档" not in followup_prompt
    db.close()


def test_assemble_prompt_with_only_inactive_input_has_no_artifact_contract(tmp_path):
    from models import Task, init_db
    import time

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id="task", title="开发任务", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    step = Step(
        key="frontend", label="前端开发", prompt="处理任务",
        inputs=[{"name": "前端BUG 修复", "outputs": [
            {"name": "修复列表", "type": "md"},
        ]}],
        outputs=[{"name": "修复列表", "type": "md"}],
    )
    snapshot = {"execution_type": "initial", "ports": [
        {"port": 0, "name": "前端BUG 修复", "status": "inactive", "sources": []},
    ]}

    prompt = assemble_prompt(task, step, tmp_path / "artifacts", input_snapshot=snapshot)

    assert "## Step execution context" not in prompt
    assert "## Output specification" not in prompt
    assert "## Artifact output directory" not in prompt
    assert "## Step requirements\n处理任务" in prompt
    db.close()


def test_assemble_prompt_tells_agent_to_inspect_directory_input(tmp_path):
    from models import init_db, Task
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="研发任务", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    step = Step(key="estimate", label="工时评估", prompt="评估方案")
    package = tmp_path / "solution-package"
    package.mkdir()
    snapshot = {
        "execution_type": "forward",
        "ports": [{
            "port": 0,
            "name": "方案包",
            "status": "ready",
            "sources": [{
                "step": "intake",
                "round": 2,
                "name": "方案包",
                "type": "directory",
                "is_dir": True,
                "path": str(package),
            }],
        }],
    }

    prompt = assemble_prompt(
        task,
        step,
        tmp_path / "artifacts",
        input_snapshot=snapshot,
    )

    assert "- Directory: `solution-package`" in prompt
    assert "Inspect this directory and read the files required for this step." in prompt
    db.close()


def test_assemble_prompt_ignores_legacy_rerun_messages_but_keeps_explicit_guidance(
    tmp_path,
):
    from models import init_db, StepSupplement, Task
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="研发任务", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    StepSupplement.create(
        id=str(uuid.uuid4()),
        task=task,
        step_key="do",
        content="历史普通重跑消息",
        created_sequence=1,
        active=True,
        created_at=int(time.time()),
    )
    StepSupplement.create(
        id=str(uuid.uuid4()),
        task=task,
        step_key="do",
        content="明确保存的阶段要求",
        origin="live_guidance",
        created_sequence=2,
        active=True,
        created_at=int(time.time()),
    )

    prompt = assemble_prompt(
        task,
        Step(key="do", label="执行", prompt="执行任务"),
        tmp_path / "artifacts",
    )

    assert "历史普通重跑消息" not in prompt
    assert "明确保存的阶段要求" in prompt
    db.close()


def test_assemble_followup_prompt_only_contains_message_and_output_requirements(tmp_path):
    """A resumed @stage turn relies on its engine session for prior context."""
    from models import init_db, Task
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Test", description="旧任务说明不应重复发送",
        cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    step = Step(key="do", label="Do", prompt="旧阶段要求不应重复发送", outputs=[
        {"name": "交付文档", "type": "md"},
    ])
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()

    prompt = assemble_followup_prompt(
        task, step, artifacts_dir, "只修改结论部分", trigger_name="小李"
    )

    assert "只修改结论部分" in prompt
    assert "## Triggered by\n小李" in prompt
    assert "旧任务说明不应重复发送" not in prompt
    assert "旧阶段要求不应重复发送" not in prompt
    assert SYSTEM_PROMPT not in prompt
    assert "交付文档.md" in prompt
    assert "必须生成或更新" not in prompt
    assert "you may omit artifacts or leave them empty" in prompt
    db.close()


def test_assemble_retry_prompt_only_contains_current_inputs_and_output_contract(tmp_path):
    from models import init_db, Task
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Test", description="不应重复的任务说明",
        cwd=str(tmp_path), created_at=int(time.time()), updated_at=int(time.time()),
    )
    step = Step(
        key="build",
        label="构建",
        prompt="不应重复的步骤要求",
        inputs=[{"name": "修改意见"}],
        outputs=[{"name": "交付文档", "type": "md"}],
    )
    feedback = tmp_path / "feedback.md"
    feedback.write_text("fix", encoding="utf-8")
    snapshot = {
        "execution_type": "feedback",
        "ports": [{
            "port": 0,
            "name": "修改意见",
            "status": "ready",
            "sources": [{
                "edge_id": "internal-edge",
                "kind": "dashed",
                "step": "review",
                "round": 2,
                "name": "修改意见",
                "path": str(feedback),
            }],
        }],
    }

    prompt = assemble_retry_prompt(
        task, step, tmp_path / "artifacts", snapshot, artifact_round=3
    )

    assert "## Step execution update" in prompt
    assert "Execution reason: `feedback_revision`" in prompt
    assert "Path: `feedback.md`" in prompt
    assert "交付文档.md" in prompt
    assert "不应重复的任务说明" not in prompt
    assert "不应重复的步骤要求" not in prompt
    assert "internal-edge" not in prompt
    db.close()


def test_assemble_prompt_unknown_output_type_uses_default_constraint(tmp_path):
    """Unknown output types fall back to the default constraint without crashing."""
    from models import init_db, Task
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Test", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    step = Step(key="do", label="Do", prompt="Do it", outputs=[
        {"name": "mystery", "type": "weird_type"},
    ])
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()

    prompt = assemble_prompt(task, step, artifacts_dir)
    assert "## Output specification" in prompt
    assert "mystery" in prompt
    assert "format requirement" in prompt
    db.close()


def test_assemble_prompt_empty_constraints_does_not_crash(tmp_path, monkeypatch):
    """An empty constraint table (missing config file) must not crash prompts."""
    import services.prompt as prompt_mod
    from models import init_db, Task
    import time, uuid

    monkeypatch.setattr(prompt_mod, "OUTPUT_TYPE_CONSTRAINTS", {})
    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Test", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    step = Step(key="do", label="Do", prompt="Do it", outputs=[
        {"name": "prd", "type": "md"},
    ])
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()

    prompt = assemble_prompt(task, step, artifacts_dir)
    assert "## Output specification" in prompt
    db.close()


def test_assemble_prompt_multi_output_avoids_generic_delegation_noise(tmp_path):
    """Output count alone must not inject unrelated subagent instructions."""
    from models import init_db, Task
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Test", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    step = Step(key="b", label="B", prompt="Produce outputs", outputs=[
        {"name": "b1", "type": "md"},
        {"name": "b2", "type": "md"},
    ])
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()

    prompt = assemble_prompt(task, step, artifacts_dir)
    assert "## Output specification" in prompt
    assert "b1" in prompt and "b2" in prompt
    assert "subagent" not in prompt
    assert "Delegation" not in prompt
    assert "you may omit artifacts or leave them empty" in prompt
    assert "every artifact has been written" not in prompt
    assert "produce exactly the following list" not in prompt
    assert "strictly follow the declared output specification" not in prompt
    db.close()


def test_assemble_prompt_only_exposes_routing_semantics_that_affect_output_choice(tmp_path):
    from models import init_db, Task
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Test", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    step = Step(
        key="test",
        label="测试",
        prompt="验证实现",
        outputs=[
            {"name": "测试报告", "type": "md"},
            {"name": "Bug列表", "type": "md"},
        ],
        outgoing_connections=[
            {"id": "edge-forward", "fromPort": 0, "to": "publish", "kind": "solid"},
            {"id": "edge-feedback", "fromPort": 1, "to": "develop", "kind": "dashed"},
        ],
    )

    prompt = assemble_prompt(task, step, tmp_path / "artifacts")

    assert "continues the workflow to step" not in prompt
    assert "requests revision of step" not in prompt
    assert "generate only when revision is required" in prompt
    assert "must not both be generated in the same execution" in prompt
    assert "`publish`" not in prompt
    assert "`develop`" not in prompt
    assert "edge-forward" not in prompt
    assert "edge-feedback" not in prompt
    assert "fromPort" not in prompt
    db.close()


def test_assemble_prompt_formats_dispatched_inputs_once_without_source_ids(tmp_path):
    from models import init_db, Task
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    artifact = tmp_path / "task-inputs" / "opaque-dispatch-id" / "design" / "brief.md"
    artifact.parent.mkdir(parents=True)
    artifact.write_text("brief", encoding="utf-8")
    task = Task.create(
        id=str(uuid.uuid4()),
        title="Child",
        description=(
            "原始任务说明\n\n## 来源任务\n项目：project-secret\n"
            "任务：task-secret\n步骤：handoff_123\n\n## 外部输入产物\n"
            f"- {artifact}"
        ),
        cwd=str(tmp_path),
        source_dispatch_id="dispatch-secret",
        source_project_id="project-secret",
        source_task_id="task-secret",
        source_step_key="handoff_123",
        input_manifest_json=json.dumps([{
            "source_project_id": "project-secret",
            "source_task_id": "task-secret",
            "source_step_key": "design",
            "source_round": 2,
            "name": "brief.md",
            "path": str(artifact),
        }]),
        created_at=int(time.time()),
        updated_at=int(time.time()),
    )
    step = Step(key="build", label="构建", prompt="完成构建")

    prompt = assemble_prompt(task, step, tmp_path / "artifacts")

    assert "## Task description\n原始任务说明" in prompt
    assert "## Upstream task inputs" in prompt
    assert "brief.md" in prompt
    assert "Source step: `design`" in prompt
    assert "Source round: 2" in prompt
    assert prompt.count(f"task-inputs/opaque-dispatch-id/design/brief.md") == 1
    assert "project-secret" not in prompt
    assert "task-secret" not in prompt
    assert "handoff_123" not in prompt
    assert "dispatch-secret" not in prompt
    db.close()


def test_assemble_prompt_single_output_no_subagent_section(tmp_path):
    """Single-output steps should not include subagent delegation guidance."""
    from models import init_db, Task
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Test", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    step = Step(key="a", label="A", prompt="Produce output", outputs=[
        {"name": "a1", "type": "md"},
    ])
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()

    prompt = assemble_prompt(task, step, artifacts_dir)
    assert "## Output specification" in prompt
    assert "subagent" not in prompt
    db.close()


def test_assemble_prompt_file_output_uses_single_file_path(tmp_path):
    """File outputs must point to a single file with the proper extension,
    not a per-artifact subdirectory."""
    from models import init_db, Task
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Test", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    step = Step(key="do", label="Do", prompt="Produce a doc", outputs=[
        {"name": "说明", "type": "md"},
        {"name": "数据", "type": "json"},
    ])
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()

    prompt = assemble_prompt(task, step, artifacts_dir)

    doc_path = f"artifacts/default/{task.id}/do/说明.md"
    data_path = f"artifacts/default/{task.id}/do/数据.json"
    assert prompt.count(doc_path) == 1
    assert prompt.count(data_path) == 1
    assert "## Artifact output directory" not in prompt
    assert ".workstep/artifacts/<workflow>/<task>/<stage>/<round>/" not in prompt
    assert "Write generated artifacts to the matching paths" not in prompt
    assert "one file" in prompt
    assert "do not wrap it in another same-named directory" in prompt
    db.close()


def test_assemble_prompt_directory_output_allows_multiple_files(tmp_path):
    """Directory outputs tell the engine to create a multi-file deliverable."""
    from models import init_db, Task
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Test", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    step = Step(key="design", label="设计", prompt="Produce prototypes", outputs=[
        {"name": "原型集合", "type": "directory"},
    ])
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()

    prompt = assemble_prompt(task, step, artifacts_dir)

    output_path = f"artifacts/default/{task.id}/design/原型集合/"
    assert "type: `directory`" in prompt
    assert "Directory artifact" in prompt
    assert "multiple files and subdirectories" in prompt
    assert "do not merge everything into one file" in prompt
    assert prompt.count(output_path) == 1
    assert "## Artifact output directory" not in prompt
    assert "Write generated artifacts to the matching paths" not in prompt
    db.close()


# --- TaskRunner integration ---

class PipelineFakeEngine(AcpEngineBase):
    @staticmethod
    def is_installed(): return True
    @staticmethod
    def get_version(): return "fake"
    @staticmethod
    def resolve_binary(): return "fake"

    def __init__(self, text="output"):
        self._text = text

    async def spawn(self, prompt, cwd, **kwargs):
        yield InternalEvent(type="agent_message_chunk", data={"content": {"text": self._text}})
        yield InternalEvent(type="status", data={"status": "done"})

    async def stop(self): pass
    async def inject_response(self, tool_use_id, content): pass
    @property
    def supports_resume(self): return False
    @property
    def supports_interactive(self): return False
    def build_resume_params(self, session_id): return {}


class PipelineUsageEngine(PipelineFakeEngine):
    """Fake engine that also emits a usage event with cache fields."""

    async def spawn(self, prompt, cwd, **kwargs):
        yield InternalEvent(type="agent_message_chunk", data={"content": {"text": self._text}})
        yield InternalEvent(type="usage_update", data={
            "input_tokens": 300,
            "output_tokens": 100,
            "cache_creation_input_tokens": 150,
            "cache_read_input_tokens": 120,
        })
        yield InternalEvent(type="status", data={"status": "done"})


@pytest.mark.anyio
async def test_initial_user_input_is_only_injected_into_its_target_step(tmp_path):
    from engines.core.registry import ENGINE_REGISTRY
    from models import Task, init_db
    import time

    prompts: list[str] = []

    class RecordingEngine(PipelineFakeEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            prompts.append(prompt)
            yield InternalEvent(
                type="agent_message_chunk",
                data={"content": {"text": "done"}},
            )

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id="targeted-user-input",
        title="Targeted input",
        cwd=str(tmp_path),
        created_at=int(time.time()),
        updated_at=int(time.time()),
    )
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["record-input"] = RecordingEngine
    try:
        await TaskRunner(
            EventBus(), initial_user_input_step_key="a"
        ).run_pipeline(
            task,
            {"steps": [
                {
                    "key": "a", "label": "A", "engine": "record-input",
                    "prompt": "Do A", "dependsOn": [],
                },
                {
                    "key": "b", "label": "B", "engine": "record-input",
                    "prompt": "Do B", "dependsOn": ["a"],
                },
            ]},
            tmp_path / "artifacts",
            user_input="只交给 A 的本轮补充",
        )
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()

    assert len(prompts) == 2
    assert "只交给 A 的本轮补充" in prompts[0]
    assert "只交给 A 的本轮补充" not in prompts[1]


class PipelineResumeEngine(PipelineFakeEngine):
    """Fake resume-capable engine that records the session ids it receives."""

    def __init__(self, text="output", seen=None):
        super().__init__(text)
        self.seen = seen if seen is not None else []

    @property
    def supports_resume(self):
        return True

    async def spawn(self, prompt, cwd, model=None, add_dirs=None, session_id=None, **kwargs):
        self.seen.append(session_id)
        active = session_id or f"sess-{len(self.seen)}"
        yield InternalEvent(type="session_started", data={"session_id": active})
        yield InternalEvent(type="agent_message_chunk", data={"content": {"text": self._text}})
        yield InternalEvent(type="status", data={"status": "done"})


class PipelineInteractionEngine(PipelineFakeEngine):
    def __init__(self):
        super().__init__("answered")
        self.responses: list[tuple[dict, dict]] = []

    async def spawn(self, prompt, cwd, **kwargs):
        yield elicitation_request(
            interaction_id="ask-pipeline",
            message="请选择实现范围",
            requested_schema={
                "type": "object",
                "properties": {"scope": {"type": "string"}},
                "required": ["scope"],
            },
            tool_call_id="ask-pipeline",
        )
        yield InternalEvent(type="agent_message_chunk", data={"content": {"text": "answered"}})
        yield InternalEvent(type="status", data={"status": "done"})

    async def respond_interaction(self, request, response):
        self.responses.append((request, response))
        return True


class PipelinePausedAfterInteractionEngine(PipelineInteractionEngine):
    def __init__(self):
        super().__init__()
        self.continue_after_response = asyncio.Event()

    async def spawn(self, prompt, cwd, **kwargs):
        yield elicitation_request(
            interaction_id="ask-pipeline",
            message="请选择实现范围",
            requested_schema={
                "type": "object",
                "properties": {"scope": {"type": "string"}},
                "required": ["scope"],
            },
            tool_call_id="ask-pipeline",
        )
        await self.continue_after_response.wait()
        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": "answered"}},
        )


class PipelinePlanEngine(PipelineFakeEngine):
    async def spawn(self, prompt, cwd, **kwargs):
        yield InternalEvent(type="tool_call", data={
            "tool_call_id": "todo-1",
            "title": "TodoWrite",
            "raw_input": {"todos": [
                {"content": "实现功能", "status": "in_progress"},
                {"content": "运行测试", "status": "pending"},
            ]},
        })
        yield InternalEvent(type="agent_message_chunk", data={"content": {"text": "done"}})


class PipelineJournalEngine(PipelineFakeEngine):
    async def spawn(self, prompt, cwd, **kwargs):
        yield InternalEvent(
            type="agent_thought_chunk",
            data={"content": {"text": "先分析"}},
        )
        yield InternalEvent(
            type="tool_call",
            data={"tool_call_id": "read-1", "title": "Read"},
        )
        yield InternalEvent(
            type="agent_message_chunk",
            data={"content": {"text": "最终回复"}},
        )


@pytest.mark.anyio
async def test_task_runner_persists_detailed_step_events_to_jsonl(tmp_path):
    """Stage history keeps its full process stream out of SQLite."""
    from models import init_db, Message, Task
    from engines.core.registry import ENGINE_REGISTRY
    import time
    import uuid

    workstep_dir = tmp_path / ".workstep"
    artifacts_dir = workstep_dir / "artifacts"
    workstep_dir.mkdir()
    db = init_db(str(workstep_dir / "workstep.db"))
    task = Task.create(
        id=str(uuid.uuid4()),
        title="Journal",
        cwd=str(tmp_path),
        engine="journal",
        created_at=int(time.time()),
        updated_at=int(time.time()),
    )
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["journal"] = PipelineJournalEngine
    try:
        await TaskRunner(EventBus()).run_pipeline(
            task,
            {"steps": [{
                "key": "a", "label": "A", "engine": "journal", "prompt": "Do A",
            }]},
            artifacts_dir,
        )

        message = Message.get((Message.task == task) & (Message.step_key == "a"))
        assert message.content == "最终回复"
        assert not message.events_json
        assert message.event_count == 3
        assert json.loads(message.event_summary_json)["thought_characters"] == 3

        event_log = workstep_dir / message.event_log_path
        records = [json.loads(line) for line in event_log.read_text().splitlines()]
        assert [record["type"] for record in records] == [
            "agent_thought_chunk",
            "tool_call",
            "agent_message_chunk",
        ]
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_task_runner_pauses_and_persists_interaction_round_trip(tmp_path):
    from models import init_db, Message, Task
    from engines.core.registry import ENGINE_REGISTRY
    from services.intervention import intervention_manager
    import time
    import uuid

    db = init_db(str(tmp_path / "interaction.db"))
    task = Task.create(
        id=str(uuid.uuid4()),
        title="Interaction",
        cwd=str(tmp_path),
        engine="interaction",
        created_at=int(time.time()),
        updated_at=int(time.time()),
    )
    engine = PipelineInteractionEngine()
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["interaction"] = lambda: engine
    try:
        bus = EventBus()
        runner = TaskRunner(bus)
        running = asyncio.create_task(runner.run_pipeline(
            task,
            {"steps": [{
                "key": "a",
                "label": "A",
                "engine": "interaction",
                "prompt": "Do A",
            }]},
            tmp_path / "artifacts",
        ))
        for _ in range(100):
            if "ask-pipeline" in intervention_manager.list_pending():
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("interaction was not registered")

        pending_message = Message.get(
            (Message.task == task) & (Message.step_key == "a")
        )
        assert [
            event["type"] for event in json.loads(pending_message.events_json)
        ] == ["interaction_request"]
        assert pending_message.run_status == "running"

        response = {
            "action": "accept",
            "content": {"scope": "backend"},
        }
        assert intervention_manager.deliver_response("ask-pipeline", response)
        await running

        assert engine.responses == [(
            {
                "interaction_id": "ask-pipeline",
                "method": "elicitation/create",
                "message": "请选择实现范围",
                "requested_schema": {
                    "type": "object",
                    "properties": {"scope": {"type": "string"}},
                    "required": ["scope"],
                },
                "tool_call_id": "ask-pipeline",
            },
            response,
        )]
        message = Message.get((Message.task == task) & (Message.step_key == "a"))
        persisted = json.loads(message.events_json)
        assert [event["type"] for event in persisted] == [
            "interaction_request",
            "interaction_response",
        ]
        assert persisted[1]["data"]["response"] == response
        assert message.content == "answered"
        journal_events = [
            json.loads(line)
            for line in (tmp_path / message.event_log_path).read_text().splitlines()
        ]
        assert [event["type"] for event in journal_events] == [
            "interaction_request",
            "interaction_response",
            "agent_message_chunk",
            "status",
        ]
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        intervention_manager.cancel("ask-pipeline")
        db.close()


@pytest.mark.anyio
async def test_task_runner_persists_interaction_response_before_engine_continues(tmp_path):
    """刷新发生在审批后、引擎结束前时，历史也必须已包含响应。"""
    from models import init_db, Message, Task
    from engines.core.registry import ENGINE_REGISTRY
    from services.intervention import intervention_manager
    import time
    import uuid

    db = init_db(str(tmp_path / "interaction-response.db"))
    task = Task.create(
        id=str(uuid.uuid4()),
        title="Interaction response persistence",
        cwd=str(tmp_path),
        engine="interaction-paused",
        created_at=int(time.time()),
        updated_at=int(time.time()),
    )
    engine = PipelinePausedAfterInteractionEngine()
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["interaction-paused"] = lambda: engine
    runner = TaskRunner(EventBus())
    running = asyncio.create_task(runner.run_pipeline(
        task,
        {"steps": [{
            "key": "a",
            "label": "A",
            "engine": "interaction-paused",
            "prompt": "Do A",
        }]},
        tmp_path / "artifacts",
    ))
    try:
        for _ in range(100):
            if "ask-pipeline" in intervention_manager.list_pending():
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("interaction was not registered")

        response = {"action": "accept", "content": {"scope": "backend"}}
        assert intervention_manager.deliver_response("ask-pipeline", response)
        for _ in range(100):
            if engine.responses:
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("engine did not receive interaction response")

        message_events = await runner._run_db(lambda: json.loads(
            Message.get((Message.task == task) & (Message.step_key == "a")).events_json
        ))
        assert [event["type"] for event in message_events] == [
            "interaction_request",
            "interaction_response",
        ]
        assert message_events[1]["data"]["response"] == response
    finally:
        intervention_manager.cancel("ask-pipeline")
        engine.continue_after_response.set()
        await running
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_task_runner_persists_base_normalized_plan_snapshots(tmp_path):
    from models import init_db, Message, Task
    from engines.core.registry import ENGINE_REGISTRY
    import time
    import uuid

    db = init_db(str(tmp_path / "plan.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Plan", cwd=str(tmp_path), engine="plan",
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["plan"] = PipelinePlanEngine
    try:
        await TaskRunner(EventBus()).run_pipeline(
            task,
            {"steps": [{
                "key": "a", "label": "A", "engine": "plan", "prompt": "Do A",
            }]},
            tmp_path / "artifacts",
        )

        message = Message.get((Message.task == task) & (Message.step_key == "a"))
        events = json.loads(message.events_json)
        assert [event["type"] for event in events] == ["plan"]
        assert events[0]["data"]["entries"][0]["status"] == "in_progress"
        journal_events = [
            json.loads(line)
            for line in (tmp_path / message.event_log_path).read_text().splitlines()
        ]
        assert [event["type"] for event in journal_events] == [
            "plan", "agent_message_chunk",
        ]
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_task_runner_persists_usage_json(tmp_path):
    """TaskRunner persists the exact stage prompt and usage reported by the engine."""
    from models import init_db, Task, Message
    from engines.core.registry import ENGINE_REGISTRY
    import time, uuid, json as _json

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Usage", description="实现完整提示词展示", cwd=str(tmp_path),
        engine="claude",
        created_at=int(time.time()), updated_at=int(time.time()),
    )

    original = ENGINE_REGISTRY.copy()
    received_prompts: list[str] = []

    class CapturingUsageEngine(PipelineUsageEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            received_prompts.append(prompt)
            async for event in super().spawn(prompt, cwd, **kwargs):
                yield event

    ENGINE_REGISTRY["claude"] = lambda: CapturingUsageEngine("output")
    try:
        bus = EventBus()
        runner = TaskRunner(bus)

        steps_config = {
            "steps": [
                {"key": "a", "label": "A", "engine": "claude", "prompt": "Do A"},
            ]
        }
        artifacts_dir = tmp_path / "artifacts"
        artifacts_dir.mkdir()
        (tmp_path / "MEMORY.md").write_text("统一使用公开消息边界", encoding="utf-8")

        await runner.run_pipeline(task, steps_config, artifacts_dir)

        msg = Message.select().where(Message.task == task).get()
        persisted_prompt = _json.loads(msg.prompt_json)["prompt"]
        assert received_prompts == [persisted_prompt]
        assert persisted_prompt.startswith("You are executing one step")
        assert "## Project memory\n统一使用公开消息边界" in persisted_prompt
        assert "## Task description\n实现完整提示词展示" in persisted_prompt
        assert persisted_prompt.endswith(
            f"artifacts/default/{task.id}/a"
        )
        assert "## Step requirements\nDo A" in persisted_prompt
        assert msg.usage_json is not None
        usage = _json.loads(msg.usage_json)
        assert usage["input_tokens"] == 300
        assert usage["output_tokens"] == 100
        assert usage["cache_creation_input_tokens"] == 150
        assert usage["cache_read_input_tokens"] == 120
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_task_runner_step_session_id_isolated_and_reused(tmp_path):
    """同任务同阶段重跑复用同一 session id；不同阶段各自隔离。"""
    from models import init_db, Task, TaskStep
    from engines.core.registry import ENGINE_REGISTRY
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Session", cwd=str(tmp_path),
        engine="claude",
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    seen: list = []

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = lambda: PipelineResumeEngine("output", seen)
    try:
        bus = EventBus()
        runner = TaskRunner(bus)
        steps_config = {
            "steps": [
                {"key": "a", "label": "A", "engine": "claude", "prompt": "Do A"},
                {"key": "b", "label": "B", "engine": "claude", "prompt": "Do B", "dependsOn": ["a"]},
            ]
        }
        artifacts_dir = tmp_path / "artifacts"
        artifacts_dir.mkdir()

        await runner.run_pipeline(task, steps_config, artifacts_dir)
        step_a = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "a"))
        step_b = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "b"))
        assert step_a.session_id == "sess-1"
        assert step_b.session_id == "sess-2"
        assert step_a.session_id != step_b.session_id  # 阶段间会话隔离
        assert seen == [None, None]  # 首次运行两个阶段都没有历史会话

        # 重跑阶段 a：应复用上一次的 session id
        step_a.status = "pending"
        step_a.save()
        await runner.run_pipeline(task, steps_config, artifacts_dir)

        step_a = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "a"))
        assert step_a.session_id == "sess-1"
        assert seen == [None, None, "sess-1"]
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_task_runner_inherited_global_provider_change_starts_new_session(
    tmp_path,
):
    """沿用引擎配置时，全局供应商变化不得复用旧供应商会话。"""
    from models import init_db, Task, TaskStep
    from engines.core.registry import ENGINE_REGISTRY
    from services.config import config_store
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Provider switch", cwd=str(tmp_path),
        engine="claude",
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    seen: list = []
    provider = {"id": "provider-a"}

    class InheritedProviderResumeEngine(PipelineResumeEngine):
        ENGINE_ID = "claude"

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = lambda: InheritedProviderResumeEngine(
        "output", seen
    )
    try:
        runner = TaskRunner(EventBus())
        steps_config = {
            "steps": [
                {"key": "a", "label": "A", "engine": "claude", "prompt": "Do A"},
            ]
        }
        artifacts_dir = tmp_path / "artifacts"
        artifacts_dir.mkdir()

        with patch.object(
            config_store,
            "get_engine_provider",
            side_effect=lambda _engine_id: provider["id"],
        ):
            await runner.run_pipeline(task, steps_config, artifacts_dir)
            step = TaskStep.get(
                (TaskStep.task == task) & (TaskStep.step_key == "a")
            )
            assert step.session_id == "sess-1"
            assert step.session_provider == "provider-a"

            provider["id"] = "provider-b"
            step.status = "pending"
            step.save()
            await runner.run_pipeline(task, steps_config, artifacts_dir)

        step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "a")
        )
        assert seen == [None, None]
        assert step.session_id == "sess-2"
        assert step.session_provider == "provider-b"
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_task_runner_linear_pipeline(tmp_path):
    """Run a 2-step linear pipeline: A → B."""
    from models import init_db, Task
    from engines.core.registry import ENGINE_REGISTRY
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Pipeline", cwd=str(tmp_path),
        engine="claude",
        created_at=int(time.time()), updated_at=int(time.time()),
    )

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = lambda: PipelineFakeEngine("step output")
    try:
        bus = EventBus()
        runner = TaskRunner(bus)
        q = bus.subscribe()

        steps_config = {
            "steps": [
                {"key": "a", "label": "A", "engine": "claude", "prompt": "Do A"},
                {"key": "b", "label": "B", "engine": "claude", "prompt": "Do B", "dependsOn": ["a"]},
            ]
        }
        artifacts_dir = tmp_path / "artifacts"
        artifacts_dir.mkdir()

        await runner.run_pipeline(task, steps_config, artifacts_dir)

        # Collect events
        events = []
        while not q.empty():
            events.append(await q.get())
        bus.unsubscribe(q)

        # Both steps should have run
        from models import TaskStep
        steps = TaskStep.select().where(TaskStep.task == task)
        step_statuses = {s.step_key: s.status for s in steps}
        assert step_statuses == {"a": "passed", "b": "passed"}

        # Task should be done
        task = Task.get_by_id(task.id)
        assert task.status == "ready"

        # Should have events for both steps
        step_keys_in_events = {e.get("step_key") for e in events if "step_key" in e}
        assert "a" in step_keys_in_events
        assert "b" in step_keys_in_events

    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_task_runner_inherits_the_engine_default_model(tmp_path, monkeypatch):
    from engines.core.registry import ENGINE_REGISTRY
    from models import Task, init_db
    import services.task_runner as task_runner_module
    import time
    import uuid

    db = init_db(str(tmp_path / "default-model.db"))
    task = Task.create(
        id=str(uuid.uuid4()),
        title="Default model",
        cwd=str(tmp_path),
        engine="claude",
        created_at=int(time.time()),
        updated_at=int(time.time()),
    )
    received_models = []

    class RecordingEngine(PipelineFakeEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            received_models.append(kwargs.get("model"))
            yield InternalEvent(type="text_delta", data={"delta": "done"})

    monkeypatch.setattr(
        task_runner_module.config_store,
        "get_engine_default_model",
        lambda engine_id: "sonnet",
    )
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = RecordingEngine
    try:
        runner = TaskRunner(EventBus())
        await runner.run_pipeline(
            task,
            {"steps": [{"key": "a", "engine": "claude"}]},
            tmp_path / "artifacts",
        )

        assert received_models == ["sonnet"]
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_task_runner_starts_after_persisted_skipped_steps(tmp_path):
    """Skipped predecessors satisfy the DAG without invoking their engines."""
    from models import Task, TaskStep, init_db
    from engines.core.registry import ENGINE_REGISTRY
    import time
    import uuid

    db = init_db(str(tmp_path / "test.db"))
    now = int(time.time())
    task = Task.create(
        id=str(uuid.uuid4()),
        title="Frontend only",
        cwd=str(tmp_path),
        engine="claude",
        created_at=now,
        updated_at=now,
    )
    TaskStep.create(task=task, step_key="req", status="skipped")
    TaskStep.create(task=task, step_key="ui", status="skipped")
    TaskStep.create(task=task, step_key="frontend", status="pending")
    calls = []

    class RecordingEngine(PipelineFakeEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            calls.append(prompt)
            yield InternalEvent(type="text_delta", data={"delta": "frontend"})

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = RecordingEngine
    try:
        runner = TaskRunner(EventBus())
        await runner.run_pipeline(
            task,
            {
                "steps": [
                    {"key": "req", "engine": "claude"},
                    {"key": "ui", "engine": "claude", "dependsOn": ["req"]},
                    {
                        "key": "frontend",
                        "engine": "claude",
                        "dependsOn": ["ui"],
                    },
                ],
            },
            tmp_path / "artifacts",
        )

        statuses = {
            step.step_key: step.status
            for step in TaskStep.select().where(TaskStep.task == task)
        }
        assert statuses == {
            "req": "skipped",
            "ui": "skipped",
            "frontend": "passed",
        }
        assert len(calls) == 1
        assert "上游产物" not in calls[0]
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_task_runner_runs_explicit_entry_with_two_boundary_inputs(tmp_path):
    """An explicit entry uses task context instead of skipped upstream files."""
    from models import Task, TaskStep, init_db
    from engines.core.registry import ENGINE_REGISTRY
    import time
    import uuid

    db = init_db(str(tmp_path / "entry.db"))
    now = int(time.time())
    task = Task.create(
        id=str(uuid.uuid4()),
        title="Direct C",
        description="直接从 C 完成任务",
        cwd=str(tmp_path),
        engine="claude",
        created_at=now,
        updated_at=now,
    )
    TaskStep.create(task=task, step_key="a", status="skipped")
    TaskStep.create(task=task, step_key="b", status="skipped")
    TaskStep.create(task=task, step_key="c", status="pending")
    prompts = []

    class RecordingEngine(PipelineFakeEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            prompts.append(prompt)
            yield InternalEvent(type="text_delta", data={"delta": "c done"})

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = RecordingEngine
    try:
        runner = TaskRunner(
            EventBus(),
            execution_scope={"c"},
            entry_step_key="c",
        )
        await runner.run_pipeline(
            task,
            {
                "steps": [
                    {
                        "key": "a", "engine": "claude",
                        "outputs": [{"name": "A2"}],
                        "outgoingConnections": [{
                            "id": "a2-to-c", "from": "a", "fromPort": 0,
                            "to": "c", "toPort": 0, "kind": "solid",
                        }],
                    },
                    {
                        "key": "b", "engine": "claude",
                        "outputs": [{"name": "B1"}],
                        "outgoingConnections": [{
                            "id": "b1-to-c", "from": "b", "fromPort": 0,
                            "to": "c", "toPort": 1, "kind": "solid",
                        }],
                    },
                    {
                        "key": "c", "engine": "claude",
                        "dependsOn": ["a", "b"],
                        "inputs": [{"name": "A2"}, {"name": "B1"}],
                        "incomingConnections": [
                            {
                                "id": "a2-to-c", "from": "a", "fromPort": 0,
                                "to": "c", "toPort": 0, "kind": "solid",
                            },
                            {
                                "id": "b1-to-c", "from": "b", "fromPort": 0,
                                "to": "c", "toPort": 1, "kind": "solid",
                            },
                        ],
                    },
                ],
            },
            tmp_path / "artifacts",
            execution_scope={"c"},
        )

        assert len(prompts) == 1
        assert prompts[0].count("Use the task title, description, dispatched inputs") == 2
        assert TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "c")
        ).status == "passed"
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_task_runner_error_event_fails_step_and_blocks_downstream(tmp_path):
    """A reported engine error fails its step without retrying or unblocking dependants."""
    from models import init_db, Message, Task, TaskStep
    from engines.core.registry import ENGINE_REGISTRY
    import time, uuid

    class ReportedErrorEngine(PipelineFakeEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            yield InternalEvent(type="error", data={"message": "engine unavailable"})

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Failure", cwd=str(tmp_path),
        engine="claude",
        created_at=int(time.time()), updated_at=int(time.time()),
    )

    created_engines = 0

    def create_fake_engine():
        nonlocal created_engines
        created_engines += 1
        if created_engines == 1:
            return ReportedErrorEngine()
        return PipelineFakeEngine("must not run")

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = create_fake_engine
    try:
        bus = EventBus()
        runner = TaskRunner(bus)
        q = bus.subscribe()
        steps_config = {
            "steps": [
                {"key": "a", "label": "A", "engine": "claude", "prompt": "Do A"},
                {
                    "key": "b",
                    "label": "B",
                    "engine": "claude",
                    "prompt": "Do B",
                    "dependsOn": ["a"],
                },
            ]
        }
        artifacts_dir = tmp_path / "artifacts"
        artifacts_dir.mkdir()

        await runner.run_pipeline(task, steps_config, artifacts_dir)

        task = Task.get_by_id(task.id)
        steps = {
            step.step_key: step
            for step in TaskStep.select().where(TaskStep.task == task)
        }
        message = Message.get(
            (Message.task == task) & (Message.step_key == "a")
        )
        events = []
        while not q.empty():
            events.append(await q.get())

        assert created_engines == 1
        assert task.status == "paused"
        assert steps["a"].status == "failed"
        assert steps["a"].error == "engine unavailable"
        assert steps["b"].status == "pending"
        assert message.run_status == "failed"
        assert events[-1]["type"] == "RUN_ERROR"
        assert events[-1]["status"] == "failed"

    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_task_runner_cancel_step_finalizes_pipeline_records(tmp_path):
    """Cancelling a running step fails the run and leaves the pipeline paused."""
    from models import init_db, Message, Task, TaskStep
    from engines.core.registry import ENGINE_REGISTRY
    import time, uuid

    class BlockingPipelineEngine(PipelineFakeEngine):
        def __init__(self):
            super().__init__()
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def spawn(self, prompt, cwd, **kwargs):
            self.started.set()
            await self.release.wait()
            if False:
                yield InternalEvent(type="status", data={"status": "done"})

        async def stop(self):
            self.release.set()

    engine = BlockingPipelineEngine()
    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Cancel pipeline", cwd=str(tmp_path),
        engine="claude",
        created_at=int(time.time()), updated_at=int(time.time()),
    )

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = lambda: engine
    try:
        bus = EventBus()
        runner = TaskRunner(bus)
        q = bus.subscribe()
        steps_config = {
            "steps": [
                {"key": "a", "label": "A", "engine": "claude", "prompt": "Do A"},
            ]
        }
        artifacts_dir = tmp_path / "artifacts"
        artifacts_dir.mkdir()

        run = asyncio.create_task(
            runner.run_pipeline(task, steps_config, artifacts_dir)
        )
        await engine.started.wait()

        assert await runner.cancel_step(task.id, "a") is True
        await asyncio.wait_for(run, timeout=1)

        task = Task.get_by_id(task.id)
        step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "a")
        )
        message = Message.get(
            (Message.task == task) & (Message.step_key == "a")
        )
        events = []
        while not q.empty():
            events.append(await q.get())

        assert task.status == "paused"
        assert step.status == "cancelled"
        assert step.error == "手动停止"
        assert message.run_status == "cancelled"
        assert f"{task.id}:a" not in runner._running_engines
        assert events[-1]["type"] == "RUN_ERROR"
        assert events[-1]["status"] == "cancelled"

    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_task_runner_unavailable_engine_finalizes_message(tmp_path):
    """Engine selection failures finalize the message created for the step."""
    from models import init_db, Message, Task, TaskStep
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Missing engine", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    try:
        bus = EventBus()
        runner = TaskRunner(bus)
        steps_config = {
            "steps": [
                {
                    "key": "a",
                    "label": "A",
                    "engine": "definitely-missing",
                    "prompt": "Do A",
                },
            ]
        }
        artifacts_dir = tmp_path / "artifacts"
        artifacts_dir.mkdir()

        await runner.run_pipeline(task, steps_config, artifacts_dir)

        task = Task.get_by_id(task.id)
        step = TaskStep.get(
            (TaskStep.task == task) & (TaskStep.step_key == "a")
        )
        message = Message.get(
            (Message.task == task) & (Message.step_key == "a")
        )

        assert task.status == "paused"
        assert step.status == "failed"
        assert "not available" in step.error
        assert message.run_status == "failed"
        assert message.started_at is not None
        assert message.ended_at is not None

    finally:
        db.close()


@pytest.mark.anyio
async def test_task_runner_parallel_branches(tmp_path):
    """Run a pipeline with parallel branches: A → {B, C} → D."""
    from models import init_db, Task
    from engines.core.registry import ENGINE_REGISTRY
    import time, uuid

    db = init_db(str(tmp_path / "test.db"))
    task = Task.create(
        id=str(uuid.uuid4()), title="Parallel", cwd=str(tmp_path),
        engine="claude",
        created_at=int(time.time()), updated_at=int(time.time()),
    )

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = lambda: PipelineFakeEngine("parallel output")
    try:
        bus = EventBus()
        runner = TaskRunner(bus)

        steps_config = {
            "steps": [
                {"key": "a", "label": "A", "engine": "claude", "prompt": "Do A"},
                {"key": "b", "label": "B", "engine": "claude", "prompt": "Do B", "dependsOn": ["a"]},
                {"key": "c", "label": "C", "engine": "claude", "prompt": "Do C", "dependsOn": ["a"]},
                {"key": "d", "label": "D", "engine": "claude", "prompt": "Do D", "dependsOn": ["b", "c"]},
            ]
        }
        artifacts_dir = tmp_path / "artifacts"
        artifacts_dir.mkdir()

        await runner.run_pipeline(task, steps_config, artifacts_dir)

        from models import TaskStep
        steps = TaskStep.select().where(TaskStep.task == task)
        step_statuses = {s.step_key: s.status for s in steps}
        assert step_statuses == {"a": "passed", "b": "passed", "c": "passed", "d": "passed"}

        task = Task.get_by_id(task.id)
        assert task.status == "ready"

    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_new_workflow_run_executes_steps_again(tmp_path):
    """A new workflow run creates a new attempt instead of reusing prior success."""
    from models import Message, StepRun, Task, WorkflowRun, init_db
    from engines.core.registry import ENGINE_REGISTRY
    import time
    import uuid

    db = init_db(str(tmp_path / "test.db"))
    now = int(time.time())
    task = Task.create(
        id=str(uuid.uuid4()),
        title="Run twice",
        cwd=str(tmp_path),
        engine="claude",
        created_at=now,
        updated_at=now,
    )
    calls = 0

    class CountingEngine(PipelineFakeEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            nonlocal calls
            calls += 1
            yield InternalEvent(type="text_delta", data={"delta": f"run-{calls}"})

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = CountingEngine
    try:
        runner = TaskRunner(EventBus())
        steps_config = {
            "steps": [
                {"key": "build", "label": "Build", "engine": "claude"},
            ]
        }
        artifacts_dir = tmp_path / "artifacts"
        artifacts_dir.mkdir()

        first_run = WorkflowRun.create(
            id=str(uuid.uuid4()),
            task=task,
            workflow_schema_version=1,
            workflow_snapshot_json="{}",
            started_at=now,
        )
        await runner.run_pipeline(
            task,
            steps_config,
            artifacts_dir,
            workflow_run=first_run,
        )

        second_run = WorkflowRun.create(
            id=str(uuid.uuid4()),
            task=task,
            workflow_schema_version=1,
            workflow_snapshot_json="{}",
            started_at=now + 1,
        )
        await runner.run_pipeline(
            task,
            steps_config,
            artifacts_dir,
            workflow_run=second_run,
        )

        assert calls == 2
        assert StepRun.select().count() == 2
        assert Message.select().count() == 2
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_failed_execution_retries_within_the_same_artifact_round(tmp_path):
    """A transient engine error retries inside the same step attempt."""
    from models import StepRun, Task, WorkflowRun, init_db
    from engines.core.registry import ENGINE_REGISTRY
    import time
    import uuid

    db = init_db(str(tmp_path / "test.db"))
    now = int(time.time())
    task = Task.create(
        id=str(uuid.uuid4()),
        title="Retry failed execution",
        cwd=str(tmp_path),
        engine="claude",
        created_at=now,
        updated_at=now,
    )
    calls = 0

    class FailThenSucceedEngine(PipelineFakeEngine):
        async def spawn(self, prompt, cwd, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                yield InternalEvent(
                    type="error",
                    data={"message": "engine crashed"},
                )
                return
            yield InternalEvent(
                type="text_delta",
                data={"delta": "retry succeeded"},
            )
            yield InternalEvent(type="status", data={"status": "done"})

    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = FailThenSucceedEngine
    try:
        runner = TaskRunner(EventBus())
        steps_config = {
            "steps": [
                {"key": "build", "label": "Build", "engine": "claude"},
            ]
        }
        artifacts_dir = tmp_path / "artifacts"
        artifacts_dir.mkdir()
        first_run = WorkflowRun.create(
            id=str(uuid.uuid4()),
            task=task,
            workflow_schema_version=1,
            workflow_snapshot_json="{}",
            started_at=now,
        )
        await runner.run_pipeline(
            task,
            steps_config,
            artifacts_dir,
            workflow_run=first_run,
        )
        round_dir = artifacts_dir / "default" / task.id / "build" / "1"

        step_runs = list(
            StepRun.select()
            .where(StepRun.step_key == "build")
            .order_by(StepRun.started_at)
        )
        assert calls == 2
        assert [(run.status, run.artifact_round) for run in step_runs] == [
            ("succeeded", 1),
        ]
        assert round_dir.is_dir()
        manifest = json.loads(
            (round_dir / "manifest.json").read_text(encoding="utf-8")
        )
        assert manifest["round"] == 1
        assert manifest["status"] == "passed"
        assert manifest["eligible_for_downstream"] is True
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()


@pytest.mark.anyio
async def test_cancelled_execution_does_not_consume_artifact_round(tmp_path):
    """A user-cancelled execution also reuses the round on the next success."""
    from models import StepRun, Task, WorkflowRun, init_db
    from engines.core.registry import ENGINE_REGISTRY
    import time
    import uuid

    class BlockingEngine(PipelineFakeEngine):
        def __init__(self):
            super().__init__()
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def spawn(self, prompt, cwd, **kwargs):
            self.started.set()
            await self.release.wait()
            if False:
                yield InternalEvent(type="status", data={"status": "done"})

        async def stop(self):
            self.release.set()

    engine = BlockingEngine()
    db = init_db(str(tmp_path / "test.db"))
    now = int(time.time())
    task = Task.create(
        id=str(uuid.uuid4()),
        title="Cancel execution round",
        cwd=str(tmp_path),
        engine="claude",
        created_at=now,
        updated_at=now,
    )
    original = ENGINE_REGISTRY.copy()
    ENGINE_REGISTRY["claude"] = lambda: engine
    try:
        bus = EventBus()
        runner = TaskRunner(bus)
        artifacts_dir = tmp_path / "artifacts"
        artifacts_dir.mkdir()
        workflow_run = WorkflowRun.create(
            id=str(uuid.uuid4()),
            task=task,
            workflow_schema_version=1,
            workflow_snapshot_json="{}",
            started_at=now,
        )
        pipeline = asyncio.create_task(
            runner.run_pipeline(
                task,
                {"steps": [{"key": "build", "engine": "claude"}]},
                artifacts_dir,
                workflow_run=workflow_run,
            )
        )
        await engine.started.wait()
        assert await runner.cancel_step(task.id, "build") is True
        await pipeline

        step_run = StepRun.get(
            (StepRun.run == workflow_run) & (StepRun.step_key == "build")
        )
        assert step_run.status == "failed"
        assert step_run.artifact_round is None
        assert (
            artifacts_dir / "default" / task.id / "build" / "1"
        ).exists() is False
    finally:
        ENGINE_REGISTRY.clear()
        ENGINE_REGISTRY.update(original)
        db.close()
