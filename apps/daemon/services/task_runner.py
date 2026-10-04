"""TaskRunner — multi-step pipeline execution with parallel branches."""

import asyncio
import json
import logging
import uuid
from pathlib import Path
from typing import AsyncIterator, Callable, TypeVar

from models import (
    Message,
    ReviewRun,
    StepRun,
    Task,
    TaskStep,
    WorkflowRun,
)
from models.fields import utc_now
from models.base import db_proxy
from services.artifact_rounds import (
    discard_artifact_round,
    write_round_manifest,
)
from services.pipeline import DAGScheduler, Step
from services.prompt import assemble_step_system_prompt
from agent_assistants.prompt_input import format_prompt_input
from services.task_step_start import start_step_state
from services.step_execution_messages import StepExecutionMessages
from services.step_interaction_messages import StepInteractionMessages
from services.step_rework import StepRework
from services.step_artifact_routes import StepArtifactRoutes
from services.step_live_messages import StepLiveMessages
from services.review_messages import (
    ReviewEvaluation,
    StepReviewMessages,
    resolve_review_config,
)
from services.config import config_store
from agent_assistants.context_handoff import (
    mark_handoff_consumed,
)
from agent_assistants.event_journal import JournalRef, TurnEventJournal
from engines.core.acp_base import AcpEngineBase
from engines.core.registry import create_engine
from engines.core.agui import AGUIContext, to_agui_events
from engines.core.events import InternalEvent, is_commentary
from streaming.bus import EventBus

logger = logging.getLogger(__name__)
ResultT = TypeVar("ResultT")
async def _with_engine_idle_timeout(
    engine: AcpEngineBase,
    spawn_iter: AsyncIterator[InternalEvent],
    timeout_seconds: float,
) -> AsyncIterator[InternalEvent]:
    """Yield engine events, failing the step when the engine goes idle.

    If no event arrives within ``timeout_seconds`` (e.g. a stalled API
    connection), the engine is stopped and its stream closed, then an error
    event is yielded so the step fails instead of hanging forever. The engine
    session is left intact, so re-running the step resumes the same session.
    """
    while True:
        try:
            event = await asyncio.wait_for(
                spawn_iter.__anext__(),
                timeout=timeout_seconds,
            )
        except StopAsyncIteration:
            return
        except asyncio.TimeoutError:
            try:
                await engine.stop()
            except Exception:
                logger.exception("Engine stop failed after idle timeout")
            try:
                await spawn_iter.aclose()
            except Exception:
                logger.exception(
                    "Failed to close engine stream after idle timeout"
                )
            yield InternalEvent(
                type="error",
                data={
                    "message": (
                        f"引擎空闲超时（{int(timeout_seconds)}s 无输出），"
                        "已停止执行并保留会话，可重新执行该步骤恢复"
                    ),
                },
            )
            return
        yield event


