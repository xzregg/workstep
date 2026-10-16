"""Pure, task-local overlays over a live workflow (never a frozen full copy)."""

from copy import deepcopy
import hashlib
import json

from services.workflow_definition import WorkflowDefinition, WorkflowValidationError


class WorkflowConflict(WorkflowValidationError):
    """An overlay can no longer be applied without changing its meaning."""


NODE_FIELDS = {
    "title", "color", "position", "prompt", "engine", "model", "config",
    "review", "maxReturnRounds", "inputs", "outputs",
}
PATCH_FIELDS = (NODE_FIELDS - {"inputs", "outputs"}) | {"append_outputs", "append_input_outputs"}


def workflow_revision(value: dict) -> str:
    return hashlib.sha256(json.dumps(
        value, sort_keys=True, ensure_ascii=False, separators=(",", ":"),
    ).encode()).hexdigest()


def canonical_workflow(raw: dict) -> dict:
    """Use stage keys as identities; numeric editor IDs are only presentation."""
    result = deepcopy(raw)
    items = raw.get("nodes") if "nodes" in raw else raw.get("steps", [])
    if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
        raise WorkflowConflict("流程节点格式无效")
    nodes, keys, aliases = [], set(), {}
    for index, item in enumerate(items):
        key = str(item.get("type") or item.get("key") or item.get("id") or "")
        if key in keys:
            raise WorkflowConflict(f"阶段标识重复: {key}")
        keys.add(key)
        if str(item.get("id", index + 1)) in aliases:
            raise WorkflowConflict("节点 ID 不能重复")
        aliases[str(item.get("id", index + 1))] = key
        node = deepcopy(item)
        node.update(id=key, type=key)
        node.pop("key", None)
        for field, default in {
            "title": item.get("label") or item.get("name") or key,
            "color": "var(--meta)", "engine": "", "model": "", "prompt": "",
            "config": {}, "inputs": [], "outputs": [], "kind": "llm",
            "maxReturnRounds": 3, "autoStart": False, "quickButtons": [],
            "position": {"x": 100 + index * 320, "y": 100},
        }.items():
            node.setdefault(field, deepcopy(default))
        node["engine"] = node["engine"] or ""
        node["model"] = node["model"] or ""
        node["autoStart"] = bool(node.get("autoStart"))
        node.pop("label", None)
        node.pop("name", None)
        for field in ("inputs", "outputs"):
            if not isinstance(node[field], list) or any(not isinstance(value, (dict, str)) for value in node[field]):
                raise WorkflowConflict(f"阶段端口格式无效: {key}.{field}")
            node[field] = [deepcopy(value) if isinstance(value, dict)
                           else {"name": str(value), "type": "md"}
                           for value in node[field]]
            for port in node[field]:
                port.setdefault("type", "md")
        for port in node["inputs"]:
            port.setdefault("outputs", [])
            if not isinstance(port["outputs"], list) or any(not isinstance(output, (dict, str)) for output in port["outputs"]):
                raise WorkflowConflict(f"输入口产物格式无效: {key}")
            port["outputs"] = [deepcopy(output) if isinstance(output, dict) else {"name": output}
                               for output in port["outputs"]]
            for output in port["outputs"]:
                output.setdefault("type", "md")
        if not isinstance(node.get("prompt") or "", str):
            raise WorkflowConflict(f"阶段提示词必须为文本: {key}")
        review = node.get("review")
        review = deepcopy(review) if isinstance(review, dict) else {"mode": "skip"}
        review.setdefault("mode", "auto" if review.get("auto") else "manual")
        for field, default in {"auto": review["mode"] == "auto", "maxRetries": 1,
                               "engine": "", "model": "", "prompt": "", "config": {}}.items():
            review.setdefault(field, default)
        node["review"] = review
        node["review"]["auto"] = review["mode"] == "auto"
        nodes.append(node)
    connections = []
    if "nodes" in raw:
        for edge in raw.get("connections", []):
            try:
                connections.append({
                    "from": aliases[str(edge["from"])], "fromPort": edge.get("fromPort", 0),
                    "to": aliases[str(edge["to"])], "toPort": edge.get("toPort", 0),
                    "kind": edge.get("kind", "solid"),
                })
            except (KeyError, TypeError) as exc:
                raise WorkflowConflict("连接引用了不存在的阶段") from exc
    else:
        for node, item in zip(nodes, items):
            for dep in item.get("dependsOn", []):
                connections.append({"from": dep, "fromPort": 0, "to": node["type"], "toPort": 0, "kind": "solid"})
            for target in item.get("reworkUpstream", []):
                connections.append({"from": node["type"], "fromPort": 0, "to": target, "toPort": 0, "kind": "dashed"})
    result.pop("steps", None)
    result.update(nodes=nodes, connections=connections)
    return result


