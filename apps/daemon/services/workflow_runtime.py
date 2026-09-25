"""Production entry point for executing a saved workflow."""

import asyncio
import functools
import json
import logging
import uuid
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path

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
from services.task_runner import TaskRunner
from services.task_dispatch import TaskDispatchService
from services.workflow_definition import WorkflowDefinition
from services.review_decision import persist_review_decision
from services.failed_step_completion import persist_failed_step_completion
from services.orphan_step_stop import persist_orphan_stop
from services.step_message_restart import (
    inspect_failed_message_retry,
    persist_step_followup,
)
from services.workflow_restart import create_restart_run
from services.step_execution_config import (
    ACTIVE_STEP_CONFIG_STATUSES as _ACTIVE_STEP_CONFIG_STATUSES,
    StepExecutionConfigService,
)
from services.workflow_recovery import (
    RUN_LEASE_STALE_SECONDS,
    heal_task_cwd,
    prepare_project_recovery,
)
from services.messages import create_task_message, new_message_id
from services.pipeline import DAGScheduler, Step
from services.artifact_rounds import (
    iter_artifact_rounds,
)
from services.artifact_routing import (
    empty_routing_state,
    normalize_routing_state,
    source_for_connection,
)
from engines.core.agui import AGUIContext, to_agui_events
from streaming.bus import EventBus

logger = logging.getLogger(__name__)

_VALID_TASK_SOURCES = {"manual", "schedule", "scheduled_start"}

# WorkflowRun 租约：一个 run 同时只能被一个 daemon 实例执行。心跳按固定周期续约，
# 启动恢复只接管租约已失效（或来自无租约旧库）的 run，避免重复派发把任务状态写脏。
RUN_LEASE_HEARTBEAT_SECONDS = 5.0
ORPHAN_RECONCILE_SECONDS = 15.0


def resolve_message_step_key(
    steps_config: dict,
    step_statuses: dict[str, str],
) -> str:
    ordered_keys = [
        step["key"]
        for step in steps_config.get("steps", [])
        if step.get("key")
    ]
    for statuses in (
        {"running", "reviewing", "awaiting_review", "retrying", "rework", "rework_waiting"},
        {"failed", "rejected"},
        {"pending"},
    ):
        current = next(
            (
                step_key
                for step_key in ordered_keys
                if step_statuses.get(step_key) in statuses
            ),
            None,
        )
        if current:
            return current
    return ordered_keys[-1] if ordered_keys else "do"


@dataclass(frozen=True, slots=True)
class WorkflowRunHandle:
    """Stable identity plus completion capability for one background run."""

    id: str
    _completion: asyncio.Task[str] = field(repr=False, compare=False)


@dataclass(frozen=True, slots=True)
class _PreparedWorkflowRun:
    project_id: str
    database_executor: object
    task: Task
    workflow_run: WorkflowRun
    steps_config: dict
    artifacts_dir: Path
    user_message: Message | None
    entry_step_key: str | None = None
    execution_scope: frozenset[str] | None = None


