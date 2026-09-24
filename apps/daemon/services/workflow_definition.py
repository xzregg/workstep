"""Load, validate, and compile persisted workflow definitions.

This module is the compatibility seam between editor-oriented workflow JSON and
the canonical ``{"steps": [...]}`` structure consumed by ``TaskRunner``.
"""

from __future__ import annotations

import re
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Mapping

from services.config import resolve_execution_engine
from services.quick_buttons import normalize_quick_buttons
from services.workflow_limits import (
    MAX_CONFIGURED_RETURN_ROUNDS,
    MAX_RETURN_ROUNDS,
)


class WorkflowValidationError(ValueError):
    """Raised when a workflow definition cannot be compiled safely."""


@dataclass(frozen=True)
class CompiledWorkflow:
    """A validated workflow in the canonical executor representation."""

    steps: tuple[dict[str, Any], ...]
    schema_version: int = 1

    def to_steps_config(self) -> dict[str, list[dict[str, Any]]]:
        """Return a fresh config object consumable by ``TaskRunner``."""
        return {"steps": deepcopy(list(self.steps))}


class WorkflowDefinition:
    """A persisted workflow definition awaiting validation and compilation."""

    CURRENT_SCHEMA_VERSION = 1
    STEP_KEY_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")

    def __init__(self, raw: Mapping[str, Any]):
        self._raw = deepcopy(dict(raw))

    @classmethod
    def load(cls, raw: Mapping[str, Any]) -> "WorkflowDefinition":
        """Load a workflow definition from an in-memory JSON-like mapping."""
        return cls(raw)

    def validate(self) -> "WorkflowDefinition":
        """Validate this definition, returning itself for fluent use."""
        inherit = self._raw.get("inheritProjectQuickButtons", False)
        if not isinstance(inherit, bool):
            raise WorkflowValidationError("inheritProjectQuickButtons: expected a boolean")
        if "projectQuickButtonIds" in self._raw:
            selected = self._raw["projectQuickButtonIds"]
            if (
                not isinstance(selected, list)
                or len(selected) > 100
                or any(not isinstance(item, str) or not item.strip() for item in selected)
                or len(set(selected)) != len(selected)
            ):
                raise WorkflowValidationError("projectQuickButtonIds: expected unique button IDs")
        if "quickButtons" in self._raw:
            try:
                normalize_quick_buttons(self._raw["quickButtons"])
            except ValueError as exc:
                raise WorkflowValidationError(f"quickButtons: {exc}") from exc
        schema_version = self._raw.get(
            "schemaVersion", self.CURRENT_SCHEMA_VERSION
        )
        if schema_version != self.CURRENT_SCHEMA_VERSION:
            raise WorkflowValidationError(
                f"schemaVersion: unsupported version {schema_version}; "
                f"expected {self.CURRENT_SCHEMA_VERSION}"
            )
        collection_name = "nodes" if "nodes" in self._raw else "steps"
        items = self._raw.get(collection_name, [])
        for index, item in enumerate(items):
            if "quickButtons" in item:
                try:
                    normalize_quick_buttons(item["quickButtons"])
                except ValueError as exc:
                    raise WorkflowValidationError(
                        f"{collection_name}[{index}].quickButtons: {exc}"
                    ) from exc
        seen_keys: dict[str, int] = {}
        for index, item in enumerate(items):
            key = item.get("key", item.get("type", item.get("id", "")))
            if not isinstance(key, str) or not self.STEP_KEY_PATTERN.fullmatch(key):
                raise WorkflowValidationError(
                    f"{collection_name}[{index}].key: invalid step key '{key}'; "
                    "expected a letter followed by letters, numbers, '_' or '-'"
                )
            if key in seen_keys:
                raise WorkflowValidationError(
                    f"{collection_name}[{index}].key: duplicate step key '{key}' "
                    f"(already defined at {collection_name}[{seen_keys[key]}])"
                )
            seen_keys[key] = index

        if collection_name == "nodes":
            node_ids = {node.get("id") for node in items}
            nodes_by_id = {node.get("id"): node for node in items}
            dispatch_node_ids = set()
            for index, node in enumerate(items):
                kind = node.get("kind", "llm")
                if kind not in ("llm", "task_dispatch"):
                    raise WorkflowValidationError(
                        f"nodes[{index}].kind: unsupported step kind '{kind}'"
                    )
                if kind != "task_dispatch":
                    continue
                dispatch_node_ids.add(node.get("id"))
                dispatch = node.get("dispatch")
                if not isinstance(dispatch, dict):
                    raise WorkflowValidationError(
                        f"nodes[{index}].dispatch: expected a dict"
                    )
                for field in (
                    "targetProjectId",
                    "targetWorkflowId",
                    "targetStartStepKey",
                ):
                    if not isinstance(dispatch.get(field), str) or not dispatch[field].strip():
                        raise WorkflowValidationError(
                            f"nodes[{index}].dispatch.{field}: value is required"
                        )
                if dispatch.get("startMode", "inherit") not in ("inherit", "immediate"):
                    raise WorkflowValidationError(
                        f"nodes[{index}].dispatch.startMode: expected 'inherit' or 'immediate'"
                    )
            connections = self._raw.get("connections", [])
            for index, connection in enumerate(connections):
                kind = connection.get("kind", "solid")
                if kind not in ("solid", "dashed"):
                    raise WorkflowValidationError(
                        f"connections[{index}].kind: invalid value '{kind}'; "
                        "expected 'solid' or 'dashed'"
                    )
                for endpoint in ("from", "to"):
                    node_id = connection.get(endpoint)
                    if node_id not in node_ids:
                        raise WorkflowValidationError(
                            f"connections[{index}].{endpoint}: "
                            f"node '{node_id}' does not exist"
                        )
                if connection.get("from") in dispatch_node_ids:
                    raise WorkflowValidationError(
                        f"connections[{index}]: task dispatch step cannot have outgoing connections"
                    )
                port_specs = (
                    ("fromPort", "from", "outputs"),
                    ("toPort", "to", "inputs"),
                )
                for port_field, endpoint, node_ports_field in port_specs:
                    port = connection.get(port_field, 0)
                    node_id = connection.get(endpoint)
                    available_ports = max(
                        1, len(nodes_by_id[node_id].get(node_ports_field, []))
                    )
                    if (
                        not isinstance(port, int)
                        or isinstance(port, bool)
                        or port < 0
                        or port >= available_ports
                    ):
                        raise WorkflowValidationError(
                            f"connections[{index}].{port_field}: port {port} "
                            f"does not exist on node '{node_id}'"
                        )
            key_by_id = {
                node.get("id"): node.get(
                    "key", node.get("type", node.get("id", ""))
                )
                for node in items
            }
            dependencies = {key: [] for key in key_by_id.values()}
            dashed_edges: list[tuple[int, str, str]] = []
            for index, connection in enumerate(connections):
                from_key = key_by_id[connection.get("from")]
                to_key = key_by_id[connection.get("to")]
                if connection.get("kind", "solid") == "dashed":
                    dashed_edges.append((index, from_key, to_key))
                else:
                    dependencies[to_key].append(from_key)
            self._validate_acyclic(dependencies)

            upstream_cache: dict[str, set[str]] = {}

            def upstream_of(key: str) -> set[str]:
                if key in upstream_cache:
                    return upstream_cache[key]
                result: set[str] = set()
                stack = list(dependencies[key])
                while stack:
                    dep = stack.pop()
                    if dep in result:
                        continue
                    result.add(dep)
                    stack.extend(dependencies[dep])
                upstream_cache[key] = result
                return result

            for index, from_key, to_key in dashed_edges:
                if from_key == to_key:
                    raise WorkflowValidationError(
                        f"connections[{index}].kind: dashed feedback edge "
                        f"'{from_key}' cannot target itself"
                    )
                if to_key not in upstream_of(from_key):
                    raise WorkflowValidationError(
                        f"connections[{index}].kind: dashed edge "
                        f"'{from_key} -> {to_key}' must target an upstream "
                        f"producer of the verifier"
                    )
        else:
            dependencies = {
                step.get("key", step.get("id", "")): list(step.get("dependsOn", []))
                for step in items
            }
            for step_index, step in enumerate(items):
                for dependency_index, dependency in enumerate(
                    step.get("dependsOn", [])
                ):
                    if dependency not in seen_keys:
                        raise WorkflowValidationError(
                            f"steps[{step_index}].dependsOn[{dependency_index}]: "
                            f"step '{dependency}' does not exist"
                        )
            for step_index, step in enumerate(items):
                for rework_index, target in enumerate(
                    step.get("reworkUpstream", [])
                ):
                    if target not in seen_keys:
                        raise WorkflowValidationError(
                            f"steps[{step_index}].reworkUpstream[{rework_index}]: "
                            f"step '{target}' does not exist"
                        )
            self._validate_acyclic(dependencies)
        return self

    def auto_start_enabled(self, start_step_key: str | None = None) -> bool:
        """Return whether tasks created at the selected step should start."""
        self.validate()
        collection_name = "nodes" if "nodes" in self._raw else "steps"
        items = self._raw.get(collection_name, [])
        if not items:
            return False
        selected = items[0] if start_step_key is None else next(
            (
                item
                for item in items
                if item.get("key", item.get("type", item.get("id", "")))
                == start_step_key
            ),
            None,
        )
        return bool(selected and selected.get("autoStart", False))

    def compile(self) -> CompiledWorkflow:
        """Compile this definition to TaskRunner's canonical step format."""
        self.validate()
        if "nodes" in self._raw:
            nodes = self._raw.get("nodes", [])
            dependencies = {node["id"]: [] for node in nodes}
            rework_by_id: dict[Any, list[str]] = {node["id"]: [] for node in nodes}
            incoming_by_id: dict[Any, list[dict[str, Any]]] = {
                node["id"]: [] for node in nodes
            }
            outgoing_by_id: dict[Any, list[dict[str, Any]]] = {
                node["id"]: [] for node in nodes
            }
            for index, connection in enumerate(self._raw.get("connections", [])):
                source_node = next(
                    node for node in nodes if node["id"] == connection["from"]
                )
                source_outputs = source_node.get("outputs", [])
                source_port = int(connection.get("fromPort", 0))
                compiled_connection = {
                    "id": f"connection-{index}",
                    "from": self._node_key_by_id(connection["from"]),
                    "fromPort": int(connection.get("fromPort", 0)),
                    "to": self._node_key_by_id(connection["to"]),
                    "toPort": int(connection.get("toPort", 0)),
                    "kind": connection.get("kind", "solid"),
                }
                if 0 <= source_port < len(source_outputs):
                    compiled_connection["output"] = deepcopy(
                        source_outputs[source_port]
                    )
                outgoing_by_id[connection["from"]].append(compiled_connection)
                incoming_by_id[connection["to"]].append(compiled_connection)
                if connection.get("kind", "solid") == "dashed":
                    # Dashed edges point from the verifier to its producers:
                    # the verifier declares the producers as rework targets.
                    rework_by_id[connection["from"]].append(
                        self._node_key_by_id(connection["to"])
                    )
                else:
                    from_key = self._node_key_by_id(connection["from"])
                    if from_key not in dependencies[connection["to"]]:
                        dependencies[connection["to"]].append(from_key)
            steps = tuple(
                self._normalize_step(
                    {
                        **node,
                        "key": node.get(
                            "key", node.get("type", node.get("id", ""))
                        ),
                        "label": node.get(
                            "label", node.get("title", node.get("type", ""))
                        ),
                        "dependsOn": dependencies[node["id"]],
                        "reworkUpstream": rework_by_id[node["id"]],
                        "maxReturnRounds": node.get(
                            "maxReturnRounds", MAX_RETURN_ROUNDS
                        ),
                        "incomingConnections": incoming_by_id[node["id"]],
                        "outgoingConnections": outgoing_by_id[node["id"]],
                    }
                )
                for node in nodes
            )
        else:
            steps = tuple(
                self._normalize_step(step) for step in self._raw.get("steps", [])
            )
        return CompiledWorkflow(
            steps=steps,
            schema_version=self.CURRENT_SCHEMA_VERSION,
        )

    def _node_key_by_id(self, node_id: Any) -> str:
        for node in self._raw.get("nodes", []):
            if node.get("id") == node_id:
                return node.get(
                    "key", node.get("type", node.get("id", ""))
                )
        raise KeyError(node_id)

    @staticmethod
    def _validate_acyclic(dependencies: Mapping[str, list[str]]) -> None:
        visited: set[str] = set()
        active: list[str] = []
        active_keys: set[str] = set()

        def visit(key: str) -> None:
            if key in active_keys:
                cycle_start = active.index(key)
                cycle = [*active[cycle_start:], key]
                raise WorkflowValidationError(
                    f"workflow: cycle detected: {' -> '.join(cycle)}"
                )
            if key in visited:
                return
            active.append(key)
            active_keys.add(key)
            for dependency in dependencies[key]:
                visit(dependency)
            active.pop()
            active_keys.remove(key)
            visited.add(key)

        for step_key in dependencies:
            visit(step_key)

    @staticmethod
    def _normalize_step(step: Mapping[str, Any]) -> dict[str, Any]:
        config = step.get("config", {})
        if not isinstance(config, dict):
            raise WorkflowValidationError(
                f"step '{step.get('key', step.get('id', ''))}'.config: "
                "expected a dict"
            )
        normalized = {
            "key": step.get("key", step.get("id", "")),
            "label": step.get("label", step.get("name", "")),
            "engine": resolve_execution_engine(step.get("engine")),
            "model": step.get("model", ""),
            "config": dict(config),
            "prompt": step.get("prompt", ""),
            "color": step.get("color", "#888"),
            "inputs": deepcopy(step.get("inputs", [])),
            "outputs": deepcopy(step.get("outputs", [])),
            "dependsOn": list(step.get("dependsOn", [])),
            "condition": step.get("condition", ""),
            "reworkUpstream": list(step.get("reworkUpstream", [])),
        }
        if "maxReturnRounds" in step:
            max_return_rounds = step.get("maxReturnRounds")
            if (
                not isinstance(max_return_rounds, int)
                or isinstance(max_return_rounds, bool)
                or max_return_rounds < 1
                or max_return_rounds > MAX_CONFIGURED_RETURN_ROUNDS
            ):
                raise WorkflowValidationError(
                    f"step '{normalized['key']}'.maxReturnRounds: expected "
                    f"an integer between 1 and {MAX_CONFIGURED_RETURN_ROUNDS}"
                )
            normalized["maxReturnRounds"] = max_return_rounds
        if "incomingConnections" in step:
            normalized["incomingConnections"] = deepcopy(
                step.get("incomingConnections", [])
            )
        if "outgoingConnections" in step:
            normalized["outgoingConnections"] = deepcopy(
                step.get("outgoingConnections", [])
            )
        if step.get("kind") == "task_dispatch":
            dispatch = step.get("dispatch")
            if not isinstance(dispatch, dict):
                raise WorkflowValidationError(
                    f"step '{normalized['key']}'.dispatch: expected a dict"
                )
            normalized["kind"] = "task_dispatch"
            normalized["dispatch"] = deepcopy(dispatch)
        # Absence means legacy pass-through. An explicit review object enables
        # the review gate, including manual review when auto is false.
        if "review" in step:
            review = step.get("review") or {}
            max_retries = review.get("maxRetries", 1)
            if (
                not isinstance(max_retries, int)
                or isinstance(max_retries, bool)
                or max_retries < 0
            ):
                raise WorkflowValidationError(
                    f"step '{normalized['key']}'.review.maxRetries: "
                    "expected a non-negative integer"
                )
            review_config = review.get("config", {})
            if not isinstance(review_config, dict):
                raise WorkflowValidationError(
                    f"step '{normalized['key']}'.review.config: "
                    "expected a dict"
                )
            normalized["review"] = {
                "mode": review.get(
                    "mode", "auto" if review.get("auto", False) else "manual"
                ),
                "auto": bool(review.get("auto", False)),
                "maxRetries": max_retries,
                "engine": review.get("engine", ""),
                "model": review.get("model", ""),
                "prompt": review.get("prompt", ""),
                "config": dict(review_config),
            }
        return normalized
