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
    StepSupplement,
    StepRun,
    Task,
    TaskStep,
    WorkflowRun,
)
from models.fields import utc_now
from services.artifact_rounds import (
    ArtifactRound,
    discard_artifact_round,
    next_artifact_round,
    select_upstream_round,
    step_round_dir,
    write_round_manifest,
)
from services.artifact_routing import (
    empty_routing_state,
    normalize_routing_state,
    resolve_input_snapshot,
    route_artifact_round,
    source_for_connection,
)
from services.pipeline import DAGScheduler, Step
from services.prompt import (
    assemble_followup_prompt,
    assemble_prompt,
    assemble_retry_prompt,
    render_step_prompt,
)
from services.review_gate import ReviewGate
from services.config import config_store
from services.messages import create_task_message, new_message_id
from agent_assistants.context_handoff import (
    mark_handoff_consumed,
    render_handoff_reference,
)
from services.intervention import intervention_manager, seal_unanswered_interactions
from agent_assistants.event_journal import JournalRef, TurnEventJournal
from engines.core.acp_base import AcpEngineBase
from engines.core.registry import create_engine
from engines.core.agui import AGUIContext, to_agui_events
from engines.core.events import InternalEvent, is_commentary
from streaming.bus import EventBus

logger = logging.getLogger(__name__)
ResultT = TypeVar("ResultT")
ENGINE_STOP_TIMEOUT_SECONDS = 10.0