class WorkflowRuntime:
    """Run project workflows behind one small interface."""

    def __init__(self, event_bus: EventBus, project_manager):
        self._event_bus = event_bus
        self._project_manager = project_manager
        self._runners: dict[str, TaskRunner] = {}
        self._active_tasks: set[asyncio.Task[str]] = set()
        self._operation_locks: dict[str, asyncio.Lock] = {}
        self._step_config = StepExecutionConfigService(
            self._run_db, self._current_workflow_steps, self._operation_locks
        )
        self._graceful_shutdown = False
        # 每个 runtime 实例拥有独立身份，用于 WorkflowRun 租约归属判定与心跳续约。
        self._instance_id = uuid.uuid4().hex
        self._leased_runs: dict[str, str] = {}
        self._lease_task: asyncio.Task | None = None
        self._lease_retry_tasks: set[asyncio.Task] = set()
        self._last_orphan_reconcile = 0.0
        self._dispatch_service = TaskDispatchService(
            project_manager, event_bus, self
        )

    async def run(
        self,
        project_id: str,
        task_id: str,
        user_input: str = "",
    ) -> str:
        """Execute and wait for the project's saved workflow."""
        handle = await self.start(project_id, task_id, user_input)
        return await self.wait(handle)

    async def start(
        self,
        project_id: str,
        task_id: str,
        user_input: str = "",
        source: str = "manual",
    ) -> WorkflowRunHandle:
        """Start a saved workflow and return its stable background handle.

        ``source`` marks the dispatch origin (manual / schedule /
        scheduled_start) so the concurrency gate can exempt scheduled tasks
        when the effective project config enables it. When the task channel
        is full the task transitions to ``queued`` and waits for a slot.
        """
        from services.concurrency import (
            ALREADY_ACTIVE,
            QUEUED,
            concurrency_gate,
        )

        if source not in _VALID_TASK_SOURCES:
            raise ValueError(f"Invalid task source: {source}")
        acquired = await concurrency_gate.acquire_task(project_id, task_id, source)
        if acquired == ALREADY_ACTIVE:
            raise RuntimeError(f"Task is already queued or running: {task_id}")
        if acquired == QUEUED:
            await self._mark_task_status(project_id, task_id, "queued")
            try:
                await concurrency_gate.wait_task_slot(project_id, task_id)
            except asyncio.CancelledError:
                concurrency_gate.cancel_queued_task(project_id, task_id)
                await self._mark_task_status(project_id, task_id, "ready")
                raise
        return await self._start_after_slot(project_id, task_id, user_input)

    async def _start_after_slot(
        self,
        project_id: str,
        task_id: str,
        user_input: str = "",
    ) -> WorkflowRunHandle:
        """Launch a workflow when the caller already holds a concurrency slot."""
        lock = self._operation_locks.setdefault(task_id, asyncio.Lock())
        async with lock:
            if task_id in self._runners:
                raise RuntimeError(f"Task is already running: {task_id}")
            prepared = await self._run_db(
                project_id,
                lambda project: self._prepare_start_in_project(
                    project,
                    task_id,
                    user_input,
                ),
            )
            handle = self._launch_prepared_run(prepared, user_input)
            normalized_input = user_input.strip()
            if normalized_input and prepared.user_message is not None:
                await self._publish_user_message(
                    task_id,
                    prepared.user_message,
                    "message_started",
                    {"content": normalized_input, "status": "completed"},
                )
            return handle

    async def _mark_task_status(
        self,
        project_id: str,
        task_id: str,
        status: str,
    ) -> None:
        """Persist a task status change and broadcast it as a status event."""
        from engines.core.agui import AGUIContext, to_agui_events
        from services.remote_project import current_actor_event_fields

        def persist():
            task = Task.get_or_none(Task.id == task_id)
            if task is None:
                return
            task.status = status
            task.updated_at = utc_now()
            task.save()

        await self._run_db(project_id, lambda _project: persist())
        from services.concurrency import concurrency_gate

        payload = {
            "task_id": task_id,
            "step_key": "",
            "type": "status",
            "data": {
                "status": status,
                "task_id": task_id,
                "queue_position": concurrency_gate.task_queue_position(project_id, task_id),
            },
            **current_actor_event_fields(),
        }
        ctx = AGUIContext.from_event(payload)
        for agui_event in to_agui_events(payload, ctx):
            await self._event_bus.publish(agui_event)

    async def cancel_queued(self, project_id: str, task_id: str) -> bool:
        """Cancel a queued (waiting for a slot) task and return it to ready."""
        from services.concurrency import concurrency_gate

        if concurrency_gate.task_queue_position(project_id, task_id) == 0:
            return False
        concurrency_gate.cancel_queued_task(project_id, task_id)
        await self._mark_task_status(project_id, task_id, "ready")
        return True

    async def _run_db(self, project_id: str, operation):
        """Use the production DB executor while retaining lightweight adapters."""
        run_db = getattr(self._project_manager, "run_db", None)
        if run_db is not None:
            return await run_db(project_id, operation)

        def execute():
            with self._project_manager.activate_project_by_id(project_id) as project:
                return operation(project)

        return await asyncio.to_thread(execute)

    def _start_in_project(
        self,
        project,
        task_id: str,
        user_input: str,
    ) -> WorkflowRunHandle:
        """Create persistent run state while its project context is active."""
        if task_id in self._runners:
            raise RuntimeError(f"Task is already running: {task_id}")
        prepared = self._prepare_start_in_project(project, task_id, user_input)
        return self._launch_prepared_run(prepared, user_input)

    def _prepare_start_in_project(
        self,
        project,
        task_id: str,
        user_input: str,
    ) -> _PreparedWorkflowRun:
        """Persist a new run while executing on the project's DB thread."""
        try:
            task = Task.get_by_id(task_id)
        except Task.DoesNotExist as exc:
            raise ValueError(f"Task not found: {task_id}") from exc
        heal_task_cwd(task, project)

        workflow_data = self._current_workflow_steps(project, task)
        workflow = WorkflowDefinition.load(workflow_data)
        compiled = workflow.compile()
        steps_config = compiled.to_steps_config()
        entry_step_key, execution_scope = self._infer_entry_scope(
            task,
            steps_config,
        )
        routing_state = empty_routing_state()
        routing_state["entry_step_key"] = entry_step_key
        routing_state["execution_scope"] = (
            sorted(execution_scope) if execution_scope is not None else None
        )
        now = utc_now()
        workflow_run = WorkflowRun.create(
            id=str(uuid.uuid4()),
            task=task,
            status="running",
            workflow_schema_version=compiled.schema_version,
            workflow_snapshot_json="{}",
            routing_state_json=json.dumps(routing_state, ensure_ascii=False),
            restart_from_step_key=entry_step_key,
            owner_id=self._instance_id,
            heartbeat_at=now,
            started_at=now,
        )

        artifacts_dir = Path(project.workstep_dir) / "artifacts"
        artifacts_dir.mkdir(parents=True, exist_ok=True)
        task.status = "running"
        task.active_workflow_run_id = workflow_run.id
        task.state_version += 1
        task.updated_at = now
        task.save()

        normalized_input = user_input.strip()
        user_message = None
        if normalized_input:
            step_statuses = {
                task_step.step_key: task_step.status
                for task_step in TaskStep.select().where(TaskStep.task == task)
            }
            message_step_key = resolve_message_step_key(
                steps_config,
                step_statuses,
            )
            user_message = create_task_message(
                id=new_message_id(),
                task=task,
                channel="execution",
                step_key=message_step_key,
                role="user",
                content=normalized_input,
                run_id=workflow_run.id,
                run_status="completed",
                position=0,
                started_at=now,
                ended_at=now,
                created_at=now,
            )

        return _PreparedWorkflowRun(
            project_id=project.id,
            database_executor=getattr(project, "database_executor", None),
            task=task,
            workflow_run=workflow_run,
            steps_config=steps_config,
            artifacts_dir=artifacts_dir,
            user_message=user_message,
            entry_step_key=entry_step_key,
            execution_scope=(
                frozenset(execution_scope)
                if execution_scope is not None else None
            ),
        )

    @staticmethod
    def _infer_entry_scope(
        task: Task,
        steps_config: dict,
    ) -> tuple[str | None, set[str] | None]:
        """Infer a deliberately selected entry from initial step statuses."""
        if WorkflowRun.select().where(WorkflowRun.task == task).exists():
            return None, None
        scheduler = DAGScheduler([
            Step.from_dict(item) for item in steps_config.get("steps", [])
        ])
        statuses = {
            row.step_key: row.status
            for row in TaskStep.select().where(TaskStep.task == task)
        }
        if not any(
            statuses.get(step_key) == "skipped"
            for step_key in scheduler.steps
        ):
            return None, None
        scope = {
            step_key
            for step_key in scheduler.steps
            if statuses.get(step_key) != "skipped"
        }
        roots = [
            step_key
            for step_key in scope
            if not (set(scheduler.steps[step_key].depends_on) & scope)
        ]
        if len(roots) != 1:
            return None, None
        return roots[0], scope

    def _launch_prepared_run(
        self,
        prepared: _PreparedWorkflowRun,
        user_input: str,
        step_followups: dict[str, str] | None = None,
        input_rounds_by_step: dict[str, dict[str, int]] | None = None,
        execution_scope: set[str] | None = None,
        entry_step_key: str | None = None,
        step_trigger_names: dict[str, str] | None = None,
        retry_message_ids: dict[str, str] | None = None,
    ) -> WorkflowRunHandle:
        """Attach prepared persistent state to event-loop-owned runtime state."""
        task = prepared.task
        workflow_run = prepared.workflow_run
        resolved_scope = (
            execution_scope
            if execution_scope is not None
            else (
                set(prepared.execution_scope)
                if prepared.execution_scope is not None else None
            )
        )
        resolved_entry = entry_step_key or prepared.entry_step_key
        runner = TaskRunner(
            self._event_bus,
            dispatch_service=self._dispatch_service,
            source_project_id=prepared.project_id,
            database_executor=prepared.database_executor,
            step_followups=step_followups,
            step_trigger_names=step_trigger_names,
            retry_message_ids=retry_message_ids,
            input_rounds_by_step=input_rounds_by_step,
            execution_scope=resolved_scope,
            entry_step_key=resolved_entry,
            initial_user_input_step_key=(
                prepared.user_message.step_key
                if prepared.user_message is not None
                else None
            ),
        )
        self._runners[task.id] = runner
        self._register_lease(workflow_run.id, prepared.project_id)

        completion = asyncio.create_task(
            self._execute(
                project_id=prepared.project_id,
                task=task,
                runner=runner,
                workflow_run=workflow_run,
                steps_config=prepared.steps_config,
                artifacts_dir=prepared.artifacts_dir,
                user_input=user_input,
                execution_scope=resolved_scope,
            ),
            name=f"workflow-run:{workflow_run.id}",
        )
        self._active_tasks.add(completion)
        completion.add_done_callback(
            functools.partial(
                self._consume_completion,
                task_id=task.id,
                runner=runner,
                workflow_run=workflow_run,
            )
        )
        return WorkflowRunHandle(workflow_run.id, completion)

    async def wait(self, handle: WorkflowRunHandle) -> str:
        """Wait for a handle returned by start and return its run id."""
        return await handle._completion

    async def _publish_user_message(
        self,
        task_id: str,
        message: Message,
        event_type: str,
        data: dict,
    ) -> None:
        """Translate a persisted user message into AG-UI live events."""
        from services.remote_project import current_actor_event_fields

        data = {**data, "role": "user"}
        payload = {
            "task_id": task_id,
            "channel": message.channel,
            "message_id": message.id,
            "step_key": message.step_key,
            "type": event_type,
            "data": data,
            "created_at": (
                message.created_at.isoformat()
                if message.created_at is not None
                else utc_now().isoformat()
            ),
            **current_actor_event_fields(),
        }
        ctx = AGUIContext.from_event(payload)
        for agui_event in to_agui_events(payload, ctx):
            await self._event_bus.publish(agui_event)

    async def send_step_message(
        self,
        project_id: str,
        task_id: str,
        step_key: str,
        content: str,
        as_guidance: bool = False,
    ) -> dict:
        """Inject a user message into a running step or automatic review."""
        runner = self._runners.get(task_id)
        if runner is None:
            raise ValueError("任务没有正在执行的步骤")
        return await runner.send_live_message(
            task_id,
            step_key,
            content,
            as_guidance=as_guidance,
        )

    async def cancel_step(
        self,
        project_id: str,
        task_id: str,
        step_key: str,
    ) -> bool:
        """Stop a running step engine."""
        runner = self._runners.get(task_id)
        if runner is not None:
            return await runner.cancel_step(task_id, step_key)

        # The persisted state can outlive its runner when final status writes
        # fail (for example, a transient SQLite failure). Let the user stop
        # that orphaned attempt so it can be restarted through the normal @
        # flow, while refusing to take over a fresh lease owned by a peer.
        lock = self._operation_locks.setdefault(task_id, asyncio.Lock())
        async with lock:
            runner = self._runners.get(task_id)
            if runner is not None:
                return await runner.cancel_step(task_id, step_key)

            now = utc_now()
            run_id, message_id, already_stopped = await self._run_db(
                project_id,
                lambda _project: persist_orphan_stop(
                    task_id, step_key, now, self._instance_id
                ),
            )
            if run_id:
                self._release_lease(run_id)

            from services.concurrency import concurrency_gate

            await concurrency_gate.release_task(project_id, task_id)
            if already_stopped:
                return True

            status_event = {
                "task_id": task_id,
                "step_key": step_key,
                "type": "status",
                "data": {
                    "status": "cancelled",
                    "task_id": task_id,
                    "step_key": step_key,
                },
            }
            status_ctx = AGUIContext.from_event(status_event)
            for agui_event in to_agui_events(status_event, status_ctx):
                await self._event_bus.publish(agui_event)
            if message_id:
                message_event = {
                    "task_id": task_id,
                    "step_key": step_key,
                    "channel": "execution",
                    "message_id": message_id,
                    "type": "message_completed",
                    "data": {"status": "cancelled"},
                }
                message_ctx = AGUIContext.from_event(message_event)
                for agui_event in to_agui_events(message_event, message_ctx):
                    await self._event_bus.publish(agui_event)
            return True

    async def resume_step_with_message(
        self,
        project_id: str,
        task_id: str,
        step_key: str,
        content: str,
        *,
        author_name: str | None = None,
        pending_insert_ids: list[str] | None = None,
        reset_session: bool = False,
    ) -> dict:
        """Persist a user message and re-run a stopped or completed step.

        The message is stored in the step's execution history (and as active
        step guidance) so the next attempt carries it into the step LLM,
        then the step plus its downstream is restarted from ``step_key``. A
        pending manual review is skipped because the new message supersedes
        the output that review was asking the user to accept.
        """
        normalized = content.strip()
        if not normalized:
            raise ValueError("消息内容不能为空")
        user_message, pending_review_id, trigger_name = await self._run_db(
            project_id, lambda _project: persist_step_followup(
                task_id, step_key, normalized, author_name, pending_insert_ids
            )
        )
        message_id = user_message.id
        handle = await self.restart_from_step(
            project_id,
            task_id,
            step_key,
            step_followup=normalized,
            trigger_name=trigger_name,
            reset_session=reset_session,
        )
        await self._publish_user_message(
            task_id,
            user_message,
            "message_started",
            {"content": normalized, "status": "completed"},
        )
        if pending_review_id is not None:
            await self._skip_manual_review(
                project_id,
                task_id,
                step_key,
                pending_review_id,
            )
        return {
            "message_id": message_id,
            "step_key": step_key,
            "run_id": handle.id,
            "status": "queued",
            "sequence": user_message.sequence,
            "created_at": user_message.created_at.isoformat(),
        }

    async def _consume_task_pending_inserts(
        self,
        project_id: str,
        task_id: str,
    ) -> None:
        """Start one merged follow-up for the oldest completed step target."""
        def load_batch(_project):
            from models import PendingMessageInsert
            from services.pending_message_inserts import pending_insert_batch

            first = (
                PendingMessageInsert.select(PendingMessageInsert, Message)
                .join(
                    Message,
                    on=(PendingMessageInsert.target_message_id == Message.id),
                )
                .where(Message.task == task_id)
                .order_by(PendingMessageInsert.created_at, PendingMessageInsert.position)
                .first()
            )
            if first is None:
                return None
            target = Message.get_by_id(first.target_message_id)
            ids, content, username = pending_insert_batch(target.id)
            if not ids or not content:
                return None
            return target.step_key, ids, content, username

        batch = await self._run_db(project_id, load_batch)
        if batch is None:
            return
        step_key, ids, content, username = batch
        try:
            await self.resume_step_with_message(
                project_id,
                task_id,
                step_key,
                content,
                author_name=username,
                pending_insert_ids=ids,
            )
        except Exception:
            logger.exception(
                "Failed to consume pending inserts for task %s step %s",
                task_id,
                step_key,
            )

    async def restart_step_with_fresh_session(
        self,
        project_id: str,
        task_id: str,
        step_key: str,
    ) -> dict:
        """Drop the step's engine session and re-run it with the full prompt.

        Used when the engine reports a lost session (e.g. Codex
        ``no rollout found``): the opaque session id can no longer be resumed,
        but the step prompt is self-contained, so clearing the saved session
        and starting a fresh engine session reproduces the step from scratch.
        """
        def validate_reset():
            task = Task.get_or_none(Task.id == task_id)
            if task is None:
                raise ValueError(f"Task not found: {task_id}")
            step = TaskStep.get_or_none(
                (TaskStep.task == task) & (TaskStep.step_key == step_key)
            )
            if step is None:
                raise ValueError(f"Step does not exist: {step_key}")
            if step.status in _ACTIVE_STEP_CONFIG_STATUSES or step.status in (
                "reviewing",
                "rework_waiting",
            ):
                raise ValueError(f"步骤执行中，不能重建会话: {step_key}")

        await self._run_db(project_id, lambda _project: validate_reset())
        handle = await self.restart_from_step(
            project_id,
            task_id,
            step_key,
            reset_session=True,
        )
        return {
            "step_key": step_key,
            "run_id": handle.id,
            "status": "queued",
        }

    async def retry_failed_message(
        self, project_id: str, task_id: str, message_id: str,
    ) -> dict:
        active_runner = task_id in self._runners
        step_key, run_id = await self._run_db(
            project_id,
            lambda _project: inspect_failed_message_retry(
                task_id, message_id, active_runner
            ),
        )
        handle = await self.restart_from_step(
            project_id, task_id, step_key,
            expected_run_id=run_id,
            expected_failed_message_id=message_id,
            reset_session=True,
        )
        return {
            "message_id": message_id,
            "step_key": step_key,
            "run_id": handle.id,
            "status": "queued",
        }

    async def complete_failed_step(
        self,
        project_id: str,
        task_id: str,
        message_id: str,
        artifact_round: int,
        *,
        schedule_downstream: bool,
    ) -> WorkflowRunHandle | None:
        """Accept an existing output after its execution message failed."""
        lock = self._operation_locks.setdefault(task_id, asyncio.Lock())
        async with lock:
            active_runner = task_id in self._runners
            decision_data = await self._run_db(
                project_id,
                lambda project: persist_failed_step_completion(
                    project, task_id, message_id, artifact_round,
                    schedule_downstream=schedule_downstream,
                    active_runner=active_runner,
                    instance_id=self._instance_id,
                    current_workflow_steps=self._current_workflow_steps,
                ),
            )
            if decision_data is None:
                return None
            task, workflow_run, steps_config = decision_data
            project = await self._run_db(project_id, lambda project: project)
            return await self._resume_in_project(project, task, workflow_run, steps_config)

    async def _skip_manual_review(
        self,
        project_id: str,
        task_id: str,
        step_key: str,
        review_run_id: str,
    ) -> None:
        """Close one superseded manual review and hide its prompt message."""
        now = utc_now()
        def persist_skip():
            review = ReviewRun.get_or_none(
                (ReviewRun.id == review_run_id)
                & (ReviewRun.task == task_id)
                & (ReviewRun.step_key == step_key)
            )
            if review is None or review.status not in {"pending", "cancelled"}:
                raise RuntimeError("Manual review is no longer pending")
            review.status = "skipped"
            review.ended_at = now
            review.save()

            review_messages = Message.select().where(
                (Message.task == task_id)
                & (Message.channel == "review")
                & (Message.step_key == step_key)
            )
            for review_message in review_messages:
                try:
                    events = json.loads(review_message.events_json or "[]")
                except (json.JSONDecodeError, TypeError):
                    continue
                matched = False
                for event in events:
                    data = event.get("data") if isinstance(event, dict) else None
                    if (
                        isinstance(data, dict)
                        and event.get("type") == "review_context"
                        and data.get("review_run_id") == review.id
                    ):
                        data["status"] = "skipped"
                        matched = True
                if matched:
                    review_message.events_json = json.dumps(events, ensure_ascii=False)
                    review_message.ended_at = now
                    review_message.run_status = "completed"
                    review_message.save()
                    break

        await self._run_db(project_id, lambda _project: persist_skip())

        event = {
            "task_id": task_id,
            "step_key": step_key,
            "type": "review_status",
            "data": {
                "task_id": task_id,
                "step_key": step_key,
                "review_run_id": review_run_id,
                "status": "skipped",
            },
        }
        ctx = AGUIContext.from_event(event)
        for agui_event in to_agui_events(event, ctx):
            await self._event_bus.publish(agui_event)

    async def decide_review(
        self,
        project_id: str,
        task_id: str,
        step_key: str,
        review_run_id: str,
        decision: str,
        comment: str | None = None,
        *,
        schedule_downstream: bool | None = None,
    ) -> WorkflowRunHandle | None:
        """Persist a manual decision and resume unless the task was terminated."""
        from services.messages import current_actor_message_fields

        if decision == "set_complete" and schedule_downstream is None:
            raise RuntimeError("请先选择是否继续调度下游步骤")

        if decision == "complete_task":
            for _ in range(100):
                if task_id not in self._runners:
                    break
                await asyncio.sleep(0.01)
        actor_fields = current_actor_message_fields()
        decision_data = await self._run_db(
            project_id,
            lambda project: persist_review_decision(
                project,
                task_id,
                step_key,
                review_run_id,
                decision,
                comment,
                actor_fields,
                schedule_downstream,
                active_runners=self._runners,
                instance_id=self._instance_id,
                current_workflow_steps=self._current_workflow_steps,
            ),
        )
        if decision in {"terminate", "complete_task", "set_complete"}:
            event = {
                "task_id": task_id,
                "step_key": step_key,
                "type": "review_status",
                "data": {
                    "task_id": task_id,
                    "step_key": step_key,
                    "review_run_id": review_run_id,
                    "status": "terminated" if decision == "terminate" else "passed",
                },
            }
            ctx = AGUIContext.from_event(event)
            for agui_event in to_agui_events(event, ctx):
                await self._event_bus.publish(agui_event)
            if decision == "complete_task":
                from services.remote_project import current_actor_event_fields

                status_event = {
                    "task_id": task_id,
                    "step_key": "",
                    "type": "status",
                    "data": {"task_id": task_id, "status": "ready"},
                    **current_actor_event_fields(),
                }
                ctx = AGUIContext.from_event(status_event)
                for agui_event in to_agui_events(status_event, ctx):
                    await self._event_bus.publish(agui_event)
        if decision_data is None:
            return None
        task, workflow_run, steps_config = decision_data
        for _ in range(100):
            if task.id not in self._runners:
                break
            await asyncio.sleep(0.01)
        if task.id in self._runners:
            raise RuntimeError("Task is still finishing the current step")
        project = await self._run_db(project_id, lambda project: project)
        return await self._resume_in_project(
            project,
            task,
            workflow_run,
            steps_config,
        )

    async def _resume_in_project(
        self,
        project,
        task: Task,
        workflow_run: WorkflowRun,
        steps_config: dict,
    ) -> WorkflowRunHandle:
        """Resume downstream scheduling with the latest workflow."""
        if task.id in self._runners:
            raise RuntimeError(f"Task is already running: {task.id}")
        await self._run_db(project.id, lambda _project: heal_task_cwd(task, project))
        routing_state = normalize_routing_state(
            json.loads(workflow_run.routing_state_json)
            if workflow_run.routing_state_json else None
        )
        entry_step_key = (
            routing_state.get("entry_step_key")
            or workflow_run.restart_from_step_key
        )
        persisted_scope = routing_state.get("execution_scope")
        execution_scope = (
            {str(value) for value in persisted_scope}
            if isinstance(persisted_scope, list) else None
        )
        if entry_step_key and execution_scope is None:
            scheduler = DAGScheduler([
                Step.from_dict(item) for item in steps_config.get("steps", [])
            ])
            if entry_step_key in scheduler.steps:
                execution_scope = {
                    entry_step_key,
                    *scheduler.get_all_downstream(entry_step_key),
                }
        runner = TaskRunner(
            self._event_bus,
            dispatch_service=self._dispatch_service,
            source_project_id=project.id,
            database_executor=getattr(project, "database_executor", None),
            execution_scope=execution_scope,
            entry_step_key=entry_step_key,
        )
        self._runners[task.id] = runner
        self._register_lease(workflow_run.id, project.id)
        completion = asyncio.create_task(
            self._execute(
                project_id=project.id,
                task=task,
                runner=runner,
                workflow_run=workflow_run,
                steps_config=steps_config,
                artifacts_dir=Path(project.workstep_dir) / "artifacts",
                user_input="",
                execution_scope=execution_scope,
            ),
            name=f"workflow-run:{workflow_run.id}:resume",
        )
        self._active_tasks.add(completion)
        completion.add_done_callback(
            functools.partial(
                self._consume_completion,
                task_id=task.id,
                runner=runner,
                workflow_run=workflow_run,
            )
        )
        return WorkflowRunHandle(workflow_run.id, completion)

    async def recover_running_workflows(self) -> int:
        """Re-launch workflows interrupted by a daemon restart.

        Runs whose ``WorkflowRun`` is still marked ``running`` are treated as
        interrupted: stale in-flight steps are failed and re-scheduled, and the
        DAG continues from the last completed node using the persisted
        workflow snapshot. Returns the number of recovered runs.
        """
        recovered = 0
        for project in self._project_manager.iter_projects():
            try:
                recovered += await self._recover_project_runs(project)
            except Exception:
                logger.exception(
                    "Failed to recover interrupted workflows for project %s",
                    project.id,
                )
        return recovered

    async def reconcile_orphaned_workflows(self) -> int:
        """Recover persisted running workflows that have no in-memory runner.

        Unlike startup recovery, this periodic path does not schedule one
        timer per fresh peer lease. It simply rechecks on the next sweep.
        Active tasks owned by this runtime are excluded by the shared recovery
        preparation logic.
        """
        recovered = 0
        for project in self._project_manager.iter_projects():
            try:
                recovered += await self._recover_project_runs(
                    project,
                    schedule_contended=False,
                )
            except Exception:
                logger.exception(
                    "Failed to reconcile orphaned workflows for project %s",
                    project.id,
                )
        return recovered

    async def requeue_queued_tasks(self) -> int:
        """Re-register tasks left in ``queued`` by a previous daemon run.

        After a restart the in-memory gate is empty, so tasks persisted as
        ``queued`` are re-acquired and wait again (FIFO) for a free slot.
        Returns the number of re-queued tasks.
        """
        from services.concurrency import GRANTED, QUEUED, concurrency_gate

        count = 0
        for project in self._project_manager.iter_projects():
            rows = await self._run_db(
                project.id,
                lambda _p: list(
                    Task.select(Task.id).where(Task.status == "queued").dicts()
                ),
            )
            for row in rows:
                task_id = row["id"]
                acquired = await concurrency_gate.acquire_task(
                    project.id, task_id, "manual"
                )
                if acquired == GRANTED:
                    completion = asyncio.create_task(
                        self._start_after_slot(project.id, task_id),
                        name=f"workflow-requeue-start:{task_id}",
                    )
                elif acquired == QUEUED:
                    completion = asyncio.create_task(
                        self._wait_and_start(project.id, task_id),
                        name=f"workflow-requeue:{task_id}",
                    )
                else:
                    continue
                self._active_tasks.add(completion)
                completion.add_done_callback(self._active_tasks.discard)
                count += 1
        return count

    async def _wait_and_start(self, project_id: str, task_id: str) -> None:
        """Wait for a re-acquired slot, then launch the queued task."""
        from services.concurrency import concurrency_gate

        try:
            await concurrency_gate.wait_task_slot(project_id, task_id)
        except asyncio.CancelledError:
            concurrency_gate.cancel_queued_task(project_id, task_id)
            await self._mark_task_status(project_id, task_id, "ready")
            raise
        try:
            await self._start_after_slot(project_id, task_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Failed to start requeued task %s", task_id)

    async def _recover_project_runs(
        self,
        project,
        *,
        schedule_contended: bool = True,
    ) -> int:
        active_task_ids = frozenset(self._runners)
        decision = await self._run_db(
            project.id,
            lambda _project: prepare_project_recovery(
                project,
                active_task_ids=active_task_ids,
                owner_id=self._instance_id,
                current_workflow_steps=self._current_workflow_steps,
            ),
        )
        if schedule_contended:
            for run_id in decision.contended_run_ids:
                self._schedule_recovery_retry(project, run_id)
        recovered = 0
        for candidate in decision.runs:
            task, workflow_run = await self._run_db(
                project.id,
                lambda _project: (
                    Task.get_by_id(candidate.task_id),
                    WorkflowRun.get_by_id(candidate.run_id),
                ),
            )
            try:
                await self._resume_in_project(
                    project,
                    task,
                    workflow_run,
                    candidate.steps_config,
                )
            except RuntimeError:
                logger.warning(
                    "Skipping recovery of run %s (task %s already active)",
                    workflow_run.id,
                    task.id,
                )
                continue
            recovered_event = {
                "task_id": task.id,
                "step_key": next(iter(candidate.step_keys), None),
                "type": "run_recovered",
                "data": {
                    "task_id": task.id,
                    "workflow_run_id": workflow_run.id,
                    "recovered_at": candidate.recovered_at,
                    "recovered_count": candidate.recovered_count,
                },
            }
            ctx = AGUIContext.from_event(recovered_event)
            for agui_event in to_agui_events(recovered_event, ctx):
                await self._event_bus.publish(agui_event)
            recovered += 1
        return recovered

    def _current_workflow_steps(self, project, task: Task) -> dict:
        """Return the project's latest workflow steps for ``task``.

        A step restart always reads the workflow as it is right now, so edits
        made to the flow (such as switching a step's engine) take effect on
        the next run instead of being frozen into the parent run's snapshot.
        """
        workflow_data = project.steps
        if task.workflow_id:
            selected_workflow = project.workflow_by_id(task.workflow_id)
            if selected_workflow is None:
                raise ValueError(f"Workflow not found: {task.workflow_id}")
            workflow_data = selected_workflow["steps"]
        merged = deepcopy(workflow_data)
        is_nodes = bool(merged.get("nodes"))
        raw_steps = merged.get("nodes") or merged.get("steps") or []
        by_key = {
            str(
                (item.get("type") or item.get("key") or item.get("id"))
                if is_nodes
                else (item.get("key") or item.get("id") or item.get("type"))
                or ""
            ): item
            for item in raw_steps
        }
        for row in TaskStep.select().where(TaskStep.task == task):
            if not row.execution_config_json or row.step_key not in by_key:
                continue
            try:
                override = json.loads(row.execution_config_json)
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(override, dict):
                continue
            target = by_key[row.step_key]
            target["engine"] = str(override.get("engine") or target.get("engine") or "")
            target["model"] = str(override.get("model") or "")
            target["config"] = dict(override.get("config") or {})
        return merged

    async def get_step_execution_config(
        self, project_id: str, task_id: str, step_key: str,
    ) -> dict:
        return await self._step_config.get(project_id, task_id, step_key)

    async def update_step_execution_config(
        self,
        project_id: str,
        task_id: str,
        step_key: str,
        *,
        engine: str,
        model: str | None,
        config: dict[str, str],
        context_mode: str | None = None,
    ) -> dict:
        return await self._step_config.update(
            project_id, task_id, step_key,
            engine=engine, model=model, config=config, context_mode=context_mode,
        )

    async def reset_step_execution_config(
        self, project_id: str, task_id: str, step_key: str,
    ) -> dict:
        return await self._step_config.reset(project_id, task_id, step_key)

    async def restart_from_step(
        self,
        project_id: str,
        task_id: str,
        step_key: str,
        *,
        expected_run_id: str | None = None,
        step_followup: str | None = None,
        trigger_name: str | None = None,
        input_rounds: dict[str, int] | None = None,
        reset_session: bool = False,
        expected_failed_message_id: str | None = None,
    ) -> WorkflowRunHandle:
        """Stop the current runner and start a child run from one DAG step.

        The child run is built from the workflow's current definition so that
        edits made to the flow (e.g. changing a step's engine) are picked up
        on re-run; the parent run's snapshot is kept only as a historical
        record.
        """
        lock = self._operation_locks.setdefault(task_id, asyncio.Lock())
        async with lock:
            active_runner = task_id in self._runners
            def inspect_restart(project):
                task = Task.get_or_none(Task.id == task_id)
                if task is None:
                    raise ValueError(f"Task not found: {task_id}")
                feedback_inputs = self._validate_input_rounds(
                    project,
                    task,
                    step_key,
                    input_rounds,
                )
                parent_run_id = expected_run_id or task.active_workflow_run_id
                if not parent_run_id:
                    return {"without_parent": True, "feedback_inputs": feedback_inputs}
                parent = WorkflowRun.get_or_none(
                    (WorkflowRun.id == parent_run_id)
                    & (WorkflowRun.task == task)
                )
                if parent is None:
                    raise RuntimeError("The referenced workflow run no longer exists")
                if expected_run_id and task.active_workflow_run_id != expected_run_id:
                    raise RuntimeError("The active workflow run has changed")
                if expected_failed_message_id:
                    retry_step_key, retry_run_id = inspect_failed_message_retry(
                        task_id, expected_failed_message_id, active_runner,
                    )
                    if retry_step_key != step_key or retry_run_id != parent_run_id:
                        raise ValueError("失败消息已不属于当前阶段")
                # Re-run from the workflow as it is now, not the parent run's
                # snapshot, so flow edits (e.g. engine changes) apply.
                workflow_data = self._current_workflow_steps(project, task)
                compiled = WorkflowDefinition.load(workflow_data).compile()
                steps_config = compiled.to_steps_config()
                step_list = [Step.from_dict(item) for item in steps_config["steps"]]
                scheduler = DAGScheduler(step_list)
                if step_key not in scheduler.steps:
                    raise ValueError(f"Step does not exist: {step_key}")
                affected = {step_key, *scheduler.get_all_downstream(step_key)}
                return {
                    "without_parent": False,
                    "parent_run_id": parent_run_id,
                    "compiled": compiled,
                    "steps_config": steps_config,
                    "affected": affected,
                    "feedback_inputs": feedback_inputs,
                }

            inspected = await self._run_db(project_id, inspect_restart)
            if inspected["without_parent"]:
                return await self._start_from_step_without_parent_async(
                    project_id,
                    task_id,
                    step_key,
                    step_followup=step_followup,
                    trigger_name=trigger_name,
                    input_rounds=input_rounds,
                    feedback_inputs=inspected["feedback_inputs"],
                    reset_session=reset_session,
                )
            parent_run_id = inspected["parent_run_id"]
            compiled = inspected["compiled"]
            steps_config = inspected["steps_config"]
            affected = inspected["affected"]
            runner = self._runners.get(task_id)
            if runner is not None:
                await runner.cancel_task(task_id)
                for _ in range(500):
                    if task_id not in self._runners:
                        break
                    await asyncio.sleep(0.01)
                if task_id in self._runners:
                    raise RuntimeError("Task runner did not stop in time")

            def persist_restart(project):
                task = Task.get_by_id(task_id)
                heal_task_cwd(task, project)
                parent = WorkflowRun.get_by_id(parent_run_id)
                execution_keys = affected
                task, child = create_restart_run(
                    task,
                    parent,
                    compiled.schema_version,
                    step_key,
                    execution_keys,
                    instance_id=self._instance_id,
                    reset_session_step_key=(step_key if reset_session else None),
                    feedback_inputs=inspected["feedback_inputs"],
                )
                return _PreparedWorkflowRun(
                    project_id=project.id,
                    database_executor=getattr(project, "database_executor", None),
                    task=task,
                    workflow_run=child,
                    steps_config=steps_config,
                    artifacts_dir=Path(project.workstep_dir) / "artifacts",
                    user_message=None,
                    entry_step_key=step_key,
                    execution_scope=frozenset(affected),
                )

            prepared = await self._run_db(project_id, persist_restart)
            return self._launch_prepared_run(
                prepared,
                "",
                {step_key: step_followup} if step_followup else None,
                {step_key: input_rounds} if input_rounds else None,
                execution_scope=affected,
                entry_step_key=step_key,
                step_trigger_names=(
                    {step_key: trigger_name} if trigger_name else None
                ),
                retry_message_ids=(
                    {step_key: expected_failed_message_id}
                    if expected_failed_message_id else None
                ),
            )

    def _validate_input_rounds(
        self,
        project,
        task: Task,
        step_key: str,
        input_rounds: dict[str, int] | None,
    ) -> dict[str, dict]:
        """Validate explicit upstream artifact rounds before starting a run."""
        if not input_rounds:
            return {}
        workflow_data = self._current_workflow_steps(project, task)
        steps_config = WorkflowDefinition.load(workflow_data).compile().to_steps_config()
        step_list = [Step.from_dict(item) for item in steps_config["steps"]]
        scheduler = DAGScheduler(step_list)
        if step_key not in scheduler.steps:
            raise ValueError(f"Step does not exist: {step_key}")
        dependencies = set(scheduler.steps[step_key].depends_on)
        feedback_connections = {}
        for connection in scheduler.steps[step_key].incoming_connections:
            if connection.get("kind") == "dashed":
                feedback_connections.setdefault(str(connection.get("from")), []).append(
                    connection
                )
        artifacts_root = Path(project.workstep_dir) / "artifacts"
        feedback_inputs: dict[str, dict] = {}
        for dep_key, requested_round in input_rounds.items():
            if dep_key not in dependencies and dep_key not in feedback_connections:
                raise ValueError(
                    f"产物轮次 {dep_key} 不是目标步骤 {step_key} 的输入来源"
                )
            rounds = iter_artifact_rounds(
                artifacts_root,
                task.workflow_id,
                task.id,
                dep_key,
            )
            selected = next(
                (item for item in rounds if item.round == int(requested_round)),
                None,
            )
            if selected is None or not selected.eligible_for_downstream:
                raise ValueError(
                    f"产物轮次 {dep_key} 第 {requested_round} 轮不可沿用"
                )
            if dep_key in feedback_connections:
                for connection in feedback_connections[dep_key]:
                    source = source_for_connection(
                        connection, selected, connection.get("output")
                    )
                    if source is not None:
                        feedback_inputs[str(connection.get("id"))] = source
                if not any(
                    str(connection.get("id")) in feedback_inputs
                    for connection in feedback_connections[dep_key]
                ):
                    raise ValueError(
                        f"产物轮次 {dep_key} 第 {requested_round} 轮没有可用的返工产物"
                    )
        return feedback_inputs

    async def _start_from_step_without_parent_async(
        self,
        project_id: str,
        task_id: str,
        step_key: str,
        step_followup: str | None = None,
        trigger_name: str | None = None,
        input_rounds: dict[str, int] | None = None,
        feedback_inputs: dict[str, dict] | None = None,
        reset_session: bool = False,
    ) -> WorkflowRunHandle:
        prepared = await self._run_db(
            project_id,
            lambda project: self._prepare_start_from_step_without_parent(
                project,
                task_id,
                step_key,
                reset_session=reset_session,
                feedback_inputs=feedback_inputs,
            ),
        )
        return self._launch_prepared_run(
            prepared,
            "",
            step_followups={step_key: step_followup} if step_followup else None,
            input_rounds_by_step={step_key: input_rounds} if input_rounds else None,
            execution_scope=(
                set(prepared.execution_scope)
                if prepared.execution_scope is not None else None
            ),
            entry_step_key=prepared.entry_step_key,
            step_trigger_names={step_key: trigger_name} if trigger_name else None,
        )

    def _prepare_start_from_step_without_parent(
        self,
        project,
        task_id: str,
        step_key: str,
        *,
        reset_session: bool = False,
        feedback_inputs: dict[str, dict] | None = None,
    ) -> _PreparedWorkflowRun:
        task = Task.get_by_id(task_id)
        heal_task_cwd(task, project)
        workflow_data = self._current_workflow_steps(project, task)
        compiled = WorkflowDefinition.load(workflow_data).compile()
        steps_config = compiled.to_steps_config()
        scheduler = DAGScheduler([
            Step.from_dict(item) for item in steps_config["steps"]
        ])
        if step_key not in scheduler.steps:
            raise ValueError(f"Step does not exist: {step_key}")
        execution_keys = {step_key, *scheduler.get_all_downstream(step_key)}
        reusable_keys = {
            row.step_key
            for row in TaskStep.select().where(
                (TaskStep.task == task)
                & (TaskStep.status == "passed")
                & (~(TaskStep.step_key.in_(execution_keys)))
            )
            if row.step_key in scheduler.steps
        }

        with db_proxy.atomic():
            TaskStep.update(
                status="pending",
                started_at=None,
                ended_at=None,
                error=None,
            ).where(
                (TaskStep.task == task)
                & (TaskStep.step_key.in_(execution_keys))
            ).execute()
            TaskStep.update(
                status="skipped",
                started_at=None,
                ended_at=None,
                error=None,
            ).where(
                (TaskStep.task == task)
                & (~(TaskStep.step_key.in_(execution_keys)))
                & (TaskStep.status != "passed")
            ).execute()
            task.status = "ready"
            task.updated_at = utc_now()
            task.save()

        prepared = self._prepare_start_in_project(project, task.id, "")
        now = utc_now()
        workflow_run = prepared.workflow_run
        workflow_run.restart_from_step_key = step_key
        routing_state = normalize_routing_state(
            json.loads(workflow_run.routing_state_json)
            if workflow_run.routing_state_json else None
        )
        routing_state["entry_step_key"] = step_key
        routing_state["execution_scope"] = sorted(execution_keys)
        if feedback_inputs:
            routing_state["feedback_inputs"][step_key] = feedback_inputs
            routing_state["active_edges"] = sorted(
                set(routing_state["active_edges"]) | set(feedback_inputs)
            )
        workflow_run.routing_state_json = json.dumps(
            routing_state,
            ensure_ascii=False,
        )
        workflow_run.save(only=[
            WorkflowRun.restart_from_step_key,
            WorkflowRun.routing_state_json,
        ])
        if reset_session:
            TaskStep.update(
                session_id=None,
                session_provider=None,
                pending_handoff_json=None,
            ).where(
                (TaskStep.task == task)
                & (TaskStep.step_key == step_key)
            ).execute()
        prepared = _PreparedWorkflowRun(
            project_id=prepared.project_id,
            database_executor=prepared.database_executor,
            task=prepared.task,
            workflow_run=prepared.workflow_run,
            steps_config=prepared.steps_config,
            artifacts_dir=prepared.artifacts_dir,
            user_message=prepared.user_message,
            entry_step_key=step_key,
            execution_scope=frozenset(execution_keys),
        )
        for reusable_key in reusable_keys:
            step = scheduler.steps[reusable_key]
            StepRun.create(
                id=str(uuid.uuid4()),
                run=workflow_run,
                step_key=reusable_key,
                attempt=1,
                status="reused",
                engine=step.engine,
                model=step.model or None,
                started_at=now,
                ended_at=now,
            )
        return prepared

    def _register_lease(self, run_id: str, project_id: str) -> None:
        """Record that this instance owns a run and start the heartbeat loop."""
        self._leased_runs[run_id] = project_id
        self._ensure_lease_task()

    def _release_lease(self, run_id: str) -> None:
        self._leased_runs.pop(run_id, None)

    def _ensure_lease_task(self) -> None:
        if self._lease_task is None or self._lease_task.done():
            self._lease_task = asyncio.create_task(self._lease_heartbeat_loop())

    def _schedule_recovery_retry(self, project, run_id: str) -> None:
        """Retry a run skipped by a live lease after the lease should expire.

        Without this, a daemon that restarts within the stale window of a
        genuinely crashed predecessor would orphan the run forever, since
        startup recovery only sweeps once.
        """

        async def _retry():
            try:
                await asyncio.sleep(RUN_LEASE_STALE_SECONDS)
                current = await self._run_db(
                    project.id, lambda _project: project
                )
                await self._recover_project_runs(current)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "Deferred recovery retry failed for run %s", run_id
                )

        task = asyncio.create_task(
            _retry(), name=f"workflow-lease-retry:{run_id}"
        )
        self._lease_retry_tasks.add(task)
        task.add_done_callback(self._lease_retry_tasks.discard)

    async def _lease_heartbeat_loop(self) -> None:
        """Periodically renew this instance's run leases via the project DB."""
        while True:
            try:
                await asyncio.sleep(RUN_LEASE_HEARTBEAT_SECONDS)
            except asyncio.CancelledError:
                raise
            loop_now = asyncio.get_running_loop().time()
            if (
                loop_now - self._last_orphan_reconcile
                >= ORPHAN_RECONCILE_SECONDS
            ):
                self._last_orphan_reconcile = loop_now
                try:
                    await self.reconcile_orphaned_workflows()
                except Exception:
                    logger.exception("Failed to run workflow orphan reconciliation")
            leased = dict(self._leased_runs)
            if not leased:
                continue
            by_project: dict[str, list[str]] = {}
            for run_id, project_id in leased.items():
                by_project.setdefault(project_id, []).append(run_id)
            for project_id, run_ids in by_project.items():
                def refresh(_project, run_ids=tuple(run_ids)):
                    WorkflowRun.update(heartbeat_at=utc_now()).where(
                        (WorkflowRun.id.in_(run_ids))
                        & (WorkflowRun.owner_id == self._instance_id)
                    ).execute()

                try:
                    await self._run_db(project_id, refresh)
                except Exception:
                    logger.exception(
                        "Failed to renew run leases for project %s", project_id
                    )

    async def shutdown(self) -> None:
        """Stop every workflow owned by this runtime.

        A graceful shutdown stops engine subprocesses but leaves ``running``
        runs marked ``running`` so the next daemon start resumes them from the
        last completed node (see :meth:`recover_running_workflows`).
        """
        self._graceful_shutdown = True
        runners = tuple(self._runners.items())
        if runners:
            await asyncio.gather(
                *(
                    runner.stop_for_shutdown()
                    for task_id, runner in runners
                ),
                return_exceptions=True,
            )
        active = tuple(self._active_tasks)
        for completion in active:
            completion.cancel()
        if active:
            await asyncio.gather(*active, return_exceptions=True)
        # Stop the heartbeat loop and release any leases that outlived the runs
        # so a restarting daemon can recover them immediately.
        if self._lease_task is not None:
            self._lease_task.cancel()
            try:
                await self._lease_task
            except asyncio.CancelledError:
                pass
            self._lease_task = None
        for retry_task in tuple(self._lease_retry_tasks):
            retry_task.cancel()
        self._lease_retry_tasks.clear()
        self._leased_runs.clear()

    def _consume_completion(
        self,
        completion: asyncio.Task[str],
        *,
        task_id: str,
        runner: TaskRunner,
        workflow_run: WorkflowRun,
    ) -> None:
        """Retire a task and retrieve its outcome for fire-and-forget callers."""
        self._active_tasks.discard(completion)
        if not completion.cancelled():
            completion.exception()
        if self._runners.get(task_id) is runner:
            self._runners.pop(task_id, None)

    async def _execute(
        self,
        *,
        project_id: str,
        task: Task,
        runner: TaskRunner,
        workflow_run: WorkflowRun,
        steps_config: dict,
        artifacts_dir: Path,
        user_input: str,
        execution_scope: set[str] | None = None,
    ) -> str:
        interrupted = False
        try:
            await runner.run_pipeline(
                task=task,
                steps_config=steps_config,
                artifacts_dir=artifacts_dir,
                user_input=user_input,
                workflow_run=workflow_run,
                execution_scope=execution_scope,
            )
        except asyncio.CancelledError:
            interrupted = True
            if not self._graceful_shutdown:
                workflow_run.status = "failed"
            raise
        except Exception:
            workflow_run.status = "failed"
            raise
        else:
            def resolve_run_status():
                latest_task = Task.get_by_id(task.id)
                if latest_task.status == "ready":
                    workflow_run.status = "succeeded"
                elif latest_task.status == "paused" and TaskStep.select().where(
                    (TaskStep.task == latest_task)
                    & (TaskStep.status.in_(
                        ["awaiting_review", "rejected", "retrying"]
                    ))
                ).exists():
                    workflow_run.status = "paused"
                else:
                    workflow_run.status = "failed"

            await runner._run_db(resolve_run_status)
        finally:
            def finalize_run():
                if not (interrupted and self._graceful_shutdown):
                    workflow_run.ended_at = utc_now()
                # 释放租约：把 owner/heartbeat 写回 NULL，让后续实例可正常接管或收尾。
                workflow_run.owner_id = None
                workflow_run.heartbeat_at = None
                workflow_run.save()

            await runner._run_db(finalize_run)
            self._release_lease(workflow_run.id)
            try:
                await runner.close()
            except Exception:
                logger.exception("Failed to close event journal for task %s", task.id)
            if self._runners.get(task.id) is runner:
                self._runners.pop(task.id, None)
            from services.concurrency import concurrency_gate

            # Recovered/resumed runs never acquired a slot, so this discard is
            # a no-op for them.
            try:
                await concurrency_gate.release_task(project_id, task.id)
            except Exception:
                logger.exception("Failed to release task slot for %s", task.id)
            if not (interrupted and self._graceful_shutdown):
                await self._consume_task_pending_inserts(project_id, task.id)

        return workflow_run.id

    async def cancel(self, task_id: str) -> bool:
        """Cancel every active step owned by a task's pipeline.

        A task that is still waiting for a concurrency slot (status ``queued``)
        is removed from the queue and returned to ``ready`` instead.
        """
        runner = self._runners.get(task_id)
        if runner is None:
            async_finder = getattr(
                self._project_manager, "find_project_for_task_async", None
            )
            project = (
                await async_finder(task_id)
                if async_finder is not None
                else await asyncio.to_thread(
                    self._project_manager.find_project_for_task, task_id
                )
            )
            if project is not None:
                if await self.cancel_queued(project.id, task_id):
                    return True

                active_step_keys = await self._run_db(
                    project.id,
                    lambda _project: [
                        row.step_key
                        for row in TaskStep.select().where(
                            (TaskStep.task == task_id)
                            & (TaskStep.status.in_([
                                *_ACTIVE_STEP_CONFIG_STATUSES,
                                "reviewing",
                                "rework_waiting",
                            ]))
                        )
                    ],
                )
                stopped = False
                for step_key in active_step_keys:
                    stopped = (
                        await self.cancel_step(project.id, task_id, step_key)
                        or stopped
                    )
                return stopped
            return False
        return await runner.cancel_task(task_id)
