"""Task service — create, run, and manage task execution."""

import asyncio
import json
import logging
import time
import uuid

from models import Task, TaskStep, Message
from models.base import db_proxy
from engines.registry import create_engine
from engines.events import InternalEvent
from streaming.bus import EventBus

logger = logging.getLogger(__name__)


class TaskService:
    """Core task execution logic. Callable from API or CLI."""

    def __init__(self, event_bus: EventBus):
        self._event_bus = event_bus
        self._running_engines: dict[str, object] = {}  # task_id → engine

    def create_task(
        self,
        title: str,
        cwd: str,
        description: str | None = None,
        engine: str = "claude",
    ) -> dict:
        """Create a new task. Returns task dict."""
        now = int(time.time())
        task_id = str(uuid.uuid4())

        task = Task.create(
            id=task_id,
            title=title,
            description=description,
            cwd=cwd,
            engine=engine,
            created_at=now,
            updated_at=now,
        )

        # Create default step
        TaskStep.create(
            task=task,
            step_key="do",
            status="pending",
        )

        return self._task_to_dict(task)

    def list_tasks(self) -> list[dict]:
        """List all tasks, newest first."""
        tasks = Task.select().order_by(Task.updated_at.desc())
        return [self._task_to_dict(t) for t in tasks]

    def get_task(self, task_id: str) -> dict | None:
        """Get a single task by ID."""
        try:
            task = Task.get_by_id(task_id)
            return self._task_to_dict(task)
        except Task.DoesNotExist:
            return None

    def get_task_history(self, task_id: str, limit: int = 50, offset: int = 0) -> list[dict]:
        """Get chat history for a task with pagination."""
        try:
            Task.get_by_id(task_id)
        except Task.DoesNotExist:
            return []

        messages = (
            Message.select()
            .where(Message.task == task_id)
            .order_by(Message.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        result = []
        import json as json_mod
        for msg in messages:
            entry = {
                "id": msg.id,
                "role": msg.role,
                "content": msg.content,
                "step_key": msg.step_key,
                "run_status": msg.run_status,
                "created_at": msg.created_at,
                "events": [],
            }
            if msg.events_json:
                try:
                    entry["events"] = json_mod.loads(msg.events_json)
                except Exception:
                    pass
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
        task.updated_at = int(time.time())
        task.save()

        # Update step status
        step = TaskStep.get((TaskStep.task == task) & (TaskStep.step_key == "do"))
        step.status = "running"
        step.started_at = int(time.time())
        step.save()

        # Create message record
        msg_id = str(uuid.uuid4())
        Message.create(
            id=msg_id,
            task=task,
            step_key="do",
            role="assistant",
            run_id=msg_id,
            run_status="running",
            position=1,
            created_at=int(time.time()),
        )

        await self._publish(task_id, "do", {
            "type": "status",
            "data": {"status": "running", "task_id": task_id},
        })

        # Store engine reference for cancellation
        self._running_engines[task_id] = engine

        events_collected = []
        content_parts = []

        try:
            async for event in engine.spawn(prompt=prompt, cwd=task.cwd):
                events_collected.append(event.to_dict())

                # Collect text content
                if event.type == "text_delta":
                    content_parts.append(event.data.get("delta", ""))

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
            step.status = "passed"
            task.status = "ready"
        finally:
            step.ended_at = int(time.time())
            step.save()
            task.updated_at = int(time.time())
            task.save()

            # Update message with collected events and content
            try:
                msg = Message.get_by_id(msg_id)
                msg.events_json = json.dumps(events_collected)
                msg.content = "".join(content_parts)
                msg.run_status = "succeeded" if step.status == "passed" else "failed"
                msg.ended_at = int(time.time())
                msg.save()
            except Exception:
                logger.exception("Failed to update message %s", msg_id)

            # Clean up engine reference
            self._running_engines.pop(task_id, None)

            await self._publish(task_id, "do", {
                "type": "status",
                "data": {"status": step.status, "task_id": task_id},
            })

    async def cancel_task(self, task_id: str) -> bool:
        """Cancel a running task."""
        engine = self._running_engines.get(task_id)
        if not engine:
            return False
        await engine.stop()
        return True

    async def _publish(self, task_id: str, step_key: str, event: dict):
        """Publish event with task/step routing info."""
        await self._event_bus.publish({
            "task_id": task_id,
            "step_key": step_key,
            **event,
        })

    def _task_to_dict(self, task: Task) -> dict:
        return {
            "id": task.id,
            "title": task.title,
            "description": task.description,
            "cwd": task.cwd,
            "status": task.status,
            "engine": task.engine,
            "model": task.model,
            "created_at": task.created_at,
            "updated_at": task.updated_at,
        }


# Will be initialized in main.py with the actual event bus
task_service: TaskService | None = None
