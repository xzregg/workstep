"""Tests for P5 features: templates, search, conditional routing."""

import pytest
from services.pipeline import Step, DAGScheduler


# --- Conditional Routing Tests ---

def test_step_with_condition():
    """Test Step parses condition field."""
    step = Step.from_dict({
        "key": "test",
        "label": "Test Step",
        "condition": "req:passed",
    })
    assert step.condition == "req:passed"


def test_step_without_condition():
    """Test Step defaults to empty condition."""
    step = Step.from_dict({
        "key": "test",
        "label": "Test Step",
    })
    assert step.condition == ""


def test_dag_scheduler_empty_condition():
    """Test empty condition always evaluates to True."""
    steps = [
        Step(key="a", label="A", condition=""),
        Step(key="b", label="B", depends_on=["a"], condition=""),
    ]
    scheduler = DAGScheduler(steps)
    ready = scheduler.get_ready_steps(completed=set(), step_results={})
    assert len(ready) == 1
    assert ready[0].key == "a"


def test_dag_scheduler_condition_passed():
    """Test condition 'step:passed' evaluates correctly."""
    steps = [
        Step(key="a", label="A"),
        Step(key="b", label="B", depends_on=["a"], condition="a:passed"),
    ]
    scheduler = DAGScheduler(steps)

    # When a passed, b should be ready
    ready = scheduler.get_ready_steps(
        completed={"a"},
        step_results={"a": True},
    )
    assert len(ready) == 1
    assert ready[0].key == "b"

    # When a failed, b should NOT be ready
    ready = scheduler.get_ready_steps(
        completed={"a"},
        step_results={"a": False},
    )
    assert len(ready) == 0


def test_dag_scheduler_condition_failed():
    """Test condition 'step:failed' evaluates correctly."""
    steps = [
        Step(key="a", label="A"),
        Step(key="b", label="B", depends_on=["a"], condition="a:failed"),
    ]
    scheduler = DAGScheduler(steps)

    # When a failed, b should be ready
    ready = scheduler.get_ready_steps(
        completed={"a"},
        step_results={"a": False},
    )
    assert len(ready) == 1
    assert ready[0].key == "b"

    # When a passed, b should NOT be ready
    ready = scheduler.get_ready_steps(
        completed={"a"},
        step_results={"a": True},
    )
    assert len(ready) == 0


def test_dag_scheduler_condition_and():
    """Test AND condition 'a:passed && b:passed'."""
    steps = [
        Step(key="a", label="A"),
        Step(key="b", label="B"),
        Step(key="c", label="C", depends_on=["a", "b"], condition="a:passed && b:passed"),
    ]
    scheduler = DAGScheduler(steps)

    # Both passed
    ready = scheduler.get_ready_steps(
        completed={"a", "b"},
        step_results={"a": True, "b": True},
    )
    assert len(ready) == 1
    assert ready[0].key == "c"

    # One failed
    ready = scheduler.get_ready_steps(
        completed={"a", "b"},
        step_results={"a": True, "b": False},
    )
    assert len(ready) == 0


def test_dag_scheduler_condition_or():
    """Test OR condition 'a:passed || b:passed'."""
    steps = [
        Step(key="a", label="A"),
        Step(key="b", label="B"),
        Step(key="c", label="C", depends_on=["a", "b"], condition="a:passed || b:passed"),
    ]
    scheduler = DAGScheduler(steps)

    # Both passed
    ready = scheduler.get_ready_steps(
        completed={"a", "b"},
        step_results={"a": True, "b": True},
    )
    assert len(ready) == 1
    assert ready[0].key == "c"

    # One passed
    ready = scheduler.get_ready_steps(
        completed={"a", "b"},
        step_results={"a": True, "b": False},
    )
    assert len(ready) == 1
    assert ready[0].key == "c"

    # Both failed
    ready = scheduler.get_ready_steps(
        completed={"a", "b"},
        step_results={"a": False, "b": False},
    )
    assert len(ready) == 0


# --- Template Tests ---

def test_builtin_templates_exist():
    """Test that built-in templates are defined."""
    from api.templates import BUILTIN_TEMPLATES
    assert len(BUILTIN_TEMPLATES) == 4

    template_ids = {t["id"] for t in BUILTIN_TEMPLATES}
    assert "dev-workflow" in template_ids
    assert "writing-workflow" in template_ids
    assert "data-workflow" in template_ids
    assert "blank" in template_ids


def test_template_structure():
    """Test template structure is valid."""
    from api.templates import BUILTIN_TEMPLATES

    for t in BUILTIN_TEMPLATES:
        assert "id" in t
        assert "name" in t
        assert "description" in t
        assert "steps" in t
        assert "nodes" in t["steps"]
        assert "connections" in t["steps"]


def test_dev_workflow_template():
    """Test dev-workflow template has expected structure."""
    from api.templates import BUILTIN_TEMPLATES

    dev_template = next(t for t in BUILTIN_TEMPLATES if t["id"] == "dev-workflow")
    nodes = dev_template["steps"]["nodes"]

    # Should have 6 nodes: req, ui, frontend, backend, test, deploy
    assert len(nodes) == 6

    node_types = {n["type"] for n in nodes}
    assert "req" in node_types
    assert "ui" in node_types
    assert "frontend" in node_types
    assert "backend" in node_types
    assert "test" in node_types
    assert "deploy" in node_types


def test_builtin_templates_compile_for_execution():
    """Every template exposed to users is accepted by the workflow compiler."""
    from api.templates import BUILTIN_TEMPLATES
    from services.workflow_definition import WorkflowDefinition

    compiled = {
        template["id"]: WorkflowDefinition.load(template["steps"])
        .compile()
        .to_steps_config()
        for template in BUILTIN_TEMPLATES
    }

    dev_steps = {
        step["key"]: step
        for step in compiled["dev-workflow"]["steps"]
    }
    assert dev_steps["backend"]["dependsOn"] == ["ui"]
    assert dev_steps["test"]["dependsOn"] == ["frontend", "backend"]


# --- Search API Tests ---

def test_search_api_imports():
    """Test search API can be imported."""
    from api.search import router
    assert router is not None


def test_sessions_api_imports():
    """Test sessions API can be imported."""
    from api.history import router
    assert router is not None
