"""Incremental canvas patches for the AI flow-design assistant.

Editing an existing workflow re-emits the whole canvas today, so even a
one-stage tweak pays for every untouched node. The assistant can instead
return a *patch* describing only the stages it touched; this module merges
that patch against the session's current canvas and records which stages
changed, so the editor can apply the whole change set or just a subset.

A patch looks like::

    {
        "upsertNodes": [ {<complete canvas node>}, ... ],
        "removeNodeIds": [3, 7],
        "connections": [ {<complete canvas connection>}, ... ]   # optional
    }

``upsertNodes`` replaces nodes whose ``id`` already exists and appends new
ones (allocating a free id when the model omitted or reused one).
``removeNodeIds`` drops nodes together with their connections. ``connections``
is optional: when present it is the complete connection list for the merged
canvas, when absent the base connections are kept (minus any dropped nodes).
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Mapping


def _as_int(value: Any) -> int | None:
    """Coerce a model-authored node id into a positive int (or ``None``)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, str) and value.strip().isdigit():
        number = int(value.strip())
        return number if number > 0 else None
    return None


def _change_entry(node_id: int, node: Mapping[str, Any], change: str) -> dict[str, Any]:
    return {
        "id": node_id,
        "key": str(node.get("type") or node.get("key") or ""),
        "title": str(node.get("title") or node.get("label") or node.get("name") or ""),
        "change": change,
    }


def is_patch(payload: Any) -> bool:
    """True when a proposal payload is a patch rather than a full canvas."""
    return isinstance(payload, Mapping) and (
        "upsertNodes" in payload
        or "removeNodeIds" in payload
        or "patch" in payload
    )


def normalize_patch(patch: Mapping[str, Any]) -> dict[str, Any]:
    """Coerce a model-authored patch into a predictable shape."""
    upsert = patch.get("upsertNodes")
    if not isinstance(upsert, list):
        upsert = patch.get("nodes") if isinstance(patch.get("nodes"), list) else []
    remove = patch.get("removeNodeIds")
    if not isinstance(remove, list):
        remove = patch.get("remove") if isinstance(patch.get("remove"), list) else []
    connections = patch.get("connections")
    if connections is not None and not isinstance(connections, list):
        connections = None
    return {
        "upsertNodes": [item for item in upsert if isinstance(item, Mapping)],
        "removeNodeIds": [
            node_id
            for node_id in (_as_int(item) for item in remove)
            if node_id is not None
        ],
        "connections": connections,
    }


class WorkflowPatchError(ValueError):
    """Raised when a patch cannot be merged into the current canvas."""


def apply_patch(
    base_steps: Mapping[str, Any] | None,
    patch: Mapping[str, Any],
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    """Merge ``patch`` into ``base_steps``.

    Returns ``(steps, changes, resolved_patch)``. ``steps`` is a complete
    canvas, ``changes`` lists the touched stages as
    ``{"id", "key", "title", "change"}`` with ``change`` in
    ``added`` / ``updated`` / ``removed``, and ``resolved_patch`` is the patch
    with every newly-added node's server-assigned id filled in, so the editor
    can apply a subset of stages by id.
    """
    normalized = normalize_patch(patch)
    if not normalized["upsertNodes"] and not normalized["removeNodeIds"]:
        raise WorkflowPatchError("patch does not change any stage")

    base = deepcopy(dict(base_steps or {}))
    raw_nodes = base.get("nodes")
    base_nodes = [node for node in raw_nodes if isinstance(node, Mapping)] if isinstance(raw_nodes, list) else []
    raw_connections = base.get("connections")
    base_connections = (
        [conn for conn in raw_connections if isinstance(conn, Mapping)]
        if isinstance(raw_connections, list)
        else []
    )
    if not base_nodes:
        # A patch only makes sense against an existing canvas; without one the
        # model has to send a complete flow instead of an incremental edit.
        raise WorkflowPatchError("current canvas is empty; a full flow is required")

    nodes_by_id: dict[int, dict[str, Any]] = {}
    order: list[int] = []
    for node in base_nodes:
        node_id = _as_int(node.get("id"))
        if node_id is None:
            continue
        if node_id not in nodes_by_id:
            order.append(node_id)
        nodes_by_id[node_id] = deepcopy(dict(node))

    next_id = max(nodes_by_id, default=0) + 1
    changes: list[dict[str, Any]] = []
    resolved_upserts: list[dict[str, Any]] = []
    for raw_node in normalized["upsertNodes"]:
        node = deepcopy(dict(raw_node))
        node_id = _as_int(node.get("id"))
        if node_id is not None and node_id in nodes_by_id:
            node["id"] = node_id
            if node == nodes_by_id[node_id]:
                # Models sometimes echo the complete canvas in upsertNodes.
                # Do not present unchanged stages as user-visible edits.
                continue
            change = "updated"
        else:
            if node_id is None:
                # Model omitted the id for a new stage; allocate a free one.
                while next_id in nodes_by_id:
                    next_id += 1
                node_id = next_id
                next_id += 1
            order.append(node_id)
            change = "added"
        node["id"] = node_id
        nodes_by_id[node_id] = node
        resolved_upserts.append(node)
        changes.append(_change_entry(node_id, node, change))

    for node_id in normalized["removeNodeIds"]:
        node = nodes_by_id.pop(node_id, None)
        if node is None:
            continue
        order = [value for value in order if value != node_id]
        changes.append(_change_entry(node_id, node, "removed"))

    node_ids = set(order)
    if normalized["connections"] is not None:
        candidate_connections = normalized["connections"]
    else:
        candidate_connections = base_connections
    connections: list[dict[str, Any]] = []
    seen_connections: set[tuple[Any, Any, Any, Any]] = set()
    for raw_conn in candidate_connections:
        if not isinstance(raw_conn, Mapping):
            continue
        conn = deepcopy(dict(raw_conn))
        source = _as_int(conn.get("from"))
        target = _as_int(conn.get("to"))
        if source is None or target is None:
            continue
        if source not in node_ids or target not in node_ids:
            continue
        signature = (source, conn.get("fromPort", 0), target, conn.get("toPort", 0))
        if signature in seen_connections:
            continue
        seen_connections.add(signature)
        connections.append(conn)

    merged: dict[str, Any] = dict(base)
    merged["nodes"] = [nodes_by_id[node_id] for node_id in order]
    merged["connections"] = connections
    resolved_patch = {
        "upsertNodes": resolved_upserts,
        "removeNodeIds": list(normalized["removeNodeIds"]),
        "connections": connections,
    }
    return merged, changes, resolved_patch
