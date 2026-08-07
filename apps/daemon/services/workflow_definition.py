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
        """Return whether tasks created at the selected stage should start."""
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
            for connection in self._raw.get("connections", []):
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
        normalized = {
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
            "reworkUpstream": list(step.get("reworkUpstream", [])),
        }
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
            normalized["review"] = {
                "auto": bool(review.get("auto", False)),
                "maxRetries": max_retries,
                "engine": review.get("engine", ""),
                "model": review.get("model", ""),
                "prompt": review.get("prompt", ""),
            }
        return normalized
