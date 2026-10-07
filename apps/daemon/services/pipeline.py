"""Pipeline orchestration — DAG scheduling and multi-step task execution."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from services.config import DEFAULT_EXECUTION_ENGINE
from services.workflow_limits import MAX_RETURN_ROUNDS


@dataclass
class Step:
    """A single step in a workflow pipeline."""

    key: str
    label: str
    engine: str = DEFAULT_EXECUTION_ENGINE
    model: str = ""
    config: dict = field(default_factory=dict)
    prompt: str = ""
    color: str = "#888"
    inputs: list[dict] = field(default_factory=list)
    outputs: list[dict] = field(default_factory=list)
    depends_on: list[str] = field(default_factory=list)
    condition: str = ""  # Optional condition expression for conditional routing
    review: dict | None = None
    rework_upstream: list[str] = field(default_factory=list)  # 验证失败时返工的上游生产者
    max_return_rounds: int = MAX_RETURN_ROUNDS
    incoming_connections: list[dict] = field(default_factory=list)
    outgoing_connections: list[dict] = field(default_factory=list)
    kind: str = "llm"
    dispatch: dict = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: dict) -> "Step":
        return cls(
            key=d["key"] if "key" in d else d.get("id", ""),
            label=d.get("label", d.get("name", "")),
            engine=d.get("engine", DEFAULT_EXECUTION_ENGINE),
            model=d.get("model", ""),
            config=dict(d.get("config") or {}),
            prompt=d.get("prompt", ""),
            color=d.get("color", "#888"),
            inputs=d.get("inputs", []),
            outputs=d.get("outputs", []),
            depends_on=d.get("dependsOn", []),
            condition=d.get("condition", ""),
            review=d.get("review"),
            rework_upstream=list(d.get("reworkUpstream", [])),
            max_return_rounds=int(d.get("maxReturnRounds", MAX_RETURN_ROUNDS)),
            incoming_connections=list(d.get("incomingConnections", [])),
            outgoing_connections=list(d.get("outgoingConnections", [])),
            kind=d.get("kind", "llm"),
            dispatch=dict(d.get("dispatch") or {}),
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

    def get_ready_steps(
        self,
        completed: set[str],
        running: set[str] | None = None,
        step_results: dict[str, bool] | None = None,
        active_edges: set[str] | None = None,
        task_context_edges: set[str] | None = None,
    ) -> list[Step]:
        """Return steps whose dependencies are all completed and not already running.

        Args:
            completed: Set of step keys that have passed.
            running: Set of step keys currently executing.
            step_results: Optional dict mapping step_key → passed (bool) for condition evaluation.
        """
        running = running or set()
        step_results = step_results or {}
        active_edges = active_edges or set()
        task_context_edges = task_context_edges or set()
        return [
            s for s in self.steps.values()
            if s.key not in completed
            and s.key not in running
            and all(dep in completed for dep in s.depends_on)
            and self._solid_inputs_are_active(
                s,
                active_edges | task_context_edges,
            )
            and self._evaluate_condition(s.condition, step_results)
        ]

    @staticmethod
    def _solid_inputs_are_active(step: Step, active_edges: set[str]) -> bool:
        """Require every compiled solid input edge to have a non-empty value."""
        solid = [
            connection
            for connection in step.incoming_connections
            if connection.get("kind", "solid") == "solid"
        ]
        if not solid:
            return True
        return all(str(connection.get("id")) in active_edges for connection in solid)

    def _evaluate_condition(self, condition: str, step_results: dict[str, bool]) -> bool:
        """Evaluate a condition expression against step results.

        Condition syntax:
        - Empty string: always true (no condition)
        - "step_key:passed" or "step_key:failed": check step result
        - "step_key:passed && other_key:failed": AND conditions
        - "step_key:passed || other_key:passed": OR conditions

        Returns True if the step should run, False if it should be skipped.
        """
        if not condition:
            return True

        # Simple condition evaluation
        try:
            # Handle OR conditions
            if "||" in condition:
                parts = condition.split("||")
                return any(self._eval_single_condition(p.strip(), step_results) for p in parts)

            # Handle AND conditions
            if "&&" in condition:
                parts = condition.split("&&")
                return all(self._eval_single_condition(p.strip(), step_results) for p in parts)

            # Single condition
            return self._eval_single_condition(condition.strip(), step_results)

        except Exception:
            # If condition parsing fails, default to running the step
            return True

    def _eval_single_condition(self, cond: str, step_results: dict[str, bool]) -> bool:
        """Evaluate a single condition like 'step_key:passed' or 'step_key:failed'."""
        if ":" not in cond:
            return True

        step_key, expected = cond.split(":", 1)
        step_key = step_key.strip()
        expected = expected.strip().lower()

        actual = step_results.get(step_key)
        if actual is None:
            # Step hasn't run yet, can't evaluate
            return True

        if expected == "passed":
            return actual is True
        elif expected == "failed":
            return actual is False
        else:
            return True

    def get_downstream(self, step_key: str) -> list[Step]:
        """Return all steps that directly depend on the given step."""
        return [s for s in self.steps.values() if step_key in s.depends_on]

    def get_skippable_steps(
        self,
        completed: set[str],
        excluded: set[str] | None = None,
        active_edges: set[str] | None = None,
        task_context_edges: set[str] | None = None,
    ) -> list[Step]:
        """Return optional branches not selected by their completed sources."""
        skippable, _blocked = self._classify_unroutable_steps(
            completed,
            excluded,
            active_edges,
            task_context_edges,
        )
        return skippable

    def get_blocked_steps(
        self,
        completed: set[str],
        excluded: set[str] | None = None,
        active_edges: set[str] | None = None,
        task_context_edges: set[str] | None = None,
    ) -> list[Step]:
        """Return steps missing required output from completed sources."""
        _skippable, blocked = self._classify_unroutable_steps(
            completed,
            excluded,
            active_edges,
            task_context_edges,
        )
        return blocked

    def _classify_unroutable_steps(
        self,
        completed: set[str],
        excluded: set[str] | None,
        active_edges: set[str] | None,
        task_context_edges: set[str] | None,
    ) -> tuple[list[Step], list[Step]]:
        """Separate unselected branches from missing required outputs.

        An inactive edge is an intentional branch omission only when its
        completed source activated another solid outgoing edge in this run.
        If a completed source activated no forward edge at all, its downstream
        is blocked by a missing required output rather than successfully
        skipped.
        """
        excluded = excluded or set()
        active_edges = active_edges or set()
        task_context_edges = task_context_edges or set()
        satisfied_edges = active_edges | task_context_edges
        skippable: list[Step] = []
        blocked: list[Step] = []
        for step in self.steps.values():
            if step.key in completed or step.key in excluded:
                continue
            solid = [
                connection
                for connection in step.incoming_connections
                if connection.get("kind", "solid") == "solid"
            ]
            if not solid:
                continue
            sources = {str(connection.get("from")) for connection in solid}
            if not all(dep in completed for dep in step.depends_on):
                continue
            if not sources.issubset(completed):
                continue
            inactive = [
                connection
                for connection in solid
                if str(connection.get("id")) not in satisfied_edges
            ]
            if not inactive:
                continue
            # An activated return explicitly selects this target; a missing
            # initial input cannot turn requested repair into an omitted branch.
            missing_required = any(
                connection.get("kind") == "dashed"
                and str(connection.get("id")) in active_edges
                for connection in step.incoming_connections
            )
            for connection in inactive:
                source = self.steps.get(str(connection.get("from")))
                active_sibling = bool(source) and any(
                    outgoing.get("kind", "solid") == "solid"
                    and str(outgoing.get("id")) in active_edges
                    for outgoing in source.outgoing_connections
                )
                if not active_sibling:
                    missing_required = True
                    break
            (blocked if missing_required else skippable).append(step)
        return skippable, blocked

    def get_all_downstream(self, step_key: str) -> set[str]:
        """Return all transitive downstream step keys."""
        if step_key not in self.steps:
            raise KeyError(step_key)
        result: set[str] = set()
        stack = [step.key for step in self.get_downstream(step_key)]
        while stack:
            key = stack.pop()
            if key in result:
                continue
            result.add(key)
            stack.extend(step.key for step in self.get_downstream(key))
        return result

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