class TaskRunner:

    """Runs a task through its multi-step pipeline.

    Handles:
    - DAG scheduling (respects dependsOn)
    - Parallel execution (asyncio.gather for fan-out)
    - Prompt assembly with upstream artifacts
    - Engine selection per step
    - Status tracking and event broadcasting
    """

    def __init__(
        self,
        event_bus: EventBus,
        dispatch_service=None,
        source_project_id=None,
        database_executor=None,
        step_followups: dict[str, str] | None = None,
        step_trigger_names: dict[str, str] | None = None,
        input_rounds_by_step: dict[str, dict[str, int]] | None = None,
        execution_scope: set[str] | None = None,
        entry_step_key: str | None = None,
        initial_user_input_step_key: str | None = None,
        retry_message_ids: dict[str, str] | None = None,
    ):
        self._event_bus = event_bus
        self._dispatch_service = dispatch_service
        self._source_project_id = source_project_id
        self._database_executor = database_executor
        self._step_followups = step_followups or {}
        self._step_trigger_names = step_trigger_names or {}
        self._initial_user_input_step_key = initial_user_input_step_key
        self._retry_message_ids = dict(retry_message_ids or {})
        self._graceful_shutdown = False
        self._cancel_audit = None
        self._step_cancel_audits = {}
        self._event_journal = TurnEventJournal()
        self._execution_messages = StepExecutionMessages(
            self._event_journal, self._run_db, self._publish,
            self._journal_snapshot, self._ajournal_snapshot,
            self._step_followups, self._step_trigger_names,
            self._initial_user_input_step_key, self._retry_message_ids,
        )
        self._interaction_messages = StepInteractionMessages(
            self._event_journal, self._run_db, self._publish,
            self._journal_snapshot,
        )
        self._live = StepLiveMessages(
            self._event_journal,
            self._run_db,
            self._publish,
            self._ajournal_snapshot,
        )
        self._review_messages = StepReviewMessages(
            self._event_journal, self._run_db, self._publish, self._live,
            project_id=getattr(database_executor, "project_id", None),
        )
        self._step_rework = StepRework(self._run_db, self._publish)
        self._artifact_routes = StepArtifactRoutes(
            input_rounds_by_step=input_rounds_by_step or {},
            execution_scope=execution_scope,
            entry_step_key=entry_step_key,
            run_db=self._run_db,
            publish=self._publish,
            rework=self._step_rework,
        )

    def _journal_snapshot(self, ref: JournalRef) -> dict:
        return self._journal_projection(self._event_journal.snapshot(ref))

    @staticmethod
    def _journal_projection(snapshot: dict) -> dict:
        return {
            "events": snapshot["events"],
            "events_json": (
                json.dumps(snapshot["events"], ensure_ascii=False)
                if snapshot["events"] else None
            ),
            "event_summary_json": json.dumps(
                snapshot["summary"], ensure_ascii=False
            ),
            "event_count": snapshot["summary"]["event_count"],
            "last_event_seq": snapshot["summary"]["last_event_seq"],
            "content": snapshot["content"],
        }

    async def _ajournal_snapshot(self, ref: JournalRef) -> dict:
        snapshot = await self._event_journal.asnapshot(ref)
        return self._journal_projection(snapshot)

    async def _run_db(self, operation: Callable[[], ResultT]) -> ResultT:
        """Run persistence on the owning project's writer when available."""
        if self._database_executor is None:
            return await asyncio.to_thread(operation)
        return await self._database_executor.run(operation)

    async def close(self) -> None:
        await self._event_journal.aclose()

    async def run_pipeline(
        self,
        task: Task,
        steps_config: dict,
        artifacts_dir: Path,
        user_input: str = "",
        workflow_run: WorkflowRun | None = None,
        execution_scope: set[str] | None = None,
    ) -> None:
        """Run the full pipeline for a task.

        Args:
            task: The Task model instance.
            steps_config: Compiled workflow definition {"steps": [...]}.
            artifacts_dir: Path to .workstep/artifacts/.
            user_input: Optional user supplementary input.
        """
        # Build DAG
        step_list = [Step.from_dict(s) for s in steps_config.get("steps", [])]
        if not step_list:
            logger.warning("No steps in pipeline for task %s", task.id)
            return

        scheduler = DAGScheduler(step_list)

        def initialize_pipeline_state() -> tuple[set[str], str | None]:
            # Ensure task_steps exist for all steps.
            for step in step_list:
                TaskStep.get_or_create(
                    task=task,
                    step_key=step.key,
                    defaults={"status": "pending"},
                )

            task.status = "running"
            task.updated_at = utc_now()
            # 只写状态列：整行 save() 会用可能已过期的实例字段覆盖并发写入。
            Task.update(
                status="running",
                updated_at=task.updated_at,
            ).where(Task.id == task.id).execute()

            persisted_completed: set[str] = set()
            task_step_statuses = {
                row.step_key: row.status
                for row in TaskStep.select().where(TaskStep.task == task)
            }
            # A task may intentionally start from a later step. Persisted
            # skipped steps satisfy their DAG dependencies.
            persisted_completed.update(
                step_key
                for step_key, status in task_step_statuses.items()
                if status == "skipped"
            )

            if workflow_run is not None:
                for step_run in StepRun.select().where(
                    (StepRun.run == workflow_run)
                    & (StepRun.status.in_(["succeeded", "reused"]))
                ):
                    # A persisted return/retry marker wins over historical
                    # successful attempts.  Otherwise resuming after a
                    # manually approved feedback artifact would silently
                    # classify the rewound target as already completed.
                    if task_step_statuses.get(step_run.step_key) in {
                        "rework",
                        "rework_waiting",
                        "retrying",
                        "failed",
                        "awaiting_review",
                        "reviewing",
                    }:
                        continue
                    reviews = list(
                        ReviewRun.select()
                        .where(ReviewRun.step_run == step_run)
                        .order_by(ReviewRun.attempt.desc())
                    )
                    if not reviews or reviews[0].status == "passed":
                        persisted_completed.add(step_run.step_key)
            else:
                for ts in TaskStep.select().where(
                    (TaskStep.task == task) & (TaskStep.status == "passed")
                ):
                    persisted_completed.add(ts.step_key)
            return (
                persisted_completed,
                workflow_run.routing_state_json if workflow_run is not None else None,
            )

        completed, routing_state_json = await self._run_db(initialize_pipeline_state)
        self._artifact_routes.restore(routing_state_json, execution_scope)
        # 重启某步骤时只重跑该步骤及其下游（scope）。范围外的步骤即便未通过
        # 也不再执行，但仍要让依赖它们的下游步骤被视为依赖已满足——否则失败的
        # 上游会被 DAG 判为 ready 而抢先执行（@ 下游却跑了上游）。
        scope = self._artifact_routes.scope
        if scope is not None:
            completed |= {key for key in scheduler.steps if key not in scope}
        running = set()
        failed = set()
        await self._artifact_routes.seed_completed_forward_routes(
            task,
            scheduler,
            artifacts_dir,
            workflow_run,
            completed,
        )

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
            final_status = task.status
            finished_at = utc_now()

            def persist_pipeline_status():
                with db_proxy.atomic("IMMEDIATE"):
                    Task.update(
                        status=final_status,
                        updated_at=finished_at,
                    ).where(Task.id == task.id).execute()
                    if (
                        self._cancel_audit is not None
                        and self._source_project_id is not None
                        and final_status in {"paused", "stopped"}
                    ):
                        from services.project_audit import record_project_audit
                        from services.remote_access import replayed_actor_context

                        action, actor = self._cancel_audit
                        with replayed_actor_context(actor):
                            record_project_audit(
                                project_id=self._source_project_id,
                                task_id=task.id,
                                action=action,
                                result="succeeded",
                                mode=("managed" if actor is not None and actor.source == "managed" else "local"),
                                metadata={"status": final_status},
                            )

            task.updated_at = finished_at
            await self._run_db(persist_pipeline_status)

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
        ready = scheduler.get_ready_steps(
            completed,
            running | failed,
            active_edges=self._artifact_routes.active_edges,
            task_context_edges=self._artifact_routes.task_context_edges(scheduler),
        )
        if not ready:
            skipped = scheduler.get_skippable_steps(
                completed,
                running | failed,
                active_edges=self._artifact_routes.active_edges,
                task_context_edges=self._artifact_routes.task_context_edges(scheduler),
            )
            if skipped:
                skipped_keys = {step.key for step in skipped}

                def persist_skipped():
                    TaskStep.update(
                        status="skipped",
                        error=None,
                        ended_at=utc_now(),
                    ).where(
                        (TaskStep.task == task)
                        & (TaskStep.step_key.in_(skipped_keys))
                    ).execute()

                await self._run_db(persist_skipped)
                completed.update(skipped_keys)
                for key in skipped_keys:
                    await self._publish(task.id, key, {
                        "type": "status",
                        "data": {
                            "status": "skipped",
                            "reason": "connected output was not produced",
                            "task_id": task.id,
                            "step_key": key,
                        },
                    })
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
                return
            blocked = scheduler.get_blocked_steps(
                completed,
                running | failed,
                active_edges=self._artifact_routes.active_edges,
                task_context_edges=self._artifact_routes.task_context_edges(scheduler),
            )
            if blocked:
                now = utc_now()
                blocked_keys = {step.key for step in blocked}
                error = "缺少必需的上游产物，步骤无法执行"

                def persist_blocked():
                    TaskStep.update(
                        status="failed",
                        error=error,
                        ended_at=now,
                    ).where(
                        (TaskStep.task == task)
                        & (TaskStep.step_key.in_(blocked_keys))
                    ).execute()

                await self._run_db(persist_blocked)
                failed.update(blocked_keys)
                for key in blocked_keys:
                    await self._publish(task.id, key, {
                        "type": "status",
                        "data": {
                            "status": "failed",
                            "reason": "required_input_missing",
                            "error": error,
                            "task_id": task.id,
                            "step_key": key,
                        },
                    })
            return  # Pipeline complete or no more work

        # Fan-out: run all ready steps in parallel
        coros = [
            self._run_step(
                task,
                step,
                scheduler,
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

    async def _apply_review_result(
        self,
        task: Task,
        step: Step,
        scheduler: DAGScheduler,
        workflow_run: WorkflowRun,
        step_run: StepRun,
        artifacts_dir: Path,
        execution_output: str,
        execution_prompt: str,
        review_config: dict,
        review: ReviewEvaluation,
        completed: set[str],
        failed: set[str],
        previous_error: str | None,
        previous_ended_at,
    ) -> tuple[TaskStep, str | None]:
        """Apply the same review decision after execution or recovery."""
        outcome, gate, cancelled, message_persisted = review
        step_key = step.key
        retry_feedback = None
        if cancelled:
            ts = await self._persist_step_status(
                task.id, step_key, "cancelled", "手动停止", utc_now()
            )
            failed.add(step_key)
        elif outcome.status == "passed":
            ts = await self._persist_step_status(
                task.id, step_key, "passed", None, utc_now()
            )
            completed.add(step_key)
        elif outcome.status == "awaiting_review":
            ts = await self._persist_step_status(
                task.id, step_key, "awaiting_review", previous_error, None
            )
            failed.add(step_key)
        elif (outcome.status == "rejected"
              and step_run.attempt <= int(review_config.get("maxRetries", 1))):
            has_feedback_route = any(
                connection.get("kind", "solid") == "dashed"
                for connection in step.outgoing_connections
            )
            if step.rework_upstream and not has_feedback_route:
                await self._step_rework.from_review(
                    task, step, scheduler, completed,
                    outcome.retry_context, step_run.attempt,
                )
                ts = await self._persist_step_status(
                    task.id, step_key, "rework_waiting", outcome.feedback, None
                )
            else:
                retry_feedback = outcome.retry_context
                ts = await self._persist_step_status(
                    task.id, step_key, "retrying",
                    outcome.feedback, previous_ended_at,
                )
                await self._publish(task.id, step_key, {
                    "type": "step_retrying",
                    "data": {
                        "task_id": task.id,
                        "step_key": step_key,
                        "attempt": step_run.attempt + 1,
                        "max_retries": review_config.get("maxRetries", 1),
                    },
                })
        else:
            # 审核失败或驳回次数耗尽：转人工，不重跑执行步骤。
            outcome = await gate.evaluate(
                task=task, step=step, workflow_run=workflow_run,
                step_run=step_run, artifacts_dir=artifacts_dir,
                execution_output=execution_output,
                execution_prompt=execution_prompt,
                review_config=review_config, mode="manual",
                artifact_round=step_run.artifact_round,
            )
            message_persisted = False
            ts = await self._persist_step_status(
                task.id, step_key, "awaiting_review", outcome.feedback, None
            )
            failed.add(step_key)

        if not message_persisted:
            await self._review_messages.persist_result(
                task, step_key, step_run, artifacts_dir,
                step_run.artifact_round, outcome,
            )
        return ts, retry_feedback

    async def _resume_review_only(
        self,
        task: Task,
        step: Step,
        scheduler: DAGScheduler,
        artifacts_dir: Path,
        user_input: str,
        completed: set[str],
        running: set[str],
        failed: set[str],
        workflow_run: WorkflowRun,
        step_run: StepRun,
        execution_output: str,
        execution_prompt: str,
        saved_review_prompt: str | None,
        latest_review_status: str | None,
    ) -> None:
        """Continue a durable execution checkpoint at its review boundary."""
        step_key = step.key
        run_key = f"{task.id}:{step_key}"
        running.add(step_key)
        retry_feedback: str | None = None
        review_config, review_mode = resolve_review_config(task, step)
        try:
            if latest_review_status == "passed" or review_mode == "skip":
                ts = await self._persist_step_status(
                    task.id, step_key, "passed", None, utc_now()
                )
                completed.add(step_key)
            else:
                review = await self._review_messages.evaluate(
                    task=task, step=step, step_run=step_run,
                    workflow_run=workflow_run, artifacts_dir=artifacts_dir,
                    execution_output=execution_output,
                    execution_prompt=execution_prompt,
                    review_config=review_config, mode=review_mode,
                    run_key=run_key, saved_prompt=saved_review_prompt,
                    should_interrupt=lambda: self._graceful_shutdown,
                )
                ts, retry_feedback = await self._apply_review_result(
                    task, step, scheduler, workflow_run, step_run,
                    artifacts_dir, execution_output, execution_prompt,
                    review_config, review, completed, failed, None, None,
                )

            await self._publish(task.id, step_key, {
                "type": "status",
                "data": {
                    "status": ts.status,
                    "step_key": step_key,
                    "task_id": task.id,
                },
            })

            if ts.status == "passed":
                input_rounds = json.loads(step_run.input_rounds_json or "{}")
                manifest = await self._finalize_artifact_round(
                    artifacts_dir, task, step, workflow_run, step_run,
                    step_run.artifact_round, input_rounds, "passed",
                )
                if manifest is not None:
                    await self._artifact_routes.apply(
                        task=task, step=step, scheduler=scheduler,
                        workflow_run=workflow_run, artifacts_dir=artifacts_dir,
                        artifact_round=step_run.artifact_round,
                        manifest=manifest, completed=completed, failed=failed,
                    )
                else:
                    await self._artifact_routes.seed_completed_forward_routes(
                        task, scheduler, artifacts_dir, workflow_run, completed,
                    )
        finally:
            if self._live.is_review_channel(run_key):
                await self._live.finish_review(run_key)
            self._live.clear_engine(run_key)
            self._live.discard_cancelled(run_key)
            running.discard(step_key)

        if retry_feedback is not None:
            await self._run_step(
                task, step, scheduler, artifacts_dir, user_input,
                completed, running, failed, workflow_run, retry_feedback,
            )

    async def _run_step(
        self,
        task: Task,
        step: Step,
        scheduler: DAGScheduler,
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
        if workflow_run is not None:
            checkpoint = await self._review_messages.load_checkpoint(
                task, step, workflow_run,
            )
            if checkpoint is not None:
                await self._resume_review_only(
                    task, step, scheduler, artifacts_dir, user_input,
                    completed, running, failed, workflow_run, *checkpoint,
                )
                return
        run_key = f"{task.id}:{step_key}"
        engine = (
            await asyncio.to_thread(create_engine, step.engine)
            if step.kind != "task_dispatch" else None
        )
        configured_provider_id = str(
            (step.config or {}).get("provider_id") or ""
        ).strip()
        effective_provider_id = configured_provider_id
        if engine is not None:
            resolve_provider_id = getattr(engine, "resolve_provider_id", None)
            if callable(resolve_provider_id):
                effective_provider_id = await asyncio.to_thread(
                    resolve_provider_id,
                    configured_provider_id,
                )
            elif not effective_provider_id:
                effective_provider_id = await asyncio.to_thread(
                    config_store.get_engine_provider,
                    step.engine,
                )
        effective_config = dict(step.config or {})
        if effective_provider_id:
            effective_config["provider_id"] = effective_provider_id
        provider_snapshot = None
        if effective_provider_id:
            def load_usage_provider():
                provider = config_store.get_provider(effective_provider_id)
                return ({key: provider.get(key) for key in
                         ("id", "prices", "managed_revision")}
                        if provider else None)

            provider_snapshot = await asyncio.to_thread(load_usage_provider)
        default_model = await asyncio.to_thread(
            config_store.get_engine_default_model, step.engine
        )
        resolved_model = (
            step.model
            or default_model
            or None
        )
        input_rounds = self._artifact_routes.input_rounds_for(step_key)
        input_snapshot = await self._artifact_routes.input_snapshot(
            task, step, scheduler, artifacts_dir,
        )

        started_state = await self._run_db(lambda: start_step_state(
            task=task, step=step, workflow_run=workflow_run,
            artifacts_dir=artifacts_dir, effective_provider_id=effective_provider_id,
            resolved_model=resolved_model, input_rounds=input_rounds,
            input_snapshot=input_snapshot,
        ))
        ts = started_state.task_step
        step_run = started_state.step_run
        pending_handoff = started_state.pending_handoff
        artifact_round = started_state.artifact_round
        input_rounds = started_state.input_rounds

        running.add(step_key)

        await self._publish(task.id, step_key, {
            "type": "status",
            "data": {"status": "running", "step_key": step_key},
        })

        if step.kind == "task_dispatch":
            try:
                if self._dispatch_service is None:
                    raise RuntimeError("流程步骤服务未初始化")
                await self._dispatch_service.dispatch(
                    source_project_id=self._source_project_id,
                    task=task,
                    step=step,
                    workflow_run=workflow_run,
                    artifacts_dir=artifacts_dir,
                )
            except Exception as exc:
                error = str(exc) or "创建下游任务失败"
                await self._fail_step(ts, task, step_key, error)
                failed.add(step_key)
                running.discard(step_key)
                if step_run is not None:
                    await self._persist_step_run_status(
                        step_run.id, "failed", error, utc_now()
                    )
                await self._discard_artifact_round(
                    artifacts_dir,
                    task,
                    step,
                    step_run,
                    artifact_round,
                )
            else:
                await self._persist_step_status(
                    task.id, step_key, "passed", None, utc_now()
                )
                completed.add(step_key)
                running.discard(step_key)
                if step_run is not None:
                    await self._persist_step_run_status(
                        step_run.id, "succeeded", None, utc_now()
                    )
                await self._finalize_artifact_round(
                    artifacts_dir,
                    task,
                    step,
                    workflow_run,
                    step_run,
                    artifact_round,
                    input_rounds,
                    "passed",
                )
                await self._publish(task.id, step_key, {
                    "type": "status",
                    "data": {"status": "passed", "step_key": step_key},
                })
            return

        execution = await self._execution_messages.start(
            task=task, step=step, artifacts_dir=artifacts_dir,
            user_input=user_input, input_snapshot=input_snapshot,
            state=started_state, review_feedback=review_feedback,
            engine=engine, resolved_model=resolved_model,
        )
        prompt, msg_id, engine_session_id, journal_ref = execution

        # Select engine
        if not engine:
            error = f"Engine '{step.engine}' not available"
            await self._fail_step(ts, task, step_key, error)
            failed.add(step_key)
            await self._execution_messages.fail_unavailable(
                message_id=msg_id, journal_ref=journal_ref,
                step_run=step_run, error=error,
            )
            await self._discard_artifact_round(
                artifacts_dir,
                task,
                step,
                step_run,
                artifact_round,
            )
            running.discard(step_key)
            return

        live_queue = self._live.start_execution(run_key, engine)
        events_collected = []
        content_parts = []
        reported_error: str | None = None
        execution_succeeded = False
        # 执行消息自身的完成时间。必须在执行引擎结束后立刻记录：放进 finally
        # 会写成整个步骤（含自动审核）收尾的时间，导致审核消息排到执行上方。
        execution_ended_at = None
        retry_feedback: str | None = None
        captured_session_id = ts.session_id
        interrupted = False
        execution_message_finalized = False

        async def finish_execution_message() -> None:
            nonlocal execution_message_finalized
            if execution_message_finalized:
                return
            completion = await self._execution_messages.finish(
                message_id=msg_id, journal_ref=journal_ref,
                events_collected=events_collected,
                succeeded=execution_succeeded,
                cancelled=self._live.is_cancelled(run_key),
                ended_at=execution_ended_at,
            )
            from main import gateway_client
            await gateway_client.record_message_usage(
                project_id=getattr(self._database_executor, "project_id", None),
                task_id=task.id, message_id=msg_id,
                run_id=str(step_run.id) if step_run is not None else None,
                model=resolved_model, occurred_at=execution_ended_at or utc_now(),
                provider=provider_snapshot, provider_id=effective_provider_id or None,
                usage_json=completion.usage_json,
                user_id=task.creator_id, session_id=captured_session_id,
            )
            execution_message_finalized = True
            await self._execution_messages.publish_completion(
                task.id, step_key, msg_id, completion,
                len(events_collected) + 1,
            )

        async def consume_pending_handoff() -> None:
            nonlocal pending_handoff
            if not pending_handoff:
                return
            handoff_id = pending_handoff.get("handoff_id")

            def consume():
                current = TaskStep.get(
                    (TaskStep.task == task) & (TaskStep.step_key == step_key)
                )
                try:
                    stored = json.loads(current.pending_handoff_json or "null")
                except (TypeError, json.JSONDecodeError):
                    stored = None
                if not isinstance(stored, dict) or stored.get("handoff_id") != handoff_id:
                    return
                mark_handoff_consumed(artifacts_dir.parent, pending_handoff)
                current.pending_handoff_json = None
                current.save(only=[TaskStep.pending_handoff_json])

            await self._run_db(consume)
            pending_handoff = None

        try:
            spawn_kwargs = dict(
                prompt=prompt,
                cwd=task.cwd,
                model=resolved_model,
                session_id=engine_session_id,
                config_overrides=effective_config or None,
            )
            if live_queue is not None:
                spawn_kwargs["live_message_queue"] = live_queue
            spawn = getattr(engine, "spawn_with_retry", engine.spawn)
            if callable(getattr(engine, "spawn_with_retry", None)):
                spawn_kwargs.update(
                    system_prompt=await asyncio.to_thread(assemble_step_system_prompt, task, artifacts_dir),
                    capture_prompt_input=True,
                )
            prompt_snapshots = []
            spawn_iter = spawn(**spawn_kwargs)
            idle_timeout = await asyncio.to_thread(
                config_store.get_engine_idle_timeout_seconds
            )
            if idle_timeout and idle_timeout > 0:
                spawn_iter = _with_engine_idle_timeout(
                    engine, spawn_iter, idle_timeout
                )
            async for event in spawn_iter:
                normalize_event = getattr(
                    engine,
                    "normalize_event",
                    getattr(engine, "normalize_interaction_event", None),
                )
                if normalize_event is not None:
                    event = normalize_event(event)
                if event is None:
                    continue
                if event.type == "prompt_input":
                    prompt_snapshots.append(format_prompt_input(event.data))
                    prompt_view = "\n\n".join(prompt_snapshots)
                    await self._run_db(lambda: Message.update(
                        prompt_json=json.dumps({"prompt": prompt_view, "input_prompt": prompt}, ensure_ascii=False)
                    ).where(Message.id == msg_id).execute())
                    await self._publish(task.id, step_key, {
                        "channel": "execution", "message_id": msg_id,
                        "engine": step.engine, "model": resolved_model,
                        "type": "message_started", "data": {"prompt": prompt_view},
                    })
                    continue
                if pending_handoff and event.type != "error":
                    await consume_pending_handoff()
                live_message_id = None
                interaction_waiter: asyncio.Task | None = None
                if event.type == "interaction_request":
                    interaction_id = str(
                        event.data.get("interaction_id") or uuid.uuid4()
                    )
                    event.data["interaction_id"] = interaction_id
                events_collected.append(event.to_dict())
                await self._event_journal.arecord(journal_ref, event.to_dict())
                if event.type == "agent_message_chunk" and not is_commentary(event):
                    content = event.data.get("content") or {}
                    content_parts.append(content.get("text", ""))
                elif event.type == "session_started":
                    captured_session_id = (
                        str(event.data.get("session_id") or "") or None
                    )
                    if captured_session_id:
                        journal_ref = await self._event_journal.amove_to_conversation(
                            journal_ref,
                            captured_session_id,
                        )
                        await self._run_db(
                            lambda: Message.update(
                                event_log_path=journal_ref.relative_path
                            ).where(Message.id == msg_id).execute()
                        )
                elif event.type == "usage_update" and event.data.get("session_id"):
                    captured_session_id = str(event.data["session_id"])
                elif event.type == "error" and reported_error is None:
                    reported_error = str(
                        event.data.get("message") or "Engine reported an error"
                    )
                elif event.type == "live_message":
                    live_data = event.data or {}
                    live_message_id = live_data.get("message_id")
                    msg_id, journal_ref = await self._live.handle_execution_event(
                        task=task, step=step, step_run=step_run,
                        artifacts_dir=artifacts_dir, data=live_data,
                        message_id=msg_id, journal_ref=journal_ref,
                        session_id=captured_session_id,
                        resolved_model=resolved_model,
                        events_collected=events_collected,
                    )
                    if live_data.get("status") == "delivered":
                        content_parts.clear()
                        events_collected.clear()
                if event.type == "interaction_request":
                    interaction_waiter = await self._interaction_messages.begin(
                        task_id=task.id, step_key=step_key, event=event,
                        message_id=msg_id, journal_ref=journal_ref,
                    )
                await self._publish(task.id, step_key, {
                    "channel": "execution",
                    "message_id": live_message_id or msg_id,
                    "engine": step.engine,
                    "model": resolved_model,
                    "event_sequence": len(events_collected),
                    "type": event.type,
                    "data": {**event.data, "task_id": task.id, "step_key": step_key},
                })
                if interaction_waiter is not None:
                    await self._interaction_messages.finish(
                        waiter=interaction_waiter,
                        task_id=task.id, step_key=step_key, event=event,
                        engine=engine, engine_id=step.engine,
                        message_id=msg_id, journal_ref=journal_ref,
                        events_collected=events_collected,
                        resolved_model=resolved_model,
                    )

            if captured_session_id is None and not engine.supports_resume:
                # 无状态引擎没有原生会话，仍生成本次运行的会话标识供前端展示。
                captured_session_id = str(uuid.uuid4())

            if captured_session_id:
                # 同任务同步骤重跑时复用该会话（session/resume）。
                # 记录建立会话时使用的供应商，供重跑前判断 resume 兼容性。
                captured_session_provider = effective_provider_id

                def save_session_id():
                    current = TaskStep.get(
                        (TaskStep.task == task) & (TaskStep.step_key == step_key)
                    )
                    current.session_id = captured_session_id
                    current.session_provider = captured_session_provider
                    current.save()
                    return current

                ts = await self._run_db(save_session_id)

            execution_ended_at = utc_now()

            if self._live.is_cancelled(run_key):
                # 手动停止：步骤状态与普通失败区分，前端显示「手动停止」。
                ts = await self._persist_step_status(
                    task.id, step_key, "cancelled", "手动停止", utc_now()
                )
                await self._publish(task.id, step_key, {
                    "type": "status",
                    "data": {
                        "status": "cancelled",
                        "task_id": task.id,
                        "step_key": step_key,
                    },
                })
                failed.add(step_key)
            elif reported_error is not None:
                await self._fail_step(ts, task, step_key, reported_error)
                failed.add(step_key)
            else:
                execution_succeeded = True
                # Missing review means a legacy workflow and retains the old
                # execution-success-is-passed behavior.
                if step.review is None or workflow_run is None or step_run is None:
                    def mark_step_passed():
                        ts.status = "passed"
                        ts.ended_at = utc_now()
                        ts.save()
                        return ts

                    ts = await self._run_db(mark_step_passed)
                    completed.add(step_key)
                else:
                    step_run = await self._persist_step_run_status(
                        step_run.id, "succeeded", None, utc_now()
                    )
                    # Execution and review are separate checkpoints. Close the
                    # execution message before the reviewer starts running.
                    await finish_execution_message()
                    review_config, review_mode = resolve_review_config(task, step)
                    if review_mode == "skip":
                        # 跳过审核：步骤执行完成后直接通过，不创建审核记录。
                        ts = await self._persist_step_status(
                            task.id, step_key, "passed", None, utc_now()
                        )
                        completed.add(step_key)
                    else:
                        review_status = (
                            "reviewing" if review_mode == "auto"
                            else "awaiting_review"
                        )
                        ts = await self._persist_step_status(
                            task.id, step_key, review_status, ts.error, ts.ended_at
                        )
                        await self._publish(task.id, step_key, {
                            "type": "status",
                            "data": {
                                "status": ts.status,
                                "step_key": step_key,
                                "task_id": task.id,
                            },
                        })
                        review = await self._review_messages.evaluate(
                            task=task, step=step, step_run=step_run,
                            workflow_run=workflow_run, artifacts_dir=artifacts_dir,
                            execution_output="".join(content_parts),
                            execution_prompt=prompt,
                            review_config=review_config, mode=review_mode,
                            run_key=run_key,
                        )
                        # 重新加载最新 ts：gate 在审核期间写入了 review_session_id，
                        # 用旧实例整行 save 会把它覆盖回 None。
                        ts, retry_feedback = await self._apply_review_result(
                            task, step, scheduler, workflow_run, step_run,
                            artifacts_dir, "".join(content_parts), prompt,
                            review_config, review, completed, failed,
                            ts.error, ts.ended_at,
                        )

                await self._publish(task.id, step_key, {
                    "type": "status",
                    "data": {
                        "status": ts.status,
                        "step_key": step_key,
                        "task_id": task.id,
                    },
                })

        except asyncio.CancelledError:
            interrupted = True
            raise
        except Exception as e:
            if self._graceful_shutdown:
                # The engine surfaced an error because we stopped it for a
                # graceful shutdown; treat the attempt as interruptible.
                interrupted = True
                raise
            logger.exception("Step %s failed", step_key)
            await self._fail_step(ts, task, step_key, str(e))
            failed.add(step_key)
            error_event = InternalEvent(
                type="error", data={"message": str(e)}
            ).to_dict()
            events_collected.append(error_event)
            await self._event_journal.arecord(journal_ref, error_event)

        finally:
            interrupted_by_shutdown = interrupted and self._graceful_shutdown
            try:
                if not interrupted_by_shutdown:
                    await finish_execution_message()
                    await self._publish(task.id, step_key, {
                        "type": "status",
                        "data": {
                            "status": ts.status,
                            "task_id": task.id,
                            "step_key": step_key,
                        },
                    })
            except Exception:
                logger.exception("Failed to update message %s", msg_id)

            cancelled_by_user = await self._live.finish_execution(run_key)
            running.discard(step_key)
            if step_run is not None:
                if (
                    step_run.status == "running"
                    and not interrupted_by_shutdown
                ):
                    # StepRun keeps the historical failed terminal for stopped
                    # attempts; TaskStep and Message carry the user-visible
                    # cancelled state.
                    final_step_run_status = (
                        "succeeded"
                        if execution_succeeded and not cancelled_by_user
                        else "failed"
                    )
                    step_run = await self._persist_step_run_status(
                        step_run.id,
                        final_step_run_status,
                        None if final_step_run_status == "succeeded" else ts.error,
                        utc_now(),
                    )
            if step_run is not None and artifact_round is not None:
                if step_run.status == "succeeded":
                    manifest = await self._finalize_artifact_round(
                        artifacts_dir,
                        task,
                        step,
                        workflow_run,
                        step_run,
                        artifact_round,
                        input_rounds,
                        ts.status,
                    )
                    if ts.status == "passed" and manifest is not None:
                        await self._artifact_routes.apply(
                            task=task,
                            step=step,
                            scheduler=scheduler,
                            workflow_run=workflow_run,
                            artifacts_dir=artifacts_dir,
                            artifact_round=artifact_round,
                            manifest=manifest,
                            completed=completed,
                            failed=failed,
                        )
                elif cancelled_by_user or step_run.status == "failed":
                    await self._discard_artifact_round(
                        artifacts_dir,
                        task,
                        step,
                        step_run,
                        artifact_round,
                    )

        if retry_feedback is not None:
            await self._run_step(
                task,
                step,
                scheduler,
                artifacts_dir,
                user_input,
                completed,
                running,
                failed,
                workflow_run,
                retry_feedback,
            )

    async def _persist_step_status(
        self, task_id, step_key, status, error, ended_at
    ):
        def persist():
            with db_proxy.atomic("IMMEDIATE"):
                row = TaskStep.get(
                    (TaskStep.task == task_id) & (TaskStep.step_key == step_key)
                )
                row.status = status
                row.error = error
                row.ended_at = ended_at
                row.save()
                actor = self._step_cancel_audits.get(step_key)
                if (
                    status == "cancelled"
                    and step_key in self._step_cancel_audits
                    and self._source_project_id is not None
                ):
                    from services.project_audit import record_project_audit
                    from services.remote_access import replayed_actor_context

                    with replayed_actor_context(actor):
                        record_project_audit(
                            project_id=self._source_project_id,
                            task_id=task_id,
                            action="step.cancel",
                            result="succeeded",
                            mode=(
                                "managed"
                                if actor is not None and actor.source == "managed"
                                else "local"
                            ),
                            metadata={"step_key": step_key, "status": status},
                        )
                return row

        result = await self._run_db(persist)
        if status == "cancelled":
            self._step_cancel_audits.pop(step_key, None)
        return result

    async def _persist_step_run_status(self, step_run_id, status, error, ended_at):
        def persist():
            row = StepRun.get_by_id(step_run_id)
            row.status = status
            row.error = error
            row.ended_at = ended_at
            if status == "failed":
                row.artifact_round = None
            row.save()
            return row

        return await self._run_db(persist)

    async def _discard_artifact_round(
        self,
        artifacts_dir,
        task,
        step,
        step_run,
        artifact_round,
    ):
        if artifact_round is None:
            return
        if step_run is not None:
            def clear_round():
                row = StepRun.get_by_id(step_run.id)
                row.artifact_round = None
                row.input_rounds_json = None
                row.save(
                    only=[
                        StepRun.artifact_round,
                        StepRun.input_rounds_json,
                    ]
                )

            await self._run_db(clear_round)
        await asyncio.to_thread(
            discard_artifact_round,
            artifacts_dir,
            task.workflow_id,
            task.id,
            step.key,
            artifact_round,
        )

    async def _finalize_artifact_round(
        self,
        artifacts_dir,
        task,
        step,
        workflow_run,
        step_run,
        artifact_round,
        input_rounds,
        status,
    ):
        if step_run is None or artifact_round is None:
            return None
        return await self._run_db(
            lambda: write_round_manifest(
                artifacts_root=artifacts_dir,
                workflow_id=task.workflow_id,
                task_id=task.id,
                step_key=step.key,
                artifact_round=artifact_round,
                workflow_run_id=workflow_run.id if workflow_run else None,
                step_run_id=step_run.id,
                input_rounds=input_rounds,
                status=status,
                eligible_for_downstream=status == "passed",
                outputs=step.outputs,
            )
        )

    async def _fail_step(self, ts: TaskStep, task: Task, step_key: str, error: str):
        """Mark a step as failed."""
        def persist_failure():
            ts.status = "failed"
            ts.error = error
            ts.ended_at = utc_now()
            ts.save()

        await self._run_db(persist_failure)

        await self._publish(task.id, step_key, {
            "type": "error",
            "data": {"message": error, "task_id": task.id, "step_key": step_key},
        })
        await self._publish(task.id, step_key, {
            "type": "status",
            "data": {"status": "failed", "task_id": task.id, "step_key": step_key},
        })

    async def cancel_step(self, task_id: str, step_key: str) -> bool:
        from services.remote_access import get_effective_actor

        if self._live.is_cancelled(f"{task_id}:{step_key}"):
            return True
        self._step_cancel_audits[step_key] = get_effective_actor()
        cancelled = await self._live.cancel_step(task_id, step_key)
        if not cancelled:
            self._step_cancel_audits.pop(step_key, None)
        return cancelled

    async def send_live_message(
        self,
        task_id: str,
        step_key: str,
        content: str,
        as_guidance: bool = False,
    ) -> dict:
        return await self._live.send_live_message(
            task_id, step_key, content, as_guidance
        )

    async def cancel_task(self, task_id: str, action: str = "task.cancel") -> bool:
        from services.remote_access import get_effective_actor

        intent = (action, get_effective_actor())
        self._cancel_audit = intent
        cancelled = await self._live.cancel_task(task_id)
        if not cancelled and self._cancel_audit is intent:
            self._cancel_audit = None
        return cancelled

    async def stop_for_shutdown(self) -> None:
        """Stop engines while leaving running steps recoverable."""
        self._graceful_shutdown = True
        await self._live.stop_for_shutdown()

    async def _publish(self, task_id: str, step_key: str, event: dict):
        """发布出口：内部事件 → AG-UI 标准事件后推送。"""
        from services.remote_project import current_actor_event_fields

        payload = {
            "task_id": task_id,
            "step_key": step_key,
            **event,
            **current_actor_event_fields(),
        }
        project_id = getattr(self._database_executor, "project_id", None)
        if project_id is not None:
            payload["project_id"] = project_id
        ctx = AGUIContext.from_event(payload)
        for agui_event in to_agui_events(payload, ctx):
            await self._event_bus.publish(agui_event)
