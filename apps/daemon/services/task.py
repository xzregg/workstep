"""Task service — create, run, and manage task execution."""

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

from peewee import fn

from agent_assistants.event_journal import TurnEventJournal
from models import (
    ActionProposal,
    CoordinatorSession,
    Task,
    TaskStep,
    Message,
    ReviewRun,
    StepRun,
    WorkflowRun,
)
from models.base import db_proxy
from models.fields import utc_now
from engines.codex_visualize import convert_visualize_markers
from engines.core.registry import create_engine
from engines.core.events import InternalEvent, is_commentary
from services.workflow_definition import WorkflowDefinition, WorkflowValidationError
from services.task_runner import extract_usage_json
from services.config import DEFAULT_EXECUTION_ENGINE
from services.messages import (
    create_task_message,
    current_actor_task_fields,
    new_message_id,
)
from services.history import (
    event_detail,
    message_artifact_projections,
    project_terminal_message_state,
    restore_running_projection,
    session_id_from_events,
    session_id_from_journal_path,
)
from streaming.bus import EventBus

logger = logging.getLogger(__name__)


def latest_previous_step_statuses(task: Task) -> dict[str, str]:
    """Return each step's latest terminal result, independent of reset state."""
    latest_step_run_by_key: dict[str, StepRun] = {}
    for step_run in (
        StepRun.select()
        .join(WorkflowRun)
        .where(
            (WorkflowRun.task == task)
            & (StepRun.status.in_(["succeeded", "reused", "failed", "cancelled", "skipped"]))
        )
        .order_by(StepRun.started_at.desc(), StepRun.attempt.desc())
    ):
        latest_step_run_by_key.setdefault(step_run.step_key, step_run)

    latest_review_by_key: dict[str, ReviewRun] = {}
    for review in (
        ReviewRun.select()
        .where(ReviewRun.task == task)
        .order_by(ReviewRun.started_at.desc(), ReviewRun.attempt.desc(), ReviewRun.id.desc())
    ):
        latest_review_by_key.setdefault(review.step_key, review)

    failed_run_ids = [
        step_run.id for step_run in latest_step_run_by_key.values()
        if step_run.status == "failed"
    ]
    stopped_run_ids = set()
    if failed_run_ids:
        stopped_run_ids = {
            message.step_run_id for message in Message.select(Message.step_run_id).where(
                (Message.step_run_id.in_(failed_run_ids))
                & (Message.channel == "execution")
                & (Message.role == "assistant")
                & (Message.run_status.in_(["cancelled", "stopped"]))
            )
        }

    previous: dict[str, str] = {}
    for step_key, step_run in latest_step_run_by_key.items():
        status = step_run.status
        if status == "failed" and step_run.id in stopped_run_ids:
            status = "cancelled"
        if status in ("succeeded", "reused"):
            review = latest_review_by_key.get(step_key)
            if review is not None and review.step_run_id == step_run.id:
                status = {
                    "pending": "awaiting_review",
                    "running": "reviewing",
                    "passed": "passed",
                    "rejected": "rejected",
                    "failed": "failed",
                    "skipped": "passed",
                }.get(review.status, "passed")
            else:
                status = "passed"
        previous[step_key] = status
    return previous


