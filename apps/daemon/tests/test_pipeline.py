"""Tests for P3: DAGScheduler, prompt assembly, TaskRunner."""

import asyncio
import json
import pytest
from pathlib import Path
from unittest.mock import patch

from services.pipeline import DAGScheduler, Step
from services.prompt import assemble_prompt, SYSTEM_PROMPT
from services.task_runner import TaskRunner
from engines.events import InternalEvent
from engines.base import BaseLLMEngine
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
        id=str(uuid.uuid4()), title="Test", cwd=str(tmp_path),
        created_at=int(time.time()), updated_at=int(time.time()),
    )
    step = Step(key="req", label="需求", prompt="Write a PRD")
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()

    prompt = assemble_prompt(task, step, artifacts_dir)
    assert SYSTEM_PROMPT in prompt
    assert "Write a PRD" in prompt
    assert str(artifacts_dir / "req" / task.id) in prompt
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
    req_dir = artifacts_dir / "req" / task.id
    req_dir.mkdir(parents=True)
    (req_dir / "prd.md").write_text("# PRD\nHello")

    step = Step(key="ui", label="UI", prompt="Design UI", depends_on=["req"])
    prompt = assemble_prompt(task, step, artifacts_dir)

    assert "上游产物" in prompt
    assert "prd.md" in prompt
    assert "Design UI" in prompt
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


# --- TaskRunner integration ---

class PipelineFakeEngine(BaseLLMEngine):
    @staticmethod
    def is_installed(): return True
    @staticmethod
    def get_version(): return "fake"
    @staticmethod
    def resolve_binary(): return "fake"

    def __init__(self, text="output"):
        self._text = text

    async def spawn(self, prompt, cwd, **kwargs):
        yield InternalEvent(type="text_delta", data={"delta": self._text})
        yield InternalEvent(type="status", data={"status": "done"})

    async def stop(self): pass
    async def inject_response(self, tool_use_id, content): pass
    @property
    def supports_resume(self): return False
    @property
    def supports_interactive(self): return False
    def build_resume_params(self, session_id): return {}


@pytest.mark.anyio
async def test_task_runner_linear_pipeline(tmp_path):
    """Run a 2-step linear pipeline: A → B."""
    from models import init_db, Task
    from engines.registry import ENGINE_REGISTRY
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
async def test_task_runner_parallel_branches(tmp_path):
    """Run a pipeline with parallel branches: A → {B, C} → D."""
    from models import init_db, Task
    from engines.registry import ENGINE_REGISTRY
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
