"""Cross-project statistics aggregation for the dashboard."""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from models import ChatMessage, ChatSession, Message, ReviewRun, StepRun, Task, WorkflowRun
from models.fields import utc_now
from services.config import config_store
from services.usage_accounting import parse_usage, usage_cost


RANGE_DAYS = {"7d": 7, "30d": 30, "90d": 90}
TERMINAL_RUN_STATUSES = {"succeeded", "failed"}
TERMINAL_MESSAGE_STATUSES = {
    "succeeded", "failed", "stopped", "cancelled", "completed", "error",
}
USAGE_CHANNELS = {"execution", "review", "coordinator"}


@dataclass(frozen=True)
class StatisticsQuery:
    project_id: str | None = None
    workflow_id: str | None = None
    range_key: str = "30d"
    start: datetime | None = None
    end: datetime | None = None
    timezone: str = "UTC"
    now: datetime | None = None


@dataclass
class Period:
    start: datetime
    end: datetime
    timezone: ZoneInfo
    granularity: str
    range_key: str


class MetricBucket:
    """Mutable implementation detail used to build one report row."""

    def __init__(self) -> None:
        self.task_count = 0
        self.statuses: dict[str, int] = defaultdict(int)
        self.restart_count = 0
        self.durations: list[int] = []
        self.input_tokens = 0
        self.cache_input_tokens = 0
        self.output_tokens = 0
        self.cache_read_tokens = 0
        self.cache_write_tokens = 0
        self.total_tokens = 0
        self.cost = 0.0
        self.usage_calls = 0
        self.eligible_calls = 0

    def add_run(self, run: WorkflowRun) -> None:
        self.statuses[run.status] += 1
        if run.parent_run_id:
            self.restart_count += 1
        duration = _duration_ms(run.started_at, run.ended_at)
        if run.status in TERMINAL_RUN_STATUSES and duration is not None:
            self.durations.append(duration)

    def add_usage(self, usage: dict[str, Any], cost: float = 0) -> None:
        self.input_tokens += usage["input_tokens"]
        self.cache_input_tokens += (
            usage["input_tokens"]
            if usage.get("cache_input_included") is not False
            else usage["input_tokens"] + usage["cache_read_tokens"] + usage["cache_write_tokens"]
        )
        self.output_tokens += usage["output_tokens"]
        self.cache_read_tokens += usage["cache_read_tokens"]
        self.cache_write_tokens += usage["cache_write_tokens"]
        self.total_tokens += usage["total_tokens"]
        self.cost += cost
        self.usage_calls += 1

    def report(self) -> dict[str, Any]:
        succeeded = self.statuses["succeeded"]
        failed = self.statuses["failed"]
        terminal = succeeded + failed
        return {
            "task_count": self.task_count,
            "run_count": sum(self.statuses.values()),
            "succeeded_runs": succeeded,
            "failed_runs": failed,
            "running_runs": self.statuses["running"],
            "paused_runs": self.statuses["paused"],
            "superseded_runs": self.statuses["superseded"],
            "success_rate": _ratio(succeeded, terminal),
            "restart_count": self.restart_count,
            "average_duration_ms": _average(self.durations),
            "p50_duration_ms": _percentile(self.durations, 0.5),
            "p95_duration_ms": _percentile(self.durations, 0.95),
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_read_tokens": self.cache_read_tokens,
            "cache_write_tokens": self.cache_write_tokens,
            "cache_rate": min(1, _ratio(self.cache_read_tokens, self.cache_input_tokens))
            if self.cache_input_tokens else None,
            "total_tokens": self.total_tokens,
            "cost": round(self.cost, 6),
            "token_coverage": _ratio(self.usage_calls, self.eligible_calls),
        }