async def _stop_engine_safely(engine: object, run_key: str) -> None:
    """Bound engine shutdown so a broken adapter cannot trap the workflow."""
    try:
        await asyncio.wait_for(
            engine.stop(),
            timeout=ENGINE_STOP_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.error("Engine stop timed out for %s", run_key)
    except Exception:
        logger.exception("Engine stop raised for %s", run_key)


def extract_usage_json(events_collected: list[dict]) -> str | None:
    """Extract the last usage event's data as JSON for message.usage_json.

    Returns None when no usage event was collected.
    """
    for event in reversed(events_collected):
        if event.get("type") in {"usage", "usage_update"}:
            return json.dumps(event.get("data", {}))
    return None


def _effective_review_mode(config: dict) -> str:
    """Resolve skip/auto/manual, honouring explicit mode or legacy auto flag."""
    if config.get("mode") in ("skip", "auto", "manual"):
        return str(config["mode"])
    return "auto" if config.get("auto", False) else "manual"


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
    ):
        self._event_bus = event_bus
        self._dispatch_service = dispatch_service
        self._source_project_id = source_project_id
        self._database_executor = database_executor
        self._step_followups = step_followups or {}
        self._step_trigger_names = step_trigger_names or {}
        self._input_rounds_by_step = input_rounds_by_step or {}
        # 本次运行只执行这些步骤；范围外的步骤只满足 DAG 依赖，不改其持久状态。
        self._execution_scope = execution_scope
        self._entry_step_key = entry_step_key
        self._initial_user_input_step_key = initial_user_input_step_key
        self._running_engines: dict[str, object] = {}  # step_run_key → engine
        self._live_message_queues: dict[str, asyncio.Queue] = {}
        self._live_message_prompts: dict[str, str] = {}
        self._cancelled_steps: set[str] = set()
        self._graceful_shutdown = False
        self._event_journal = TurnEventJournal()
        self._routing_state = empty_routing_state()
        self._routing_lock = asyncio.Lock()

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

    async def _start_automatic_review_message(
        self,
        task: Task,
        step: Step,
        step_run: StepRun,
        artifacts_dir: Path,
        review_config: dict,
        review_prompt: str,
    ) -> tuple[str, JournalRef]:
        """Persist and publish the review bubble before the reviewer starts."""
        message_id = new_message_id()
        now = utc_now()
        journal_ref = await self._event_journal.astart(
            artifacts_dir.parent,
            f"task-{task.id}",
            message_id,
        )
        engine = str(review_config.get("engine") or step.engine)
        default_model = await asyncio.to_thread(
            config_store.get_engine_default_model, engine
        )
        model = str(
            review_config.get("model")
            or step.model
            or default_model
            or ""
        )
        await self._run_db(
            lambda: create_task_message(
                id=message_id,
                task=task,
                channel="review",
                step_key=step.key,
                role="assistant",
                content="审核中",
                engine=engine,
                model=model,
                run_id=message_id,
                step_run_id=step_run.id,
                artifact_round=step_run.artifact_round,
                run_status="running",
                prompt_json=json.dumps({"prompt": review_prompt}, ensure_ascii=False),
                event_log_path=journal_ref.relative_path,
                position=0,
                started_at=now,
                created_at=now,
            )
        )
        await self._publish(task.id, step.key, {
            "channel": "review",
            "message_id": message_id,
            "engine": engine,
            "model": model,
            "event_sequence": 0,
            "type": "message_started",
            "data": {
                "role": "assistant",
                "status": "running",
                "content": "审核中",
                "prompt": review_prompt,
                "artifact_round": step_run.artifact_round,
            },
            "created_at": now.isoformat(),
        })
        return message_id, journal_ref

    async def _finish_automatic_review_message(
        self,
        task: Task,
        step_key: str,
        message_id: str,
        journal_ref: JournalRef,
        outcome,
        *,
        cancelled: bool = False,
    ) -> None:
        """Finalize the same review bubble with its report and event trace."""
        await self._event_journal.afinish(journal_ref)
        snapshot = await self._ajournal_snapshot(journal_ref)
        summary = outcome.report.get("summary", "")
        issues = outcome.report.get("issues", [])
        items = "".join(
            f"- {issue.get('description', '')}"
            + (
                f" → {issue.get('suggestion', '')}"
                if issue.get("suggestion") else ""
            )
            + "\n"
            for issue in (issues or [])
        )
        if cancelled:
            content = "自动审核已手动停止"
        else:
            verdict = "通过" if outcome.status == "passed" else "未通过"
            content = f"**审核结果：{verdict}**\n{summary}\n{items}"

        def finalize_review_message():
            message = Message.get_by_id(message_id)
            message.content = content
            message.engine = outcome.review_run.engine
            message.model = outcome.review_run.model
            message.run_status = "cancelled" if cancelled else "completed"
            message.prompt_json = outcome.review_run.prompt_json
            message.events_json = json.dumps(
                [{
                    "type": "review_context",
                    "data": {"review_run_id": outcome.review_run.id},
                }, *snapshot["events"]],
                ensure_ascii=False,
            )
            message.event_summary_json = snapshot["event_summary_json"]
            message.event_count = snapshot["event_count"]
            message.last_event_seq = snapshot["last_event_seq"]
            message.usage_json = extract_usage_json(list(outcome.events))
            message.started_at = outcome.review_run.started_at
            message.ended_at = outcome.review_run.ended_at
            message.save()

        await self._run_db(finalize_review_message)
        common = {
            "channel": "review",
            "message_id": message_id,
            "engine": outcome.review_run.engine,
            "model": outcome.review_run.model,
            "created_at": outcome.review_run.started_at.isoformat(),
        }
        await self._publish(task.id, step_key, {
            **common,
            "type": "message_snapshot",
            "data": {"content": content},
        })
        await self._publish(task.id, step_key, {
            **common,
            "type": "message_completed",
            "data": {
                "status": "cancelled" if cancelled else "completed",
                "content": content,
                "ended_at": (
                    outcome.review_run.ended_at.isoformat()
                    if outcome.review_run.ended_at else None
                ),
            },
        })

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

        def initialize_pipeline_state() -> tuple[set[str], dict]:
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
            routing_state = empty_routing_state()
            if workflow_run is not None and workflow_run.routing_state_json:
                try:
                    routing_state = normalize_routing_state(
                        json.loads(workflow_run.routing_state_json)
                    )
                except (TypeError, json.JSONDecodeError):
                    routing_state = empty_routing_state()
            return persisted_completed, routing_state

        completed, self._routing_state = await self._run_db(initialize_pipeline_state)
        # 重启某步骤时只重跑该步骤及其下游（scope）。范围外的步骤即便未通过
        # 也不再执行，但仍要让依赖它们的下游步骤被视为依赖已满足——否则失败的
        # 上游会被 DAG 判为 ready 而抢先执行（@ 下游却跑了上游）。
        scope = execution_scope if execution_scope is not None else self._execution_scope
        self._execution_scope = scope
        if scope is not None:
            completed |= {key for key in scheduler.steps if key not in scope}
        running = set()
        failed = set()
        await self._seed_completed_forward_routes(
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
                Task.update(
                    status=final_status,
                    updated_at=finished_at,
                ).where(Task.id == task.id).execute()

            task.updated_at = finished_at
            await self._run_db(persist_pipeline_status)

    def _task_context_edges(self, scheduler: DAGScheduler) -> set[str]:
        """Return entry inputs intentionally replaced by task context."""
        entry_key = self._entry_step_key
        scope = self._execution_scope
        if not entry_key or scope is None or entry_key not in scheduler.steps:
            return set()
        explicit_sources = set(self._input_rounds_by_step.get(entry_key, {}))
        return {
            str(connection.get("id"))
            for connection in scheduler.steps[entry_key].incoming_connections
            if connection.get("kind", "solid") == "solid"
            and str(connection.get("from")) not in scope
            and str(connection.get("from")) not in explicit_sources
        }

    async def _seed_completed_forward_routes(
        self,
        task: Task,
        scheduler: DAGScheduler,
        artifacts_dir: Path,
        workflow_run: WorkflowRun | None,
        completed: set[str],
    ) -> None:
        """Restore forward-edge readiness for reused or recovered steps."""
        active_edges = {
            str(value) for value in self._routing_state.get("active_edges", [])
        }
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
                    if 0 <= output_port < len(step.outputs)
                    else None
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
                            target_step,
                            {},
                        )[step_key] = selected.round
                edge_id = str(connection.get("id"))
                if edge_id not in active_edges:
                    active_edges.add(edge_id)
                    changed = True
        if not changed:
            return
        self._routing_state["active_edges"] = sorted(active_edges)
        if workflow_run is None:
            return

        def persist():
            row = WorkflowRun.get_by_id(workflow_run.id)
            row.routing_state_json = json.dumps(
                self._routing_state, ensure_ascii=False, sort_keys=True
            )
            row.save(only=[WorkflowRun.routing_state_json])

        await self._run_db(persist)

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
            active_edges=set(self._routing_state.get("active_edges", [])),
            task_context_edges=self._task_context_edges(scheduler),
        )
        if not ready:
            skipped = scheduler.get_skippable_steps(
                completed,
                running | failed,
                active_edges=set(self._routing_state.get("active_edges", [])),
                task_context_edges=self._task_context_edges(scheduler),
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
                active_edges=set(self._routing_state.get("active_edges", [])),
                task_context_edges=self._task_context_edges(scheduler),
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
        run_key = f"{task.id}:{step_key}"
        engine = create_engine(step.engine) if step.kind != "task_dispatch" else None
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
        default_model = await asyncio.to_thread(
            config_store.get_engine_default_model, step.engine
        )
        resolved_model = (
            step.model
            or default_model
            or None
        )
        input_rounds = self._input_rounds_by_step.get(step_key, {})
        input_snapshot = await asyncio.to_thread(
            resolve_input_snapshot,
            step=step,
            artifacts_root=artifacts_dir,
            workflow_id=task.workflow_id,
            task_id=task.id,
            routing_state=self._routing_state,
            input_rounds=input_rounds,
            task_context_edges=(
                self._task_context_edges(scheduler)
                if step_key == self._entry_step_key else set()
            ),
        )

        def prepare_step_state():
            ts = TaskStep.get(
                (TaskStep.task == task) & (TaskStep.step_key == step_key)
            )
            previous_engine = ts.engine
            last_completed_execution = (
                Message.select()
                .where(
                    (Message.task == task)
                    & (Message.step_key == step_key)
                    & (Message.channel == "execution")
                    & (Message.role == "assistant")
                    & (Message.run_status.in_(["succeeded", "completed"]))
                )
                .order_by(Message.sequence.desc())
                .first()
            )
            session_engine = (
                last_completed_execution.engine
                if last_completed_execution is not None
                and last_completed_execution.engine
                else previous_engine
            )
            # Engine session identifiers are provider-specific: an engine or
            # provider switch must not resume the old session. The assembled
            # step prompt still carries supplements, upstream artifacts and
            # task context (plus the handoff reference when one is pending),
            # but the new endpoint must create its own session instead of
            # receiving an incompatible ID.
            session_provider = effective_provider_id
            if ts.session_id and (
                ts.pending_handoff_json
                or (session_engine and session_engine != step.engine)
                # 同引擎但供应商变更（含重置为默认后 provider 覆盖被移除）：
                # 旧会话建立于另一个供应商端点，不能继续 resume。
                or (
                    session_engine == step.engine
                    and str(ts.session_provider or "").strip() != session_provider
                )
            ):
                ts.session_id = None
            is_review_retry = (
                ts.status in ("retrying", "rework_waiting")
                and ts.started_at is not None
            )
            rework_feedback = ts.rework_feedback
            if rework_feedback:
                ts.rework_feedback = None
            manual_review_feedback = ts.review_feedback
            if manual_review_feedback:
                ts.review_feedback = None
            ts.status = "running"
            if not is_review_retry:
                ts.started_at = utc_now()
            ts.ended_at = None
            ts.engine = step.engine
            ts.save()

            step_run = None
            artifact_round = None
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
                latest_round_row = (
                    StepRun.select(StepRun.artifact_round)
                    .join(WorkflowRun)
                    .where(
                        (WorkflowRun.task == task)
                        & (StepRun.step_key == step_key)
                        & (StepRun.artifact_round.is_null(False))
                        & (StepRun.status.in_(["succeeded", "reused"]))
                    )
                    .order_by(StepRun.artifact_round.desc())
                    .first()
                )
                artifact_round = next_artifact_round(
                    artifacts_dir,
                    task.workflow_id,
                    task.id,
                    step_key,
                    database_round=(
                        latest_round_row.artifact_round
                        if latest_round_row is not None else 0
                    ),
                )
                step_run = StepRun.create(
                    id=str(uuid.uuid4()),
                    run=workflow_run,
                    step_key=step_key,
                    attempt=attempt,
                    artifact_round=artifact_round,
                    input_rounds_json=(
                        json.dumps(input_rounds, ensure_ascii=False)
                        if input_rounds else None
                    ),
                    input_snapshot_json=json.dumps(
                        input_snapshot, ensure_ascii=False
                    ),
                    io_contract_json=json.dumps(
                        {
                            "inputs": step.inputs,
                            "outputs": step.outputs,
                        },
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                    status="running",
                    engine=step.engine,
                    model=resolved_model,
                    started_at=utc_now(),
                )

            # 步骤确实开始执行，任务与运行必须回到 running。中断的重复派发（例如
            # 另一个 daemon 实例的启动恢复）可能已把行写成 paused/failed，而真正
            # 在跑的这条流水线不会自己回写状态，前端就会在整轮重跑/重审期间一直
            # 显示「暂停」。条件 UPDATE 只修过期行，也不覆盖其它并发字段。
            Task.update(
                status="running",
                updated_at=utc_now(),
            ).where(
                (Task.id == task.id) & (Task.status != "running")
            ).execute()
            task.status = "running"
            if workflow_run is not None:
                WorkflowRun.update(
                    status="running",
                    ended_at=None,
                ).where(
                    (WorkflowRun.id == workflow_run.id)
                    & (
                        (WorkflowRun.status != "running")
                        | WorkflowRun.ended_at.is_null(False)
                    )
                ).execute()
                workflow_run.status = "running"
                workflow_run.ended_at = None

            pending_handoff = None
            if ts.pending_handoff_json:
                try:
                    value = json.loads(ts.pending_handoff_json)
                    pending_handoff = value if isinstance(value, dict) else None
                except (TypeError, json.JSONDecodeError):
                    pending_handoff = None
            return (
                ts,
                step_run,
                rework_feedback,
                manual_review_feedback,
                pending_handoff,
                artifact_round,
                input_rounds,
            )

        (
            ts,
            step_run,
            rework_feedback,
            manual_review_feedback,
            pending_handoff,
            artifact_round,
            input_rounds,
        ) = (
            await self._run_db(prepare_step_state)
        )

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

        # Assemble prompt
        review_results = list(dict.fromkeys(
            value
            for value in (
                review_feedback,
                manual_review_feedback,
                rework_feedback,
            )
            if value
        ))
        followup = self._step_followups.get(step_key, "").strip()
        trigger_name = self._step_trigger_names.get(step_key, "").strip()
        if followup and ts.session_id and engine is not None and engine.supports_resume:
            prompt = await asyncio.to_thread(
                assemble_followup_prompt,
                task,
                step,
                artifacts_dir,
                followup,
                artifact_round,
                trigger_name,
            )
        elif (
            ts.session_id
            and engine is not None
            and engine.supports_resume
            and (
                review_results
                or input_snapshot.get("execution_type") == "feedback"
            )
        ):
            prompt = await asyncio.to_thread(
                assemble_retry_prompt,
                task,
                step,
                artifacts_dir,
                input_snapshot,
                artifact_round,
            )
        else:
            step_user_input = (
                followup
                or (
                    user_input
                    if self._initial_user_input_step_key in (None, step_key)
                    else ""
                )
            )
            prompt = await self._run_db(
                lambda: assemble_prompt(
                    task,
                    step,
                    artifacts_dir,
                    step_user_input,
                    artifact_round,
                    input_rounds,
                    input_snapshot,
                    trigger_name,
                )
            )
        if pending_handoff:
            handoff_reference = await asyncio.to_thread(
                render_handoff_reference, pending_handoff, artifacts_dir.parent
            )
            if handoff_reference:
                prompt = f"{handoff_reference}\n\n{prompt}"
        if review_results:
            prompt += (
                "\n\n## Previous review feedback\n"
                + "\n\n".join(
                    render_step_prompt(value, task, step, trigger_name)
                    for value in review_results
                )
            )
            prompt += (
                "\n\n请根据以上反馈修复问题，保留已有正确结果。\n"
                "**注意：修复时必须严格遵守「输出规范」中声明的产物类型、名称和写入路径，"
                "不要改变输出格式、文件扩展名或目录结构。**"
            )

        # Ensure artifact output directory (workflow / task / step / round)
        out_dir = (
            step_round_dir(
                artifacts_dir,
                task.workflow_id,
                task.id,
                step_key,
                artifact_round,
            )
            if artifact_round is not None
            else artifacts_dir / (task.workflow_id or "default") / task.id / step_key
        )
        msg_id = new_message_id()
        message_started_at = utc_now()
        engine_session_id = (
            ts.session_id
            if engine is not None and engine.supports_resume
            else None
        )
        if (
            engine is not None
            and engine.supports_resume
            and engine_session_id is None
            and step.engine == "pydantic_ai"
        ):
            engine_session_id = msg_id
        journal_ref = await self._event_journal.astart(
            artifacts_dir.parent,
            f"task-{task.id}",
            msg_id,
            engine_session_id,
        )

        def create_message():
            out_dir.mkdir(parents=True, exist_ok=True)
            create_task_message(
                id=msg_id,
                task=task,
                channel="execution",
                step_key=step_key,
                role="assistant",
                engine=step.engine,
                model=resolved_model,
                run_id=msg_id,
                step_run_id=step_run.id if step_run is not None else None,
                artifact_round=artifact_round,
                run_status="running",
                event_log_path=journal_ref.relative_path,
                prompt_json=json.dumps({"prompt": prompt}, ensure_ascii=False),
                position=1,
                started_at=message_started_at,
                created_at=message_started_at,
            )

        await self._run_db(create_message)
        await self._publish(task.id, step_key, {
            "channel": "execution",
            "message_id": msg_id,
            "engine": step.engine,
            "model": resolved_model,
            "event_sequence": 0,
            "type": "message_started",
            "data": {"prompt": prompt, "artifact_round": artifact_round},
            "created_at": message_started_at.isoformat(),
        })

        # Select engine
        if not engine:
            error = f"Engine '{step.engine}' not available"
            await self._fail_step(ts, task, step_key, error)
            failed.add(step_key)
            error_event = InternalEvent(
                type="error", data={"message": error}
            ).to_dict()
            await self._event_journal.afinish(journal_ref, error_event)
            snapshot = await self._ajournal_snapshot(journal_ref)
            def persist_unavailable_engine():
                message = Message.get_by_id(msg_id)
                message.events_json = snapshot["events_json"]
                message.event_summary_json = snapshot["event_summary_json"]
                message.event_count = snapshot["event_count"]
                message.last_event_seq = snapshot["last_event_seq"]
                message.run_status = "failed"
                message.ended_at = utc_now()
                message.save()
                if step_run is not None:
                    step_run.status = "failed"
                    step_run.error = error
                    step_run.ended_at = utc_now()
                    step_run.save()

            await self._run_db(persist_unavailable_engine)
            await self._discard_artifact_round(
                artifacts_dir,
                task,
                step,
                step_run,
                artifact_round,
            )
            running.discard(step_key)
            return

        self._cancelled_steps.discard(run_key)
        self._running_engines[run_key] = engine
        live_queue: asyncio.Queue | None = None
        engine_capabilities = getattr(engine, "capabilities", None)
        if engine_capabilities is not None and engine_capabilities.supports_live_step_message:
            live_queue = asyncio.Queue()
            self._live_message_queues[run_key] = live_queue
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
                if pending_handoff and event.type != "error":
                    await consume_pending_handoff()
                live_message_id = None
                interaction_waiter: asyncio.Task | None = None
                if event.type == "interaction_request":
                    interaction_id = str(
                        event.data.get("interaction_id") or uuid.uuid4()
                    )
                    event.data["interaction_id"] = interaction_id
                    interaction_waiter = asyncio.create_task(
                        intervention_manager.request_response(
                            interaction_id,
                            task.id,
                            step_key,
                            event.data,
                        )
                    )
                    # Register before publishing so a fast UI response cannot
                    # race the in-memory intervention broker.
                    await asyncio.sleep(0)
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
                    live_message_content = ""
                    if live_message_id:
                        def finish_live_message():
                            live_message = Message.get_by_id(live_message_id)
                            live_message.run_status = (
                                "succeeded"
                                if live_data.get("status") == "delivered"
                                else "failed"
                            )
                            live_message.ended_at = utc_now()
                            live_message.save()
                            return self._live_message_prompts.pop(
                                live_message_id,
                                live_message.content,
                            )
                        try:
                            live_message_content = await self._run_db(
                                finish_live_message
                            )
                        except Message.DoesNotExist:
                            pass
                    if live_data.get("status") == "delivered":
                        # 引擎确认收到插入消息：封口当前执行段并开启新的响应段，
                        # 历史消息呈现「步骤输出 → 用户插入 → 步骤响应」的分段结构。
                        seal_time = utc_now()
                        prompt_after_insert = (
                            live_message_content
                            or str(live_data.get("content") or "")
                        ).strip()
                        def seal_current_message():
                            sealed = Message.get_by_id(msg_id)
                            self._event_journal.finish(journal_ref)
                            snapshot = self._journal_snapshot(journal_ref)
                            sealed.content = snapshot["content"]
                            sealed.events_json = snapshot["events_json"]
                            sealed.event_summary_json = snapshot["event_summary_json"]
                            sealed.event_count = snapshot["event_count"]
                            sealed.last_event_seq = snapshot["last_event_seq"]
                            sealed.usage_json = extract_usage_json(events_collected)
                            sealed.run_status = "succeeded"
                            sealed.ended_at = seal_time
                            sealed.save()
                            return sealed.engine, sealed.model

                        try:
                            sealed_engine, sealed_model = await self._run_db(
                                seal_current_message
                            )
                            await self._publish(task.id, step_key, {
                                "channel": "execution",
                                "message_id": msg_id,
                                "engine": sealed_engine,
                                "model": sealed_model,
                                "event_sequence": len(events_collected) + 1,
                                "type": "message_completed",
                                "data": {"status": "succeeded"},
                            })
                        except Message.DoesNotExist:
                            pass
                        new_msg_id = new_message_id()
                        journal_ref = await self._event_journal.astart(
                            artifacts_dir.parent,
                            f"task-{task.id}",
                            new_msg_id,
                            captured_session_id,
                        )
                        await self._run_db(lambda: create_task_message(
                                id=new_msg_id,
                                task=task,
                                channel="execution",
                                step_key=step_key,
                                role="assistant",
                                engine=step.engine,
                                model=resolved_model,
                                run_id=new_msg_id,
                                step_run_id=step_run.id if step_run is not None else None,
                                artifact_round=artifact_round,
                                run_status="running",
                                event_log_path=journal_ref.relative_path,
                                prompt_json=(
                                    json.dumps(
                                        {"prompt": prompt_after_insert},
                                        ensure_ascii=False,
                                    )
                                    if prompt_after_insert
                                    else None
                                ),
                                position=1,
                                started_at=seal_time,
                                created_at=seal_time,
                            ))
                        msg_id = new_msg_id
                        content_parts.clear()
                        events_collected.clear()
                        await self._publish(task.id, step_key, {
                            "channel": "execution",
                            "message_id": new_msg_id,
                            "engine": step.engine,
                            "model": resolved_model,
                            "event_sequence": 0,
                            "type": "message_started",
                            "data": {
                                "content": "",
                                **(
                                    {"prompt": prompt_after_insert}
                                    if prompt_after_insert
                                    else {}
                                ),
                            },
                            "created_at": seal_time.isoformat(),
                        })
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
                    # Persist before blocking so navigation/reload can rebuild
                    # the active interaction card from normal message history.
                    def persist_pending_interaction():
                        pending_message = Message.get_by_id(msg_id)
                        self._event_journal.sync(journal_ref, durable=True)
                        snapshot = self._journal_snapshot(journal_ref)
                        pending_message.content = snapshot["content"]
                        pending_message.events_json = snapshot["events_json"]
                        pending_message.event_summary_json = snapshot["event_summary_json"]
                        pending_message.event_count = snapshot["event_count"]
                        pending_message.last_event_seq = snapshot["last_event_seq"]
                        pending_message.save()

                    try:
                        await self._run_db(persist_pending_interaction)
                    except Message.DoesNotExist:
                        pass
                    response = await interaction_waiter
                    if response.get("error"):
                        response = (
                            {"outcome": {"outcome": "cancelled"}}
                            if event.data.get("method") == "session/request_permission"
                            else {"action": "cancel"}
                        )
                    await engine.respond_interaction(event.data, response)
                    response_event = InternalEvent(
                        type="interaction_response",
                        data={
                            "interaction_id": event.data["interaction_id"],
                            "method": event.data.get("method"),
                            "response": response,
                        },
                    )
                    events_collected.append(response_event.to_dict())
                    await self._event_journal.arecord(journal_ref, response_event.to_dict())
                    # Make the response visible to history before notifying
                    # the UI. Otherwise the live card disappears immediately,
                    # but a reload while the engine is still running rebuilds
                    # the stale request-only projection from SQLite.
                    def persist_interaction_response():
                        response_message = Message.get_by_id(msg_id)
                        self._event_journal.sync(journal_ref, durable=True)
                        snapshot = self._journal_snapshot(journal_ref)
                        response_message.content = snapshot["content"]
                        response_message.events_json = snapshot["events_json"]
                        response_message.event_summary_json = snapshot["event_summary_json"]
                        response_message.event_count = snapshot["event_count"]
                        response_message.last_event_seq = snapshot["last_event_seq"]
                        response_message.save()

                    try:
                        await self._run_db(persist_interaction_response)
                    except Message.DoesNotExist:
                        pass
                    await self._publish(task.id, step_key, {
                        "channel": "execution",
                        "message_id": msg_id,
                        "engine": step.engine,
                        "model": resolved_model,
                        "event_sequence": len(events_collected),
                        "type": response_event.type,
                        "data": {
                            **response_event.data,
                            "task_id": task.id,
                            "step_key": step_key,
                        },
                    })

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

            if run_key in self._cancelled_steps:
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
                    # Merge task-level review overrides with step config
                    review_config = dict(step.review or {})
                    if task.review_overrides_json:
                        try:
                            overrides = json.loads(task.review_overrides_json)
                            step_ov = overrides.get(step_key, {}) if isinstance(overrides, dict) else {}
                            if isinstance(step_ov, dict):
                                review_config.update(step_ov)
                        except (json.JSONDecodeError, TypeError):
                            pass
                    review_mode = _effective_review_mode(review_config)
                    if review_mode == "skip":
                        # 跳过审核：步骤执行完成后直接通过，不创建审核记录。
                        ts = await self._persist_step_status(
                            task.id, step_key, "passed", None, utc_now()
                        )
                        completed.add(step_key)
                        outcome = None
                    else:
                        review_status = (
                            "reviewing" if review_mode == "auto"
                            else "awaiting_review"
                        )
                        review_message_persisted = False
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
                        review_message_id = None
                        review_journal_ref = None
                        assembled_review_prompt = None
                        if review_mode == "auto":
                            assembled_review_prompt = await asyncio.to_thread(
                                ReviewGate._assemble_prompt,
                                task,
                                step,
                                artifacts_dir,
                                "".join(content_parts),
                                str(review_config.get("prompt", "")),
                                prompt,
                                artifact_round,
                            )
                            review_message_id, review_journal_ref = (
                                await self._start_automatic_review_message(
                                    task,
                                    step,
                                    step_run,
                                    artifacts_dir,
                                    review_config,
                                    assembled_review_prompt,
                                )
                            )
                        async def _record_review_event(event: dict) -> None:
                            await self._event_journal.arecord(
                                review_journal_ref,
                                event,
                            )
                            # 历史接口使用独立的 journal 实例读取磁盘，
                            # 因此运行中的审核事件必须及时 flush 才能恢复。
                            await self._event_journal.async_flush(
                                review_journal_ref,
                            )

                        gate = ReviewGate(
                            lambda event: self._publish(task.id, step_key, event),
                            self._run_db,
                            (
                                _record_review_event
                            ) if review_journal_ref is not None else None,
                            set_active_engine=lambda active_engine: (
                                self._running_engines.__setitem__(
                                    run_key, active_engine
                                )
                            ),
                        )
                        outcome = await gate.evaluate(
                            task=task,
                            step=step,
                            workflow_run=workflow_run,
                            step_run=step_run,
                            artifacts_dir=artifacts_dir,
                            execution_output="".join(content_parts),
                            execution_prompt=prompt,
                            review_config=review_config,
                            mode=review_mode,
                            message_id=review_message_id,
                            artifact_round=artifact_round,
                            assembled_prompt=assembled_review_prompt,
                        )
                        cancelled_during_review = run_key in self._cancelled_steps
                        if cancelled_during_review:
                            def fail_cancelled_review():
                                review = ReviewRun.get_by_id(outcome.review_run.id)
                                review.status = "failed"
                                review.error = "手动停止"
                                review.ended_at = review.ended_at or utc_now()
                                review.save()

                            await self._run_db(fail_cancelled_review)
                        if review_message_id is not None and review_journal_ref is not None:
                            await self._finish_automatic_review_message(
                                task,
                                step_key,
                                review_message_id,
                                review_journal_ref,
                                outcome,
                                cancelled=cancelled_during_review,
                            )
                            review_message_persisted = True
                        # 重新加载最新 ts：gate 在审核期间写入了 review_session_id，
                        # 用旧实例整行 save 会把它覆盖回 None。
                        if cancelled_during_review:
                            ts = await self._persist_step_status(
                                task.id,
                                step_key,
                                "cancelled",
                                "手动停止",
                                utc_now(),
                            )
                            failed.add(step_key)
                        elif outcome.status == "passed":
                            ts = await self._persist_step_status(
                                task.id, step_key, "passed", None, utc_now()
                            )
                            completed.add(step_key)
                        elif outcome.status == "awaiting_review":
                            ts = await self._persist_step_status(
                                task.id, step_key, "awaiting_review", ts.error, None
                            )
                            failed.add(step_key)
                        elif step_run.attempt <= int(review_config.get("maxRetries", 1)):
                            has_artifact_feedback_route = any(
                                connection.get("kind", "solid") == "dashed"
                                for connection in step.outgoing_connections
                            )
                            if (
                                step.rework_upstream
                                and not has_artifact_feedback_route
                            ):
                                await self._schedule_rework(
                                    task,
                                    step,
                                    scheduler,
                                    completed,
                                    outcome.retry_context,
                                    step_run.attempt,
                                )
                                ts = await self._persist_step_status(
                                    task.id,
                                    step_key,
                                    "rework_waiting",
                                    outcome.feedback,
                                    None,
                                )
                            else:
                                retry_feedback = outcome.retry_context
                                ts = await self._persist_step_status(
                                    task.id,
                                    step_key,
                                    "retrying",
                                    outcome.feedback,
                                    ts.ended_at,
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
                            # 自动审核次数耗尽：转入人工审核，等待用户确认或驳回修正。
                            outcome = await gate.evaluate(
                                task=task,
                                step=step,
                                workflow_run=workflow_run,
                                step_run=step_run,
                                artifacts_dir=artifacts_dir,
                                execution_output="".join(content_parts),
                                execution_prompt=prompt,
                                review_config=review_config,
                                mode="manual",
                                artifact_round=artifact_round,
                            )
                            review_message_persisted = False
                            ts = await self._persist_step_status(
                                task.id,
                                step_key,
                                "awaiting_review",
                                outcome.feedback,
                                None,
                            )
                            failed.add(step_key)

                if (
                    step.review is not None
                    and workflow_run is not None
                    and step_run is not None
                    and outcome is not None
                    and not review_message_persisted
                ):
                    rmsg_id = new_message_id()
                    rnow = utc_now()
                    review_journal_ref = await self._event_journal.astart(
                        artifacts_dir.parent,
                        f"task-{task.id}",
                        rmsg_id,
                    )
                    for review_event in outcome.events:
                        await self._event_journal.arecord(
                            review_journal_ref,
                            review_event,
                        )
                    await self._event_journal.afinish(review_journal_ref)
                    review_snapshot = await self._ajournal_snapshot(review_journal_ref)
                    rsummary = outcome.report.get("summary", "")
                    rissues = outcome.report.get("issues", [])
                    ritems = "".join(
                        f"- {i.get('description', '')}"
                        + (
                            f" → {i.get('suggestion', '')}"
                            if i.get("suggestion")
                            else ""
                        )
                        + "\n"
                        for i in (rissues or [])
                    )
                    if outcome.status == "awaiting_review":
                        # 人工审核：不展示「审核结果」格式，直接提示等待用户确认。
                        rcontent = "等待你审核"
                    else:
                        verdict = "通过" if outcome.status == "passed" else "未通过"
                        rcontent = (
                            "**审核结果："
                            f"{verdict}**\n"
                            f"{rsummary}\n{ritems}"
                        )
                    await self._run_db(
                        lambda: create_task_message(
                            id=rmsg_id,
                            task=task,
                            channel="review",
                            step_key=step_key,
                            role="assistant",
                            content=rcontent,
                            engine=outcome.review_run.engine,
                            model=outcome.review_run.model,
                            run_id=rmsg_id,
                            step_run_id=step_run.id,
                            artifact_round=artifact_round,
                            run_status="completed",
                            event_log_path=review_journal_ref.relative_path,
                            prompt_json=outcome.review_run.prompt_json,
                            events_json=json.dumps(
                                [{
                                    "type": "review_context",
                                    "data": {"review_run_id": outcome.review_run.id},
                                }, *review_snapshot["events"]],
                                ensure_ascii=False,
                            ),
                            event_summary_json=review_snapshot["event_summary_json"],
                            event_count=review_snapshot["event_count"],
                            last_event_seq=review_snapshot["last_event_seq"],
                            usage_json=extract_usage_json(list(outcome.events)),
                            position=0,
                            started_at=outcome.review_run.started_at,
                            ended_at=outcome.review_run.ended_at,
                            created_at=rnow,
                        )
                    )
                    # 审核消息已持久化：实时推送完整消息事件，前端据此刷新
                    # reviews / history（否则打开面板期间不会显示审核消息）。
                    await self._publish(task.id, step_key, {
                        "channel": "review",
                        "message_id": rmsg_id,
                        "engine": outcome.review_run.engine,
                        "model": outcome.review_run.model,
                        "event_sequence": 0,
                        "type": "message_started",
                        "data": {"content": rcontent},
                        "created_at": rnow.isoformat(),
                    })
                    await self._publish(task.id, step_key, {
                        "channel": "review",
                        "message_id": rmsg_id,
                        "engine": outcome.review_run.engine,
                        "model": outcome.review_run.model,
                        "event_sequence": 1,
                        "type": "message_completed",
                        "data": {
                            "status": "completed",
                            "content": rcontent,
                        },
                        "created_at": rnow.isoformat(),
                    })

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
            # Update message
            try:
                if not interrupted_by_shutdown:
                    def finalize_message():
                        msg = Message.get_by_id(msg_id)
                        self._event_journal.finish(journal_ref)
                        snapshot = self._journal_snapshot(journal_ref)
                        msg.events_json = seal_unanswered_interactions(
                            snapshot["events_json"]
                        )
                        msg.event_summary_json = snapshot["event_summary_json"]
                        msg.event_count = snapshot["event_count"]
                        msg.last_event_seq = snapshot["last_event_seq"]
                        msg.usage_json = extract_usage_json(events_collected)
                        msg.content = snapshot["content"]
                        if run_key in self._cancelled_steps:
                            # 手动停止：与普通失败区分，前端显示「已停止」。
                            msg.run_status = "cancelled"
                        else:
                            msg.run_status = (
                                "succeeded" if execution_succeeded else "failed"
                            )
                        msg.ended_at = execution_ended_at or utc_now()
                        msg.save()
                        return msg

                    msg = await self._run_db(finalize_message)
                    await self._publish(task.id, step_key, {
                        "channel": "execution",
                        "message_id": msg_id,
                        "engine": msg.engine,
                        "model": msg.model,
                        "event_sequence": len(events_collected) + 1,
                        "type": "message_completed",
                        "data": {"status": msg.run_status},
                    })
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

            self._running_engines.pop(run_key, None)
            live_queue = self._live_message_queues.pop(run_key, None)
            if live_queue is not None:
                pending: list[tuple[str, str]] = []
                while not live_queue.empty():
                    pending.append(live_queue.get_nowait())
                for message_id, _ in pending:
                    self._live_message_prompts.pop(message_id, None)
                    await self._run_db(
                        lambda mid=message_id: self._fail_live_message(mid)
                    )
            cancelled_by_user = run_key in self._cancelled_steps
            self._cancelled_steps.discard(run_key)
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
                        await self._apply_artifact_routes(
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

    async def _apply_artifact_routes(
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
        """Apply one passed round's non-empty output ports to the scheduler."""
        if workflow_run is None or not step.outgoing_connections:
            return
        artifact = ArtifactRound(
            round=int(artifact_round),
            path=step_round_dir(
                artifacts_dir,
                task.workflow_id,
                task.id,
                step.key,
                artifact_round,
            ),
            manifest=manifest,
        )
        async with self._routing_lock:
            result = route_artifact_round(
                step=step,
                artifact_round=artifact,
                routing_state=self._routing_state,
            )
            self._routing_state = result.state
            for connection in result.solid_edges:
                target_step = str(connection.get("to") or "").strip()
                if target_step:
                    self._input_rounds_by_step.setdefault(
                        target_step,
                        {},
                    )[step.key] = artifact.round

            def persist_routing_state():
                row = WorkflowRun.get_by_id(workflow_run.id)
                row.routing_state_json = json.dumps(
                    self._routing_state, ensure_ascii=False, sort_keys=True
                )
                row.save(only=[WorkflowRun.routing_state_json])

            await self._run_db(persist_routing_state)

            if result.conflict:
                error = "同一轮同时产生了正常输出和返回输出，路由冲突"
                await self._persist_step_status(
                    task.id, step.key, "failed", error, utc_now()
                )
                completed.discard(step.key)
                failed.add(step.key)
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
                await self._persist_step_status(
                    task.id, step.key, "failed", error, utc_now()
                )
                completed.discard(step.key)
                failed.add(step.key)
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
                await self._schedule_port_return(
                    task,
                    step,
                    scheduler,
                    completed,
                    failed,
                    result.feedback_edges,
                )

    async def _schedule_port_return(
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
                    "rework_waiting" if key == source_step.key else "rework"
                )
                # The semantic input snapshot carries feedback artifact names,
                # rounds and paths.  Do not duplicate the same paths in a
                # free-form feedback field.
                row.rework_feedback = None
                row.error = None
                row.ended_at = None
                row.save()

        await self._run_db(persist_return)
        for key in rewind:
            await self._publish(task.id, key, {
                "type": "status",
                "data": {
                    "status": (
                        "rework_waiting" if key == source_step.key else "rework"
                    ),
                    "task_id": task.id,
                    "step_key": key,
                },
            })
        await self._publish(task.id, source_step.key, {
            "type": "step_return",
            "data": {
                "task_id": task.id,
                "step_key": source_step.key,
                "targets": sorted(targets),
                "connections": [
                    connection.get("id") for connection in feedback_edges
                ],
                "max_returns": source_step.max_return_rounds,
            },
        })

    async def _schedule_rework(
        self,
        task: Task,
        step: Step,
        scheduler: DAGScheduler,
        completed: set[str],
        feedback: str,
        attempt: int,
    ) -> None:
        """Reset upstream producers and their downstream so the DAG re-runs them.

        Called when an automatic review rejects this (verifier) step and the
        step declares rework targets via dashed feedback edges. Producers are
        re-run reusing their own sessions (same task+step), then the verifier
        is re-picked by the scheduler for another verification attempt.
        """
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

    async def _persist_step_status(
        self, task_id, step_key, status, error, ended_at
    ):
        def persist():
            row = TaskStep.get(
                (TaskStep.task == task_id) & (TaskStep.step_key == step_key)
            )
            row.status = status
            row.error = error
            row.ended_at = ended_at
            row.save()
            return row

        return await self._run_db(persist)

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

    @staticmethod
    def _fail_live_message(message_id):
        try:
            live_message = Message.get_by_id(message_id)
        except Message.DoesNotExist:
            return
        live_message.run_status = "failed"
        live_message.ended_at = utc_now()
        live_message.save()

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
        """Cancel a running step (idempotent)."""
        run_key = f"{task_id}:{step_key}"
        if run_key in self._cancelled_steps:
            # 已在停止流程中：重复点击直接视为成功，不再重复 stop。
            return True
        cancelled_interactions = intervention_manager.cancel_for_task_step(
            task_id, step_key
        )
        engine = self._running_engines.get(run_key)
        if not engine:
            return cancelled_interactions > 0
        self._cancelled_steps.add(run_key)
        await _stop_engine_safely(engine, run_key)
        return True

    async def send_live_message(
        self,
        task_id: str,
        step_key: str,
        content: str,
        as_guidance: bool = False,
    ) -> dict:
        """Send an ordinary user message into a running step execution.

        Persists an ``execution``-channel user message and queues it for the
        running engine to inject mid-run. With ``as_guidance`` the content is
        also saved as active step guidance (``StepSupplement``) so future
        attempts include it in the step prompt. Raises ValueError when the
        step is not running or its engine cannot deliver live messages.
        """
        normalized = content.strip()
        if not normalized:
            raise ValueError("消息内容不能为空")
        run_key = f"{task_id}:{step_key}"
        engine = self._running_engines.get(run_key)
        if engine is None:
            raise ValueError(f"步骤未在运行: {step_key}")
        engine_capabilities = getattr(engine, "capabilities", None)
        if engine_capabilities is None or not engine_capabilities.supports_live_step_message:
            raise ValueError("该引擎不支持执行中消息注入")
        queue = self._live_message_queues.get(run_key)
        if queue is None:
            raise ValueError("步骤消息队列不可用")
        now = utc_now()
        message_id = new_message_id()
        def persist_live_message():
            try:
                task = Task.get_by_id(task_id)
            except Task.DoesNotExist:
                raise ValueError(f"任务不存在: {task_id}")
            message = create_task_message(
                id=message_id,
                task=task,
                channel="execution",
                step_key=step_key,
                role="user",
                content=normalized,
                run_id=message_id,
                run_status="running",
                position=0,
                started_at=now,
                created_at=now,
            )
            trigger_name = message.author_name or task.creator_name or ""
            injected_content = (
                f"## Triggered by\n{trigger_name}\n\n## User message\n{normalized}"
                if trigger_name
                else normalized
            )
            if as_guidance:
                StepSupplement.create(
                    id=str(uuid.uuid4()),
                    task=task,
                    step_key=step_key,
                    content=normalized,
                    source_proposal=None,
                    origin="live_guidance",
                    created_sequence=(
                        task.next_message_sequence - 1
                        if task.next_message_sequence > 0
                        else 0
                    ),
                    created_at=now,
                )
                task.state_version += 1
                task.save()
            return message.sequence, injected_content

        sequence, injected_content = await self._run_db(persist_live_message)
        self._live_message_prompts[message_id] = injected_content
        await self._publish(task_id, step_key, {
            "channel": "execution",
            "message_id": message_id,
            "type": "message_started",
            "data": {
                "content": normalized,
                "status": "queued",
                "role": "user",
                "as_guidance": as_guidance,
            },
        })
        queue.put_nowait((message_id, injected_content))
        return {
            "message_id": message_id,
            "step_key": step_key,
            "status": "queued",
            "sequence": sequence,
            "created_at": now.isoformat(),
        }

    async def cancel_task(self, task_id: str) -> bool:
        """Cancel every running step for a task."""
        cancelled_interactions = intervention_manager.cancel_for_task(task_id)
        prefix = f"{task_id}:"
        run_keys = [
            run_key
            for run_key in self._running_engines
            if run_key.startswith(prefix)
        ]
        if not run_keys:
            return cancelled_interactions > 0
        for run_key in run_keys:
            self._cancelled_steps.add(run_key)
        await asyncio.gather(
            *(
                _stop_engine_safely(self._running_engines[run_key], run_key)
                for run_key in run_keys
            ),
        )
        return True

    async def stop_for_shutdown(self) -> None:
        """Stop engine subprocesses without marking steps failed.

        Used by graceful daemon shutdown so interrupted runs stay ``running``
        and are resumed from the last completed node on the next start.
        """
        self._graceful_shutdown = True
        running_engines = list(self._running_engines.items())
        for run_key, _engine in running_engines:
            task_id, _separator, _step_key = run_key.partition(":")
            intervention_manager.cancel_for_task(task_id)
        await asyncio.gather(
            *(
                _stop_engine_safely(engine, run_key)
                for run_key, engine in running_engines
            ),
        )
        self._running_engines.clear()

    async def _publish(self, task_id: str, step_key: str, event: dict):
        """发布出口：内部事件 → AG-UI 标准事件后推送。"""
        from services.remote_project import current_actor_event_fields

        payload = {
            "task_id": task_id,
            "step_key": step_key,
            **event,
            **current_actor_event_fields(),
        }
        ctx = AGUIContext.from_event(payload)
        for agui_event in to_agui_events(payload, ctx):
            await self._event_bus.publish(agui_event)
