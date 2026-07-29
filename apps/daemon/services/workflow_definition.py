"""Load, validate, and compile persisted workflow definitions.

This module is the compatibility seam between editor-oriented workflow JSON and
the canonical ``{"steps": [...]}`` structure consumed by ``TaskRunner``.
"""

from __future__ import annotations

import re
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Mapping


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
            for index, connection in enumerate(self._raw.get("connections", [])):
                for endpoint in ("from", "to"):
                    node_id = connection.get(endpoint)
                    if node_id not in node_ids:
                        raise WorkflowValidationError(
                            f"connections[{index}].{endpoint}: "
                            f"node '{node_id}' does not exist"
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
                node.get("id"): node.get("key", node.get("type", "")) for node in items
            }
            dependencies = {key: [] for key in key_by_id.values()}
            for connection in self._raw.get("connections", []):
                dependencies[key_by_id[connection.get("to")]].append(
                    key_by_id[connection.get("from")]
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
        self._validate_acyclic(dependencies)
        return self

    def compile(self) -> CompiledWorkflow:
        """Compile this definition to TaskRunner's canonical step format."""
        self.validate()
        if "nodes" in self._raw:
            nodes = self._raw.get("nodes", [])
            dependencies = {node["id"]: [] for node in nodes}
            for connection in self._raw.get("connections", []):
                dependency = self._node_key_by_id(connection["from"])
                if dependency not in dependencies[connection["to"]]:
                    dependencies[connection["to"]].append(dependency)
            steps = tuple(
                self._normalize_step(
                    {
                        **node,
                        "key": node.get("key", node.get("type", "")),
                        "label": node.get(
                            "label", node.get("title", node.get("type", ""))
                        ),
                        "dependsOn": dependencies[node["id"]],
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
                return node.get("key", node.get("type", ""))
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
        return {
            "key": step.get("key", step.get("id", "")),
            "label": step.get("label", step.get("name", "")),
            "engine": step.get("engine", "claude"),
            "model": step.get("model", ""),
            "prompt": step.get("prompt", ""),
            "color": step.get("color", "#888"),
            "inputs": deepcopy(step.get("inputs", [])),
            "outputs": deepcopy(step.get("outputs", [])),
            "dependsOn": list(step.get("dependsOn", [])),
            "condition": step.get("condition", ""),
        }
