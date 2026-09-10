"""Project schedule module: rule compilation, persistence and dispatch."""

from __future__ import annotations

import asyncio
from datetime import date, datetime, time, timedelta, timezone
import json
import uuid
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter

from models import Schedule, ScheduleRun, Task
from models.fields import utc_now
from services.config import DEFAULT_EXECUTION_ENGINE, config_store


class ScheduleValidationError(ValueError):
    """A schedule rule cannot be normalized or executed."""


# task_template.mode: "static" (default, backward compatible) or "agent".
AGENT_MODE = "agent"
DEFAULT_AGENT_RETRY_COUNT = 2
# Bounded wall-clock budget for one agent-mode run attempt.
SCHEDULE_AGENT_TIMEOUT_SECONDS = 10 * 60


def _zone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name or datetime.now().astimezone().tzinfo.key)
    except (ZoneInfoNotFoundError, AttributeError, TypeError) as exc:
        raise ScheduleValidationError(f"Unknown timezone: {name}") from exc


def _clock(value: object) -> tuple[int, int]:
    try:
        parsed = time.fromisoformat(str(value))
    except ValueError as exc:
        raise ScheduleValidationError("time must use HH:MM") from exc
    return parsed.hour, parsed.minute


def _effective_range(rule: dict, zone: ZoneInfo) -> tuple[datetime | None, datetime | None]:
    try:
        start_date = date.fromisoformat(str(rule["start_date"])) if rule.get("start_date") else None
        end_date = date.fromisoformat(str(rule["end_date"])) if rule.get("end_date") else None
    except ValueError as exc:
        raise ScheduleValidationError("effective dates must use YYYY-MM-DD") from exc
    if start_date and end_date and start_date > end_date:
        raise ScheduleValidationError("start_date must not be after end_date")
    start = datetime.combine(start_date, time.min, zone) if start_date else None
    end = datetime.combine(end_date + timedelta(days=1), time.min, zone) if end_date else None
    return start, end


def _interval_runs(
    rule: dict,
    *,
    zone: ZoneInfo,
    current: datetime,
    count: int,
) -> list[datetime]:
    if rule.get("unit") != "hours":
        raise ScheduleValidationError("interval unit must be hours")
    try:
        every = int(rule.get("every"))
        weekdays = sorted({int(day) for day in rule.get("weekdays", [])})
    except (TypeError, ValueError) as exc:
        raise ScheduleValidationError("invalid interval configuration") from exc
    if every < 1 or every > 24:
        raise ScheduleValidationError("interval every must be between 1 and 24 hours")
    if not weekdays or any(day < 0 or day > 6 for day in weekdays):
        raise ScheduleValidationError("weekdays must contain values from 0 to 6")

    start, end = _effective_range(rule, zone)
    local_current = current.astimezone(zone)
    cursor_date = max(local_current.date(), start.date() if start else local_current.date())
    results: list[datetime] = []
    while len(results) < count:
        day_start = datetime.combine(cursor_date, time.min, zone)
        if end and day_start >= end:
            break
        cron_weekday = (cursor_date.weekday() + 1) % 7
        if cron_weekday in weekdays:
            for hour in range(0, 24, every):
                candidate = day_start + timedelta(hours=hour)
                if candidate <= local_current or (start and candidate < start):
                    continue
                if end and candidate >= end:
                    return results
                results.append(candidate.astimezone(timezone.utc))
                if len(results) >= count:
                    break
        cursor_date += timedelta(days=1)
    return results


def compile_rule(rule: dict) -> tuple[str | None, str, datetime | None]:
    """Return canonical cron, timezone and one-time UTC instant."""
    kind = str(rule.get("kind") or "")
    zone_name = str(rule.get("timezone") or datetime.now().astimezone().tzinfo)
    zone = _zone(zone_name)
    if kind == "once":
        try:
            run_at = datetime.fromisoformat(str(rule.get("run_at")))
        except ValueError as exc:
            raise ScheduleValidationError("run_at must be an ISO datetime") from exc
        if run_at.tzinfo is None:
            run_at = run_at.replace(tzinfo=zone)
        return None, zone_name, run_at.astimezone(timezone.utc)

    _effective_range(rule, zone)
    if kind == "interval":
        _interval_runs(
            rule,
            zone=zone,
            current=datetime.now(timezone.utc),
            count=1,
        )
        return None, zone_name, None

    hour, minute = _clock(rule.get("time", "00:00")) if kind != "cron" else (0, 0)
    if kind == "daily":
        expression = f"{minute} {hour} * * *"
    elif kind == "weekly":
        weekdays = sorted({int(day) for day in rule.get("weekdays", [])})
        if not weekdays or any(day < 0 or day > 6 for day in weekdays):
            raise ScheduleValidationError("weekdays must contain values from 0 to 6")
        expression = f"{minute} {hour} * * {','.join(map(str, weekdays))}"
    elif kind == "monthly":
        monthdays = sorted({int(day) for day in rule.get("monthdays", [])})
        if not monthdays or any(day < 1 or day > 31 for day in monthdays):
            raise ScheduleValidationError("monthdays must contain values from 1 to 31")
        expression = f"{minute} {hour} {','.join(map(str, monthdays))} * *"
    elif kind == "cron":
        expression = str(rule.get("expression") or "").strip()
        if len(expression.split()) != 5:
            raise ScheduleValidationError("cron expression must contain five fields")
    else:
        raise ScheduleValidationError(f"Unknown schedule kind: {kind}")
    if not croniter.is_valid(expression):
        raise ScheduleValidationError("Invalid cron expression")
    return expression, zone_name, None