def edge_key(edge: dict) -> str:
    return json.dumps([edge["from"], edge.get("fromPort", 0), edge["to"],
                       edge.get("toPort", 0), edge.get("kind", "solid")], separators=(",", ":"))


def _patch(base: dict, patch: dict) -> dict:
    result = deepcopy(base)
    for key, value in patch.items():
        if value is None:
            result.pop(key, None)
        elif isinstance(value, dict):
            result[key] = _patch(result.get(key) if isinstance(result.get(key), dict) else {}, value)
        else:
            result[key] = deepcopy(value)
    return result


def _diff(base: dict, value: dict) -> dict:
    result = {}
    for key in base.keys() | value.keys():
        if key not in value:
            result[key] = None
        elif base.get(key) != value[key]:
            if isinstance(base.get(key), dict) and isinstance(value[key], dict):
                result[key] = _diff(base[key], value[key])
            else:
                result[key] = deepcopy(value[key])
    return result


def _port_contract(node: dict) -> dict:
    return {"kind": node.get("kind", "llm"),
            "inputs": [{k: v for k, v in port.items() if k != "outputs"} for port in node.get("inputs", [])],
            "outputs": node.get("outputs", [])}


def _check_extension(base: dict, edited: dict) -> None:
    key = base["type"]
    if base.get("kind", "llm") != edited.get("kind", "llm"):
        raise WorkflowConflict(f"不能修改原阶段类型: {key}")
    if base.get("dispatch") != edited.get("dispatch"):
        raise WorkflowConflict(f"不能修改原交接阶段的目标: {key}")
    for field in ("autoStart", "quickButtons", "condition"):
        if field in edited and edited.get(field) != base.get(field):
            raise WorkflowConflict(f"不支持修改原阶段字段 {field}: {key}")
    old_ports, new_ports = base.get("inputs", []), edited.get("inputs", [])
    if len(old_ports) != len(new_ports) or any(
        {k: v for k, v in old.items() if k != "outputs"}
        != {k: v for k, v in new.items() if k != "outputs"}
        for old, new in zip(old_ports, new_ports)
    ):
        raise WorkflowConflict(f"不能修改原输入连接点: {key}")
    old_outputs, new_outputs = base.get("outputs", []), edited.get("outputs", [])
    if new_outputs[:len(old_outputs)] != old_outputs:
        raise WorkflowConflict(f"只能末尾追加产物，不能修改原产物及其编号: {key}")
    for old, new in zip(old_ports, new_ports):
        old_values = old.get("outputs", [])
        if new.get("outputs", [])[:len(old_values)] != old_values:
            raise WorkflowConflict(f"不能删除或修改原输入口的产物: {key}")
    nested = [value for port in new_ports for value in port.get("outputs", [])]
    if any(port.get("outputs") for port in old_ports) and nested != new_outputs:
        raise WorkflowConflict(f"追加产物不能改变输入口与输出编号的对应关系: {key}")


def _validate(value: dict) -> None:
    if not value.get("nodes"):
        raise WorkflowConflict("至少保留一个步骤节点")
    WorkflowDefinition.load(value).compile()
    edges = [edge_key(edge) for edge in value.get("connections", [])]
    if len(edges) != len(set(edges)):
        raise WorkflowConflict("不能重复连接相同端口")
    for node in value["nodes"]:
        mode = (node.get("review") or {}).get("mode", "skip")
        if not isinstance(mode, str) or mode not in {"skip", "auto", "manual"}:
            raise WorkflowConflict(f"审核模式无效: {node['type']}")
        names = [item.get("name") for item in node.get("outputs", [])]
        if len(names) != len(set(names)):
            raise WorkflowConflict(f"产物名称不能重复: {node['type']}")


