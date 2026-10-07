"""DAG rewind and persistent step state after review or artifact feedback."""

from typing import Awaitable, Callable

from models import Task, TaskStep
from services.pipeline import DAGScheduler, Step


def artifact_return_events(task_id, source_step, scheduler, feedback_edges):
    """Describe selected repairs and their waiting downstream after commit."""
    targets = {str(edge.get("to")) for edge in feedback_edges}
    rewind = set(targets)
    for target in targets:
        rewind.update(scheduler.get_all_downstream(target))
    events = [{
        "type": "status", "step_key": key,
        "data": {"status": "rework" if key in targets else "rework_waiting",
                 "task_id": task_id, "step_key": key},
    } for key in sorted(rewind)]
    events.append({
        "type": "step_return", "step_key": source_step.key,
        "data": {"task_id": task_id, "step_key": source_step.key,
                 "targets": sorted(targets),
                 "connections": [edge.get("id") for edge in feedback_edges],
                 "max_returns": source_step.max_return_rounds},
    })
    return events


class StepRework:
    """Keep both feedback paths' rewind, persistence and events together."""

    def __init__(
        self,
        run_db: Callable[[Callable[[], None]], Awaitable[None]],
        publish: Callable[[str, str, dict], Awaitable[None]],
    ):
        self._run_db = run_db
        self._publish = publish

    async def from_artifact(
        self,
        task: Task,
        source_step: Step,
        scheduler: DAGScheduler,
        completed: set[str],
        failed: set[str],
        feedback_edges: tuple[dict, ...],
    ) -> None:
        """Rewind feedback targets while retaining their other input ports."""
        targets = {str(connection.get("to")) for connection in feedback_edges}
        rewind: set[str] = set()
        for target in targets:
            rewind.add(target)
            rewind.update(scheduler.get_all_downstream(target))
        completed.difference_update(rewind)
        failed.difference_update(rewind)

        def persist_return():
            for key in rewind:
                row = TaskStep.get(
                    (TaskStep.task == task) & (TaskStep.step_key == key)
                )
                row.status = (
                    "rework" if key in targets else "rework_waiting"
                )
                # The input snapshot already carries feedback artifact paths.
                row.rework_feedback = None
                row.error = None
                row.started_at = None
                row.ended_at = None
                row.save()

        await self._run_db(persist_return)
        for event in artifact_return_events(
            task.id, source_step, scheduler, feedback_edges,
        ):
            await self._publish(task.id, event["step_key"], event)

    async def from_review(
        self,
        task: Task,
        step: Step,
        scheduler: DAGScheduler,
        completed: set[str],
        feedback: str,
        attempt: int,
    ) -> None:
        """Re-run rejected review's producers and their downstream steps."""
        rewind: set[str] = set()
        for upstream_key in step.rework_upstream:
            rewind.add(upstream_key)
            rewind.update(scheduler.get_all_downstream(upstream_key))

        targets = set(step.rework_upstream)
        rework_keys = [key for key in sorted(rewind) if key != step.key]
        completed.difference_update(rework_keys)

        def persist_rework():
            for key in rework_keys:
                ts = TaskStep.get(
                    (TaskStep.task == task) & (TaskStep.step_key == key)
                )
                ts.status = "rework"
                ts.rework_feedback = feedback if key in targets else None
                ts.ended_at = None
                ts.save()

        await self._run_db(persist_rework)
        for key in rework_keys:
            await self._publish(task.id, key, {
                "type": "status",
                "data": {"status": "rework", "task_id": task.id, "step_key": key},
            })

        await self._publish(task.id, step.key, {
            "type": "step_rework",
            "data": {
                "task_id": task.id,
                "step_key": step.key,
                "rework_targets": list(step.rework_upstream),
                "attempt": attempt,
                "max_retries": int((step.review or {}).get("maxRetries", 1)),
            },
        })
