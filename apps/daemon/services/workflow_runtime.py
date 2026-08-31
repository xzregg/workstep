"""Production entry point for executing a saved workflow."""

import asyncio
import functools
import json
import logging
import uuid
from dataclasses import dataclass, field
from pathlib import Path

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
from models.base import db_proxy
from services.task_runner import TaskRunner
from services.task_dispatch import TaskDispatchService
from services.workflow_definition import WorkflowDefinition
from services.messages import create_task_message, new_message_id
from services.intervention import seal_unanswered_interactions
from agent_assistants.event_journal import TurnEventJournal
from services.pipeline import DAGScheduler, Step
from engines.core.agui import AGUIContext, to_agui_events
from streaming.bus import EventBus

logger = logging.getLogger(__name__)


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


class WorkflowRuntime:
    """Run project workflows behind one small interface."""

    def __init__(self, event_bus: EventBus, project_manager):
        self._event_bus = event_bus
        self._project_manager = project_manager
        self._runners: dict[str, TaskRunner] = {}
        self._active_tasks: set[asyncio.Task[str]] = set()
        self._operation_locks: dict[str, asyncio.Lock] = {}
        self._graceful_shutdown = False
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
    ) -> WorkflowRunHandle:
        """Start a saved workflow and return its stable background handle."""
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

        workflow_data = project.steps
        if task.workflow_id:
            selected_workflow = project.workflow_by_id(task.workflow_id)
            if selected_workflow is None:
                raise ValueError(f"Workflow not found: {task.workflow_id}")
            workflow_data = selected_workflow["steps"]
        workflow = WorkflowDefinition.load(workflow_data)
        compiled = workflow.compile()
        steps_config = compiled.to_steps_config()
        now = utc_now()
        workflow_run = WorkflowRun.create(
            id=str(uuid.uuid4()),
            task=task,
            status="running",
            workflow_schema_version=compiled.schema_version,
            workflow_snapshot_json=json.dumps(
                workflow_data,
                ensure_ascii=False,
                sort_keys=True,
            ),
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
        )

    def _launch_prepared_run(
        self,
        prepared: _PreparedWorkflowRun,
        user_input: str,
    ) -> WorkflowRunHandle:
        """Attach prepared persistent state to event-loop-owned runtime state."""
        task = prepared.task
        workflow_run = prepared.workflow_run
        runner = TaskRunner(
            self._event_bus,
            dispatch_service=self._dispatch_service,
            source_project_id=prepared.project_id,
            database_executor=prepared.database_executor,
        )
        self._runners[task.id] = runner

        completion = asyncio.create_task(
            self._execute(
                task=task,
                runner=runner,
                workflow_run=workflow_run,
                steps_config=prepared.steps_config,
                artifacts_dir=prepared.artifacts_dir,
                user_input=user_input,
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

    async def send_stage_message(
        self,
        project_id: str,
        task_id: str,
        step_key: str,
        content: str,
        as_guidance: bool = False,
    ) -> dict:
        """Inject an ordinary user message into a running stage."""
        runner = self._runners.get(task_id)
        if runner is None:
            raise ValueError("任务没有正在执行的阶段")
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
        """Stop a running stage engine."""
        runner = self._runners.get(task_id)
        if runner is None:
            raise ValueError("任务没有正在执行的阶段")
        return await runner.cancel_step(task_id, step_key)

    async def resume_stage_with_message(
        self,
        project_id: str,
        task_id: str,
        step_key: str,
        content: str,
    ) -> dict:
        """Persist a user message for a stopped or review-waiting stage.

        The message is stored in the stage's execution history (and as active
        stage guidance) so the next attempt carries it into the stage LLM,
        then the stage plus its downstream is restarted from ``step_key``. A
        pending manual review is skipped because the new message supersedes
        the output that review was asking the user to accept.
        """
        normalized = content.strip()
        if not normalized:
            raise ValueError("消息内容不能为空")
        def persist_message():
            task = Task.get_or_none(Task.id == task_id)
            if task is None:
                raise ValueError(f"Task not found: {task_id}")
            step = TaskStep.get_or_none(
                (TaskStep.task == task) & (TaskStep.step_key == step_key)
            )
            if step is None:
                raise ValueError(f"Stage does not exist: {step_key}")
            if step.status not in (
                "cancelled",
                "failed",
                "rejected",
                "awaiting_review",
            ):
                raise ValueError(
                    f"阶段未停止: {step_key}（当前状态 {step.status}）"
                )
            pending_review = None
            if step.status == "awaiting_review":
                pending_review = (
                    ReviewRun.select()
                    .where(
                        (ReviewRun.task == task)
                        & (ReviewRun.step_key == step_key)
                    )
                    .order_by(ReviewRun.started_at.desc(), ReviewRun.id.desc())
                    .first()
                )
                if (
                    pending_review is None
                    or pending_review.mode != "manual"
                    or pending_review.status != "pending"
                ):
                    raise ValueError("阶段没有可跳过的人工审核")
            now = utc_now()
            message_id = new_message_id()
            user_message = create_task_message(
                id=message_id,
                task=task,
                channel="execution",
                step_key=step_key,
                role="user",
                content=normalized,
                run_id=message_id,
                run_status="completed",
                position=0,
                started_at=now,
                ended_at=now,
                created_at=now,
            )
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
            return user_message, pending_review.id if pending_review else None

        user_message, pending_review_id = await self._run_db(
            project_id, lambda _project: persist_message()
        )
        message_id = user_message.id
        handle = await self.restart_from_stage(project_id, task_id, step_key)
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
            if review is None or review.status != "pending":
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
    ) -> WorkflowRunHandle | None:
        """Persist a manual decision and resume the same workflow when approved."""
        decision_data = await self._run_db(
            project_id,
            lambda _project: self._persist_review_decision_sync(
                task_id, step_key, review_run_id, decision, comment
            ),
        )
        if decision_data is None:
            return None
        task, workflow_run = decision_data
        for _ in range(100):
            if task.id not in self._runners:
                break
            await asyncio.sleep(0.01)
        if task.id in self._runners:
            raise RuntimeError("Task is still finishing the current stage")
        project = await self._run_db(project_id, lambda project: project)
        return self._resume_in_project(project, task, workflow_run)

    def _persist_review_decision_sync(
        self, task_id, step_key, review_run_id, decision, comment
    ):
        review = ReviewRun.get_or_none(ReviewRun.id == review_run_id)
        if (
            review is None
            or review.task_id != task_id
            or review.step_key != step_key
        ):
            raise ValueError("Review not found for the requested task step")
        if review.status == "skipped":
            raise RuntimeError("Review has been skipped by a newer stage message")
        latest = (
            ReviewRun.select()
            .where(
                (ReviewRun.task == task_id)
                & (ReviewRun.step_key == step_key)
            )
            .order_by(ReviewRun.started_at.desc(), ReviewRun.id.desc())
            .first()
        )
        if latest is None or latest.id != review.id:
            raise RuntimeError("Review has been superseded by a newer attempt")
        if review.decision:
            if review.decision == decision:
                return None
            raise RuntimeError("Review already has a different decision")

        now = utc_now()
        approved = decision in {"approve", "force_approve"}
        review.decision = decision
        review.decision_comment = comment
        review.decided_at = now
        review.ended_at = review.ended_at or now
        review.status = "passed" if approved else "rejected"
        review.save()

        # 人工审核完成后，同步审核消息的结束时间，前端据此显示审核耗时。
        Message.update(
            ended_at=review.ended_at,
            run_status="completed",
        ).where(
            (Message.task == task_id)
            & (Message.channel == "review")
            & (Message.step_key == step_key)
            & (Message.ended_at.is_null())
        ).execute()

        task_step = TaskStep.get(
            (TaskStep.task == task_id) & (TaskStep.step_key == step_key)
        )
        if approved:
            task_step.status = "passed"
            task_step.error = None
            task_step.ended_at = now
            task_step.review_feedback = None
        else:
            # 人工审核不通过：保存原因，带反馈自动重跑当前阶段。
            task_step.status = "retrying"
            task_step.error = comment or "用户驳回审核"
            task_step.review_feedback = comment or ""
            task_step.ended_at = None
        task_step.save()
        task = Task.get_by_id(task_id)
        task.status = "running"
        task.state_version += 1
        task.updated_at = now
        task.save()
        workflow_run = review.workflow_run
        workflow_run.status = "running"
        workflow_run.ended_at = None
        workflow_run.save()
        return task, workflow_run

    def _resume_in_project(
        self,
        project,
        task: Task,
        workflow_run: WorkflowRun,
    ) -> WorkflowRunHandle:
        """Resume downstream scheduling from persisted review state."""
        if task.id in self._runners:
            raise RuntimeError(f"Task is already running: {task.id}")
        snapshot = json.loads(workflow_run.workflow_snapshot_json)
        compiled = WorkflowDefinition.load(snapshot).compile()
        runner = TaskRunner(
            self._event_bus,
            dispatch_service=self._dispatch_service,
            source_project_id=project.id,
            database_executor=getattr(project, "database_executor", None),
        )
        self._runners[task.id] = runner
        completion = asyncio.create_task(
            self._execute(
                task=task,
                runner=runner,
                workflow_run=workflow_run,
                steps_config=compiled.to_steps_config(),
                artifacts_dir=Path(project.workstep_dir) / "artifacts",
                user_input="",
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

    async def _recover_project_runs(self, project) -> int:
        prepared = await self._run_db(
            project.id,
            lambda _project: self._prepare_project_recovery_sync(project),
        )
        recovered = 0
        for task, workflow_run, stale_keys, now in prepared:
            try:
                self._resume_in_project(project, task, workflow_run)
            except RuntimeError:
                logger.warning(
                    "Skipping recovery of run %s (task %s already active)",
                    workflow_run.id,
                    task.id,
                )
                continue
            recovered_event = {
                "task_id": task.id,
                "step_key": next(iter(stale_keys), None),
                "type": "run_recovered",
                "data": {
                    "task_id": task.id,
                    "workflow_run_id": workflow_run.id,
                    "recovered_at": now,
                    "recovered_count": workflow_run.recovered_count,
                },
            }
            ctx = AGUIContext.from_event(recovered_event)
            for agui_event in to_agui_events(recovered_event, ctx):
                await self._event_bus.publish(agui_event)
            recovered += 1
        return recovered

    def _prepare_project_recovery_sync(self, project):
        prepared = []
        interrupted = list(
            WorkflowRun.select().where(WorkflowRun.status == "running")
        )
        for workflow_run in interrupted:
            task = Task.get_by_id(workflow_run.task_id)
            if task.id in self._runners:
                continue
            now = utc_now()
            stale_keys = set()
            for step_run in StepRun.select().where(
                (StepRun.run == workflow_run)
                & (StepRun.status == "running")
            ):
                step_run.status = "failed"
                step_run.error = "进程重启中断，等待自动恢复"
                step_run.ended_at = now
                step_run.save()
                stale_keys.add(step_run.step_key)
            for ts in TaskStep.select().where(
                (TaskStep.task == task) & (TaskStep.status == "running")
            ):
                ts.status = "pending"
                ts.ended_at = None
                ts.error = None
                ts.save()
                stale_keys.add(ts.step_key)
            if stale_keys:
                # Close in-flight execution messages so the UI does not keep
                # an eternally-running spinner for the interrupted attempt.
                stale_messages = Message.select().where(
                    (Message.task == task)
                    & (Message.channel == "execution")
                    & (Message.run_status == "running")
                    & (Message.step_key.in_(stale_keys))
                )
                for stale_message in stale_messages:
                    stale_message.run_status = "failed"
                    stale_message.ended_at = now
                    if stale_message.event_log_path:
                        journal = TurnEventJournal()
                        ref = journal.reopen(
                            project.workstep_dir,
                            stale_message.event_log_path,
                        )
                        snapshot = journal.snapshot(ref)
                        summary_events = snapshot["events"]
                        sealed_json = seal_unanswered_interactions(
                            json.dumps(summary_events, ensure_ascii=False)
                        )
                        sealed_events = json.loads(sealed_json or "[]")
                        for response_event in sealed_events[len(summary_events):]:
                            journal.record(ref, response_event)
                        journal.finish(ref)
                        snapshot = journal.snapshot(ref)
                        stale_message.content = snapshot["content"]
                        stale_message.events_json = json.dumps(
                            snapshot["events"], ensure_ascii=False
                        ) if snapshot["events"] else None
                        stale_message.event_summary_json = json.dumps(
                            snapshot["summary"], ensure_ascii=False
                        )
                        stale_message.event_count = snapshot["summary"]["event_count"]
                        stale_message.last_event_seq = snapshot["summary"]["last_event_seq"]
                    else:
                        stale_message.events_json = seal_unanswered_interactions(
                            stale_message.events_json
                        )
                    stale_message.save()
            task.status = "running"
            task.updated_at = now
            task.save()
            workflow_run.recovered_at = now
            workflow_run.recovered_count = (
                workflow_run.recovered_count or 0
            ) + 1
            workflow_run.save()
            prepared.append((task, workflow_run, stale_keys, now))
        return prepared

    async def restart_from_stage(
        self,
        project_id: str,
        task_id: str,
        step_key: str,
        *,
        expected_run_id: str | None = None,
    ) -> WorkflowRunHandle:
        """Stop the current runner and start a child run from one DAG stage."""
        lock = self._operation_locks.setdefault(task_id, asyncio.Lock())
        async with lock:
            def inspect_restart(project):
                task = Task.get_or_none(Task.id == task_id)
                if task is None:
                    raise ValueError(f"Task not found: {task_id}")
                parent_run_id = expected_run_id or task.active_workflow_run_id
                if not parent_run_id:
                    return {"without_parent": True}
                parent = WorkflowRun.get_or_none(
                    (WorkflowRun.id == parent_run_id)
                    & (WorkflowRun.task == task)
                )
                if parent is None:
                    raise RuntimeError("The referenced workflow run no longer exists")
                if expected_run_id and task.active_workflow_run_id != expected_run_id:
                    raise RuntimeError("The active workflow run has changed")
                workflow_data = json.loads(parent.workflow_snapshot_json)
                compiled = WorkflowDefinition.load(workflow_data).compile()
                steps_config = compiled.to_steps_config()
                step_list = [Step.from_dict(item) for item in steps_config["steps"]]
                scheduler = DAGScheduler(step_list)
                if step_key not in scheduler.steps:
                    raise ValueError(f"Stage does not exist: {step_key}")
                affected = {step_key, *scheduler.get_all_downstream(step_key)}
                interrupted = {
                    row.step_key
                    for row in TaskStep.select().where(
                        (TaskStep.task == task)
                        & (
                            TaskStep.status.in_(
                                ["running", "reviewing", "retrying", "rework"]
                            )
                        )
                    )
                }
                return {
                    "without_parent": False,
                    "parent_run_id": parent_run_id,
                    "compiled": compiled,
                    "steps_config": steps_config,
                    "affected": affected,
                    "interrupted": interrupted,
                }

            inspected = await self._run_db(project_id, inspect_restart)
            if inspected["without_parent"]:
                return await self._start_from_stage_without_parent_async(
                    project_id, task_id, step_key
                )
            parent_run_id = inspected["parent_run_id"]
            compiled = inspected["compiled"]
            steps_config = inspected["steps_config"]
            affected = inspected["affected"]
            interrupted = inspected["interrupted"]

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
                parent = WorkflowRun.get_by_id(parent_run_id)
                execution_keys = affected | interrupted
                archived = self._archive_stage_artifacts(
                    project,
                    task,
                    parent,
                    execution_keys,
                )
                try:
                    task, child = self._create_restart_run(
                        task,
                        parent,
                        compiled.schema_version,
                        step_key,
                        execution_keys,
                    )
                except Exception:
                    self._restore_archived_artifacts(archived)
                    raise
                return _PreparedWorkflowRun(
                    project_id=project.id,
                    database_executor=getattr(project, "database_executor", None),
                    task=task,
                    workflow_run=child,
                    steps_config=steps_config,
                    artifacts_dir=Path(project.workstep_dir) / "artifacts",
                    user_message=None,
                )

            prepared = await self._run_db(project_id, persist_restart)
            return self._launch_prepared_run(prepared, "")

    async def _start_from_stage_without_parent_async(
        self,
        project_id: str,
        task_id: str,
        step_key: str,
    ) -> WorkflowRunHandle:
        prepared = await self._run_db(
            project_id,
            lambda project: self._prepare_start_from_stage_without_parent(
                project, task_id, step_key
            ),
        )
        return self._launch_prepared_run(prepared, "")

    def _prepare_start_from_stage_without_parent(
        self,
        project,
        task_id: str,
        step_key: str,
    ) -> _PreparedWorkflowRun:
        task = Task.get_by_id(task_id)
        workflow_data = project.steps
        if task.workflow_id:
            selected_workflow = project.workflow_by_id(task.workflow_id)
            if selected_workflow is None:
                raise ValueError(f"Workflow not found: {task.workflow_id}")
            workflow_data = selected_workflow["steps"]
        compiled = WorkflowDefinition.load(workflow_data).compile()
        steps_config = compiled.to_steps_config()
        scheduler = DAGScheduler([
            Step.from_dict(item) for item in steps_config["steps"]
        ])
        if step_key not in scheduler.steps:
            raise ValueError(f"Stage does not exist: {step_key}")
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
        workflow_run.save(only=[WorkflowRun.restart_from_step_key])
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

    def _create_restart_run(
        self,
        task: Task,
        parent: WorkflowRun,
        schema_version: int,
        step_key: str,
        execution_keys: set[str],
    ) -> tuple[Task, WorkflowRun]:
        now = utc_now()
        with db_proxy.atomic():
            parent.status = "superseded"
            parent.ended_at = parent.ended_at or now
            parent.save()
            StepRun.update(
                status="cancelled",
                ended_at=now,
            ).where(
                (StepRun.run == parent)
                & (StepRun.status == "running")
            ).execute()
            child = WorkflowRun.create(
                id=str(uuid.uuid4()),
                task=task,
                status="running",
                workflow_schema_version=schema_version,
                workflow_snapshot_json=parent.workflow_snapshot_json,
                parent_run_id=parent.id,
                restart_from_step_key=step_key,
                started_at=now,
            )
            reusable = {
                row.step_key
                for row in TaskStep.select().where(
                    (TaskStep.task == task)
                    & (TaskStep.status == "passed")
                    & (~(TaskStep.step_key.in_(execution_keys)))
                )
            }
            for reusable_key in reusable:
                source = (
                    StepRun.select()
                    .where(
                        (StepRun.run == parent)
                        & (StepRun.step_key == reusable_key)
                        & (StepRun.status.in_(["succeeded", "reused"]))
                    )
                    .order_by(StepRun.attempt.desc())
                    .first()
                )
                if source is None:
                    continue
                StepRun.create(
                    id=str(uuid.uuid4()),
                    run=child,
                    step_key=reusable_key,
                    attempt=1,
                    status="reused",
                    engine=source.engine,
                    model=source.model,
                    source_step_run_id=source.id,
                    started_at=now,
                    ended_at=now,
                )
            TaskStep.update(
                status="pending",
                started_at=None,
                ended_at=None,
                error=None,
            ).where(
                (TaskStep.task == task)
                & (TaskStep.step_key.in_(execution_keys))
            ).execute()
            task.status = "running"
            task.active_workflow_run_id = child.id
            task.state_version += 1
            task.updated_at = now
            task.save()
        return task, child

    def _archive_stage_artifacts(
        self,
        project,
        task: Task,
        workflow_run: WorkflowRun,
        step_keys: set[str],
    ) -> list[tuple[Path, Path]]:
        artifacts_root = Path(project.workstep_dir) / "artifacts"
        history_root = (
            Path(project.workstep_dir)
            / "artifact-history"
            / task.id
            / workflow_run.id
        )
        archived: list[tuple[Path, Path]] = []
        for key in sorted(step_keys):
            source = artifacts_root / key / task.id
            if not source.exists():
                continue
            destination = history_root / key
            if destination.exists():
                raise RuntimeError(
                    f"Artifact history already exists for stage '{key}'"
                )
            destination.parent.mkdir(parents=True, exist_ok=True)
            source.rename(destination)
            archived.append((source, destination))
        return archived

    def _restore_archived_artifacts(
        self,
        archived: list[tuple[Path, Path]],
    ) -> None:
        for source, destination in reversed(archived):
            if destination.exists() and not source.exists():
                source.parent.mkdir(parents=True, exist_ok=True)
                destination.rename(source)

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
        task: Task,
        runner: TaskRunner,
        workflow_run: WorkflowRun,
        steps_config: dict,
        artifacts_dir: Path,
        user_input: str,
    ) -> str:
        interrupted = False
        try:
            await runner.run_pipeline(
                task=task,
                steps_config=steps_config,
                artifacts_dir=artifacts_dir,
                user_input=user_input,
                workflow_run=workflow_run,
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
                workflow_run.save()

            await runner._run_db(finalize_run)
            if self._runners.get(task.id) is runner:
                self._runners.pop(task.id, None)

        return workflow_run.id

    async def cancel(self, task_id: str) -> bool:
        """Cancel every active step owned by a task's pipeline."""
        runner = self._runners.get(task_id)
        if runner is None:
            return False
        return await runner.cancel_task(task_id)