def build_overrides(source: dict, edited: dict) -> dict | None:
    """Diff a validated editor result; never store unchanged source fields."""
    base, value = canonical_workflow(source), canonical_workflow(edited)
    old = {node["type"]: node for node in base["nodes"]}
    new = {node["type"]: node for node in value["nodes"]}
    missing = old.keys() - new.keys()
    if missing:
        raise WorkflowConflict("不能删除原阶段: " + ", ".join(sorted(missing)))
    changes, guards = {}, {}
    for key in old:
        _check_extension(old[key], new[key])
        # Fields absent from editor serialization (e.g. conditions) are inherited.
        scalar_fields = NODE_FIELDS - {"inputs", "outputs"}
        patch = _diff({k: old[key].get(k) for k in scalar_fields},
                      {k: new[key].get(k) for k in scalar_fields})
        if old[key].get("engine") != new[key].get("engine"):
            # Models and parameter namespaces belong to the selected engine.
            patch["model"] = new[key].get("model", "")
            patch["config"] = _diff({}, new[key].get("config", {}))
        if old[key]["review"].get("engine") != new[key]["review"].get("engine"):
            patch.setdefault("review", {})["model"] = new[key]["review"].get("model", "")
            patch["review"]["config"] = _diff({}, new[key]["review"].get("config", {}))
        appended = new[key]["outputs"][len(old[key]["outputs"]):]
        if appended:
            patch["append_outputs"] = deepcopy(appended)
        input_outputs = {str(index): deepcopy(new_port.get("outputs", [])[len(old_port.get("outputs", [])):])
                         for index, (old_port, new_port) in enumerate(zip(old[key]["inputs"], new[key]["inputs"]))
                         if len(new_port.get("outputs", [])) > len(old_port.get("outputs", []))}
        if input_outputs:
            patch["append_input_outputs"] = input_outputs
        if patch:
            changes[key] = patch
            guards[key] = _port_contract(old[key]) if appended or input_outputs else {"kind": old[key]["kind"]}
    old_edges = {edge_key(edge): edge for edge in base["connections"]}
    new_edges = {edge_key(edge): edge for edge in value["connections"]}
    removed = [old_edges[key] for key in old_edges if key not in new_edges]
    added_edges = [new_edges[key] for key in new_edges if key not in old_edges]
    for edge in [*removed, *added_edges]:
        for key in (edge["from"], edge["to"]):
            if key in old:
                guards[key] = _port_contract(old[key])
    added = [node for node in value["nodes"] if node["type"] not in old]
    bookmarks_changed = value.get("bookmarks", []) != base.get("bookmarks", [])
    if not changes and not added and not removed and not added_edges and not bookmarks_changed:
        return None
    delta = {"version": 1, "nodes": changes, "added_nodes": added,
             "removed_connections": removed, "added_connections": added_edges, "guards": guards}
    if bookmarks_changed:
        delta["bookmarks"] = deepcopy(value.get("bookmarks", []))
    _validate(merge_workflow(source, delta))
    return delta


def merge_workflow(source: dict, delta: dict | None) -> dict:
    if not delta:
        return deepcopy(source)
    if not isinstance(delta, dict) or delta.get("version") != 1:
        raise WorkflowConflict("任务流程增量版本无效")
    result = canonical_workflow(source)
    if "bookmarks" in delta:
        result["bookmarks"] = deepcopy(delta["bookmarks"])
    nodes = {node["type"]: node for node in result["nodes"]}
    for key, guard in delta.get("guards", {}).items():
        if key not in nodes:
            raise WorkflowConflict(f"主流程已删除任务覆盖的阶段: {key}；请移除覆盖或同步主流程")
        contract = _port_contract(nodes[key])
        if any(contract.get(field) != value for field, value in guard.items()):
            raise WorkflowConflict(f"主流程已修改端口约定: {key}；请重新编辑或同步主流程")
    for key, patch in delta.get("nodes", {}).items():
        if key not in nodes:
            raise WorkflowConflict(f"覆盖阶段不存在: {key}")
        if set(patch) - PATCH_FIELDS:
            raise WorkflowConflict(f"不支持的任务覆盖字段: {key}")
        if "engine" in patch and patch["engine"] != nodes[key].get("engine"):
            nodes[key]["config"] = {}
        review_patch = patch.get("review")
        if (isinstance(review_patch, dict) and "engine" in review_patch
                and review_patch["engine"] != nodes[key]["review"].get("engine")):
            nodes[key]["review"]["config"] = {}
        nodes[key] = _patch(nodes[key], {k: v for k, v in patch.items() if k not in {"append_outputs", "append_input_outputs"}})
        nodes[key]["outputs"].extend(deepcopy(patch.get("append_outputs", [])))
        for index, values in patch.get("append_input_outputs", {}).items():
            nodes[key]["inputs"][int(index)].setdefault("outputs", []).extend(deepcopy(values))
    result["nodes"] = list(nodes.values())
    for node in delta.get("added_nodes", []):
        if node["type"] in nodes:
            raise WorkflowConflict(f"新增阶段与主流程冲突: {node['type']}")
        nodes[node["type"]] = deepcopy(node)
        result["nodes"].append(nodes[node["type"]])
    removed = {edge_key(edge) for edge in delta.get("removed_connections", [])}
    edges = {edge_key(edge): edge for edge in result["connections"] if edge_key(edge) not in removed}
    for edge in delta.get("added_connections", []):
        edges[edge_key(edge)] = deepcopy(edge)
    result["connections"] = list(edges.values())
    _validate(result)
    return result
