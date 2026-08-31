"""TaskRunner — multi-stage pipeline execution with parallel branches."""

import asyncio
import json
import logging
import uuid
from pathlib import Path
from typing import AsyncIterator, Callable, TypeVar

from models import (
    Message,
    ReviewRun,
    StageSupplement,
    StepRun,
    Task,
    TaskStep,
    WorkflowRun,
)
from models.fields import utc_now
from services.pipeline import DAGScheduler, Step
from services.prompt import assemble_prompt
from services.review_gate import ReviewGate
from services.config import config_store
from services.messages import create_task_message, new_message_id
from services.intervention import intervention_manager, seal_unanswered_interactions
from agent_assistants.event_journal import JournalRef, TurnEventJournal
from engines.core.acp_base import AcpEngineBase
from engines.core.registry import create_engine
from engines.core.agui import AGUIContext, to_agui_events
from engines.core.events import InternalEvent
from streaming.bus import EventBus

logger = logging.getLogger(__name__)
ResultT = TypeVar("ResultT")


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
    """Yield engine events, failing the stage when the engine goes idle.

    If no event arrives within ``timeout_seconds`` (e.g. a stalled API
    connection), the engine is stopped and its stream closed, then an error
    event is yielded so the stage fails instead of hanging forever. The engine
    session is left intact, so re-running the stage resumes the same session.
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
                        "已停止执行并保留会话，可重新执行该阶段恢复"
                    ),
                },
            )
            return
        yield event


class TaskRunner:

    """Runs a task through its multi-stage pipeline.

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
    ):
        self._event_bus = event_bus
        self._dispatch_service = dispatch_service
        self._source_project_id = source_project_id
        self._database_executor = database_executor
        self._running_engines: dict[str, object] = {}  # step_run_key → engine
        self._live_message_queues: dict[str, asyncio.Queue] = {}
        self._cancelled_steps: set[str] = set()
        self._graceful_shutdown = False
        self._event_journal = TurnEventJournal()

    def _journal_snapshot(self, ref: JournalRef) -> dict:
        snapshot = self._event_journal.snapshot(ref)
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

    async def _run_db(self, operation: Callable[[], ResultT]) -> ResultT:
        """Run persistence on the owning project's writer when available."""
        if self._database_executor is None:
            return await asyncio.to_thread(operation)
        return await self._database_executor.run(operation)

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

        def initialize_pipeline_state() -> set[str]:
            # Ensure task_steps exist for all steps.
            for step in step_list:
                TaskStep.get_or_create(
                    task=task,
                    step_key=step.key,
                    defaults={"status": "pending"},
                )

            task.status = "running"
            task.updated_at = utc_now()
            task.save()

            persisted_completed: set[str] = set()
            # A task may intentionally start from a later stage. Persisted
            # skipped stages satisfy their DAG dependencies.
            for ts in TaskStep.select().where(
                (TaskStep.task == task) & (TaskStep.status == "skipped")
            ):
                persisted_completed.add(ts.step_key)

            if workflow_run is not None:
                for step_run in StepRun.select().where(
                    (StepRun.run == workflow_run)
                    & (StepRun.status.in_(["succeeded", "reused"]))
                ):
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
            return persisted_completed

        completed = await self._run_db(initialize_pipeline_state)
        running = set()
        failed = set()

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
            task.updated_at = utc_now()
            await self._run_db(task.save)

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
        resolved_model = (
            step.model
            or config_store.get_engine_default_model(step.engine)
            or None
        )

        def prepare_step_state():
            ts = TaskStep.get(
                (TaskStep.task == task) & (TaskStep.step_key == step_key)
            )
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
                    started_at=utc_now(),
                )
            return ts, step_run, rework_feedback, manual_review_feedback

        ts, step_run, rework_feedback, manual_review_feedback = (
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
                    raise RuntimeError("流程阶段服务未初始化")
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
                await self._publish(task.id, step_key, {
                    "type": "status",
                    "data": {"status": "passed", "step_key": step_key},
                })
            return

        # Assemble prompt
        feedback = review_feedback or manual_review_feedback or rework_feedback
        prompt = await self._run_db(
            lambda: assemble_prompt(task, step, artifacts_dir, user_input)
        )
        if feedback:
            label = (
                "人工审核反馈"
                if manual_review_feedback
                else "验证反馈"
            )
            prompt += (
                f"\n\n## 上一轮{label}\n"
                f"{feedback}\n\n"
                "请保留已有正确结果，并修复以上问题。"
            )

        # Ensure artifact output directory (workflow / task / stage)
        wf_name = task.workflow_id or "default"
        out_dir = artifacts_dir / wf_name / task.id / step_key
        msg_id = new_message_id()
        message_started_at = utc_now()
        journal_ref = self._event_journal.start(
            artifacts_dir.parent,
            f"task-{task.id}",
            msg_id,
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
            "data": {"prompt": prompt},
            "created_at": message_started_at.isoformat(),
        })

        # Select engine
        engine = create_engine(step.engine)
        if not engine:
            error = f"Engine '{step.engine}' not available"
            await self._fail_step(ts, task, step_key, error)
            failed.add(step_key)
            error_event = InternalEvent(
                type="error", data={"message": error}
            ).to_dict()
            self._event_journal.finish(journal_ref, error_event)
            snapshot = self._journal_snapshot(journal_ref)
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
            running.discard(step_key)
            return

        self._cancelled_steps.discard(run_key)
        self._running_engines[run_key] = engine
        live_queue: asyncio.Queue | None = None
        engine_capabilities = getattr(engine, "capabilities", None)
        if engine_capabilities is not None and engine_capabilities.supports_live_stage_message:
            live_queue = asyncio.Queue()
            self._live_message_queues[run_key] = live_queue
        events_collected = []
        content_parts = []
        reported_error: str | None = None
        execution_succeeded = False
        retry_feedback: str | None = None
        captured_session_id = ts.session_id
        interrupted = False

        try:
            spawn_kwargs = dict(
                prompt=prompt,
                cwd=task.cwd,
                model=resolved_model,
                session_id=ts.session_id if engine.supports_resume else None,
                config_overrides=step.config or None,
            )
            if live_queue is not None:
                spawn_kwargs["live_message_queue"] = live_queue
            spawn_iter = engine.spawn(**spawn_kwargs)
            idle_timeout = config_store.get_engine_idle_timeout_seconds()
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
                self._event_journal.record(journal_ref, event.to_dict())
                if event.type == "agent_message_chunk":
                    content = event.data.get("content") or {}
                    content_parts.append(content.get("text", ""))
                elif event.type == "session_started":
                    captured_session_id = (
                        str(event.data.get("session_id") or "") or None
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
                        try:
                            await self._run_db(finish_live_message)
                        except Message.DoesNotExist:
                            pass
                    if live_data.get("status") == "delivered":
                        # 引擎确认收到插入消息：封口当前执行段并开启新的响应段，
                        # 历史消息呈现「阶段输出 → 用户插入 → 阶段响应」的分段结构。
                        seal_time = utc_now()
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
                        journal_ref = self._event_journal.start(
                            artifacts_dir.parent,
                            f"task-{task.id}",
                            new_msg_id,
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
                                run_status="running",
                                event_log_path=journal_ref.relative_path,
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
                            "data": {"content": ""},
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
                    self._event_journal.record(journal_ref, response_event.to_dict())
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
                # 同任务同阶段重跑时复用该会话（session/resume）。
                def save_session_id():
                    current = TaskStep.get(
                        (TaskStep.task == task) & (TaskStep.step_key == step_key)
                    )
                    current.session_id = captured_session_id
                    current.save()
                    return current

                ts = await self._run_db(save_session_id)

            if run_key in self._cancelled_steps:
                # 手动停止：阶段状态与普通失败区分，前端显示「手动停止」。
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
                    # Merge task-level review overrides with stage config
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
                        # 跳过审核：阶段执行完成后直接通过，不创建审核记录。
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
                        gate = ReviewGate(
                            lambda event: self._publish(task.id, step_key, event),
                            self._run_db,
                        )
                        outcome = await gate.evaluate(
                            task=task,
                            step=step,
                            workflow_run=workflow_run,
                            step_run=step_run,
                            artifacts_dir=artifacts_dir,
                            execution_output="".join(content_parts),
                            review_config=review_config,
                            mode=review_mode,
                        )
                        # 重新加载最新 ts：gate 在审核期间写入了 review_session_id，
                        # 用旧实例整行 save 会把它覆盖回 None。
                        if outcome.status == "passed":
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
                            if step.rework_upstream:
                                await self._schedule_rework(
                                    task,
                                    step,
                                    scheduler,
                                    completed,
                                    outcome.feedback,
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
                                retry_feedback = outcome.feedback
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
                                review_config=review_config,
                                mode="manual",
                            )
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
                ):
                    rmsg_id = new_message_id()
                    rnow = utc_now()
                    review_journal_ref = self._event_journal.start(
                        artifacts_dir.parent,
                        f"task-{task.id}",
                        rmsg_id,
                    )
                    for review_event in outcome.events:
                        self._event_journal.record(
                            review_journal_ref,
                            review_event,
                        )
                    self._event_journal.finish(review_journal_ref)
                    review_snapshot = self._journal_snapshot(review_journal_ref)
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
            self._event_journal.record(journal_ref, error_event)

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
                        msg.ended_at = utc_now()
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
                    await self._run_db(
                        lambda mid=message_id: self._fail_live_message(mid)
                    )
            self._cancelled_steps.discard(run_key)
            running.discard(step_key)
            if step_run is not None:
                if (
                    step_run.status == "running"
                    and not interrupted_by_shutdown
                ):
                    step_run = await self._persist_step_run_status(
                        step_run.id,
                        "succeeded" if execution_succeeded else "failed",
                        None if execution_succeeded else ts.error,
                        utc_now(),
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
        re-run reusing their own sessions (same task+stage), then the verifier
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
            row.save()
            return row

        return await self._run_db(persist)

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
        engine = self._running_engines.get(run_key)
        if not engine:
            return False
        self._cancelled_steps.add(run_key)
        try:
            await engine.stop()
        except Exception:
            # 引擎可能已停止/已退出：标记已取消即可，不让错误冒泡。
            logger.exception("Engine stop raised during cancel for %s", run_key)
        return True

    async def send_live_message(
        self,
        task_id: str,
        step_key: str,
        content: str,
        as_guidance: bool = False,
    ) -> dict:
        """Send an ordinary user message into a running stage execution.

        Persists an ``execution``-channel user message and queues it for the
        running engine to inject mid-run. With ``as_guidance`` the content is
        also saved as active stage guidance (``StageSupplement``) so future
        attempts include it in the stage prompt. Raises ValueError when the
        stage is not running or its engine cannot deliver live messages.
        """
        normalized = content.strip()
        if not normalized:
            raise ValueError("消息内容不能为空")
        run_key = f"{task_id}:{step_key}"
        engine = self._running_engines.get(run_key)
        if engine is None:
            raise ValueError(f"阶段未在运行: {step_key}")
        engine_capabilities = getattr(engine, "capabilities", None)
        if engine_capabilities is None or not engine_capabilities.supports_live_stage_message:
            raise ValueError("该引擎不支持执行中消息注入")
        queue = self._live_message_queues.get(run_key)
        if queue is None:
            raise ValueError("阶段消息队列不可用")
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
            if as_guidance:
                StageSupplement.create(
                    id=str(uuid.uuid4()),
                    task=task,
                    step_key=step_key,
                    content=normalized,
                    source_proposal=None,
                    created_sequence=(
                        task.next_message_sequence - 1
                        if task.next_message_sequence > 0
                        else 0
                    ),
                    created_at=now,
                )
                task.state_version += 1
                task.save()
            return message.sequence

        sequence = await self._run_db(persist_live_message)
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
        queue.put_nowait((message_id, normalized))
        return {
            "message_id": message_id,
            "step_key": step_key,
            "status": "queued",
            "sequence": sequence,
            "created_at": now.isoformat(),
        }

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
            *(self._running_engines[run_key].stop() for run_key in run_keys),
            return_exceptions=True,
        )
        return True

    async def stop_for_shutdown(self) -> None:
        """Stop engine subprocesses without marking steps failed.

        Used by graceful daemon shutdown so interrupted runs stay ``running``
        and are resumed from the last completed node on the next start.
        """
        self._graceful_shutdown = True
        engines = list(self._running_engines.values())
        await asyncio.gather(
            *(engine.stop() for engine in engines),
            return_exceptions=True,
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