class StatisticsModule:
    """Hide cross-database aggregation behind one dashboard interface."""

    def __init__(self, project_manager):
        self._project_manager = project_manager

    def overview(
        self,
        query: StatisticsQuery,
        *,
        include_comparison: bool = True,
    ) -> dict[str, Any]:
        projects = self._resolve_projects(query)
        period = self._resolve_period(query)
        pricing = config_store.get_model_pricing()

        global_bucket = MetricBucket()
        project_buckets: dict[str, MetricBucket] = {
            project.id: MetricBucket() for project in projects
        }
        workflow_buckets: dict[tuple[str, str], MetricBucket] = {}
        step_buckets: dict[str, dict[str, Any]] = {}
        engine_buckets: dict[tuple[str, str], dict[str, Any]] = {}
        user_buckets: dict[str, dict[str, Any]] = {}
        quality = {
            "step_attempt_count": 0,
            "step_succeeded": 0,
            "step_failed": 0,
            "step_cancelled": 0,
            "retry_count": 0,
            "review_passed": 0,
            "review_rejected": 0,
            "review_pending": 0,
            "review_durations": [],
        }
        trend: dict[str, MetricBucket] = {}
        workflow_meta: dict[tuple[str, str], dict[str, Any]] = {}
        earliest: datetime | None = None

        for project in projects:
            project_bucket = project_buckets[project.id]
            for workflow in project.workflows:
                workflow_meta[(project.id, workflow["id"])] = workflow
                workflow_buckets[(project.id, workflow["id"])] = MetricBucket()

            with self._project_manager.activate_project_by_id(project.id):
                tasks = list(Task.select())
                task_by_id = {task.id: task for task in tasks}
                scoped_tasks = {
                    task.id: task
                    for task in tasks
                    if self._workflow_matches(task.workflow_id, query.workflow_id)
                }

                for task in scoped_tasks.values():
                    if _in_period(task.created_at, period):
                        global_bucket.task_count += 1
                        project_bucket.task_count += 1
                        workflow_bucket = self._workflow_bucket(
                            workflow_buckets, project.id, task.workflow_id,
                        )
                        workflow_bucket.task_count += 1
                        earliest = _earlier(earliest, task.created_at)

                runs = list(
                    WorkflowRun.select()
                    .where(WorkflowRun.task.in_(tuple(scoped_tasks) or ("",)))
                )
                run_by_id = {run.id: run for run in runs}
                for run in runs:
                    if not _in_period(run.started_at, period):
                        continue
                    task = task_by_id[run.task_id]
                    global_bucket.add_run(run)
                    project_bucket.add_run(run)
                    self._workflow_bucket(
                        workflow_buckets, project.id, task.workflow_id,
                    ).add_run(run)
                    self._trend_bucket(trend, run.started_at, period).add_run(run)
                    earliest = _earlier(earliest, run.started_at)

                step_runs = list(
                    StepRun.select()
                    .where(StepRun.run.in_(tuple(run_by_id) or ("",)))
                )
                for step_run in step_runs:
                    run = run_by_id.get(step_run.run_id)
                    if run is None or not _in_period(step_run.started_at, period):
                        continue
                    task = task_by_id[run.task_id]
                    quality["step_attempt_count"] += 1
                    quality["step_succeeded"] += int(step_run.status == "succeeded")
                    quality["step_failed"] += int(step_run.status == "failed")
                    quality["step_cancelled"] += int(step_run.status == "cancelled")
                    quality["retry_count"] += int(step_run.attempt > 1)
                    engine_key = (step_run.engine or "unknown", step_run.model or "")
                    engine = engine_buckets.setdefault(engine_key, _new_engine_bucket())
                    engine["attempt_count"] += 1
                    if step_run.status == "succeeded":
                        engine["succeeded_attempts"] += 1
                    elif step_run.status in {"failed", "cancelled"}:
                        engine["failed_attempts"] += 1
                    duration = _duration_ms(step_run.started_at, step_run.ended_at)
                    if duration is not None:
                        engine["durations"].append(duration)

                    if query.workflow_id is not None:
                        step = step_buckets.setdefault(
                            step_run.step_key,
                            _new_step_bucket(step_run.step_key),
                        )
                        step["attempt_count"] += 1
                        step["succeeded_attempts"] += int(step_run.status == "succeeded")
                        step["failed_attempts"] += int(step_run.status == "failed")
                        step["cancelled_attempts"] += int(step_run.status == "cancelled")
                        step["retry_count"] += int(step_run.attempt > 1)
                        if duration is not None:
                            step["durations"].append(duration)

                reviews = list(
                    ReviewRun.select()
                    .where(ReviewRun.workflow_run.in_(tuple(run_by_id) or ("",)))
                )
                for review in reviews:
                    if not _in_period(review.started_at, period):
                        continue
                    quality["review_passed"] += int(review.status == "passed")
                    quality["review_rejected"] += int(review.status == "rejected")
                    quality["review_pending"] += int(review.status in {"pending", "running"})
                    review_duration = _duration_ms(review.started_at, review.ended_at)
                    if review_duration is not None:
                        quality["review_durations"].append(review_duration)
                    if query.workflow_id is not None:
                        step = step_buckets.setdefault(
                            review.step_key,
                            _new_step_bucket(review.step_key),
                        )
                        step["review_passed"] += int(review.status == "passed")
                        step["review_rejected"] += int(review.status == "rejected")
                        step["review_pending"] += int(review.status in {"pending", "running"})
                        if review_duration is not None:
                            step["review_durations"].append(review_duration)

                messages = list(
                    Message.select()
                    .where(Message.task.in_(tuple(scoped_tasks) or ("",)))
                )
                for message in messages:
                    if not self._eligible_message(message, period):
                        continue
                    task = task_by_id[message.task_id]
                    global_bucket.eligible_calls += 1
                    project_bucket.eligible_calls += 1
                    workflow_bucket = self._workflow_bucket(
                        workflow_buckets, project.id, task.workflow_id,
                    )
                    workflow_bucket.eligible_calls += 1
                    usage = parse_usage(message.usage_json, message.engine)
                    if usage is None:
                        continue
                    cost = usage_cost(
                        usage,
                        message.model or "",
                        pricing,
                        engine=message.engine or "",
                    )
                    global_bucket.add_usage(usage, cost)
                    project_bucket.add_usage(usage, cost)
                    workflow_bucket.add_usage(usage, cost)
                    self._trend_bucket(trend, message.started_at or message.created_at, period).add_usage(usage, cost)
                    earliest = _earlier(earliest, message.started_at or message.created_at)

                    engine_key = (message.engine or "unknown", message.model or "")
                    engine = engine_buckets.setdefault(engine_key, _new_engine_bucket())
                    engine["call_count"] += 1
                    _add_usage_to_dict(engine, usage)
                    engine["cost"] += cost
                    _add_user_usage(
                        user_buckets,
                        (message.initiated_by_user_id if message.author_type in
                         {"assistant", "system", "scheduler"} else message.author_id),
                        (message.initiated_by_username if message.author_type in
                         {"assistant", "system", "scheduler"} else message.author_name),
                        usage,
                        cost,
                    )

                    if query.workflow_id is not None and message.channel in {"execution", "review"}:
                        step = step_buckets.setdefault(
                            message.step_key,
                            _new_step_bucket(message.step_key),
                        )
                        step["total_tokens"] += usage["total_tokens"]

                chat_query = (
                    ChatMessage.select(ChatMessage, ChatSession)
                    .join(ChatSession)
                    .where(ChatSession.project_id == project.id)
                )
                if query.workflow_id is not None:
                    chat_query = chat_query.where(
                        ChatSession.workflow_id == query.workflow_id
                    )
                for message in chat_query:
                    timestamp = message.created_at
                    if not (
                        message.role == "assistant"
                        and message.status in TERMINAL_MESSAGE_STATUSES
                        and _in_period(timestamp, period)
                    ):
                        continue
                    global_bucket.eligible_calls += 1
                    project_bucket.eligible_calls += 1
                    workflow_id = message.session.workflow_id or None
                    workflow_bucket = None
                    if workflow_id:
                        workflow_bucket = self._workflow_bucket(
                            workflow_buckets,
                            project.id,
                            workflow_id,
                        )
                        workflow_bucket.eligible_calls += 1
                    usage = parse_usage(message.usage_json, message.engine)
                    if usage is None:
                        continue
                    cost = usage_cost(
                        usage,
                        message.model or "",
                        pricing,
                        engine=message.engine or "",
                    )
                    global_bucket.add_usage(usage, cost)
                    project_bucket.add_usage(usage, cost)
                    if workflow_bucket is not None:
                        workflow_bucket.add_usage(usage, cost)
                    self._trend_bucket(trend, timestamp, period).add_usage(usage, cost)
                    earliest = _earlier(earliest, timestamp)
                    engine_key = (message.engine or "unknown", message.model or "")
                    engine = engine_buckets.setdefault(engine_key, _new_engine_bucket())
                    engine["call_count"] += 1
                    _add_usage_to_dict(engine, usage)
                    engine["cost"] += cost
                    _add_user_usage(
                        user_buckets,
                        (message.initiated_by_user_id if message.author_type in
                         {"assistant", "system", "scheduler"} else message.author_id),
                        (message.initiated_by_username if message.author_type in
                         {"assistant", "system", "scheduler"} else message.author_name),
                        usage,
                        cost,
                    )

        if query.range_key == "all":
            period = self._all_time_period(period, earliest)

        self._fill_trend(trend, period)
        scope = self._scope(query, projects, workflow_meta)
        summary = global_bucket.report()
        summary["project_count"] = len(projects)
        summary["workflow_count"] = self._workflow_count(projects, query)

        step_terminal = (
            quality["step_succeeded"]
            + quality["step_failed"]
            + quality["step_cancelled"]
        )
        review_terminal = quality["review_passed"] + quality["review_rejected"]
        quality_report = {
            "step_attempt_count": quality["step_attempt_count"],
            "step_failed": quality["step_failed"],
            "step_cancelled": quality["step_cancelled"],
            "step_failure_rate": _ratio(
                quality["step_failed"] + quality["step_cancelled"],
                step_terminal,
            ),
            "retry_count": quality["retry_count"],
            "review_passed": quality["review_passed"],
            "review_rejected": quality["review_rejected"],
            "review_pending": quality["review_pending"],
            "review_pass_rate": _ratio(quality["review_passed"], review_terminal),
            "average_review_duration_ms": _average(quality["review_durations"]),
        }

        report = {
            "currency": pricing["currency"],
            "scope": scope,
            "period": self._period_report(period),
            "summary": summary,
            "trend": [self._trend_report(key, trend[key]) for key in sorted(trend)],
            "projects": self._project_reports(projects, project_buckets) if query.project_id is None else [],
            "workflows": self._workflow_reports(
                projects, workflow_buckets, workflow_meta, query,
            ) if query.project_id is not None and query.workflow_id is None else [],
            "steps": self._step_reports(step_buckets, projects, query),
            "engines": self._engine_reports(engine_buckets),
            "users": _user_reports(user_buckets),
            "quality": quality_report,
            "data_quality": {
                "eligible_token_calls": global_bucket.eligible_calls,
                "reported_token_calls": global_bucket.usage_calls,
                "token_coverage": summary["token_coverage"],
            },
        }
        report["comparison"] = self._comparison(query, period, report) if include_comparison else None
        return report

    def _comparison(
        self,
        query: StatisticsQuery,
        period: Period,
        current_report: dict[str, Any],
    ) -> dict[str, Any] | None:
        if query.range_key == "all":
            return None
        duration = period.end - period.start
        previous = self.overview(StatisticsQuery(
            project_id=query.project_id,
            workflow_id=query.workflow_id,
            range_key="custom",
            start=period.start - duration,
            end=period.start,
            timezone=query.timezone,
        ), include_comparison=False)
        change_keys = (
            "task_count", "run_count", "succeeded_runs", "failed_runs",
            "success_rate", "total_tokens", "average_duration_ms",
            "cache_rate", "cost",
        )
        changes: dict[str, int | float | None] = {}
        for key in change_keys:
            current = current_report["summary"].get(key)
            prior = previous["summary"].get(key)
            changes[key] = (
                round(current - prior, 4)
                if isinstance(current, (int, float)) and isinstance(prior, (int, float))
                else None
            )
        return {
            "period": previous["period"],
            "summary": previous["summary"],
            "changes": changes,
        }

    def _resolve_projects(self, query: StatisticsQuery) -> list[Any]:
        if query.workflow_id and not query.project_id:
            raise ValueError("workflow_id requires project_id")
        if query.project_id:
            project = self._project_manager.get_project_by_id(query.project_id)
            if project is None:
                raise ValueError(f"Project not found: {query.project_id}")
            if query.workflow_id and not any(
                workflow["id"] == query.workflow_id for workflow in project.workflows
            ):
                raise ValueError(f"Workflow not found: {query.workflow_id}")
            return [project]
        return list(self._project_manager.iter_projects())

    @staticmethod
    def _resolve_period(query: StatisticsQuery) -> Period:
        try:
            zone = ZoneInfo(query.timezone)
        except ZoneInfoNotFoundError as exc:
            raise ValueError(f"Unknown timezone: {query.timezone}") from exc
        now = _utc(query.now or utc_now())
        if query.range_key == "custom":
            if query.start is None or query.end is None:
                raise ValueError("Custom range requires start and end")
            start, end = _utc(query.start), _utc(query.end)
        elif query.range_key == "all":
            start, end = datetime(1970, 1, 1, tzinfo=timezone.utc), now
        elif query.range_key in RANGE_DAYS:
            end = now
            start = end - timedelta(days=RANGE_DAYS[query.range_key])
        else:
            raise ValueError(f"Unsupported range: {query.range_key}")
        if start >= end:
            raise ValueError("start must be before end")
        return Period(start, end, zone, _granularity(start, end), query.range_key)

    @staticmethod
    def _workflow_matches(task_workflow_id: str | None, selected: str | None) -> bool:
        if selected is None:
            return True
        return task_workflow_id == selected

    @staticmethod
    def _workflow_bucket(
        buckets: dict[tuple[str, str], MetricBucket],
        project_id: str,
        workflow_id: str | None,
    ) -> MetricBucket:
        key = (project_id, workflow_id or "legacy-default")
        return buckets.setdefault(key, MetricBucket())

    @staticmethod
    def _eligible_message(message: Message, period: Period) -> bool:
        timestamp = message.started_at or message.created_at
        return (
            message.role == "assistant"
            and message.channel in USAGE_CHANNELS
            and message.run_status in TERMINAL_MESSAGE_STATUSES
            and _in_period(timestamp, period)
        )

    @staticmethod
    def _trend_bucket(
        trend: dict[str, MetricBucket],
        value: datetime,
        period: Period,
    ) -> MetricBucket:
        key = _bucket_key(value, period)
        return trend.setdefault(key, MetricBucket())

    @staticmethod
    def _all_time_period(period: Period, earliest: datetime | None) -> Period:
        start = earliest or period.end - timedelta(days=30)
        local = start.astimezone(period.timezone)
        start_local = local.replace(hour=0, minute=0, second=0, microsecond=0)
        start = start_local.astimezone(timezone.utc)
        return Period(start, period.end, period.timezone, _granularity(start, period.end), "all")

    @staticmethod
    def _fill_trend(trend: dict[str, MetricBucket], period: Period) -> None:
        for key in _bucket_keys(period):
            trend.setdefault(key, MetricBucket())

    @staticmethod
    def _scope(query, projects, workflow_meta) -> dict[str, Any]:
        level = "workflow" if query.workflow_id else "project" if query.project_id else "global"
        project = projects[0] if query.project_id and projects else None
        workflow = workflow_meta.get((query.project_id, query.workflow_id)) if query.workflow_id else None
        return {
            "level": level,
            "project_id": query.project_id,
            "project_name": project.name if project else None,
            "workflow_id": query.workflow_id,
            "workflow_name": workflow.get("name") if workflow else None,
        }

    @staticmethod
    def _workflow_count(projects, query) -> int:
        if query.workflow_id:
            return 1
        return sum(
            1 for project in projects for workflow in project.workflows
            if not workflow.get("deleted")
        )

    @staticmethod
    def _period_report(period: Period) -> dict[str, Any]:
        return {
            "range": period.range_key,
            "start": period.start.isoformat(),
            "end": period.end.isoformat(),
            "timezone": period.timezone.key,
            "granularity": period.granularity,
        }

    @staticmethod
    def _trend_report(key: str, bucket: MetricBucket) -> dict[str, Any]:
        report = bucket.report()
        return {
            "bucket": key,
            "run_count": report["run_count"],
            "succeeded_runs": report["succeeded_runs"],
            "failed_runs": report["failed_runs"],
            "total_tokens": report["total_tokens"],
            "cost": report["cost"],
            "average_duration_ms": report["average_duration_ms"],
        }

    @staticmethod
    def _project_reports(projects, buckets) -> list[dict[str, Any]]:
        reports = []
        for project in projects:
            report = buckets[project.id].report()
            report.update({
                "id": project.id,
                "name": project.name,
                "workflow_count": sum(1 for workflow in project.workflows if not workflow.get("deleted")),
            })
            reports.append(report)
        return sorted(reports, key=lambda row: (-row["run_count"], row["name"]))

    @staticmethod
    def _workflow_reports(projects, buckets, metadata, query) -> list[dict[str, Any]]:
        reports = []
        project = projects[0]
        keys = {key for key in buckets if key[0] == project.id}
        for key in keys:
            workflow_id = key[1]
            workflow = metadata.get(key)
            report = buckets[key].report()
            report.update({
                "id": workflow_id,
                "name": workflow.get("name") if workflow else "旧版默认流程",
                "deleted": bool(workflow.get("deleted")) if workflow else True,
                "drilldown_available": workflow is not None,
                "node_count": len((workflow or {}).get("steps", {}).get("nodes", [])),
            })
            reports.append(report)
        return sorted(reports, key=lambda row: (row["deleted"], -row["run_count"], row["name"]))

    @staticmethod
    def _step_reports(step_buckets, projects, query) -> list[dict[str, Any]]:
        if query.workflow_id is None:
            return []
        names: dict[str, str] = {}
        workflow = next(
            (item for item in projects[0].workflows if item["id"] == query.workflow_id),
            None,
        )
        for node in (workflow or {}).get("steps", {}).get("nodes", []):
            key = str(node.get("key") or node.get("type") or node.get("id"))
            names[key] = str(node.get("title") or node.get("label") or key)

        reports = []
        for step_key, step in step_buckets.items():
            terminal = step["succeeded_attempts"] + step["failed_attempts"] + step["cancelled_attempts"]
            review_terminal = step["review_passed"] + step["review_rejected"]
            reports.append({
                "step_key": step_key,
                "name": names.get(step_key, step_key),
                "attempt_count": step["attempt_count"],
                "succeeded_attempts": step["succeeded_attempts"],
                "failed_attempts": step["failed_attempts"],
                "cancelled_attempts": step["cancelled_attempts"],
                "retry_count": step["retry_count"],
                "failure_rate": _ratio(
                    step["failed_attempts"] + step["cancelled_attempts"], terminal,
                ),
                "review_passed": step["review_passed"],
                "review_rejected": step["review_rejected"],
                "review_pass_rate": _ratio(step["review_passed"], review_terminal),
                "average_duration_ms": _average(step["durations"]),
                "p95_duration_ms": _percentile(step["durations"], 0.95),
                "total_tokens": step["total_tokens"],
            })
        return sorted(reports, key=lambda row: (-row["attempt_count"], row["step_key"]))

    @staticmethod
    def _engine_reports(engine_buckets) -> list[dict[str, Any]]:
        reports = []
        for (engine_name, model), item in engine_buckets.items():
            terminal = item["succeeded_attempts"] + item["failed_attempts"]
            reports.append({
                "engine": engine_name,
                "model": model,
                "call_count": item["call_count"],
                "attempt_count": item["attempt_count"],
                "failure_rate": _ratio(item["failed_attempts"], terminal),
                "average_duration_ms": _average(item["durations"]),
                "input_tokens": item["input_tokens"],
                "output_tokens": item["output_tokens"],
                "cache_read_tokens": item["cache_read_tokens"],
                "cache_write_tokens": item["cache_write_tokens"],
                "total_tokens": item["total_tokens"],
                "cost": round(item["cost"], 6),
            })
        return sorted(reports, key=lambda row: (-row["total_tokens"], row["engine"], row["model"]))


