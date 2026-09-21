"""Port-aware artifact routing for workflow execution.

This module is the seam between artifact manifests and the scheduler.  It
turns declared output facts into activated connections and builds the exact
input-port snapshot injected into an engine prompt.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path

from services.artifact_rounds import ArtifactRound, select_upstream_round
from services.pipeline import Step


def empty_routing_state() -> dict:
    return {
        "active_edges": [],
        "return_counts": {},
        "feedback_inputs": {},
        "routed_rounds": {},
    }


def normalize_routing_state(value: object) -> dict:
    state = deepcopy(value) if isinstance(value, dict) else empty_routing_state()
    state.setdefault("active_edges", [])
    state.setdefault("return_counts", {})
    state.setdefault("feedback_inputs", {})
    state.setdefault("routed_rounds", {})
    return state


def _legacy_manifest_output(
    round_: ArtifactRound,
    output_port: int,
    output_spec: dict | None,
) -> dict | None:
    """Map pre-port manifests back to a declared output when unambiguous."""
    manifest = round_.manifest if isinstance(round_.manifest, dict) else {}
    if "outputs" in manifest:
        return None
    artifacts = [
        artifact
        for artifact in manifest.get("artifacts", [])
        if isinstance(artifact, dict) and artifact.get("path")
    ]
    expected_name = str((output_spec or {}).get("name") or "").strip()
    matches = [
        artifact
        for artifact in artifacts
        if expected_name and str(artifact.get("name") or "").strip() == expected_name
    ]
    if len(matches) == 1:
        artifact = matches[0]
    elif len(artifacts) == 1 and output_port == 0:
        artifact = artifacts[0]
    else:
        return None

    relative_path = Path(str(artifact["path"]))
    if relative_path.is_absolute() or ".." in relative_path.parts:
        return None
    try:
        size = int(artifact.get("size") or 0)
    except (TypeError, ValueError):
        return None
    if size <= 0:
        return None
    return {
        "round": round_.round,
        "name": str(artifact.get("name") or ""),
        "path": str(round_.path / relative_path),
        "size": size,
    }


def _manifest_output(
    round_: ArtifactRound,
    output_port: int,
    output_spec: dict | None = None,
) -> dict | None:
    manifest = round_.manifest if isinstance(round_.manifest, dict) else {}
    for output in manifest.get("outputs", []):
        if (
            isinstance(output, dict)
            and output.get("port") == output_port
            and output.get("nonempty") is True
        ):
            return {
                "round": round_.round,
                "name": str(output.get("name") or ""),
                "path": str(round_.path / str(output.get("path") or "")),
                "size": int(output.get("size") or 0),
            }
    return _legacy_manifest_output(round_, output_port, output_spec)


def source_for_connection(
    connection: dict,
    artifact_round: ArtifactRound,
    output_spec: dict | None = None,
) -> dict | None:
    output = _manifest_output(
        artifact_round,
        int(connection.get("fromPort", 0)),
        output_spec,
    )
    if output is None:
        return None
    return {
        "edge_id": str(connection.get("id")),
        "kind": str(connection.get("kind", "solid")),
        "step": str(connection.get("from")),
        "output_port": int(connection.get("fromPort", 0)),
        **output,
    }


def resolve_input_snapshot(
    *,
    step: Step,
    artifacts_root: Path,
    workflow_id: str | None,
    task_id: str,
    routing_state: dict,
    input_rounds: dict[str, int] | None = None,
) -> dict:
    """Resolve exact artifacts available at every dynamic input port."""
    state = normalize_routing_state(routing_state)
    active_edges = {str(value) for value in state["active_edges"]}
    feedback = state["feedback_inputs"].get(step.key, {})
    connections_by_port: dict[int, list[dict]] = {}
    for connection in step.incoming_connections:
        connections_by_port.setdefault(
            int(connection.get("toPort", 0)), []
        ).append(connection)

    highest_connection_port = max(connections_by_port, default=-1)
    port_count = max(len(step.inputs), highest_connection_port + 1)
    ports: list[dict] = []
    triggered_edges: list[str] = []
    for port_index in range(port_count):
        spec = step.inputs[port_index] if port_index < len(step.inputs) else {}
        name = str(spec.get("name") or f"input-{port_index}")
        connections = connections_by_port.get(port_index, [])
        sources: list[dict] = []
        for connection in connections:
            edge_id = str(connection.get("id"))
            kind = str(connection.get("kind", "solid"))
            if kind == "dashed":
                source = feedback.get(edge_id)
                if isinstance(source, dict):
                    sources.append(deepcopy(source))
                    triggered_edges.append(edge_id)
                continue
            if edge_id not in active_edges:
                continue
            source_step = str(connection.get("from"))
            selected = select_upstream_round(
                artifacts_root,
                workflow_id,
                task_id,
                source_step,
                (input_rounds or {}).get(source_step),
            )
            if selected is None:
                continue
            source = source_for_connection(connection, selected, spec)
            if source is not None:
                sources.append(source)
        if sources:
            status = "ready"
        elif connections:
            status = "inactive"
        else:
            status = "task_context"
        ports.append({
            "port": port_index,
            "name": name,
            "status": status,
            "sources": sources,
        })
    return {
        "execution_type": "feedback" if triggered_edges else (
            "initial" if not any(
                connection.get("kind", "solid") == "solid"
                for connection in step.incoming_connections
            ) else "forward"
        ),
        "triggered_edges": sorted(set(triggered_edges)),
        "ports": ports,
    }


@dataclass(frozen=True)
class RouteResult:
    state: dict
    solid_edges: tuple[dict, ...]
    feedback_edges: tuple[dict, ...]
    exhausted_edges: tuple[dict, ...]
    conflict: bool


def route_artifact_round(
    *,
    step: Step,
    artifact_round: ArtifactRound,
    routing_state: dict,
) -> RouteResult:
    """Activate only connections whose declared source output is non-empty."""
    state = normalize_routing_state(routing_state)
    active_edges = {str(value) for value in state["active_edges"]}
    outgoing_ids = {
        str(connection.get("id")) for connection in step.outgoing_connections
    }
    active_edges.difference_update(outgoing_ids)

    # Canvas definitions created before artifact-port routing may connect
    # stages without declaring outputs. Preserve their stage-level forward
    # semantics; a dashed edge still requires an actual declared artifact.
    if not step.outputs:
        solid = tuple(
            connection
            for connection in step.outgoing_connections
            if connection.get("kind", "solid") != "dashed"
        )
        active_edges.update(str(connection.get("id")) for connection in solid)
        state["active_edges"] = sorted(active_edges)
        state["routed_rounds"][step.key] = artifact_round.round
        return RouteResult(
            state=state,
            solid_edges=solid,
            feedback_edges=(),
            exhausted_edges=(),
            conflict=False,
        )

    solid_candidates: list[tuple[dict, dict]] = []
    feedback_candidates: list[tuple[dict, dict]] = []
    for connection in step.outgoing_connections:
        output_port = int(connection.get("fromPort", 0))
        output_spec = (
            step.outputs[output_port]
            if 0 <= output_port < len(step.outputs)
            else None
        )
        source = source_for_connection(connection, artifact_round, output_spec)
        edge_id = str(connection.get("id"))
        target = str(connection.get("to"))
        if connection.get("kind", "solid") == "dashed":
            state["feedback_inputs"].get(target, {}).pop(edge_id, None)
        if source is None:
            continue
        if connection.get("kind", "solid") != "dashed":
            solid_candidates.append((connection, source))
            continue
        feedback_candidates.append((connection, source))

    if solid_candidates and feedback_candidates:
        state["active_edges"] = sorted(active_edges)
        state["routed_rounds"][step.key] = artifact_round.round
        return RouteResult(
            state=state,
            solid_edges=(),
            feedback_edges=(),
            exhausted_edges=(),
            conflict=True,
        )

    solid: list[dict] = []
    feedback: list[dict] = []
    exhausted: list[dict] = []
    for connection, _source in solid_candidates:
        active_edges.add(str(connection.get("id")))
        solid.append(connection)
    for connection, source in feedback_candidates:
        edge_id = str(connection.get("id"))
        target = str(connection.get("to"))
        count = int(state["return_counts"].get(edge_id, 0))
        if count >= step.max_return_rounds:
            exhausted.append(connection)
            continue
        state["return_counts"][edge_id] = count + 1
        state["feedback_inputs"].setdefault(target, {})[edge_id] = source
        active_edges.add(edge_id)
        feedback.append(connection)

    state["active_edges"] = sorted(active_edges)
    state["routed_rounds"][step.key] = artifact_round.round
    return RouteResult(
        state=state,
        solid_edges=tuple(solid),
        feedback_edges=tuple(feedback),
        exhausted_edges=tuple(exhausted),
        conflict=bool(solid and feedback),
    )
