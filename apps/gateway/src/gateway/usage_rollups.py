"""Incremental usage aggregation with a transactionally advanced queue watermark."""

import asyncio
import hashlib
import json
import logging
from datetime import timezone

from sqlalchemy import delete, insert, select

from .models import UsageDailyRollup, UsageEvent, UsageRollupQueue, UsageRollupState

logger = logging.getLogger(__name__)
SUM_FIELDS = ("input_tokens", "output_tokens", "cache_read_tokens",
              "cache_write_tokens", "total_tokens", "estimated_cost", "billed_cost")
DIMENSIONS = ("day", "source", "metering_status", "user_id", "device_id",
              "project_id", "provider_id", "model", "currency")


def _identity(event: UsageEvent) -> tuple[str, dict]:
    day = event.occurred_at.replace(tzinfo=event.occurred_at.tzinfo or timezone.utc)
    values = {"day": day.astimezone(timezone.utc).date().isoformat()}
    values.update({field: getattr(event, field) for field in DIMENSIONS[1:]})
    digest = hashlib.sha256(json.dumps(
        [values[field] for field in DIMENSIONS], separators=(",", ":"),
    ).encode()).hexdigest()
    return digest, values


def _add_event(rollup: UsageDailyRollup, event: UsageEvent) -> None:
    rollup.event_count += 1
    rollup.unmetered_count += int(event.metering_status == "unmetered")
    rollup.cost_missing_count += int(
        (event.estimated_cost is not None or event.billed_cost is not None)
        and event.currency is None
    )
    for field in SUM_FIELDS:
        value = getattr(event, field)
        if value is not None:
            previous = getattr(rollup, field)
            setattr(rollup, field, (previous or 0) + value)


async def _advance_locked(database, batch_size: int) -> int:
    async with database.session() as session:
        async with session.begin():
            state = await session.get(UsageRollupState, 1)
            queue = (await session.scalars(select(UsageRollupQueue).where(
                UsageRollupQueue.id > state.last_queue_id,
            ).order_by(UsageRollupQueue.id).limit(batch_size))).all()
            if not queue:
                return 0
            events = (await session.scalars(select(UsageEvent).where(
                UsageEvent.id.in_([item.usage_event_id for item in queue]),
            ))).all()
            mapped = {event.id: event for event in events}
            keys = {_identity(event)[0] for event in events}
            existing = (await session.scalars(select(UsageDailyRollup).where(
                UsageDailyRollup.id.in_(keys),
            ))).all()
            rollups = {item.id: item for item in existing}
            for item in queue:
                event = mapped.get(item.usage_event_id)
                if event is None:
                    raise RuntimeError(f"Usage event missing for rollup queue {item.id}")
                key, dimensions = _identity(event)
                rollup = rollups.get(key)
                if rollup is None:
                    rollup = UsageDailyRollup(id=key, **dimensions, event_count=0,
                                              unmetered_count=0, cost_missing_count=0)
                    session.add(rollup)
                    rollups[key] = rollup
                _add_event(rollup, event)
            state.last_queue_id = queue[-1].id
            await session.execute(delete(UsageRollupQueue).where(
                UsageRollupQueue.id.in_([item.id for item in queue]),
            ))
            return len(queue)


async def advance_rollups(database, batch_size: int = 100) -> int:
    if not 1 <= batch_size <= 1000:
        raise ValueError("Invalid rollup batch size")
    async with database.usage_rollup_lock:
        return await _advance_locked(database, batch_size)


async def rebuild_rollups(database) -> int:
    async with database.usage_rollup_lock:
        async with database.session() as session:
            async with session.begin():
                await session.execute(delete(UsageDailyRollup))
                await session.execute(delete(UsageRollupQueue))
                state = await session.get(UsageRollupState, 1)
                state.last_queue_id = 0
                await session.execute(insert(UsageRollupQueue).from_select(
                    [UsageRollupQueue.usage_event_id], select(UsageEvent.id),
                ))
        total = 0
        while count := await _advance_locked(database, 100):
            total += count
        return total


async def run_periodic(database, stop: asyncio.Event,
                       interval_seconds: float = 1.0) -> None:
    while not stop.is_set():
        processed = 0
        try:
            processed = await advance_rollups(database)
        except Exception:
            logger.exception("Usage rollup advance failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=0.05 if processed else interval_seconds)
        except asyncio.TimeoutError:
            pass
