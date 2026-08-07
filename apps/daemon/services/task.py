"""Task service — create, run, and manage task execution."""

import asyncio
import json
import logging
import uuid

from models import ActionProposal, Task, TaskStep, Message, WorkflowRun
from models.base import db_proxy
from models.fields import utc_now
from engines.registry import create_engine
from engines.events import InternalEvent
from services.workflow_definition import WorkflowDefinition, WorkflowValidationError
from services.task_runner import extract_usage_json
from services.messages import create_task_message
from streaming.bus import EventBus

logger = logging.getLogger(__name__)


class TaskService:
    """Core task execution logic. Callable from API or CLI."""

    def __init__(self, event_bus: EventBus):
        self._event_bus = event_bus
        self._running_engines: dict[str, object] = {}  # task_id → engine
        self._cancelled_tasks: set[str] = set()

    def create_task(
        self,
        title: str,
        cwd: str,
        description: str | None = None,
        engine: str = "claude",
        workflow: dict | None = None,
        start_step_key: str | None = None,
        review_overrides: dict[str, object] | None = None,
        workflow_id: str | None = None,
    ) -> dict:
        """Create a task, optionally skipping stages before its start stage."""
        steps = (
            WorkflowDefinition.load(workflow).compile().to_steps_config()["steps"]
            if workflow is not None
            else [{"key": "do", "engine": None}]
        )
        step_keys = [step["key"] for step in steps]
        if start_step_key is not None and start_step_key not in step_keys:
            raise WorkflowValidationError(
                f"start_step_key: stage '{start_step_key}' does not exist"
            )
        start_index = (
            step_keys.index(start_step_key)
            if start_step_key is not None
            else 0
        )
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
        )
        if review_overrides:
            task.review_overrides_json = json.dumps(review_overrides, ensure_ascii=False)
            task.save()

        for index, step in enumerate(steps):
            TaskStep.create(
                task=task,
                step_key=step["key"],
                status="skipped" if index < start_index else "pending",
                engine=step.get("engine"),
            )

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

    def get_task_history(self, task_id: str, limit: int = 50, offset: int = 0) -> list[dict]:
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
        import json as json_mod
        for msg in reversed(messages):
            entry = {
                "id": msg.id,
                "role": msg.role,
                "content": msg.content,
                "step_key": msg.step_key,
                "context_step_key": msg.context_step_key,
                "channel": msg.channel,
                "sequence": msg.sequence,
                "run_status": msg.run_status,
                "engine": msg.engine,
                "model": msg.model,
                "started_at": msg.started_at,
                "ended_at": msg.ended_at,
                "created_at": msg.created_at,
                "events": [],
                "prompt": None,
                "usage": None,
                "proposals": [],
            }
            if msg.events_json:
                try:
                    entry["events"] = json_mod.loads(msg.events_json)
                except Exception:
                    pass
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
        try:
            task = Task.get_by_id(task_id)
        except Task.DoesNotExist:
            logger.error("Task not found: %s", task_id)
            return

        engine = create_engine(task.engine or "claude")
        if not engine:
            await self._publish(task_id, "do", {
                "type": "error",
                "data": {"message": f"Unknown engine: {task.engine}"},
            })
            return

        # Update task status
        task.status = "running"
        task.updated_at = utc_now()
        task.save()

        # Update step status
        step = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "do"))
        step.status = "running"
        step.started_at = utc_now()
        step.save()

        # Create message record
        msg_id = str(uuid.uuid4())
        message_started_at = utc_now()
        create_task_message(
            id=msg_id,
            task=task,
            channel="execution",
            step_key="do",
            role="assistant",
            run_id=msg_id,
            run_status="running",
            position=1,
            started_at=message_started_at,
            created_at=message_started_at,
        )

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
            async for event in engine.spawn(prompt=prompt, cwd=task.cwd):
                events_collected.append(event.to_dict())

                # Collect text content
                if event.type == "text_delta":
                    content_parts.append(event.data.get("delta", ""))
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
            step.status = "failed"
            step.error = str(e)
            task.status = "stopped"
        else:
            if task_id in self._cancelled_tasks:
                # 手动停止：与普通失败区分，前端显示「手动停止」。
                step.status = "cancelled"
                step.error = "手动停止"
                task.status = "paused"
            elif reported_error is not None:
                step.status = "failed"
                step.error = reported_error
                task.status = "stopped"
            else:
                step.status = "passed"
                task.status = "ready"
        finally:
            step.ended_at = utc_now()
            step.save()
            task.updated_at = utc_now()
            task.save()

            # Update message with collected events and content
            try:
                msg = Message.get_by_id(msg_id)
                msg.events_json = json.dumps(events_collected)
                msg.usage_json = extract_usage_json(events_collected)
                msg.content = "".join(content_parts)
                if step.status == "cancelled":
                    msg.run_status = "cancelled"
                else:
                    msg.run_status = "succeeded" if step.status == "passed" else "failed"
                msg.ended_at = utc_now()
                msg.save()
            except Exception:
                logger.exception("Failed to update message %s", msg_id)

            # Clean up engine reference
            self._running_engines.pop(task_id, None)
            self._cancelled_tasks.discard(task_id)

            await self._publish(task_id, "do", {
                "type": "status",
                "data": {"status": step.status, "task_id": task_id},
            })

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

    def copy_task(self, task_id: str, new_title: str, project_id: str) -> dict | None:
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
                engine=original.engine or "claude",
                created_at=now,
                updated_at=now,
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
        """Publish event with task/step routing info."""
        await self._event_bus.publish({
            "task_id": task_id,
            "step_key": step_key,
            **event,
        })

    def _task_to_dict(self, task: Task) -> dict:
        steps = list(TaskStep.select().where(TaskStep.task == task))
        run_round = 1
        restart_from_step_key = None
        recovered_at = None
        recovered_count = 0
        if task.active_workflow_run_id:
            run = WorkflowRun.get_or_none(
                (WorkflowRun.id == task.active_workflow_run_id)
                & (WorkflowRun.task == task)
            )
            if run is not None:
                restart_from_step_key = run.restart_from_step_key
                recovered_at = run.recovered_at
                recovered_count = run.recovered_count or 0
                depth = 1
                current = run
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
            "active_workflow_run_id": task.active_workflow_run_id,
            "run_round": run_round,
            "restart_from_step_key": restart_from_step_key,
            "recovered_at": recovered_at,
            "recovered_count": recovered_count,
            "state_version": task.state_version,
            "workflow_id": task.workflow_id,
            "created_at": task.created_at,
            "updated_at": task.updated_at,
            "review_overrides": json.loads(task.review_overrides_json) if task.review_overrides_json else None,
            "steps": [
                {
                    "step_key": step.step_key,
                    "status": step.status,
                    "engine": step.engine,
                    "session_id": step.session_id,
                    "started_at": step.started_at,
                    "ended_at": step.ended_at,
                    "error": step.error,
                }
                for step in steps
            ],
        }


# Will be initialized in main.py with the actual event bus
task_service: TaskService | None = None