def _new_step_bucket(step_key: str) -> dict[str, Any]:
    return {
        "step_key": step_key,
        "attempt_count": 0,
        "succeeded_attempts": 0,
        "failed_attempts": 0,
        "cancelled_attempts": 0,
        "retry_count": 0,
        "review_passed": 0,
        "review_rejected": 0,
        "review_pending": 0,
        "durations": [],
        "review_durations": [],
        "total_tokens": 0,
    }


def _new_engine_bucket() -> dict[str, Any]:
    return {
        "call_count": 0,
        "attempt_count": 0,
        "succeeded_attempts": 0,
        "failed_attempts": 0,
        "durations": [],
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "total_tokens": 0,
        "cost": 0.0,
    }


def _add_usage_to_dict(target: dict[str, Any], usage: dict[str, int]) -> None:
    for key in (
        "input_tokens", "output_tokens", "cache_read_tokens",
        "cache_write_tokens", "total_tokens",
    ):
        target[key] += usage[key]


def _add_user_usage(
    buckets: dict[str, dict[str, Any]],
    author_id: str | None,
    author_name: str | None,
    usage: dict[str, Any],
    cost: float,
) -> None:
    normalized_name = str(author_name or "").strip() or "未知用户"
    normalized_id = str(author_id or "").strip()
    key = normalized_id or f"name:{normalized_name}"
    bucket = buckets.setdefault(key, {
        "author_id": normalized_id,
        "author_name": normalized_name,
        "call_count": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "total_tokens": 0,
        "cost": 0.0,
    })
    if normalized_name != "未知用户":
        bucket["author_name"] = normalized_name
    bucket["call_count"] += 1
    _add_usage_to_dict(bucket, usage)
    bucket["cost"] += cost


