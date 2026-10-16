from copy import deepcopy

import pytest

from services.pipeline import DAGScheduler, Step
from services.task_workflow import WorkflowConflict
from services.task_workflow_boundary import reconcile_workflow_routing


def scheduler(edges, keys=("a", "b", "c")):
    return DAGScheduler([Step.from_dict({"key": key, "dependsOn": [edge["from"] for edge in edges if edge["to"] == key],
        "incomingConnections": [edge for edge in edges if edge["to"] == key],
        "outgoingConnections": [edge for edge in edges if edge["from"] == key]}) for key in keys])


def edge(id, source, target):
    return {"id": id, "from": source, "fromPort": 0, "to": target, "toPort": 0, "kind": "solid"}


def test_routes_are_remapped_by_identity_not_array_index():
    a, b = edge("connection-0", "a", "b"), edge("connection-1", "b", "c")
    state, _ = reconcile_workflow_routing(None, scheduler([a, b]))
    state["active_edges"] = ["connection-1"]
    result, changed = reconcile_workflow_routing(state, scheduler([{**b, "id": "connection-0"}]))
    assert changed
    assert result["active_edges"] == ["connection-0"]
    assert state["active_edges"] == ["connection-1"]


def test_added_downstream_is_included_in_the_entry_scope():
    state, _ = reconcile_workflow_routing({"entry_step_key": "b", "execution_scope": ["b"]}, scheduler([]))
    result, changed = reconcile_workflow_routing(state, scheduler([edge("connection-0", "b", "c")]))
    assert changed
    assert result["execution_scope"] == ["b", "c"]


def test_changed_graph_does_not_silently_drop_feedback():
    state, _ = reconcile_workflow_routing(None, scheduler([edge("connection-0", "a", "b")]))
    state["feedback_inputs"] = {"b": {"connection-0": {"step": "a"}}}
    with pytest.raises(WorkflowConflict):
        reconcile_workflow_routing(state, scheduler([]))


def test_reconciliation_is_idempotent_and_preserves_return_counts():
    dag = scheduler([edge("connection-0", "a", "b")])
    state, _ = reconcile_workflow_routing(None, dag)
    state.update(active_edges=["connection-0"], return_counts={"connection-0": 3})
    original = deepcopy(state)
    result, changed = reconcile_workflow_routing(state, dag)
    assert result == original
    assert changed is False


def test_prompt_update_is_incremental_and_can_clear_old_requirements(tmp_path):
    from types import SimpleNamespace
    from services.prompt import _step_requirements_parts

    task = SimpleNamespace(id="task", cwd=str(tmp_path), workflow_id="flow")
    step = SimpleNamespace(key="a", prompt="old")
    first = {}
    assert "old" in _step_requirements_parts(task, step, tmp_path, "", None, first)[0]
    assert _step_requirements_parts(task, step, tmp_path, "", first, {}) == []
    step.prompt = "new"
    next_hashes = {}
    assert "new" in _step_requirements_parts(task, step, tmp_path, "", first, next_hashes)[0]
    step.prompt = ""
    assert "No additional" in _step_requirements_parts(task, step, tmp_path, "", next_hashes, {})[0]
