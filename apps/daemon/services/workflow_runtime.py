"""Production entry point for executing a saved workflow."""

import asyncio
import functools
import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from models import Task, WorkflowRun
from services.task_runner import TaskRunner
from services.workflow_definition import WorkflowDefinition
from streaming.bus import EventBus


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

        workflow = WorkflowDefinition.load(project.steps)
        compiled = workflow.compile()
        steps_config = compiled.to_steps_config()
        now = int(time.time())
        workflow_run = WorkflowRun.create(
            id=str(uuid.uuid4()),
            task=task,
            status="running",
            workflow_schema_version=compiled.schema_version,
            workflow_snapshot_json=json.dumps(
                project.steps,
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
            workflow_run.ended_at = int(time.time())
            workflow_run.save()
            raise RuntimeError(f"Task is already running: {task.id}")
        self._runners[task.id] = runner

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

    async def shutdown(self) -> None:
        """Cancel and await every workflow owned by this runtime."""
        runners = tuple(self._runners.items())
        if runners:
            await asyncio.gather(
                *(
                    runner.cancel_task(task_id)
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
            if workflow_run.status == "running":
                workflow_run.status = "failed"
                workflow_run.ended_at = int(time.time())
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
        try:
            await runner.run_pipeline(
                task=task,
                steps_config=steps_config,
                artifacts_dir=artifacts_dir,
                user_input=user_input,
                workflow_run=workflow_run,
            )
        except asyncio.CancelledError:
            workflow_run.status = "failed"
            raise
        except Exception:
            workflow_run.status = "failed"
            raise
        else:
            task = Task.get_by_id(task.id)
            workflow_run.status = (
                "succeeded" if task.status == "ready" else "failed"
            )
        finally:
            workflow_run.ended_at = int(time.time())
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
