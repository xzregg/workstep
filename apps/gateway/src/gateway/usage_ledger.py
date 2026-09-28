"""Idempotent, bounded device usage ledger and administrator totals."""

import hashlib
import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Literal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator
from sqlalchemy import case, func, select

from .identity_api import _super_admin_read
from .models import UsageEvent, UsageEventReceipt

router = APIRouter(prefix="/api/admin/usage")


class UsageEventInput(BaseModel):
    usage_event_id: str = Field(min_length=1, max_length=64)
    request_id: str | None = Field(default=None, max_length=128)
    device_id: str | None = Field(default=None, max_length=64)
    user_id: str | None = Field(default=None, max_length=64)
    initiated_by_user_id: str | None = Field(default=None, max_length=64)
    project_id: str | None = Field(default=None, max_length=64)
    task_id: str | None = Field(default=None, max_length=64)
    run_id: str | None = Field(default=None, max_length=64)
    message_id: str | None = Field(default=None, max_length=64)
    session_id: str | None = Field(default=None, max_length=128)
    provider_id: str | None = Field(default=None, max_length=64)
    provider_revision: int | None = Field(default=None, ge=0, le=2**63 - 1, strict=True)
    model: str | None = Field(default=None, max_length=128)
    input_tokens: int | None = Field(default=None, ge=0, le=2**63 - 1, strict=True)
    output_tokens: int | None = Field(default=None, ge=0, le=2**63 - 1, strict=True)
    cache_read_tokens: int | None = Field(default=None, ge=0, le=2**63 - 1, strict=True)
    cache_write_tokens: int | None = Field(default=None, ge=0, le=2**63 - 1, strict=True)
    total_tokens: int | None = Field(default=None, ge=0, le=2**63 - 1, strict=True)
    pricing_version: str | None = Field(default=None, max_length=64)
    unit_price_snapshot: dict[str, str] | None = None
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    estimated_cost: Decimal | None = Field(default=None, ge=0, le=Decimal("999999999999"))
    metering_status: Literal["metered", "unmetered"] = "metered"
    occurred_at: datetime

    @field_validator("unit_price_snapshot")
    @classmethod
    def limited_prices(cls, value: dict[str, str] | None):
        if value is None:
            return value
        allowed = {"input_per_million", "output_per_million",
                   "cache_read_per_million", "cache_write_per_million"}
        if set(value) - allowed or len(json.dumps(value)) > 2048:
            raise ValueError("Invalid price snapshot")
        for raw in value.values():
            try:
                amount = Decimal(raw) if isinstance(raw, str) else Decimal("NaN")
            except InvalidOperation as exc:
                raise ValueError("Invalid price snapshot") from exc
            if not amount.is_finite() or amount < 0:
                raise ValueError("Invalid price snapshot")
        return value

    @model_validator(mode="after")
    def valid_metering(self):
        if self.occurred_at.tzinfo is None:
            raise ValueError("Usage time must include timezone")
        if self.metering_status == "metered":
            if self.input_tokens is None or self.output_tokens is None:
                raise ValueError("Metered usage requires input and output tokens")
        elif any(value is not None for value in (
            self.input_tokens, self.output_tokens, self.total_tokens,
            self.cache_read_tokens, self.cache_write_tokens, self.estimated_cost,
        )):
            raise ValueError("Unmetered usage cannot report zero or estimated cost")
        return self


