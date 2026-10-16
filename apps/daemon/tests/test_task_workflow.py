"""Task overlays must rebase without mutating the shared workflow."""

from copy import deepcopy
from itertools import product

import pytest

from services.task_workflow import (
    build_overrides, canonical_workflow, merge_workflow, WorkflowConflict,
)


def flow():
    return {"nodes": [
        {"id": 1, "type": "a", "prompt": "source", "engine": "codex",
         "inputs": [{"name": "task", "type": "md", "outputs": [{"name": "prd", "type": "md"}]}],
         "outputs": [{"name": "prd", "type": "md"}], "review": {"mode": "skip"}},
        {"id": 2, "type": "b", "inputs": [{"name": "prd", "type": "md", "outputs": []}]},
    ], "connections": [{"from": 1, "fromPort": 0, "to": 2, "toPort": 0}]}


def test_no_edits_do_not_create_a_snapshot():
    base = flow()
    assert build_overrides(base, canonical_workflow(base)) is None
    assert merge_workflow(base, None) == base


def test_legacy_port_defaults_match_editor_without_becoming_overrides():
    source = {"nodes": [{"id": "a", "inputs": [{"name": "task", "outputs": ["prd"]}], "outputs": [{"name": "prd"}]}], "connections": []}
    normalized = canonical_workflow(source)
    assert normalized["nodes"][0]["inputs"][0]["type"] == "md"
    assert normalized["nodes"][0]["inputs"][0]["outputs"] == [{"name": "prd", "type": "md"}]
    assert build_overrides(source, normalized) is None


@pytest.mark.parametrize("prompt,model,skip", list(product(["", "local"], ["", "new-model"], [False, True])))
def test_overlay_roundtrip_and_source_immutability(prompt, model, skip):
    base = flow()
    original = deepcopy(base)
    edited = canonical_workflow(base)
    edited["nodes"][0].update(prompt=prompt, model=model)
    edited["nodes"][0]["review"].update(mode="skip" if skip else "auto", auto=not skip)
    delta = build_overrides(base, edited)
    assert canonical_workflow(merge_workflow(base, delta)) == edited
    assert base == original
    assert build_overrides(base, canonical_workflow(merge_workflow(base, delta))) == delta


def test_unmodified_fields_follow_latest_source():
    base = flow()
    edited = canonical_workflow(base)
    edited["nodes"][0]["prompt"] = "task only"
    delta = build_overrides(base, edited)
    base["nodes"][0].update(prompt="new source", model="source-model")
    resolved = merge_workflow(base, delta)
    assert resolved["nodes"][0]["prompt"] == "task only"
    assert resolved["nodes"][0]["model"] == "source-model"
    assert "outputs" not in delta["nodes"]["a"]


@pytest.mark.parametrize("change", ["delete", "kind", "input", "output", "output_order"])
def test_source_identity_and_ports_are_protected(change):
    base = flow()
    edited = canonical_workflow(base)
    node = edited["nodes"][0]
    if change == "delete":
        edited["nodes"].pop(0)
    elif change == "kind":
        node["kind"] = "task_dispatch"
    elif change == "input":
        node["inputs"][0]["name"] = "different"
    elif change == "output":
        node["outputs"] = []
    else:
        node["outputs"].insert(0, {"name": "new", "type": "md"})
    with pytest.raises(WorkflowConflict):
        build_overrides(base, edited)


def test_appended_outputs_and_new_nodes_rebase_connections_by_identity():
    base = flow()
    edited = canonical_workflow(base)
    extra = {"name": "report", "type": "md"}
    edited["nodes"][0]["outputs"].append(extra)
    edited["nodes"][0]["inputs"][0]["outputs"].append(extra)
    edited["nodes"].append({"id": "c", "type": "c", "inputs": [{"name": "report", "type": "md"}]})
    edited["connections"] = [{"from": "a", "fromPort": 1, "to": "c", "toPort": 0, "kind": "solid"}]
    delta = build_overrides(base, edited)
    base["nodes"].reverse()
    resolved = merge_workflow(base, delta)
    assert resolved["connections"] == edited["connections"]
    assert {node["type"] for node in resolved["nodes"]} == {"a", "b", "c"}


def test_deleted_source_override_target_is_a_conflict_not_an_implicit_new_node():
    base = flow()
    edited = canonical_workflow(base)
    edited["nodes"][0]["prompt"] = "local"
    delta = build_overrides(base, edited)
    base["nodes"].pop(0)
    base["connections"] = []
    with pytest.raises(WorkflowConflict, match="a"):
        merge_workflow(base, delta)


def test_source_port_change_cannot_retarget_a_task_connection_silently():
    base = flow()
    edited = canonical_workflow(base)
    edited["connections"][0]["kind"] = "solid"
    edited["connections"] = []
    delta = build_overrides(base, edited)
    base["nodes"][0]["outputs"][0]["name"] = "different"
    with pytest.raises(WorkflowConflict):
        merge_workflow(base, delta)


def test_legacy_steps_can_be_edited_without_losing_dependency_or_condition():
    base = {"steps": [{"key": "a", "prompt": "original"},
                      {"key": "b", "dependsOn": ["a"], "condition": "a:passed"}]}
    edited = canonical_workflow(base)
    edited["nodes"][0]["prompt"] = "local"
    result = merge_workflow(base, build_overrides(base, edited))
    assert result["nodes"][1]["condition"] == "a:passed"
    assert result["connections"][0]["from"] == "a"


def test_empty_and_unknown_patch_are_rejected():
    with pytest.raises(WorkflowConflict):
        build_overrides(flow(), {"nodes": [], "connections": []})
    with pytest.raises(WorkflowConflict):
        merge_workflow(flow(), {"version": 999})


def test_display_name_override_also_changes_the_compiled_stage_name():
    from services.workflow_definition import WorkflowDefinition
    source = {"steps": [{"key": "build", "label": "Original"}]}
    edited = canonical_workflow(source)
    edited["nodes"][0]["title"] = "Task name"
    merged = merge_workflow(source, build_overrides(source, edited))
    assert WorkflowDefinition.load(merged).compile().steps[0]["label"] == "Task name"


def test_prompt_override_does_not_freeze_unmodified_source_ports():
    source = flow()
    edited = canonical_workflow(source)
    edited["nodes"][0]["prompt"] = "task"
    delta = build_overrides(source, edited)
    source["nodes"][0]["outputs"].append({"name": "new-source-output", "type": "md"})
    assert len(merge_workflow(source, delta)["nodes"][0]["outputs"]) == 2


def test_overridden_engine_does_not_inherit_another_engines_later_model_or_parameters():
    source = flow()
    edited = canonical_workflow(source)
    edited["nodes"][0]["engine"] = "claude"
    delta = build_overrides(source, edited)
    source["nodes"][0].update(model="codex-only-model", config={"codex_only": "value"})
    target = merge_workflow(source, delta)["nodes"][0]
    assert target["engine"] == "claude"
    assert target["model"] == ""
    assert target["config"] == {}