def _user_reports(buckets: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    reports = []
    for bucket in buckets.values():
        report = dict(bucket)
        report["cost"] = round(report["cost"], 6)
        reports.append(report)
    return sorted(
        reports,
        key=lambda row: (-row["total_tokens"], row["author_name"], row["author_id"]),
    )


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _in_period(value: datetime | None, period: Period) -> bool:
    return value is not None and period.start <= _utc(value) < period.end


def _earlier(current: datetime | None, candidate: datetime | None) -> datetime | None:
    if candidate is None:
        return current
    candidate = _utc(candidate)
    return candidate if current is None or candidate < current else current


def _duration_ms(start: datetime | None, end: datetime | None) -> int | None:
    if start is None or end is None:
        return None
    return max(0, round((_utc(end) - _utc(start)).total_seconds() * 1000))


def _average(values: Iterable[int]) -> int | None:
    values = list(values)
    return round(sum(values) / len(values)) if values else None


def _percentile(values: Iterable[int], percentile: float) -> int | None:
    ordered = sorted(values)
    if not ordered:
        return None
    index = (len(ordered) - 1) * percentile
    lower = math.floor(index)
    upper = math.ceil(index)
    if lower == upper:
        return ordered[lower]
    return round(ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower))


def _ratio(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 4) if denominator else None