class TaskService:
    """Core task execution logic. Callable from API or CLI."""

    def __init__(self, event_bus: EventBus):
        self._event_bus = event_bus
        self._running_engines: dict[str, object] = {}  # task_id → engine
        self._cancelled_tasks: set[str] = set()
        self._event_journal = TurnEventJournal()

    def create_task(
        self,
        title: str,
        cwd: str,
        description: str | None = None,
        engine: str = DEFAULT_EXECUTION_ENGINE,
        workflow: dict | None = None,
        start_step_key: str | None = None,
        review_overrides: dict[str, object] | None = None,
        workflow_id: str | None = None,
        scheduled_start_at: datetime | None = None,
        source_dispatch_id: str | None = None,
        source_project_id: str | None = None,
        source_task_id: str | None = None,
        source_step_key: str | None = None,
        input_manifest: list[dict] | None = None,
        dispatch_lineage: list[str] | None = None,
        creator_fields: dict[str, str] | None = None,
    ) -> dict:
        """Create a task, optionally skipping steps before its start step."""
        steps = (
            WorkflowDefinition.load(workflow).compile().to_steps_config()["steps"]
            if workflow is not None
            else [{"key": "do", "engine": None}]
        )
        step_keys = [step["key"] for step in steps]
        if start_step_key is not None and start_step_key not in step_keys:
            raise WorkflowValidationError(
                f"start_step_key: step '{start_step_key}' does not exist"
            )
        if scheduled_start_at is not None:
            if scheduled_start_at.tzinfo is None:
                raise ValueError("scheduled_start_at must include a timezone")
            scheduled_start_at = scheduled_start_at.astimezone(timezone.utc)
            if scheduled_start_at <= utc_now():
                raise ValueError("scheduled_start_at must be in the future")
        execution_keys = set(step_keys)
        if start_step_key is not None:
            execution_keys = {start_step_key}
            changed = True
            while changed:
                changed = False
                for step in steps:
                    if any(dep in execution_keys for dep in step.get("dependsOn", [])) and step["key"] not in execution_keys:
                        execution_keys.add(step["key"])
                        changed = True
        now = utc_now()
        task_id = str(uuid.uuid4())

        task = Task.create(
            id=task_id,
            title=title,
            description=description,
            cwd=cwd,
            engine=engine,
            workflow_id=workflow_id,
            created_at=now,
            updated_at=now,
            scheduled_start_at=scheduled_start_at,
            scheduled_start_state="pending" if scheduled_start_at else None,
            source_dispatch_id=source_dispatch_id,
            source_project_id=source_project_id,
            source_task_id=source_task_id,
            source_step_key=source_step_key,
            input_manifest_json=(
                json.dumps(input_manifest, ensure_ascii=False)
                if input_manifest is not None else None
            ),
            dispatch_lineage_json=(
                json.dumps(dispatch_lineage, ensure_ascii=False)
                if dispatch_lineage is not None else None
            ),
            **(
                creator_fields
                if creator_fields is not None
                else current_actor_task_fields()
            ),
        )
        if review_overrides:
            task.review_overrides_json = json.dumps(review_overrides, ensure_ascii=False)
            task.save()

        for index, step in enumerate(steps):
            TaskStep.create(
                task=task,
                step_key=step["key"],
                status="pending" if step["key"] in execution_keys else "skipped",
                engine=step.get("engine"),
            )

        return self._task_to_dict(task)

    def update_scheduled_start(
        self, task_id: str, scheduled_start_at: datetime | None,
    ) -> dict | None:
        try:
            task = Task.get_by_id(task_id)
        except Task.DoesNotExist:
            return None
        if any(step.status != "pending" for step in TaskStep.select().where(TaskStep.task == task)):
            raise RuntimeError("Task has already started")
        if scheduled_start_at is not None:
            if scheduled_start_at.tzinfo is None:
                raise ValueError("scheduled_start_at must include a timezone")
            scheduled_start_at = scheduled_start_at.astimezone(timezone.utc)
            if scheduled_start_at <= utc_now():
                raise ValueError("scheduled_start_at must be in the future")
            task.scheduled_start_at = scheduled_start_at
            task.scheduled_start_state = "pending"
            task.scheduled_start_error = None
        else:
            task.scheduled_start_at = None
            task.scheduled_start_state = None
            task.scheduled_start_error = None
        task.updated_at = utc_now()
        task.save()
        return self._task_to_dict(task)

    def clear_scheduled_start(self, task_id: str) -> None:
        task = Task.get_or_none(Task.id == task_id)
        if task is None or task.scheduled_start_at is None:
            return
        task.scheduled_start_at = None
        task.scheduled_start_state = None
        task.scheduled_start_error = None
        task.updated_at = utc_now()
        task.save()

    def mark_scheduled_start(self, task_id: str, state: str, error: str | None = None) -> dict | None:
        task = Task.get_or_none(Task.id == task_id)
        if task is None:
            return None
        task.scheduled_start_state = state
        task.scheduled_start_error = error
        task.updated_at = utc_now()
        task.save()
        return self._task_to_dict(task)

    def list_tasks(
        self,
        workflow_id: str | None = None,
        archived: bool = False,
    ) -> list[dict]:
        """List tasks, optionally filtered by workflow and archive state.

        By default archived tasks are hidden from the active board; pass
        ``archived=True`` to list only archived tasks.
        """
        q = Task.select().order_by(Task.updated_at.desc())
        if workflow_id:
            q = q.where(Task.workflow_id == workflow_id)
        q = q.where(Task.archived == (1 if archived else 0))
        return [self._task_to_dict(t) for t in q]

    def get_task(self, task_id: str) -> dict | None:
        """Get a single task by ID."""
        try:
            task = Task.get_by_id(task_id)
            return self._task_to_dict(task)
        except Task.DoesNotExist:
            return None

    def update_task_description(
        self,
        task_id: str,
        description: str | None,
        review_overrides: dict[str, object] | None = None,
    ) -> dict | None:
        """Update task context without interrupting an active engine run."""
        try:
            task = Task.get_by_id(task_id)
        except Task.DoesNotExist:
            return None
        if description is not None:
            normalized = description.strip()
            if normalized:
                task.description = normalized
        task.updated_at = utc_now()
        if review_overrides is not None:
            task.review_overrides_json = json.dumps(review_overrides, ensure_ascii=False)
        task.save()
        return self._task_to_dict(task)

    def get_task_history(
        self,
        task_id: str,
        limit: int = 50,
        offset: int = 0,
        workstep_dir: str | None = None,
    ) -> list[dict]:
        """Get chat history for a task with pagination."""
        try:
            Task.get_by_id(task_id)
        except Task.DoesNotExist:
            return []

        messages = list(
            Message.select()
            .where(Message.task == task_id)
            .order_by(Message.sequence.desc(), Message.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        result = []
        artifact_projections = message_artifact_projections(task_id, messages)
        import json as json_mod
        for msg in reversed(messages):
            step_run_id, artifact_round = artifact_projections[msg.id]
            entry = {
                "id": msg.id,
                "role": msg.role,
                "content": convert_visualize_markers(msg.content or ""),
                "author_id": msg.author_id,
                "author_name": msg.author_name,
                "author_device_id": msg.author_device_id,
                "author_device_name": msg.author_device_name,
                "step_key": msg.step_key,
                "context_step_key": msg.context_step_key,
                "channel": msg.channel,
                "sequence": msg.sequence,
                "run_status": msg.run_status,
                "step_run_id": step_run_id,
                "artifact_round": artifact_round,
                "engine": msg.engine,
                "model": msg.model,
                "started_at": msg.started_at,
                "ended_at": msg.ended_at,
                "created_at": msg.created_at,
                "events": [],
                "prompt": None,
                "usage": None,
                "session_id": session_id_from_journal_path(msg),
                "proposals": [],
            }
            if msg.events_json:
                try:
                    entry["events"] = json_mod.loads(msg.events_json)
                    entry["session_id"] = (
                        session_id_from_events(entry["events"])
                        or entry["session_id"]
                    )
                except Exception:
                    pass
            detail = event_detail(msg)
            if detail is not None:
                entry["event_detail"] = detail
            restore_running_projection(entry, msg, workstep_dir)
            project_terminal_message_state(entry, msg)
            if msg.prompt_json:
                try:
                    prompt_data = json_mod.loads(msg.prompt_json)
                    entry["prompt"] = prompt_data.get("prompt")
                except Exception:
                    pass
            if msg.usage_json:
                try:
                    entry["usage"] = json_mod.loads(msg.usage_json)
                except Exception:
                    pass
            entry["proposals"] = [
                {
                    "id": proposal.id,
                    "type": proposal.type,
                    "target_step_key": proposal.target_step_key,
                    "payload": json_mod.loads(proposal.payload_json),
                    "impact": (
                        json_mod.loads(proposal.impact_json)
                        if proposal.impact_json else None
                    ),
                    "status": proposal.status,
                    "result": (
                        json_mod.loads(proposal.result_json)
                        if proposal.result_json else None
                    ),
                    "error": proposal.error,
                }
                for proposal in ActionProposal.select().where(
                    ActionProposal.source_message == msg
                )
            ]
            result.append(entry)
        return result

    async def run_task(self, task_id: str, prompt: str) -> None:
        """Run a task: spawn engine, stream events to event bus.

        This is the core execution loop. Runs as an async task
        so the caller can await it or fire-and-forget.
        """
        prepared = await asyncio.to_thread(self._prepare_legacy_run, task_id)
        if prepared is None:
            logger.error("Task not found: %s", task_id)
            return
        engine_id, cwd, msg_id, journal_ref = prepared
        engine = create_engine(engine_id)
        if not engine:
            await self._publish(task_id, "do", {
                "type": "error",
                "data": {"message": f"Unknown engine: {engine_id}"},
            })
            return

        await self._publish(task_id, "do", {
            "type": "status",
            "data": {"status": "running", "task_id": task_id},
        })

        # Store engine reference for cancellation
        self._cancelled_tasks.discard(task_id)
        self._running_engines[task_id] = engine

        events_collected = []
        content_parts = []
        reported_error: str | None = None

        try:
            spawn = getattr(engine, "spawn_with_retry", engine.spawn)
            async for event in spawn(prompt=prompt, cwd=cwd):
                normalize_event = getattr(engine, "normalize_event", None)
                if normalize_event is not None:
                    event = normalize_event(event)
                if event is None:
                    continue
                events_collected.append(event.to_dict())
                await self._event_journal.arecord(journal_ref, event.to_dict())

                # Collect text content
                if event.type == "agent_message_chunk" and not is_commentary(event):
                    content = event.data.get("content") or {}
                    content_parts.append(content.get("text", ""))
                elif event.type == "error" and reported_error is None:
                    reported_error = str(
                        event.data.get("message") or "Engine reported an error"
                    )

                # Broadcast to WebSocket
                await self._publish(task_id, "do", {
                    "type": event.type,
                    "data": {**event.data, "task_id": task_id},
                })

        except Exception as e:
            logger.exception("Engine spawn failed for task %s", task_id)
            await self._publish(task_id, "do", {
                "type": "error",
                "data": {"message": str(e)},
            })
            step_status = "failed"
            step_error = str(e)
            task_status = "stopped"
        else:
            if task_id in self._cancelled_tasks:
                # 手动停止：与普通失败区分，前端显示「手动停止」。
                step_status = "cancelled"
                step_error = "手动停止"
                task_status = "paused"
            elif reported_error is not None:
                step_status = "failed"
                step_error = reported_error
                task_status = "stopped"
            else:
                step_status = "passed"
                step_error = None
                task_status = "ready"
        finally:
            try:
                await self._event_journal.afinish(
                    journal_ref,
                    {"type": "status", "data": {"status": step_status}},
                )
                journal_snapshot = await self._event_journal.asnapshot(journal_ref)
                await asyncio.to_thread(
                    self._finish_legacy_run,
                    task_id,
                    msg_id,
                    step_status,
                    step_error,
                    task_status,
                    events_collected,
                    content_parts,
                    journal_snapshot,
                )
            except Exception:
                logger.exception("Failed to update message %s", msg_id)

            # Clean up engine reference
            self._running_engines.pop(task_id, None)

            self._cancelled_tasks.discard(task_id)

            await self._publish(task_id, "do", {
                "type": "status",
                "data": {"status": step_status, "task_id": task_id},
            })

    async def shutdown(self) -> None:
        await self._event_journal.aclose()

    def _prepare_legacy_run(self, task_id: str):
        try:
            task = Task.get_by_id(task_id)
        except Task.DoesNotExist:
            return None
        task.status = "running"
        task.updated_at = utc_now()
        task.save()
        step = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "do"))
        step.status = "running"
        step.started_at = utc_now()
        step.save()
        msg_id = new_message_id()
        message_started_at = utc_now()
        journal_ref = self._event_journal.start(
            Path(task.cwd) / ".workstep",
            f"task-{task.id}",
            msg_id,
        )
        create_task_message(
            id=msg_id,
            task=task,
            channel="execution",
            step_key="do",
            role="assistant",
            run_id=msg_id,
            run_status="running",
            event_log_path=journal_ref.relative_path,
            position=1,
            started_at=message_started_at,
            created_at=message_started_at,
        )
        return task.engine or DEFAULT_EXECUTION_ENGINE, task.cwd, msg_id, journal_ref

    @staticmethod
    def _finish_legacy_run(
        task_id, msg_id, step_status, step_error, task_status,
        events_collected, content_parts, journal_snapshot,
    ):
        task = Task.get_by_id(task_id)
        step = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "do"))
        step.status = step_status
        step.error = step_error
        step.ended_at = utc_now()
        step.save()
        task.status = task_status
        task.updated_at = utc_now()
        task.save()
        msg = Message.get_by_id(msg_id)
        summary_events = journal_snapshot["events"]
        msg.events_json = (
            json.dumps(summary_events, ensure_ascii=False)
            if summary_events else None
        )
        msg.event_summary_json = json.dumps(
            journal_snapshot["summary"], ensure_ascii=False
        )
        msg.event_count = journal_snapshot["summary"]["event_count"]
        msg.last_event_seq = journal_snapshot["summary"]["last_event_seq"]
        msg.usage_json = extract_usage_json(events_collected)
        msg.content = "".join(content_parts)
        msg.run_status = (
            "cancelled" if step_status == "cancelled"
            else "succeeded" if step_status == "passed"
            else "failed"
        )
        msg.ended_at = utc_now()
        msg.save()

    async def cancel_task(self, task_id: str) -> bool:
        """Cancel a running task (idempotent)."""
        if task_id in self._cancelled_tasks:
            return True
        engine = self._running_engines.get(task_id)
        if not engine:
            return False
        self._cancelled_tasks.add(task_id)
        try:
            await engine.stop()
        except Exception:
            logger.exception("Engine stop raised during cancel for task %s", task_id)
        return True

    async def pause_task(self, task_id: str) -> bool:
        """Pause a running task."""
        return await asyncio.to_thread(self._pause_task_sync, task_id)

    @staticmethod
    def _pause_task_sync(task_id: str) -> bool:
        try:
            task = Task.get_by_id(task_id)
        except Task.DoesNotExist:
            return False

        # Update task status to paused
        task.status = "paused"
        task.updated_at = utc_now()
        task.save()
        return True

    def delete_task(self, task_id: str, project_id: str) -> bool:
        """Delete a task."""
        try:
            task = Task.get_by_id(task_id)
            if task.status == "running":
                raise RuntimeError("Running tasks cannot be deleted")
            task.delete_instance(recursive=True)
            return True
        except Task.DoesNotExist:
            return False

    def archive_task(self, task_id: str) -> bool:
        """Archive a task so it disappears from the active board."""
        try:
            task = Task.get_by_id(task_id)
            if task.status == "running":
                raise RuntimeError("Running tasks cannot be archived")
            task.archived = 1
            self.clear_scheduled_start(task_id)
            task.updated_at = utc_now()
            task.save()
            return True
        except Task.DoesNotExist:
            return False

    def unarchive_task(self, task_id: str) -> bool:
        """Restore an archived task back to the active board."""
        try:
            task = Task.get_by_id(task_id)
            if not task.archived:
                return False
            task.archived = 0
            task.updated_at = utc_now()
            task.save()
            return True
        except Task.DoesNotExist:
            return False

    def copy_task(
        self,
        task_id: str,
        new_title: str,
        project_id: str,
        creator_fields: dict[str, str] | None = None,
    ) -> dict | None:
        """Copy a task with a new title."""
        try:
            original = Task.get_by_id(task_id)
            now = utc_now()
            new_id = str(uuid.uuid4())
            # Create new task
            new_task = Task.create(
                id=new_id,
                title=new_title,
                description=original.description,
                cwd=original.cwd,
                engine=original.engine or DEFAULT_EXECUTION_ENGINE,
                created_at=now,
                updated_at=now,
                **(creator_fields if creator_fields is not None else current_actor_task_fields()),
            )

            # Copy task steps
            for step in TaskStep.select().where(TaskStep.task == original):
                TaskStep.create(
                    task=new_task,
                    step_key=step.step_key,
                    status="pending",
                    engine=step.engine,
                )

            return self._task_to_dict(new_task)
        except Task.DoesNotExist:
            return None

    async def _publish(self, task_id: str, step_key: str, event: dict):
        """发布出口：内部事件 → AG-UI 标准事件后推送。"""
        from engines.core.agui import AGUIContext, to_agui_events

        payload = {
            "task_id": task_id,
            "step_key": step_key,
            **event,
        }
        from services.remote_project import current_actor_event_fields
        payload.update(current_actor_event_fields())
        ctx = AGUIContext.from_event(payload)
        for agui_event in to_agui_events(payload, ctx):
            await self._event_bus.publish(agui_event)

    @staticmethod
    def _task_to_dict(task: Task) -> dict:
        active_run = None
        if task.active_workflow_run_id:
            active_run = WorkflowRun.get_or_none(
                (WorkflowRun.id == task.active_workflow_run_id)
                & (WorkflowRun.task == task)
            )
        steps = list(TaskStep.select().where(TaskStep.task == task))
        previous_status_by_step = latest_previous_step_statuses(task)
        # 「执行过」判定：步骤是否有 execution 频道的用户/助手消息。
        # 一次分组查询取回所有已执行步骤，避免逐步骤查询。
        executed_step_keys = {
            row.step_key
            for row in (
                Message.select(Message.step_key)
                .where(
                    (Message.task == task)
                    & (Message.channel == "execution")
                    & (Message.role.in_(["user", "assistant"]))
                )
                .group_by(Message.step_key)
            )
        }
        coordinator_session = CoordinatorSession.get_or_none(
            CoordinatorSession.task == task
        )
        coordinator_session_id = (
            coordinator_session.session_id if coordinator_session else None
        )
        # Include the current attempt while it runs: its execution message
        # already shows that reserved artifact round. Ignore interrupted
        # attempts from older runs and failed attempts without artifacts.
        running_step_keys = [
            step.step_key for step in steps if step.status == "running"
        ]
        latest_artifact_round_by_step = {
            row.step_key: row.max_round
            for row in (
                StepRun.select(
                    StepRun.step_key,
                    fn.MAX(StepRun.artifact_round).alias("max_round"),
                )
                .join(WorkflowRun)
                .where(
                    (WorkflowRun.task == task)
                    & (StepRun.artifact_round.is_null(False))
                    & (
                        StepRun.status.in_(["succeeded", "reused"])
                        | (
                            (StepRun.status == "running")
                            & (WorkflowRun.id == task.active_workflow_run_id)
                            & (StepRun.step_key.in_(running_step_keys))
                        )
                    )
                )
                .group_by(StepRun.step_key)
            )
        }
        latest_io_contract_by_step: dict[str, dict] = {}
        for row in (
            StepRun.select(StepRun.step_key, StepRun.io_contract_json)
            .join(WorkflowRun)
            .where(
                (WorkflowRun.task == task)
                & StepRun.io_contract_json.is_null(False)
            )
            .order_by(StepRun.started_at.desc(), StepRun.id.desc())
        ):
            if row.step_key in latest_io_contract_by_step:
                continue
            try:
                contract = json.loads(row.io_contract_json or "")
            except (TypeError, json.JSONDecodeError):
                continue
            if isinstance(contract, dict):
                latest_io_contract_by_step[row.step_key] = contract
        run_round = 1
        restart_from_step_key = None
        recovered_at = None
        recovered_count = 0
        if active_run is not None:
            restart_from_step_key = active_run.restart_from_step_key
            recovered_at = active_run.recovered_at
            recovered_count = active_run.recovered_count or 0
            depth = 1
            current = active_run
            while current.parent_run_id:
                parent = WorkflowRun.get_or_none(
                    (WorkflowRun.id == current.parent_run_id)
                    & (WorkflowRun.task == task)
                )
                if parent is None:
                    break
                current = parent
                depth += 1
            run_round = depth
        first_message = (
            Message.select(Message.created_at)
            .where(Message.task == task)
            .order_by(Message.created_at, Message.sequence)
            .limit(1)
            .scalar()
        )
        last_step_end = (
            TaskStep.select(TaskStep.ended_at)
            .where((TaskStep.task == task) & (TaskStep.ended_at.is_null(False)))
            .order_by(TaskStep.ended_at.desc())
            .limit(1)
            .scalar()
        )
        duration_ms = None
        if first_message is not None and last_step_end is not None:
            delta = (last_step_end - first_message).total_seconds() * 1000
            if delta > 0:
                duration_ms = int(delta)

        total_tokens = 0
        for msg in Message.select(Message.usage_json).where(Message.task == task):
            if not msg.usage_json:
                continue
            try:
                usage = json.loads(msg.usage_json)
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(usage, dict):
                continue
            total = usage.get("total_tokens", usage.get("tokens"))
            if isinstance(total, (int, float)) and not isinstance(total, bool):
                total_tokens += max(0, int(total))
            else:
                input_tokens = usage.get("input_tokens", usage.get("prompt_tokens", 0))
                output_tokens = usage.get("output_tokens", usage.get("completion_tokens", 0))
                if isinstance(input_tokens, (int, float)) and not isinstance(input_tokens, bool):
                    total_tokens += max(0, int(input_tokens))
                if isinstance(output_tokens, (int, float)) and not isinstance(output_tokens, bool):
                    total_tokens += max(0, int(output_tokens))

        return {
            "id": task.id,
            "title": task.title,
            "description": task.description,
            "cwd": task.cwd,
            "status": task.status,
            "archived": bool(task.archived),
            "engine": task.engine,
            "model": task.model,
            "coordinator_engine": task.coordinator_engine,
            "coordinator_model": task.coordinator_model,
            "coordinator_fast_model": task.coordinator_fast_model,
            "coordinator_vision_model": task.coordinator_vision_model,
            "coordinator_session_id": coordinator_session_id,
            "active_workflow_run_id": task.active_workflow_run_id,
            "run_round": run_round,
            "restart_from_step_key": restart_from_step_key,
            "recovered_at": recovered_at,
            "recovered_count": recovered_count,
            "state_version": task.state_version,
            "workflow_id": task.workflow_id,
            "first_message_at": first_message,
            "completed_at": last_step_end,
            "duration_ms": duration_ms,
            "total_tokens": total_tokens if total_tokens > 0 else None,
            "created_at": task.created_at,
            "updated_at": task.updated_at,
            "review_overrides": json.loads(task.review_overrides_json) if task.review_overrides_json else None,
            "creator_id": task.creator_id,
            "creator_name": task.creator_name,
            "creator_device_id": task.creator_device_id,
            "creator_device_name": task.creator_device_name,
            "scheduled_start_at": task.scheduled_start_at,
            "scheduled_start_state": task.scheduled_start_state,
            "scheduled_start_error": task.scheduled_start_error,
            "source_dispatch_id": task.source_dispatch_id,
            "source_project_id": task.source_project_id,
            "source_task_id": task.source_task_id,
            "source_step_key": task.source_step_key,
            "input_manifest": json.loads(task.input_manifest_json) if task.input_manifest_json else [],
            "steps": [
                {
                    "step_key": step.step_key,
                    "status": step.status,
                    "engine": step.engine,
                    "session_id": step.session_id,
                    "started_at": step.started_at,
                    "ended_at": step.ended_at,
                    "error": step.error,
                    "artifact_round": latest_artifact_round_by_step.get(
                        step.step_key
                    ),
                    "io_contract": latest_io_contract_by_step.get(step.step_key),
                    "previous_status": previous_status_by_step.get(step.step_key),
                    "has_history": (
                        step.step_key in executed_step_keys
                        or step.started_at is not None
                    ),
                }
                for step in steps
            ],
        }


# Will be initialized in main.py with the actual event bus
task_service: TaskService | None = None