async def record_usage_batch(database, device_id: str, batch_id: str,
                             events: list[dict]) -> dict:
    if (not isinstance(batch_id, str) or not 1 <= len(batch_id) <= 128
            or not isinstance(events, list) or not 1 <= len(events) <= 100
            or len(json.dumps(events, default=str)) > 512 * 1024):
        raise ValueError("Invalid usage batch")
    now = datetime.now(timezone.utc)
    valid: list[tuple[UsageEventInput, str]] = []
    rejected: list[str] = []
    for raw in events:
        event_id = raw.get("usage_event_id", "") if isinstance(raw, dict) else ""
        try:
            event = UsageEventInput.model_validate(raw)
            if (event.device_id is not None and event.device_id != device_id
                    or event.occurred_at < now - timedelta(days=30)
                    or event.occurred_at > now + timedelta(minutes=5)):
                raise ValueError("Usage scope or time invalid")
            canonical = json.dumps(event.model_dump(mode="json"), sort_keys=True,
                                   separators=(",", ":"))
            valid.append((event, hashlib.sha256(canonical.encode()).hexdigest()))
        except (ValidationError, ValueError, TypeError):
            rejected.append(str(event_id)[:64])
    accepted: list[str] = []
    duplicates: list[str] = []
    async with database.session() as session:
        async with session.begin():
            for event, digest in valid:
                receipt = await session.get(UsageEventReceipt, event.usage_event_id)
                if receipt is not None:
                    if receipt.device_id == device_id and receipt.payload_sha256 == digest:
                        duplicates.append(event.usage_event_id)
                    else:
                        rejected.append(event.usage_event_id)
                    continue
                session.add(UsageEventReceipt(
                    usage_event_id=event.usage_event_id, device_id=device_id,
                    batch_id=batch_id, payload_sha256=digest,
                ))
                session.add(UsageEvent(
                    id=event.usage_event_id, device_id=device_id,
                    source="reported_by_device", request_id=event.request_id,
                    user_id=event.user_id,
                    initiated_by_user_id=event.initiated_by_user_id,
                    project_id=event.project_id, task_id=event.task_id,
                    run_id=event.run_id, message_id=event.message_id,
                    session_id=event.session_id,
                    provider_id=event.provider_id, provider_revision=event.provider_revision,
                    model=event.model, input_tokens=event.input_tokens,
                    output_tokens=event.output_tokens,
                    cache_read_tokens=event.cache_read_tokens,
                    cache_write_tokens=event.cache_write_tokens,
                    total_tokens=event.total_tokens,
                    pricing_version=event.pricing_version,
                    unit_price_snapshot_json=(json.dumps(event.unit_price_snapshot)
                                              if event.unit_price_snapshot else None),
                    currency=event.currency, estimated_cost=event.estimated_cost,
                    metering_status=event.metering_status,
                    occurred_at=event.occurred_at,
                ))
                await session.flush()
                accepted.append(event.usage_event_id)
    return {"batch_id": batch_id, "accepted": accepted,
            "duplicates": duplicates, "rejected": rejected}


@router.get("")
async def usage_summary(request: Request,
                        device_id: str | None = Query(default=None, max_length=64),
                        user_id: str | None = Query(default=None, max_length=64),
                        project_id: str | None = Query(default=None, max_length=64),
                        provider_id: str | None = Query(default=None, max_length=64),
                        model: str | None = Query(default=None, max_length=128),
                        from_time: datetime | None = None,
                        to_time: datetime | None = None,
                        group_by: Literal["user", "device", "project", "provider", "model", "day"] | None = None,
                        limit: int = Query(default=100, ge=1, le=1000),
                        offset: int = Query(default=0, ge=0)):
    await _super_admin_read(request)
    conditions = []
    for column, value in ((UsageEvent.device_id, device_id), (UsageEvent.user_id, user_id),
                          (UsageEvent.project_id, project_id),
                          (UsageEvent.provider_id, provider_id), (UsageEvent.model, model)):
        if value:
            conditions.append(column == value)
    if from_time:
        conditions.append(UsageEvent.occurred_at >= from_time)
    if to_time:
        conditions.append(UsageEvent.occurred_at < to_time)
    totals = (
        func.count(UsageEvent.id),
        func.sum(case((UsageEvent.metering_status == "unmetered", 1), else_=0)),
        func.sum(UsageEvent.input_tokens), func.sum(UsageEvent.output_tokens),
        func.sum(UsageEvent.cache_read_tokens), func.sum(UsageEvent.cache_write_tokens),
        func.sum(UsageEvent.estimated_cost),
    )
    query = select(*totals).where(*conditions)
    async with request.app.state.database.session() as session:
        row = (await session.execute(query)).one()
        result = _usage_totals(row)
        if group_by:
            dimension = {
                "user": UsageEvent.user_id, "device": UsageEvent.device_id,
                "project": UsageEvent.project_id,
                "provider": UsageEvent.provider_id, "model": UsageEvent.model,
                "day": func.date(UsageEvent.occurred_at),
            }[group_by]
            groups = (await session.execute(
                select(dimension, *totals).where(*conditions).group_by(dimension)
                .order_by(dimension).limit(limit).offset(offset),
            )).all()
            result["group_by"] = group_by
            result["groups"] = [{"value": value, **_usage_totals(values)}
                                for value, *values in groups]
        return result


def _usage_totals(row) -> dict:
    return {"event_count": row[0], "unmetered_count": row[1] or 0,
            "input_tokens": row[2], "output_tokens": row[3],
            "cache_read_tokens": row[4], "cache_write_tokens": row[5],
            "estimated_cost": f"{row[6]:.6f}" if row[6] is not None else None}
