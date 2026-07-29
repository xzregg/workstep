"""TaskRunner — multi-stage pipeline execution with parallel branches."""

import asyncio
import json
import logging
import time
import uuid
from pathlib import Path

from models import Message, ReviewRun, StepRun, Task, TaskStep, WorkflowRun
from services.pipeline import DAGScheduler, Step
from services.prompt import assemble_prompt
from services.review_gate import ReviewGate
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
                reviews = list(
                    ReviewRun.select()
                    .where(ReviewRun.step_run == step_run)
                    .order_by(ReviewRun.attempt.desc())
                )
                if not reviews or reviews[0].status == "passed":
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
        review_feedback: str = "",
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
        is_review_retry = ts.status == "retrying" and ts.started_at is not None
        ts.status = "running"
        # A review retry is still part of the same stage lifecycle. Preserve the
        # first attempt's start time so the final duration includes execution,
        # automatic review, and every retry.
        if not is_review_retry:
            ts.started_at = int(time.time())
        ts.ended_at = None
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
        if review_feedback:
            prompt += (
                "\n\n## 上一轮审核反馈\n"
                f"{review_feedback}\n\n"
                "请保留已有正确结果，并修复以上问题。"
            )

        # Ensure artifact output directory
        out_dir = artifacts_dir / step_key / task.id
        out_dir.mkdir(parents=True, exist_ok=True)

        # Create message record
        msg_id = str(uuid.uuid4())
        message_started_at = int(time.time())
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
            started_at=message_started_at,
            created_at=message_started_at,
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
        execution_succeeded = False
        retry_feedback: str | None = None

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
                execution_succeeded = True
                # Missing review means a legacy workflow and retains the old
                # execution-success-is-passed behavior.
                if step.review is None or workflow_run is None or step_run is None:
                    ts.status = "passed"
                    ts.ended_at = int(time.time())
                    ts.save()
                    completed.add(step_key)
                else:
                    step_run.status = "succeeded"
                    step_run.ended_at = int(time.time())
                    step_run.save()
                    ts.status = (
                        "reviewing"
                        if step.review.get("auto", False)
                        else "awaiting_review"
                    )
                    ts.save()
                    await self._publish(task.id, step_key, {
                        "type": "status",
                        "data": {
                            "status": ts.status,
                            "step_key": step_key,
                            "task_id": task.id,
                        },
                    })
                    gate = ReviewGate(
                        lambda event: self._publish(task.id, step_key, event)
                    )
                    outcome = await gate.evaluate(
                        task=task,
                        step=step,
                        workflow_run=workflow_run,
                        step_run=step_run,
                        artifacts_dir=artifacts_dir,
                        execution_output="".join(content_parts),
                    )
                    if outcome.status == "passed":
                        ts.status = "passed"
                        ts.ended_at = int(time.time())
                        ts.error = None
                        ts.save()
                        completed.add(step_key)
                    elif outcome.status == "awaiting_review":
                        ts.status = "awaiting_review"
                        # The stage remains open until the reviewer decides.
                        # decide_review() records the actual lifecycle end.
                        ts.ended_at = None
                        ts.save()
                        failed.add(step_key)
                    elif step_run.attempt <= int(step.review.get("maxRetries", 1)):
                        retry_feedback = outcome.feedback
                        ts.status = "retrying"
                        ts.error = outcome.feedback
                        ts.save()
                        await self._publish(task.id, step_key, {
                            "type": "step_retrying",
                            "data": {
                                "task_id": task.id,
                                "step_key": step_key,
                                "attempt": step_run.attempt + 1,
                                "max_retries": step.review.get("maxRetries", 1),
                            },
                        })
                    else:
                        ts.status = "rejected"
                        ts.error = outcome.feedback
                        ts.ended_at = int(time.time())
                        ts.save()
                        failed.add(step_key)

                await self._publish(task.id, step_key, {
                    "type": "status",
                    "data": {
                        "status": ts.status,
                        "step_key": step_key,
                        "task_id": task.id,
                    },
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
                msg.run_status = "succeeded" if execution_succeeded else "failed"
                msg.ended_at = int(time.time())
                msg.save()
            except Exception:
                logger.exception("Failed to update message %s", msg_id)

            self._running_engines.pop(run_key, None)
            self._cancelled_steps.discard(run_key)
            running.discard(step_key)
            if step_run is not None:
                if step_run.status == "running":
                    step_run.status = (
                        "succeeded" if execution_succeeded else "failed"
                    )
                    step_run.error = None if execution_succeeded else ts.error
                    step_run.ended_at = int(time.time())
                    step_run.save()

        if retry_feedback is not None:
            await self._run_step(
                task,
                step,
                artifacts_dir,
                user_input,
                completed,
                running,
                failed,
                workflow_run,
                retry_feedback,
            )

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
