"""Reconcile persisted run inputs with a newly resolved workflow, not its rules."""

from copy import deepcopy
import json

from services.artifact_routing import normalize_routing_state
from services.task_workflow import WorkflowConflict


def reconcile_workflow_routing(raw, scheduler, *, structural_override=False):
    state = normalize_routing_state(raw)
    bindings = {str(edge["id"]): {key: value for key, value in edge.items() if key != "id"}
                for step in scheduler.steps.values() for edge in step.outgoing_connections}
    previous = state.get("workflow_edges")
    current_configuration = state.pop("configuration_current", False)
    old_keys = state.get("workflow_keys")
    changed = previous is not None and (previous != bindings or old_keys != list(scheduler.steps))
    if previous is None and structural_override and not current_configuration:
        if state["feedback_inputs"]:
            raise WorkflowConflict("Old run contains unconsumed rework input; please re-execute from the target stage to adopt the new connection")
        # Old index-based routes cannot safely be attached to a changed graph.
        state["active_edges"] = []
        state["return_counts"] = {}
        changed = True
    elif changed:
        signatures = {json.dumps(value, sort_keys=True): key for key, value in bindings.items()}
        remap = {old: signatures[signature] for old, value in previous.items()
                 if (signature := json.dumps(value, sort_keys=True)) in signatures}
        state["active_edges"] = [remap[key] for key in state["active_edges"] if key in remap]
        state["return_counts"] = {remap[key]: count for key, count in state["return_counts"].items() if key in remap}
        feedback = {}
        for target, inputs in state["feedback_inputs"].items():
            for key, source in inputs.items():
                if key not in remap:
                    raise WorkflowConflict("Connection modification affected unconsumed rework input; please re-execute from the target stage")
                feedback.setdefault(target, {})[remap[key]] = {**source, "edge_id": remap[key]}
        state["feedback_inputs"] = feedback
    if changed:
        entry = state.get("entry_step_key")
        if entry:
            if entry not in scheduler.steps:
                raise WorkflowConflict("The original entry stage no longer exists, please reselect the execution entry")
            state["execution_scope"] = sorted({entry, *scheduler.get_all_downstream(entry)})
        state["routed_rounds"] = {key: value for key, value in state["routed_rounds"].items() if key in scheduler.steps}
    state["workflow_edges"] = deepcopy(bindings)
    state["workflow_keys"] = list(scheduler.steps)
    return state, changed
