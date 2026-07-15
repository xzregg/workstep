"""Pipeline orchestration — DAG scheduling and multi-stage task execution."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class Step:
    """A single step in a workflow pipeline."""

    key: str
    label: str
    engine: str = "claude"
    model: str = ""
    prompt: str = ""
    color: str = "#888"
    inputs: list[dict] = field(default_factory=list)
    outputs: list[dict] = field(default_factory=list)
    depends_on: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: dict) -> "Step":
        return cls(
            key=d["key"] if "key" in d else d.get("id", ""),
            label=d.get("label", d.get("name", "")),
            engine=d.get("engine", "claude"),
            model=d.get("model", ""),
            prompt=d.get("prompt", ""),
            color=d.get("color", "#888"),
            inputs=d.get("inputs", []),
            outputs=d.get("outputs", []),
            depends_on=d.get("dependsOn", []),
        )


class DAGScheduler:
    """DAG-based step scheduler.

    Given a list of Steps with dependsOn relationships, determines
    execution order and identifies parallelizable steps.
    """

    def __init__(self, steps: list[Step]):
        self.steps = {s.key: s for s in steps}
        self._validate()

    def _validate(self):
        """Validate DAG: check for cycles and missing dependencies."""
        for step in self.steps.values():
            for dep in step.depends_on:
                if dep not in self.steps:
                    raise ValueError(
                        f"Step '{step.key}' depends on '{dep}' which does not exist"
                    )

        # Check for cycles using DFS
        visited = set()
        in_stack = set()

        def dfs(key: str):
            if key in in_stack:
                raise ValueError(f"Cycle detected involving step '{key}'")
            if key in visited:
                return
            in_stack.add(key)
            for dep in self.steps[key].depends_on:
                dfs(dep)
            in_stack.discard(key)
            visited.add(key)

        for key in self.steps:
            dfs(key)

    def get_ready_steps(self, completed: set[str], running: set[str] | None = None) -> list[Step]:
        """Return steps whose dependencies are all completed and not already running.

        Args:
            completed: Set of step keys that have passed.
            running: Set of step keys currently executing.
        """
        running = running or set()
        return [
            s for s in self.steps.values()
            if s.key not in completed
            and s.key not in running
            and all(dep in completed for dep in s.depends_on)
        ]

    def get_downstream(self, step_key: str) -> list[Step]:
        """Return all steps that directly depend on the given step."""
        return [s for s in self.steps.values() if step_key in s.depends_on]

    def get_all_upstream(self, step_key: str) -> set[str]:
        """Return all transitive upstream step keys."""
        result = set()
        stack = list(self.steps[step_key].depends_on)
        while stack:
            key = stack.pop()
            if key not in result:
                result.add(key)
                stack.extend(self.steps[key].depends_on)
        return result

    def topological_order(self) -> list[str]:
        """Return steps in topological order."""
        visited = set()
        order = []

        def dfs(key: str):
            if key in visited:
                return
            visited.add(key)
            for dep in self.steps[key].depends_on:
                dfs(dep)
            order.append(key)

        for key in self.steps:
            dfs(key)
        return order

    @property
    def is_empty(self) -> bool:
        return len(self.steps) == 0

    @property
    def root_steps(self) -> list[Step]:
        """Steps with no dependencies."""
        return [s for s in self.steps.values() if not s.depends_on]

    @property
    def leaf_steps(self) -> list[Step]:
        """Steps that no other step depends on."""
        depended_on = set()
        for s in self.steps.values():
            depended_on.update(s.depends_on)
        return [s for s in self.steps.values() if s.key not in depended_on]
