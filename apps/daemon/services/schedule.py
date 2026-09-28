"""Project schedule module: rule compilation, persistence and dispatch."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import uuid

from models import Schedule, ScheduleRun, Task
from models.fields import utc_now
from services.config import DEFAULT_EXECUTION_ENGINE, config_store
from services.messages import current_actor_task_fields
from services.schedule_rules import (
    ScheduleValidationError,
    _as_utc,
    compile_rule,
    describe_rule,
    preview_rule,
)


# task_template.mode: "static" (default, backward compatible) or "agent".
AGENT_MODE = "agent"
DEFAULT_AGENT_RETRY_COUNT = 2
# Bounded wall-clock budget for one agent-mode run attempt.
SCHEDULE_AGENT_TIMEOUT_SECONDS = 10 * 60


class ScheduleModule:
    """Deep project schedule interface shared by HTTP, CLI and agent tools."""

    def __init__(
        self,
        project_manager,
        task_service,
        workflow_runtime,
        task_agent=None,
    ):
        self._projects = project_manager
        self._tasks = task_service
        self._runtime = workflow_runtime
        self._task_agent = task_agent
        self._stop = asyncio.Event()
        self._loop_task: asyncio.Task | None = None
        self._workers: set[asyncio.Task] = set()
        self._closing = False

    async def start(self) -> None:
        """Skip offline misfires, restore queues, then start polling."""
        self._closing = False
        self._stop.clear()
        await self.tick(utc_now(), startup=True)
        self._loop_task = asyncio.create_task(
            self._poll(), name="workstep-schedule-loop"
        )

    async def shutdown(self) -> None:
        """Stop background scheduling without cancelling workflow runs."""
        self._closing = True
        self._stop.set()
        if self._loop_task is not None:
            await self._loop_task
            self._loop_task = None
        for worker in list(self._workers):
            worker.cancel()
        if self._workers:
            await asyncio.gather(*self._workers, return_exceptions=True)

    async def _poll(self) -> None:
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=15)
            except TimeoutError:
                await self.tick(utc_now())

    def _spawn(self, coroutine, *, name: str) -> None:
        worker = asyncio.create_task(coroutine, name=name)
        self._workers.add(worker)
        worker.add_done_callback(self._workers.discard)

    async def wait_idle(self) -> None:
        """Wait until all currently queued dispatch workers are terminal."""
        while self._workers:
            await asyncio.gather(*list(self._workers), return_exceptions=True)

    async def _run_db(self, project_id: str, operation):
        """Serialize project Peewee work outside the event loop."""
        return await self._projects.run_db(
            project_id,
            lambda _project: operation(),
        )

    @staticmethod
    def _to_dict(row: Schedule) -> dict:
        rule = json.loads(row.rule_json)
        task_template = dict(json.loads(row.task_template_json))
        task_template.pop("_creator", None)
        return {
            "id": row.id,
            "name": row.name,
            "workflow_id": row.workflow_id,
            "task_template": task_template,
            "rule": rule,
            "summary": describe_rule(rule),
            "cron_expression": row.cron_expression,
            "timezone": row.timezone,
            "execution_mode": row.execution_mode,
            "overlap_policy": row.overlap_policy,
            "status": row.status,
            "invalid_reason": row.invalid_reason,
            "next_run_at": row.next_run_at,
            "last_run_at": row.last_run_at,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        }

    def _workflow(self, project, workflow_id: str):
        workflow = project.workflow_by_id(workflow_id)
        if workflow is None:
            raise ScheduleValidationError(f"Workflow not found: {workflow_id}")
        return workflow

    @staticmethod
    def _template_mode(task_template: dict) -> str:
        return str(task_template.get("mode") or "static")

    @staticmethod
    def _template_creator_fields(task_template: dict) -> dict[str, str | None]:
        raw = task_template.get("_creator")
        if not isinstance(raw, dict):
            return {}
        return {
            "creator_id": str(raw.get("id") or "").strip(),
            "creator_username": str(raw.get("username") or "").strip() or None,
            "creator_name": str(raw.get("name") or "").strip(),
            "creator_device_id": str(raw.get("device_id") or "").strip(),
            "creator_device_name": str(raw.get("device_name") or "").strip(),
        }

    @classmethod
    def _normalize_template(cls, task_template: dict) -> dict:
        normalized = dict(task_template)
        if (
            cls._template_mode(normalized) != AGENT_MODE
            and not str(normalized.get("title") or "").strip()
        ):
            description = str(normalized.get("description") or "").strip()
            normalized["title"] = f"{description[:10]}..."
        return normalized

    def _validate_template(
        self,
        project,
        task_template: dict,
        workflow: dict | None = None,
    ) -> None:
        if self._template_mode(task_template) == AGENT_MODE:
            if not str(task_template.get("instruction") or "").strip():
                raise ScheduleValidationError(
                    "task_template.instruction is required in agent mode"
                )
            candidates = task_template.get("candidate_workflow_ids") or []
            if candidates:
                active_ids = {
                    wf["id"]
                    for wf in project.workflows
                    if not wf.get("deleted")
                }
                missing = next(
                    (wid for wid in candidates if wid not in active_ids),
                    None,
                )
                if missing is not None:
                    raise ScheduleValidationError(
                        f"candidate workflow not found: {missing}"
                    )
            return
        start_key = task_template.get("start_step_key")
        if not start_key or workflow is None:
            return
        from services.workflow_definition import WorkflowDefinition
        keys = {
            item["key"]
            for item in WorkflowDefinition.load(workflow["steps"])
            .compile().to_steps_config()["steps"]
        }
        if str(start_key) not in keys:
            raise ScheduleValidationError(
                f"start_step_key does not exist: {start_key}"
            )

    def create(
        self,
        project_id: str,
        *,
        name: str,
        workflow_id: str,
        task_template: dict,
        rule: dict,
        execution_mode: str = "workflow",
        overlap_policy: str = "skip",
    ) -> dict:
        task_template = self._normalize_template(task_template)
        creator = current_actor_task_fields()
        if creator and "_creator" not in task_template:
            task_template["_creator"] = {
                "id": creator["creator_id"],
                "username": creator["creator_username"],
                "name": creator["creator_name"],
                "device_id": creator["creator_device_id"],
                "device_name": creator["creator_device_name"],
            }
        if execution_mode not in {"workflow", "immediate", "manual"}:
            raise ScheduleValidationError("Invalid execution_mode")
        if overlap_policy not in {"skip", "parallel", "queue"}:
            raise ScheduleValidationError("Invalid overlap_policy")
        if not str(name).strip():
            raise ScheduleValidationError("name is required")
        preview = preview_rule(rule)
        next_run_at = _as_utc(preview["next_runs"][0] if preview["next_runs"] else None)
        if next_run_at is None:
            raise ScheduleValidationError("The schedule has no future occurrence")
        with self._projects.activate_project_by_id(project_id) as project:
            if self._template_mode(task_template) == AGENT_MODE:
                workflow_id = str(workflow_id or "").strip()
                self._validate_template(project, task_template)
            else:
                workflow = self._workflow(project, workflow_id)
                self._validate_template(project, task_template, workflow)
            now = utc_now()
            row = Schedule.create(
                id=str(uuid.uuid4()),
                name=str(name).strip(),
                workflow_id=workflow_id,
                task_template_json=json.dumps(task_template, ensure_ascii=False),
                rule_json=json.dumps(rule, ensure_ascii=False),
                cron_expression=preview["cron_expression"],
                timezone=preview["timezone"],
                execution_mode=execution_mode,
                overlap_policy=overlap_policy,
                status="active",
                next_run_at=next_run_at,
                created_at=now,
                updated_at=now,
            )
            return self._to_dict(row)

    def list(self, project_id: str) -> list[dict]:
        with self._projects.activate_project_by_id(project_id):
            return [
                self._to_dict(row)
                for row in Schedule.select().order_by(Schedule.created_at.desc())
            ]

    def get(self, project_id: str, schedule_id: str) -> dict:
        with self._projects.activate_project_by_id(project_id):
            row = Schedule.get_or_none(Schedule.id == schedule_id)
            if row is None:
                raise ValueError(f"Schedule not found: {schedule_id}")
            return self._to_dict(row)

    def update(self, project_id: str, schedule_id: str, **changes) -> dict:
        with self._projects.activate_project_by_id(project_id) as project:
            row = Schedule.get_or_none(Schedule.id == schedule_id)
            if row is None:
                raise ValueError(f"Schedule not found: {schedule_id}")
            workflow_id = changes.get("workflow_id", row.workflow_id)
            task_template = changes.get(
                "task_template", json.loads(row.task_template_json)
            )
            existing_template = json.loads(row.task_template_json)
            task_template = self._normalize_template(task_template)
            if "_creator" not in task_template and isinstance(existing_template.get("_creator"), dict):
                task_template["_creator"] = existing_template["_creator"]
            if not task_template.get("_creator"):
                creator = current_actor_task_fields()
                if creator:
                    task_template["_creator"] = {
                        "id": creator["creator_id"],
                        "username": creator["creator_username"],
                        "name": creator["creator_name"],
                        "device_id": creator["creator_device_id"],
                        "device_name": creator["creator_device_name"],
                    }
            if self._template_mode(task_template) == AGENT_MODE:
                workflow_id = str(workflow_id or "").strip()
                self._validate_template(project, task_template)
            else:
                workflow = self._workflow(project, workflow_id)
                self._validate_template(project, task_template, workflow)
            rule = changes.get("rule", json.loads(row.rule_json))
            preview = preview_rule(rule)
            next_run = _as_utc(preview["next_runs"][0] if preview["next_runs"] else None)
            if next_run is None:
                raise ScheduleValidationError("The schedule has no future occurrence")
            execution_mode = changes.get("execution_mode", row.execution_mode)
            overlap_policy = changes.get("overlap_policy", row.overlap_policy)
            if execution_mode not in {"workflow", "immediate", "manual"}:
                raise ScheduleValidationError("Invalid execution_mode")
            if overlap_policy not in {"skip", "parallel", "queue"}:
                raise ScheduleValidationError("Invalid overlap_policy")
            row.name = str(changes.get("name", row.name)).strip()
            row.workflow_id = workflow_id
            row.task_template_json = json.dumps(task_template, ensure_ascii=False)
            row.rule_json = json.dumps(rule, ensure_ascii=False)
            row.cron_expression = preview["cron_expression"]
            row.timezone = preview["timezone"]
            row.execution_mode = execution_mode
            row.overlap_policy = overlap_policy
            if row.status in {"active", "invalid", "completed"}:
                row.status = "active"
                row.invalid_reason = None
                row.next_run_at = next_run
            row.updated_at = utc_now()
            row.save()
            return self._to_dict(row)

    def delete(self, project_id: str, schedule_id: str) -> None:
        with self._projects.activate_project_by_id(project_id):
            row = Schedule.get_or_none(Schedule.id == schedule_id)
            if row is None:
                raise ValueError(f"Schedule not found: {schedule_id}")
            ScheduleRun.delete().where(ScheduleRun.schedule == row).execute()
            row.delete_instance()

    @staticmethod
    def _run_to_dict(row: ScheduleRun) -> dict:
        # Older scheduler runs followed the workflow after task creation.
        # Their terminal workflow status does not describe the schedule trigger.
        task_created = bool(row.task_id) and row.status in {
            "running", "succeeded", "failed"
        }
        return {
            "id": row.id,
            "schedule_id": row.schedule_id,
            "scheduled_for": row.scheduled_for,
            "status": "created" if task_created else row.status,
            "reason": None if task_created else row.reason,
            "task_id": row.task_id,
            "workflow_run_id": row.workflow_run_id,
            "started_at": row.started_at,
            "ended_at": row.ended_at,
            "created_at": row.created_at,
        }

    def list_runs(
        self, project_id: str, schedule_id: str, limit: int = 50, offset: int = 0
    ) -> list[dict]:
        with self._projects.activate_project_by_id(project_id):
            if not Schedule.select().where(Schedule.id == schedule_id).exists():
                raise ValueError(f"Schedule not found: {schedule_id}")
            query = (
                ScheduleRun.select()
                .where(ScheduleRun.schedule == schedule_id)
                .order_by(ScheduleRun.scheduled_for.desc())
                .limit(limit)
                .offset(offset)
            )
            return [self._run_to_dict(row) for row in query]

    def _next_after(self, row: Schedule, current: datetime) -> datetime | None:
        rule = json.loads(row.rule_json)
        if rule.get("kind") == "once":
            return None
        preview = preview_rule(rule, now=current, count=1)
        return _as_utc(preview["next_runs"][0] if preview["next_runs"] else None)

    async def tick(self, now: datetime | None = None, *, startup: bool = False) -> None:
        """Claim due occurrences across every registered project."""
        current = now or utc_now()
        if current.tzinfo is None:
            current = current.replace(tzinfo=timezone.utc)
        for project in list(self._projects.iter_projects()):
            def claim_due():
                due_ids: list[str] = []
                queued_schedule_ids: set[str] = set()
                self._reconcile_running_rows()
                active_rows = list(Schedule.select().where(Schedule.status == "active"))
                for row in active_rows:
                    if row.next_run_at is None or row.next_run_at > current:
                        continue
                    if startup:
                        next_run = self._next_after(row, current)
                        if next_run is None:
                            row.status = "completed"
                            row.invalid_reason = "expired"
                        row.next_run_at = next_run
                        row.updated_at = current
                        row.save()
                        continue
                    scheduled_for = row.next_run_at
                    prior_active = ScheduleRun.select().where(
                        (ScheduleRun.schedule == row)
                        & (ScheduleRun.status.in_(("queued", "running")))
                    ).exists()
                    run_id = str(uuid.uuid4())
                    try:
                        run = ScheduleRun.create(
                            id=run_id,
                            schedule=row,
                            scheduled_for=scheduled_for,
                            status="queued",
                            created_at=current,
                        )
                    except Exception as exc:
                        # A unique occurrence already exists; another tick claimed it.
                        if "UNIQUE" in str(exc).upper():
                            continue
                        raise
                    row.last_run_at = scheduled_for
                    row.next_run_at = self._next_after(row, current)
                    if row.next_run_at is None:
                        row.status = "completed"
                    row.updated_at = current
                    row.save()
                    if prior_active and row.overlap_policy == "skip":
                        run.status = "skipped"
                        run.reason = "previous run is still active"
                        run.ended_at = current
                        run.save()
                    elif prior_active and row.overlap_policy == "queue":
                        queued_schedule_ids.add(row.id)
                    else:
                        due_ids.append(run_id)
                queued_schedule_ids.update(
                    item.schedule_id
                    for item in ScheduleRun.select(ScheduleRun.schedule).where(
                        ScheduleRun.status == "queued"
                    )
                )
                return due_ids, queued_schedule_ids

            due_ids, queued_schedule_ids = await self._run_db(
                project.id, claim_due
            )
            for run_id in due_ids:
                self._spawn(
                    self._execute_run(project.id, run_id),
                    name=f"schedule-run:{run_id}",
                )
            for schedule_id in queued_schedule_ids:
                await self._drain_queue(project.id, schedule_id)
            await self._tick_scheduled_tasks(project.id, current, startup=startup)

    async def _tick_scheduled_tasks(
        self, project_id: str, current: datetime, *, startup: bool,
    ) -> None:
        """Start one-shot task timers, or mark missed timers during recovery."""
        def claim_tasks():
            rows = list(Task.select().where(
                Task.scheduled_start_at.is_null(False),
                Task.scheduled_start_at <= current,
                Task.scheduled_start_state.in_(("pending", "dispatching")),
            ))
            if startup:
                for task in rows:
                    task.scheduled_start_state = "missed"
                    task.scheduled_start_error = "应用未运行，错过了定时启动时间"
                    task.updated_at = current
                    task.save()
                missed = [(task.id, task.scheduled_start_at) for task in rows]
            else:
                missed = []
                for task in rows:
                    task.scheduled_start_state = "dispatching"
                    task.updated_at = current
                    task.save()
            return missed, [task.id for task in rows] if not startup else []

        missed, dispatch_ids = await self._run_db(project_id, claim_tasks)
        for task_id in dispatch_ids:
            self._spawn(
                self._execute_scheduled_task(project_id, task_id),
                name=f"scheduled-task:{task_id}",
            )
        for task_id, scheduled_at in missed:
            await self._publish_scheduled_event(
                project_id, task_id, "missed", scheduled_at, "应用未运行，错过了定时启动时间"
            )

    async def _execute_scheduled_task(self, project_id: str, task_id: str) -> None:
        def load_scheduled_at():
            task = Task.get_or_none(Task.id == task_id)
            return task.scheduled_start_at if task else None

        scheduled_at = await self._run_db(project_id, load_scheduled_at)
        if scheduled_at is None:
            return
        try:
            await self._runtime.start(
                project_id, task_id, "", source="scheduled_start"
            )
        except asyncio.CancelledError:
            # A user stop cancels the workflow coroutine. The one-shot timer
            # must be consumed as well, otherwise the next polling tick sees
            # the stale dispatching row and starts the same task again.
            await self._run_db(
                project_id, lambda: self._tasks.clear_scheduled_start(task_id)
            )
            await self._publish_scheduled_event(project_id, task_id, None, scheduled_at, None)
            return
        except Exception as exc:
            await self._run_db(
                project_id,
                lambda: self._tasks.mark_scheduled_start(task_id, "failed", str(exc)),
            )
            await self._publish_scheduled_event(project_id, task_id, "failed", scheduled_at, str(exc))
            return
        await self._run_db(
            project_id, lambda: self._tasks.clear_scheduled_start(task_id)
        )
        await self._publish_scheduled_event(project_id, task_id, None, scheduled_at, None)

    async def _publish_scheduled_event(
        self, project_id: str, task_id: str, state: str | None, scheduled_at,
        error: str | None,
    ) -> None:
        event_bus = getattr(self._tasks, "_event_bus", None)
        if event_bus is None:
            return
        await event_bus.publish({
            "type": "CUSTOM",
            "project_id": project_id,
            "name": "workstep.scheduled_start",
            "value": {
                "task_id": task_id,
                "scheduled_start_at": scheduled_at.isoformat() if scheduled_at else None,
                "scheduled_start_state": state,
                "scheduled_start_error": error,
            },
            "task_id": task_id,
        })

    def _reconcile_running_rows(self) -> None:
        for run in ScheduleRun.select().where(ScheduleRun.status == "running"):
            if not run.task_id:
                continue
            run.status = "created"
            run.reason = None
            run.ended_at = run.ended_at or utc_now()
            run.save()

    async def _drain_queue(self, project_id: str, schedule_id: str) -> None:
        if self._closing:
            return

        def next_queued_run():
            running = ScheduleRun.select().where(
                (ScheduleRun.schedule == schedule_id)
                & (ScheduleRun.status == "running")
            ).exists()
            if running:
                return None
            queued = (
                ScheduleRun.select()
                .where(
                    (ScheduleRun.schedule == schedule_id)
                    & (ScheduleRun.status == "queued")
                )
                .order_by(ScheduleRun.scheduled_for)
                .first()
            )
            if queued is None:
                return None
            return queued.id

        run_id = await self._run_db(project_id, next_queued_run)
        if run_id is None:
            return
        if any(task.get_name() == f"schedule-run:{run_id}" for task in self._workers):
            return
        self._spawn(
            self._execute_run(project_id, run_id),
            name=f"schedule-run:{run_id}",
        )

    async def _execute_run(self, project_id: str, run_id: str) -> None:
        schedule_id = ""
        try:
            def start_run():
                run = ScheduleRun.get_by_id(run_id)
                schedule = Schedule.get_by_id(run.schedule_id)
                template = json.loads(schedule.task_template_json)
                run.status = "running"
                run.started_at = utc_now()
                run.save()
                return (
                    schedule.id,
                    template,
                    schedule.workflow_id,
                    schedule.execution_mode,
                )

            schedule_id, template, workflow_id, execution_mode = await self._run_db(
                project_id, start_run
            )
            from services.task_creation import create_project_task
            if self._template_mode(template) == AGENT_MODE:
                result = await self._run_agent_attempts(
                    project_id, template, execution_mode
                )
            else:
                result = await create_project_task(
                    project_manager=self._projects,
                    task_service=self._tasks,
                    workflow_runtime=self._runtime,
                    project_id=project_id,
                    title=str(template["title"]),
                    description=template.get("description"),
                    engine=self._resolve_engine(template),
                    workflow_id=workflow_id,
                    start_step_key=template.get("start_step_key"),
                    review_overrides=template.get("review_overrides"),
                    execution_mode=execution_mode,
                    source="schedule",
                    creator_fields=self._template_creator_fields(template),
                )
            await self._attach_task_result(project_id, run_id, result)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            def fail_run():
                nonlocal schedule_id
                run = ScheduleRun.get_or_none(ScheduleRun.id == run_id)
                if run is not None:
                    schedule_id = schedule_id or run.schedule_id
                    run.status = "failed"
                    run.reason = str(exc)
                    run.ended_at = utc_now()
                    run.save()
                schedule = Schedule.get_or_none(Schedule.id == schedule_id)
                if schedule is not None and "Workflow not found" in str(exc):
                    schedule.status = "invalid"
                    schedule.invalid_reason = str(exc)
                    schedule.next_run_at = None
                    schedule.updated_at = utc_now()
                    schedule.save()

            await self._run_db(project_id, fail_run)
        finally:
            if schedule_id:
                await self._drain_queue(project_id, schedule_id)

    @staticmethod
    def _resolve_engine(template: dict) -> str:
        return str(
            template.get("engine")
            or config_store.get_execution_default_engine()
            or DEFAULT_EXECUTION_ENGINE
        )

    async def _run_agent_attempts(
        self,
        project_id: str,
        template: dict,
        execution_mode: str,
    ) -> object:
        """Run the task agent (with retries), then create the task from its result."""
        from services.task_creation import create_project_task

        if self._task_agent is None:
            raise RuntimeError("Task agent is not initialized")
        instruction = str(template.get("instruction") or "").strip()
        if not instruction:
            raise ScheduleValidationError(
                "task_template.instruction is required in agent mode"
            )
        candidates = list(template.get("candidate_workflow_ids") or [])
        try:
            retry_count = int(
                template.get("retry_count") or DEFAULT_AGENT_RETRY_COUNT
            )
        except (TypeError, ValueError):
            retry_count = DEFAULT_AGENT_RETRY_COUNT
        retry_count = max(0, retry_count)
        last_error: str | None = None
        for attempt in range(retry_count + 1):
            try:
                result = await self._task_agent.run_schedule(
                    project_id,
                    instruction=instruction,
                    title=template.get("title"),
                    description=template.get("description"),
                    candidate_workflow_ids=candidates,
                    retry_feedback=last_error,
                    timeout=SCHEDULE_AGENT_TIMEOUT_SECONDS,
                )
                break
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                last_error = f"attempt {attempt + 1}: {exc}"
        else:
            raise RuntimeError(
                "Scheduled task agent failed after "
                f"{retry_count + 1} attempts: {last_error}"
            )
        return await create_project_task(
            project_manager=self._projects,
            task_service=self._tasks,
            workflow_runtime=self._runtime,
            project_id=project_id,
            title=str(result["title"]),
            description=result.get("description"),
            engine=self._resolve_engine(template),
            workflow_id=result["workflow_id"],
            start_step_key=result.get("start_step_key"),
            review_overrides=None,
            execution_mode=execution_mode,
            source="schedule",
            creator_fields=self._template_creator_fields(template),
        )

    async def _attach_task_result(self, project_id, run_id, result) -> None:
        task = result.task

        def attach_task():
            run = ScheduleRun.get_by_id(run_id)
            run.task_id = task["id"]
            run.workflow_run_id = (
                result.run_handle.id if result.run_handle is not None else None
            )
            run.status = "created"
            run.reason = None
            run.ended_at = utc_now()
            run.save()

        await self._run_db(project_id, attach_task)

    def _get_row(self, project_id: str, schedule_id: str) -> Schedule:
        with self._projects.activate_project_by_id(project_id):
            row = Schedule.get_or_none(Schedule.id == schedule_id)
            if row is None:
                raise ValueError(f"Schedule not found: {schedule_id}")
            return row

    def pause(self, project_id: str, schedule_id: str) -> dict:
        with self._projects.activate_project_by_id(project_id):
            row = Schedule.get_or_none(Schedule.id == schedule_id)
            if row is None:
                raise ValueError(f"Schedule not found: {schedule_id}")
            row.status = "paused"
            row.next_run_at = None
            row.updated_at = utc_now()
            row.save()
            return self._to_dict(row)

    def resume(self, project_id: str, schedule_id: str) -> dict:
        with self._projects.activate_project_by_id(project_id) as project:
            row = Schedule.get_or_none(Schedule.id == schedule_id)
            if row is None:
                raise ValueError(f"Schedule not found: {schedule_id}")
            template = json.loads(row.task_template_json)
            if self._template_mode(template) != AGENT_MODE:
                self._workflow(project, row.workflow_id)
            rule = json.loads(row.rule_json)
            preview = preview_rule(rule)
            next_run = _as_utc(preview["next_runs"][0] if preview["next_runs"] else None)
            if next_run is None:
                row.status = "completed"
                row.invalid_reason = "expired"
                row.next_run_at = None
            else:
                row.status = "active"
                row.invalid_reason = None
                row.next_run_at = next_run
            row.updated_at = utc_now()
            row.save()
            return self._to_dict(row)
