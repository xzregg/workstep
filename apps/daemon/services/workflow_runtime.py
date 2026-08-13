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
from services.workflow_definition import WorkflowDefinition
from services.messages import create_task_message, new_message_id
from services.intervention import seal_unanswered_interactions
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


class WorkflowRuntime:
    """Run project workflows behind one small interface."""

    def __init__(self, event_bus: EventBus, project_manager):
        self._event_bus = event_bus
        self._project_manager = project_manager
        self._runners: dict[str, TaskRunner] = {}
        self._active_tasks: set[asyncio.Task[str]] = set()
        self._operation_locks: dict[str, asyncio.Lock] = {}
        self._graceful_shutdown = False

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
        with self._project_manager.activate_project_by_id(project_id) as project:
            return self._start_in_project(project, task_id, user_input)

    def _start_in_project(
        self,
        project,
        task_id: str,
        user_input: str,
    ) -> WorkflowRunHandle:
        """Create persistent run state while its project context is active."""
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

        runner = TaskRunner(self._event_bus)
        if task.id in self._runners:
            workflow_run.status = "failed"
            workflow_run.ended_at = utc_now()
            workflow_run.save()
            raise RuntimeError(f"Task is already running: {task.id}")
        self._runners[task.id] = runner
        task.status = "running"
        task.active_workflow_run_id = workflow_run.id
        task.state_version += 1
        task.updated_at = now
        task.save()

        normalized_input = user_input.strip()
        if normalized_input:
            step_statuses = {
                task_step.step_key: task_step.status
                for task_step in TaskStep.select().where(TaskStep.task == task)
            }
            message_step_key = resolve_message_step_key(
                steps_config,
                step_statuses,
            )
            create_task_message(
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

        completion = asyncio.create_task(
            self._execute(
                task=task,
                runner=runner,
                workflow_run=workflow_run,
                steps_config=steps_config,
                artifacts_dir=artifacts_dir,
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

    async def send_stage_message(
        self,
        project_id: str,
        task_id: str,
        step_key: str,
        content: str,
        as_guidance: bool = False,
    ) -> dict:
        """Inject an ordinary user message into a running stage."""
        with self._project_manager.activate_project_by_id(project_id):
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
        with self._project_manager.activate_project_by_id(project_id):
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
        """Persist a user message for a stopped stage and re-run that stage.

        The message is stored in the stage's execution history (and as active
        stage guidance) so the next attempt carries it into the stage LLM,
        then the stage plus its downstream is restarted from ``step_key``.
        """
        normalized = content.strip()
        if not normalized:
            raise ValueError("消息内容不能为空")
        with self._project_manager.activate_project_by_id(project_id):
            task = Task.get_or_none(Task.id == task_id)
            if task is None:
                raise ValueError(f"Task not found: {task_id}")
            step = TaskStep.get_or_none(
                (TaskStep.task == task) & (TaskStep.step_key == step_key)
            )
            if step is None:
                raise ValueError(f"Stage does not exist: {step_key}")
            if step.status not in ("cancelled", "failed", "rejected"):
                raise ValueError(
                    f"阶段未停止: {step_key}（当前状态 {step.status}）"
                )
            now = utc_now()
            message_id = new_message_id()
            create_task_message(
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
        handle = await self.restart_from_stage(project_id, task_id, step_key)
        message = Message.get_by_id(message_id)
        return {
            "message_id": message_id,
            "step_key": step_key,
            "run_id": handle.id,
            "status": "queued",
            "sequence": message.sequence,
            "created_at": message.created_at.isoformat(),
        }

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
        with self._project_manager.activate_project_by_id(project_id) as project:
            review = ReviewRun.get_or_none(ReviewRun.id == review_run_id)
            if (
                review is None
                or review.task_id != task_id
                or review.step_key != step_key
            ):
                raise ValueError("Review not found for the requested task step")
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
            # The awaiting-review event can reach the UI just before the
            # scheduler retires. Wait briefly so an immediate click resumes
            # instead of racing the still-active runner.
            for _ in range(100):
                if task.id not in self._runners:
                    break
                await asyncio.sleep(0.01)
            if task.id in self._runners:
                raise RuntimeError("Task is still finishing the current stage")
            return self._resume_in_project(project, task, review.workflow_run)

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
        workflow_run.status = "running"
        workflow_run.ended_at = None
        workflow_run.save()
        runner = TaskRunner(self._event_bus)
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
            with self._project_manager.activate_project_by_id(project.id):
                try:
                    recovered += await self._recover_project_runs(project)
                except Exception:
                    logger.exception(
                        "Failed to recover interrupted workflows for project %s",
                        project.id,
                    )
        return recovered

    async def _recover_project_runs(self, project) -> int:
        recovered = 0
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
            with self._project_manager.activate_project_by_id(project_id) as project:
                task = Task.get_or_none(Task.id == task_id)
                if task is None:
                    raise ValueError(f"Task not found: {task_id}")
                parent_run_id = expected_run_id or task.active_workflow_run_id
                if not parent_run_id:
                    return self._start_from_stage_without_parent(
                        project,
                        task,
                        step_key,
                    )
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

            runner = self._runners.get(task_id)
            if runner is not None:
                await runner.cancel_task(task_id)
                for _ in range(500):
                    if task_id not in self._runners:
                        break
                    await asyncio.sleep(0.01)
                if task_id in self._runners:
                    raise RuntimeError("Task runner did not stop in time")

            with self._project_manager.activate_project_by_id(project_id) as project:
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
                new_runner = TaskRunner(self._event_bus)
                self._runners[task.id] = new_runner
                completion = asyncio.create_task(
                    self._execute(
                        task=task,
                        runner=new_runner,
                        workflow_run=child,
                        steps_config=steps_config,
                        artifacts_dir=Path(project.workstep_dir) / "artifacts",
                        user_input="",
                    ),
                    name=f"workflow-run:{child.id}:restart",
                )
                self._active_tasks.add(completion)
                completion.add_done_callback(
                    functools.partial(
                        self._consume_completion,
                        task_id=task.id,
                        runner=new_runner,
                        workflow_run=child,
                    )
                )
                return WorkflowRunHandle(child.id, completion)

    def _start_from_stage_without_parent(
        self,
        project,
        task: Task,
        step_key: str,
    ) -> WorkflowRunHandle:
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

        handle = self._start_in_project(project, task.id, "")
        now = utc_now()
        workflow_run = WorkflowRun.get_by_id(handle.id)
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
        return handle

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
        if completion.cancelled():
            if (
                workflow_run.status == "running"
                and not self._graceful_shutdown
            ):
                workflow_run.status = "failed"
                workflow_run.ended_at = utc_now()
                workflow_run.save()
        else:
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
            task = Task.get_by_id(task.id)
            if task.status == "ready":
                workflow_run.status = "succeeded"
            elif task.status == "paused" and TaskStep.select().where(
                (TaskStep.task == task)
                & (TaskStep.status.in_(
                    ["awaiting_review", "rejected", "retrying"]
                ))
            ).exists():
                workflow_run.status = "paused"
            else:
                workflow_run.status = "failed"
        finally:
            if not (interrupted and self._graceful_shutdown):
                workflow_run.ended_at = utc_now()
            workflow_run.save()
            if self._runners.get(task.id) is runner:
                self._runners.pop(task.id, None)

        return workflow_run.id

    async def cancel(self, task_id: str) -> bool:
        """Cancel every active step owned by a task's pipeline."""
        runner = self._runners.get(task_id)
        if runner is None:
            return False
        return await runner.cancel_task(task_id)
