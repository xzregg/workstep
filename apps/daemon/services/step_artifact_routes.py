"""Runtime artifact-port state, recovery and feedback routing for one DAG."""

import asyncio
import json
from copy import deepcopy
from pathlib import Path

from models import StepRun, Task, TaskStep, WorkflowRun
from models.fields import utc_now
from services.artifact_rounds import ArtifactRound, select_upstream_round, step_round_dir
from services.artifact_routing import (
    empty_routing_state,
    normalize_routing_state,
    resolve_input_snapshot,
    route_artifact_round,
    source_for_connection,
)
from services.pipeline import DAGScheduler, Step
from services.step_rework import StepRework


class StepArtifactRoutes:
    """Own mutable routing state and its persistent projection."""

    def __init__(
        self,
        *,
        input_rounds_by_step: dict[str, dict[str, int]],
        execution_scope: set[str] | None,
        entry_step_key: str | None,
        run_db,
        publish,
        rework: StepRework,
    ):
        self._input_rounds_by_step = input_rounds_by_step
        self._scope = execution_scope
        self._entry_step_key = entry_step_key
        # Only caller-selected rounds require every connected output. Rounds
        # discovered while seeding reused steps must retain the entry fallback.
        self._entry_explicit_sources = set(
            input_rounds_by_step.get(entry_step_key or "", {})
        )
        self._run_db = run_db
        self._publish = publish
        self._rework = rework
        self._state = empty_routing_state()
        self._lock = asyncio.Lock()

    @property
    def scope(self) -> set[str] | None:
        return self._scope

    @property
    def active_edges(self) -> set[str]:
        return set(self._state.get("active_edges", []))

    def restore(
        self,
        routing_state_json: str | None,
        execution_scope: set[str] | None = None,
    ) -> None:
        """Restore a persisted run and apply an optional restart scope."""
        self._state = empty_routing_state()
        if routing_state_json:
            try:
                self._state = normalize_routing_state(
                    json.loads(routing_state_json)
                )
            except (TypeError, json.JSONDecodeError):
                pass
        if execution_scope is not None:
            self._scope = execution_scope

    def task_context_edges(self, scheduler: DAGScheduler) -> set[str]:
        """Entry inputs intentionally replaced by the task context."""
        entry_key = self._entry_step_key
        scope = self._scope
        if not entry_key or scope is None or entry_key not in scheduler.steps:
            return set()
        active_edges = self.active_edges
        return {
            str(connection.get("id"))
            for connection in scheduler.steps[entry_key].incoming_connections
            if connection.get("kind", "solid") == "solid"
            and str(connection.get("from")) not in scope
            and str(connection.get("from")) not in self._entry_explicit_sources
            and str(connection.get("id")) not in active_edges
        }

    async def input_snapshot(
        self,
        task: Task,
        step: Step,
        scheduler: DAGScheduler,
        artifacts_dir: Path,
    ) -> dict:
        """Resolve file inputs from one consistent routing-state snapshot."""
        async with self._lock:
            routing_state = deepcopy(self._state)
            input_rounds = dict(self._input_rounds_by_step.get(step.key, {}))
            context_edges = (
                self.task_context_edges(scheduler)
                if step.key == self._entry_step_key else set()
            )
        return await asyncio.to_thread(
            resolve_input_snapshot,
            step=step,
            artifacts_root=artifacts_dir,
            workflow_id=task.workflow_id,
            task_id=task.id,
            routing_state=routing_state,
            input_rounds=input_rounds,
            task_context_edges=context_edges,
        )

    def input_rounds_for(self, step_key: str) -> dict[str, int]:
        return dict(self._input_rounds_by_step.get(step_key, {}))

    async def _persist_state(self, workflow_run: WorkflowRun) -> None:
        serialized = json.dumps(self._state, ensure_ascii=False, sort_keys=True)

        def persist():
            row = WorkflowRun.get_by_id(workflow_run.id)
            row.routing_state_json = serialized
            row.save(only=[WorkflowRun.routing_state_json])

        await self._run_db(persist)

    async def seed_completed_forward_routes(
        self,
        task: Task,
        scheduler: DAGScheduler,
        artifacts_dir: Path,
        workflow_run: WorkflowRun | None,
        completed: set[str],
    ) -> None:
        """Restore forward-edge readiness for reused or recovered steps."""
        async with self._lock:
            active_edges = self.active_edges
            run_artifact_rounds: dict[str, int] = {}
            if workflow_run is not None:
                def load_run_artifact_rounds():
                    result: dict[str, int] = {}
                    rows = (
                        StepRun.select()
                        .where(
                            (StepRun.run == workflow_run)
                            & (StepRun.status.in_(["succeeded", "reused"]))
                            & (StepRun.artifact_round.is_null(False))
                        )
                        .order_by(StepRun.attempt)
                    )
                    for row in rows:
                        result[row.step_key] = int(row.artifact_round)
                    return result

                run_artifact_rounds = await self._run_db(load_run_artifact_rounds)
            changed = False
            for step_key in completed:
                step = scheduler.steps.get(step_key)
                if step is None or not step.outgoing_connections:
                    continue
                solid = [
                    connection
                    for connection in step.outgoing_connections
                    if connection.get("kind", "solid") != "dashed"
                ]
                if not solid:
                    continue
                if not step.outputs:
                    for connection in solid:
                        edge_id = str(connection.get("id"))
                        if edge_id not in active_edges:
                            active_edges.add(edge_id)
                            changed = True
                    continue
                selected_round = run_artifact_rounds.get(step_key)
                selected = await asyncio.to_thread(
                    select_upstream_round,
                    artifacts_dir,
                    task.workflow_id,
                    task.id,
                    step.key,
                    selected_round,
                )
                if selected is None:
                    continue
                for connection in solid:
                    output_port = int(connection.get("fromPort", 0))
                    output_spec = (
                        step.outputs[output_port]
                        if 0 <= output_port < len(step.outputs) else None
                    )
                    source = await asyncio.to_thread(
                        source_for_connection,
                        connection,
                        selected,
                        output_spec,
                        allow_artifact_remap=True,
                    )
                    if source is None:
                        continue
                    if selected_round is not None:
                        target_step = str(connection.get("to") or "").strip()
                        if target_step:
                            self._input_rounds_by_step.setdefault(
                                target_step, {},
                            )[step_key] = selected.round
                    edge_id = str(connection.get("id"))
                    if edge_id not in active_edges:
                        active_edges.add(edge_id)
                        changed = True
            if not changed:
                return
            self._state["active_edges"] = sorted(active_edges)
            if workflow_run is not None:
                await self._persist_state(workflow_run)

    async def apply(
        self,
        *,
        task: Task,
        step: Step,
        scheduler: DAGScheduler,
        workflow_run: WorkflowRun | None,
        artifacts_dir: Path,
        artifact_round: int,
        manifest: dict,
        completed: set[str],
        failed: set[str],
    ) -> None:
        """Apply one passed round's non-empty output ports to the DAG."""
        if workflow_run is None or not step.outgoing_connections:
            return
        artifact = ArtifactRound(
            round=int(artifact_round),
            path=step_round_dir(
                artifacts_dir, task.workflow_id, task.id,
                step.key, artifact_round,
            ),
            manifest=manifest,
        )
        async with self._lock:
            # Output resolution may inspect large files and directories.
            result = await asyncio.to_thread(
                route_artifact_round,
                step=step,
                artifact_round=artifact,
                routing_state=self._state,
            )
            self._state = result.state
            if result.feedback_edges and self._scope is not None:
                rewind = set()
                for connection in result.feedback_edges:
                    target = str(connection.get("to"))
                    rewind.add(target)
                    rewind.update(scheduler.get_all_downstream(target))
                self._scope.update(rewind)
                self._state["execution_scope"] = sorted(self._scope)
            for connection in result.solid_edges:
                target_step = str(connection.get("to") or "").strip()
                if target_step:
                    self._input_rounds_by_step.setdefault(
                        target_step, {},
                    )[step.key] = artifact.round
            await self._persist_state(workflow_run)

            if result.conflict:
                error = "同一轮同时产生了正常输出和返回输出，路由冲突"
                await self._fail_step(task, step, completed, failed, error)
                await self._publish(task.id, step.key, {
                    "type": "status",
                    "data": {
                        "status": "failed",
                        "error": error,
                        "task_id": task.id,
                        "step_key": step.key,
                    },
                })
                return

            if result.exhausted_edges:
                error = f"返回线已达到配置上限 {step.max_return_rounds} 次"
                await self._fail_step(task, step, completed, failed, error)
                await self._publish(task.id, step.key, {
                    "type": "return_limit_reached",
                    "data": {
                        "status": "failed",
                        "error": error,
                        "task_id": task.id,
                        "step_key": step.key,
                        "max_returns": step.max_return_rounds,
                        "connections": [
                            connection.get("id")
                            for connection in result.exhausted_edges
                        ],
                    },
                })
                return

            if result.feedback_edges:
                await self._rework.from_artifact(
                    task, step, scheduler, completed, failed,
                    result.feedback_edges,
                )

    async def _fail_step(
        self,
        task: Task,
        step: Step,
        completed: set[str],
        failed: set[str],
        error: str,
    ) -> None:
        ended_at = utc_now()

        def persist():
            row = TaskStep.get(
                (TaskStep.task == task.id) & (TaskStep.step_key == step.key)
            )
            row.status = "failed"
            row.error = error
            row.ended_at = ended_at
            row.save()

        await self._run_db(persist)
        completed.discard(step.key)
        failed.add(step.key)