def preview_rule(
    rule: dict,
    *,
    now: datetime | None = None,
    count: int = 5,
) -> dict:
    cron_expression, zone_name, run_at = compile_rule(rule)
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    if run_at is not None:
        next_runs = [run_at] if run_at > current else []
    elif rule.get("kind") == "interval":
        next_runs = _interval_runs(
            rule,
            zone=_zone(zone_name),
            current=current,
            count=max(1, min(count, 20)),
        )
    else:
        zone = _zone(zone_name)
        local_now = current.astimezone(zone)
        start, end = _effective_range(rule, zone)
        iterator = croniter(
            cron_expression,
            max(local_now, start - timedelta(microseconds=1)) if start else local_now,
        )
        next_runs = []
        for _ in range(max(1, min(count, 20))):
            candidate = iterator.get_next(datetime)
            if end and candidate >= end:
                break
            next_runs.append(candidate.astimezone(timezone.utc))
    return {
        "cron_expression": cron_expression,
        "timezone": zone_name,
        "summary": describe_rule(rule),
        "next_runs": [value.isoformat() for value in next_runs],
    }


def describe_rule(rule: dict) -> str:
    kind = rule.get("kind")
    if kind == "once":
        return f"Once at {rule.get('run_at')}"
    if kind == "daily":
        return f"Daily at {rule.get('time')}"
    if kind == "weekly":
        return f"Weekly on {','.join(map(str, rule.get('weekdays', [])))} at {rule.get('time')}"
    if kind == "monthly":
        return f"Monthly on {','.join(map(str, rule.get('monthdays', [])))} at {rule.get('time')}"
    if kind == "interval":
        return f"Every {rule.get('every')} hours on {','.join(map(str, rule.get('weekdays', [])))}"
    return f"Cron {rule.get('expression', '')}"


def _as_utc(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


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
        return {
            "id": row.id,
            "name": row.name,
            "workflow_id": row.workflow_id,
            "task_template": json.loads(row.task_template_json),
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
            task_template = self._normalize_template(task_template)
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
        return {
            "id": row.id,
            "schedule_id": row.schedule_id,
            "scheduled_for": row.scheduled_for,
            "status": row.status,
            "reason": row.reason,
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
                task_id, "missed", scheduled_at, "应用未运行，错过了定时启动时间"
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
            await self._publish_scheduled_event(task_id, None, scheduled_at, None)
            return
        except Exception as exc:
            await self._run_db(
                project_id,
                lambda: self._tasks.mark_scheduled_start(task_id, "failed", str(exc)),
            )
            await self._publish_scheduled_event(task_id, "failed", scheduled_at, str(exc))
            return
        await self._run_db(
            project_id, lambda: self._tasks.clear_scheduled_start(task_id)
        )
        await self._publish_scheduled_event(task_id, None, scheduled_at, None)

    async def _publish_scheduled_event(
        self, task_id: str, state: str | None, scheduled_at, error: str | None,
    ) -> None:
        event_bus = getattr(self._tasks, "_event_bus", None)
        if event_bus is None:
            return
        await event_bus.publish({
            "type": "CUSTOM",
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
        from models import WorkflowRun

        for run in ScheduleRun.select().where(ScheduleRun.status == "running"):
            if not run.workflow_run_id:
                continue
            workflow_run = WorkflowRun.get_or_none(WorkflowRun.id == run.workflow_run_id)
            if workflow_run is None or workflow_run.status == "running":
                continue
            run.status = "succeeded" if workflow_run.status == "succeeded" else "failed"
            run.reason = None if run.status == "succeeded" else workflow_run.status
            run.ended_at = workflow_run.ended_at or utc_now()
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
        )

    async def _attach_task_result(self, project_id, run_id, result) -> None:
        task = result.task

        def attach_task():
            run = ScheduleRun.get_by_id(run_id)
            run.task_id = task["id"]
            if result.run_handle is None:
                run.status = "created"
                run.ended_at = utc_now()
                run.save()
                return True
            run.workflow_run_id = result.run_handle.id
            run.save()
            return False

        if await self._run_db(project_id, attach_task):
            return
        handle = result.run_handle
        # Stopping the scheduler must not propagate cancellation into the
        # workflow runtime, which owns and recovers the actual execution.
        await asyncio.shield(self._runtime.wait(handle))

        def finish_run():
            from models import WorkflowRun
            run = ScheduleRun.get_by_id(run_id)
            workflow_run = WorkflowRun.get_by_id(handle.id)
            run.status = (
                "succeeded" if workflow_run.status == "succeeded" else "failed"
            )
            run.reason = None if run.status == "succeeded" else workflow_run.status
            run.ended_at = workflow_run.ended_at or utc_now()
            run.save()

        await self._run_db(project_id, finish_run)

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
