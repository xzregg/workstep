"""Pure schedule rule validation, compilation, previews and descriptions."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter


class ScheduleValidationError(ValueError):
    """A schedule rule cannot be normalized or executed."""


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