def _granularity(start: datetime, end: datetime) -> str:
    days = (end - start).total_seconds() / 86400
    if days <= 31:
        return "day"
    if days <= 180:
        return "week"
    return "month"


def _bucket_key(value: datetime, period: Period) -> str:
    local = _utc(value).astimezone(period.timezone)
    if period.granularity == "day":
        return local.date().isoformat()
    if period.granularity == "week":
        return (local.date() - timedelta(days=local.weekday())).isoformat()
    return local.strftime("%Y-%m")


def _bucket_keys(period: Period) -> list[str]:
    start = period.start.astimezone(period.timezone)
    end = (period.end - timedelta(microseconds=1)).astimezone(period.timezone)
    if period.granularity == "day":
        current = start.date()
        last = end.date()
        keys = []
        while current <= last:
            keys.append(current.isoformat())
            current += timedelta(days=1)
        return keys
    if period.granularity == "week":
        current = start.date() - timedelta(days=start.weekday())
        last = end.date() - timedelta(days=end.weekday())
        keys = []
        while current <= last:
            keys.append(current.isoformat())
            current += timedelta(days=7)
        return keys

    year, month = start.year, start.month
    last = (end.year, end.month)
    keys = []
    while (year, month) <= last:
        keys.append(f"{year:04d}-{month:02d}")
        month += 1
        if month == 13:
            year += 1
            month = 1
    return keys
