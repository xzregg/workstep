"""Build one task's execution timeline, usage totals, and milestones."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from models import Message, ReviewRun, StepRun, Task, WorkflowRun
from services.statistics import _parse_usage, _usage_cost


REPORT_CHANNELS = {"execution", "review"}


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _milliseconds(start: datetime | None, end: datetime | None) -> int | None:
    if start is None or end is None:
        return None
    return max(0, int((end - start).total_seconds() * 1000))


def _step_titles(workflow: dict | None) -> dict[str, str]:
    if not isinstance(workflow, dict):
        return {}
    nodes = workflow.get("nodes") or workflow.get("steps") or []
    titles: dict[str, str] = {}
    for node in nodes:
        if not isinstance(node, dict):
            continue
        key = str(node.get("type") or node.get("key") or node.get("id") or "").strip()
        title = str(node.get("title") or node.get("name") or key).strip()
        if key:
            titles[key] = title or key
    return titles


def _rounds(runs: list[WorkflowRun]) -> dict[str, int]:
    by_id = {run.id: run for run in runs}
    cache: dict[str, int] = {}

    def depth(run: WorkflowRun, seen: set[str] | None = None) -> int:
        if run.id in cache:
            return cache[run.id]
        seen = set(seen or ())
        if run.id in seen:
            return 1
        seen.add(run.id)
        parent = by_id.get(run.parent_run_id) if run.parent_run_id else None
        value = depth(parent, seen) + 1 if parent is not None else 1
        cache[run.id] = value
        return value

    for item in runs:
        depth(item)
    return cache


def _contains(start: datetime | None, end: datetime | None, point: datetime) -> bool:
    return start is not None and start <= point and (end is None or point <= end)


def _nearest_execution(
    message: Message,
    candidates: list[StepRun],
) -> StepRun | None:
    point = message.started_at or message.created_at
    matching = [
        row for row in candidates
        if row.step_key == message.step_key and _contains(row.started_at, row.ended_at, point)
    ]
    if matching:
        return max(matching, key=lambda row: row.started_at or datetime.min.replace(tzinfo=timezone.utc))
    earlier = [
        row for row in candidates
        if row.step_key == message.step_key and row.started_at is not None and row.started_at <= point
    ]
    return max(earlier, key=lambda row: row.started_at) if earlier else None


def _nearest_review(
    message: Message,
    candidates: list[ReviewRun],
) -> ReviewRun | None:
    point = message.started_at or message.created_at
    matching = [
        row for row in candidates
        if row.step_key == message.step_key and _contains(row.started_at, row.ended_at, point)
    ]
    if matching:
        return max(matching, key=lambda row: row.started_at or datetime.min.replace(tzinfo=timezone.utc))
    earlier = [
        row for row in candidates
        if row.step_key == message.step_key and row.started_at is not None and row.started_at <= point
    ]
    return max(earlier, key=lambda row: row.started_at) if earlier else None


def _new_usage_bucket() -> dict[str, Any]:
    return {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "total_tokens": 0,
        "cost": 0.0,
        "provider_cost": 0.0,
        "estimated_cost": 0.0,
        "message_count": 0,
        "sources": set(),
    }


def _cost_source(bucket: dict[str, Any]) -> str | None:
    sources = bucket["sources"]
    if len(sources) > 1:
        return "mixed"
    return next(iter(sources), None)


def build_task_execution_report(
    task_id: str,
    *,
    pricing: dict[str, Any],
    project=None,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """Return a JSON-ready report. Must run inside the project's DB executor."""
    task = Task.get_or_none(Task.id == task_id)
    if task is None:
        return None

    now = now or datetime.now(timezone.utc)
    runs = list(
        WorkflowRun.select()
        .where(WorkflowRun.task == task)
        .order_by(WorkflowRun.started_at, WorkflowRun.id)
    )
    run_ids = [run.id for run in runs]
    steps = list(
        StepRun.select()
        .where(StepRun.run.in_(run_ids or [""]))
        .order_by(StepRun.started_at, StepRun.id)
    )
    reviews = list(
        ReviewRun.select()
        .where(ReviewRun.task == task)
        .order_by(ReviewRun.started_at, ReviewRun.id)
    )
    messages = list(
        Message.select()
        .where(
            (Message.task == task)
            & (Message.role == "assistant")
            & (Message.channel.in_(REPORT_CHANNELS))
        )
        .order_by(Message.started_at, Message.created_at, Message.id)
    )

    workflow = None
    if project is not None:
        if task.workflow_id:
            selected = project.workflow_by_id(task.workflow_id)
            workflow = selected.get("steps") if selected is not None else None
        else:
            workflow = project.steps
    titles = _step_titles(workflow)
    round_by_run = _rounds(runs)
    usage_by_segment: dict[tuple[str, str], dict[str, Any]] = defaultdict(_new_usage_bucket)
    usage_by_user: dict[str, dict[str, Any]] = {}
    eligible_calls = len(messages)
    reported_calls = 0

    for message in messages:
        target: tuple[str, str] | None = None
        if message.channel == "review":
            review = _nearest_review(message, reviews)
            if review is not None:
                target = ("review", review.id)
        else:
            step = _nearest_execution(message, steps)
            if step is not None:
                target = ("execution", step.id)
        if target is None:
            continue
        usage = _parse_usage(message.usage_json, message.engine)
        if usage is None:
            continue
        reported_calls += 1
        bucket = usage_by_segment[target]
        for key in (
            "input_tokens", "output_tokens", "cache_read_tokens",
            "cache_write_tokens", "total_tokens",
        ):
            bucket[key] += usage[key]
        cost = _usage_cost(
            usage,
            message.model or "",
            pricing,
            engine=message.engine or "",
        )
        source = "provider" if usage.get("provider_cost") is not None else "estimated"
        if source == "provider":
            bucket["provider_cost"] += cost
        else:
            bucket["estimated_cost"] += cost
        if cost > 0 or source == "provider":
            bucket["sources"].add(source)
        bucket["cost"] += cost
        bucket["message_count"] += 1
        author_name = str(message.author_name or "").strip() or "未知用户"
        author_id = str(message.author_id or "").strip()
        user_key = author_id or f"name:{author_name}"
        user_bucket = usage_by_user.setdefault(user_key, {
            "author_id": author_id,
            "author_name": author_name,
            **_new_usage_bucket(),
        })
        if author_name != "未知用户":
            user_bucket["author_name"] = author_name
        for key in (
            "input_tokens", "output_tokens", "cache_read_tokens",
            "cache_write_tokens", "total_tokens",
        ):
            user_bucket[key] += usage[key]
        user_bucket["cost"] += cost
        user_bucket["message_count"] += 1

    segments: list[dict[str, Any]] = []
    for step in steps:
        usage = usage_by_segment[("execution", step.id)]
        end = step.ended_at or now
        segments.append({
            "id": step.id,
            "type": "execution",
            "workflow_run_id": step.run_id,
            "step_run_id": step.id,
            "round": round_by_run.get(step.run_id, 1),
            "step_key": step.step_key,
            "step_title": titles.get(step.step_key, step.step_key),
            "attempt": step.attempt,
            "status": step.status,
            "engine": step.engine,
            "model": step.model,
            "started_at": _iso(step.started_at),
            "ended_at": _iso(step.ended_at),
            "duration_ms": _milliseconds(step.started_at, end),
            **{key: usage[key] for key in (
                "input_tokens", "output_tokens", "cache_read_tokens",
                "cache_write_tokens", "total_tokens", "message_count",
            )},
            "cost": round(usage["cost"], 6),
            "cost_source": _cost_source(usage),
        })
    for review in reviews:
        usage = usage_by_segment[("review", review.id)]
        end = review.ended_at or now
        segments.append({
            "id": review.id,
            "type": "review",
            "workflow_run_id": review.workflow_run_id,
            "step_run_id": review.step_run_id,
            "round": round_by_run.get(review.workflow_run_id, 1),
            "step_key": review.step_key,
            "step_title": titles.get(review.step_key, review.step_key),
            "attempt": review.attempt,
            "status": review.status,
            "engine": review.engine,
            "model": review.model,
            "started_at": _iso(review.started_at),
            "ended_at": _iso(review.ended_at),
            "duration_ms": _milliseconds(review.started_at, end),
            **{key: usage[key] for key in (
                "input_tokens", "output_tokens", "cache_read_tokens",
                "cache_write_tokens", "total_tokens", "message_count",
            )},
            "cost": round(usage["cost"], 6),
            "cost_source": _cost_source(usage),
        })
    segments.sort(key=lambda row: (row["started_at"] or "", row["type"], row["id"]))

    run_report = [{
        "id": run.id,
        "round": round_by_run.get(run.id, 1),
        "status": run.status,
        "parent_run_id": run.parent_run_id,
        "restart_from_step_key": run.restart_from_step_key,
        "started_at": _iso(run.started_at),
        "ended_at": _iso(run.ended_at),
    } for run in runs]

    step_buckets: dict[str, dict[str, Any]] = {}
    execution_counts: dict[str, int] = defaultdict(int)
    for segment in segments:
        key = segment["step_key"]
        if segment["type"] == "execution":
            execution_counts[key] += 1
        bucket = step_buckets.setdefault(key, {
            "step_key": key,
            "step_title": segment["step_title"],
            "status": segment["status"],
            "attempt_count": 0,
            "duration_ms": 0,
            "total_tokens": 0,
            "cost": 0.0,
            "last_started_at": "",
        })
        if segment["type"] == "execution":
            bucket["attempt_count"] += 1
        if (segment["started_at"] or "") >= bucket["last_started_at"]:
            bucket["status"] = segment["status"]
            bucket["last_started_at"] = segment["started_at"] or ""
        bucket["duration_ms"] += segment["duration_ms"] or 0
        bucket["total_tokens"] += segment["total_tokens"]
        bucket["cost"] += segment["cost"]
    step_breakdown = []
    for bucket in step_buckets.values():
        bucket.pop("last_started_at", None)
        bucket["cost"] = round(bucket["cost"], 6)
        step_breakdown.append(bucket)
    step_breakdown.sort(key=lambda row: (-row["total_tokens"], row["step_title"]))

    segment_by_id = {(row["type"], row["id"]): row for row in segments}
    milestones: list[dict[str, Any]] = []
    for step in steps:
        if step.ended_at is None:
            continue
        segment = segment_by_id[("execution", step.id)]
        milestones.append({
            "id": f"step:{step.id}",
            "kind": "step_completed",
            "step_key": step.step_key,
            "step_title": titles.get(step.step_key, step.step_key),
            "status": step.status,
            "at": _iso(step.ended_at),
            "duration_ms": segment["duration_ms"],
            "total_tokens": segment["total_tokens"],
            "cost": segment["cost"],
        })
    for review in reviews:
        if review.ended_at is None:
            continue
        segment = segment_by_id[("review", review.id)]
        milestones.append({
            "id": f"review:{review.id}",
            "kind": "review_completed",
            "step_key": review.step_key,
            "step_title": titles.get(review.step_key, review.step_key),
            "status": review.status,
            "at": _iso(review.ended_at),
            "duration_ms": segment["duration_ms"],
            "total_tokens": segment["total_tokens"],
            "cost": segment["cost"],
        })
    latest_run = max(runs, key=lambda row: row.started_at or task.created_at, default=None)
    if latest_run is not None and latest_run.ended_at is not None and latest_run.status in {"succeeded", "failed"}:
        milestones.append({
            "id": f"task:{latest_run.id}",
            "kind": "task_completed",
            "step_key": None,
            "step_title": task.title,
            "status": latest_run.status,
            "at": _iso(latest_run.ended_at),
            "duration_ms": _milliseconds(latest_run.started_at, latest_run.ended_at),
            "total_tokens": sum(row["total_tokens"] for row in segments),
            "cost": round(sum(row["cost"] for row in segments), 6),
        })
    milestones.sort(key=lambda row: (row["at"] or "", row["id"]), reverse=True)

    starts = [run.started_at for run in runs if run.started_at is not None]
    has_running = any(run.ended_at is None and run.status in {"running", "paused"} for run in runs)
    ends = [run.ended_at for run in runs if run.ended_at is not None]
    overall_end = now if has_running else max(ends, default=None)
    duration_ms = _milliseconds(min(starts), overall_end) if starts and overall_end else 0
    provider_cost = sum(bucket["provider_cost"] for bucket in usage_by_segment.values())
    estimated_cost = sum(bucket["estimated_cost"] for bucket in usage_by_segment.values())
    total_tokens = sum(bucket["total_tokens"] for bucket in usage_by_segment.values())
    user_breakdown = []
    for bucket in usage_by_user.values():
        user_breakdown.append({
            "author_id": bucket["author_id"],
            "author_name": bucket["author_name"],
            "message_count": bucket["message_count"],
            "input_tokens": bucket["input_tokens"],
            "output_tokens": bucket["output_tokens"],
            "cache_read_tokens": bucket["cache_read_tokens"],
            "cache_write_tokens": bucket["cache_write_tokens"],
            "total_tokens": bucket["total_tokens"],
            "cost": round(bucket["cost"], 6),
        })
    user_breakdown.sort(
        key=lambda row: (-row["total_tokens"], row["author_name"], row["author_id"]),
    )

    return {
        "currency": str(pricing.get("currency") or "USD"),
        "generated_at": _iso(now),
        "summary": {
            "duration_ms": duration_ms,
            "total_tokens": total_tokens,
            "cost": round(provider_cost + estimated_cost, 6),
            "provider_cost": round(provider_cost, 6),
            "estimated_cost": round(estimated_cost, 6),
            "usage_coverage": reported_calls / eligible_calls if eligible_calls else None,
            "run_count": len(runs),
            "attempt_count": len(steps),
            "retry_count": sum(max(0, count - 1) for count in execution_counts.values()),
        },
        "runs": run_report,
        "segments": segments,
        "step_breakdown": step_breakdown,
        "user_breakdown": user_breakdown,
        "milestones": milestones,
        "data_quality": {
            "eligible_usage_calls": eligible_calls,
            "reported_usage_calls": reported_calls,
        },
    }
