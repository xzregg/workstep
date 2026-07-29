"""TaskRunner — multi-stage pipeline execution with parallel branches."""

import asyncio
import json
import logging
import time
import uuid
from pathlib import Path

from models import Message, StepRun, Task, TaskStep, WorkflowRun
from services.pipeline import DAGScheduler, Step
from services.prompt import assemble_prompt
from services.config import config_store
from engines.registry import create_engine
from engines.events import InternalEvent
from streaming.bus import EventBus

logger = logging.getLogger(__name__)


class TaskRunner:
    """Runs a task through its multi-stage pipeline.

    Handles:
    - DAG scheduling (respects dependsOn)
    - Parallel execution (asyncio.gather for fan-out)
    - Prompt assembly with upstream artifacts
    - Engine selection per step
    - Status tracking and event broadcasting
    """

    def __init__(self, event_bus: EventBus):
        self._event_bus = event_bus
        self._running_engines: dict[str, object] = {}  # step_run_key → engine
        self._cancelled_steps: set[str] = set()

    async def run_pipeline(
        self,
        task: Task,
        steps_config: dict,
        artifacts_dir: Path,
        user_input: str = "",
        workflow_run: WorkflowRun | None = None,
    ) -> None:
        """Run the full pipeline for a task.

        Args:
            task: The Task model instance.
            steps_config: Parsed steps.json {"steps": [...]}.
            artifacts_dir: Path to .workstep/artifacts/.
            user_input: Optional user supplementary input.
        """
        # Build DAG
        step_list = [Step.from_dict(s) for s in steps_config.get("steps", [])]
        if not step_list:
            logger.warning("No steps in pipeline for task %s", task.id)
            return

        scheduler = DAGScheduler(step_list)

        # Ensure task_steps exist for all steps
        for step in step_list:
            TaskStep.get_or_create(
                task=task,
                step_key=step.key,
                defaults={"status": "pending"},
            )

        # Mark task as running
        task.status = "running"
        task.updated_at = int(time.time())
        task.save()

        # Track completed/running steps
        completed = set()
        running = set()
        failed = set()

        # A task may intentionally start from a later stage. Persisted skipped
        # stages satisfy their DAG dependencies without producing artifacts.
        for ts in TaskStep.select().where(
            (TaskStep.task == task) & (TaskStep.status == "skipped")
        ):
            completed.add(ts.step_key)

        # Completion belongs to a workflow run, not permanently to the task.
        # Legacy direct calls have no run record, so retain their old TaskStep
        # resume behavior.
        if workflow_run is not None:
            for step_run in StepRun.select().where(
                (StepRun.run == workflow_run)
                & (StepRun.status == "succeeded")
            ):
                completed.add(step_run.step_key)
        else:
            for ts in TaskStep.select().where(
                (TaskStep.task == task) & (TaskStep.status == "passed")
            ):
                completed.add(ts.step_key)

        try:
            await self._execute_dag(
                task,
                scheduler,
                artifacts_dir,
                user_input,
                completed,
                running,
                failed,
                workflow_run,
            )
        except Exception as e:
            logger.exception("Pipeline failed for task %s", task.id)
            task.status = "stopped"
        else:
            # Check if all steps completed
            all_keys = set(scheduler.steps.keys())
            if completed == all_keys:
                task.status = "ready"  # all done
            else:
                task.status = "paused"  # some failed
        finally:
            task.updated_at = int(time.time())
            task.save()

    async def _execute_dag(
        self,
        task: Task,
        scheduler: DAGScheduler,
        artifacts_dir: Path,
        user_input: str,
        completed: set[str],
        running: set[str],
        failed: set[str],
        workflow_run: WorkflowRun | None,
    ) -> None:
        """Recursively execute ready steps, respecting DAG dependencies."""
        ready = scheduler.get_ready_steps(completed, running | failed)
        if not ready:
            return  # Pipeline complete or no more work

        # Fan-out: run all ready steps in parallel
        coros = [
            self._run_step(
                task,
                step,
                artifacts_dir,
                user_input,
                completed,
                running,
                failed,
                workflow_run,
            )
            for step in ready
        ]
        await asyncio.gather(*coros)

        # Recurse: check for newly ready steps
        await self._execute_dag(
            task,
            scheduler,
            artifacts_dir,
            user_input,
            completed,
            running,
            failed,
            workflow_run,
        )

    async def _run_step(
        self,
        task: Task,
        step: Step,
        artifacts_dir: Path,
        user_input: str,
        completed: set[str],
        running: set[str],
        failed: set[str],
        workflow_run: WorkflowRun | None,
    ) -> None:
        """Execute a single pipeline step."""
        step_key = step.key
        run_key = f"{task.id}:{step_key}"
        resolved_model = (
            step.model
            or config_store.get_engine_default_model(step.engine)
            or None
        )

        # Update step status
        ts = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == step_key))
        ts.status = "running"
        ts.started_at = int(time.time())
        ts.engine = step.engine
        ts.save()

        running.add(step_key)

        step_run = None
        if workflow_run is not None:
            attempt = (
                StepRun.select()
                .where(
                    (StepRun.run == workflow_run)
                    & (StepRun.step_key == step_key)
                )
                .count()
                + 1
            )
            step_run = StepRun.create(
                id=str(uuid.uuid4()),
                run=workflow_run,
                step_key=step_key,
                attempt=attempt,
                status="running",
                engine=step.engine,
                model=resolved_model,
                started_at=int(time.time()),
            )

        await self._publish(task.id, step_key, {
            "type": "status",
            "data": {"status": "running", "step_key": step_key},
        })

        # Assemble prompt
        prompt = assemble_prompt(task, step, artifacts_dir, user_input)

        # Ensure artifact output directory
        out_dir = artifacts_dir / step_key / task.id
        out_dir.mkdir(parents=True, exist_ok=True)

        # Create message record
        msg_id = str(uuid.uuid4())
        Message.create(
            id=msg_id,
            task=task,
            step_key=step_key,
            role="assistant",
            engine=step.engine,
            model=resolved_model,
            run_id=msg_id,
            run_status="running",
            position=1,
            created_at=int(time.time()),
        )

        # Select engine
        engine = create_engine(step.engine)
        if not engine:
            error = f"Engine '{step.engine}' not available"
            await self._fail_step(ts, task, step_key, error)
            failed.add(step_key)
            message = Message.get_by_id(msg_id)
            message.events_json = json.dumps([
                InternalEvent(type="error", data={"message": error}).to_dict()
            ])
            message.run_status = "failed"
            message.ended_at = int(time.time())
            message.save()
            if step_run is not None:
                step_run.status = "failed"
                step_run.error = error
                step_run.ended_at = int(time.time())
                step_run.save()
            running.discard(step_key)
            return

        self._cancelled_steps.discard(run_key)
        self._running_engines[run_key] = engine
        events_collected = []
        content_parts = []
        reported_error: str | None = None

        try:
            async for event in engine.spawn(
                prompt=prompt,
                cwd=task.cwd,
                model=resolved_model,
            ):
                events_collected.append(event.to_dict())
                if event.type == "text_delta":
                    content_parts.append(event.data.get("delta", ""))
                elif event.type == "error" and reported_error is None:
                    reported_error = str(
                        event.data.get("message") or "Engine reported an error"
                    )
                await self._publish(task.id, step_key, {
                    "type": event.type,
                    "data": {**event.data, "task_id": task.id, "step_key": step_key},
                })

            if run_key in self._cancelled_steps:
                await self._fail_step(ts, task, step_key, "Cancelled")
                failed.add(step_key)
            elif reported_error is not None:
                await self._fail_step(ts, task, step_key, reported_error)
                failed.add(step_key)
            else:
                # Step passed
                ts.status = "passed"
                ts.ended_at = int(time.time())
                ts.save()
                completed.add(step_key)

                await self._publish(task.id, step_key, {
                    "type": "status",
                    "data": {"status": "passed", "step_key": step_key, "task_id": task.id},
                })

        except Exception as e:
            logger.exception("Step %s failed", step_key)
            await self._fail_step(ts, task, step_key, str(e))
            failed.add(step_key)
            events_collected.append(InternalEvent(type="error", data={"message": str(e)}).to_dict())

        finally:
            # Update message
            try:
                msg = Message.get_by_id(msg_id)
                msg.events_json = json.dumps(events_collected)
                msg.content = "".join(content_parts)
                msg.run_status = "succeeded" if ts.status == "passed" else "failed"
                msg.ended_at = int(time.time())
                msg.save()
            except Exception:
                logger.exception("Failed to update message %s", msg_id)

            self._running_engines.pop(run_key, None)
            self._cancelled_steps.discard(run_key)
            running.discard(step_key)
            if step_run is not None:
                step_run.status = (
                    "succeeded" if ts.status == "passed" else "failed"
                )
                step_run.error = ts.error
                step_run.ended_at = int(time.time())
                step_run.save()

    async def _fail_step(self, ts: TaskStep, task: Task, step_key: str, error: str):
        """Mark a step as failed."""
        ts.status = "failed"
        ts.error = error
        ts.ended_at = int(time.time())
        ts.save()

        await self._publish(task.id, step_key, {
            "type": "error",
            "data": {"message": error, "task_id": task.id, "step_key": step_key},
        })
        await self._publish(task.id, step_key, {
            "type": "status",
            "data": {"status": "failed", "task_id": task.id, "step_key": step_key},
        })

    async def cancel_step(self, task_id: str, step_key: str) -> bool:
        """Cancel a running step."""
        run_key = f"{task_id}:{step_key}"
        engine = self._running_engines.get(run_key)
        if not engine:
            return False
        self._cancelled_steps.add(run_key)
        await engine.stop()
        return True

    async def cancel_task(self, task_id: str) -> bool:
        """Cancel every running step for a task."""
        prefix = f"{task_id}:"
        run_keys = [
            run_key
            for run_key in self._running_engines
            if run_key.startswith(prefix)
        ]
        if not run_keys:
            return False
        for run_key in run_keys:
            self._cancelled_steps.add(run_key)
        await asyncio.gather(
            *(self._running_engines[run_key].stop() for run_key in run_keys)
        )
        return True

    async def _publish(self, task_id: str, step_key: str, event: dict):
        await self._event_bus.publish({
            "task_id": task_id,
            "step_key": step_key,
            **event,
        })
