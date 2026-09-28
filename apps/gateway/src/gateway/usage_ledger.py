"""Idempotent, bounded device usage ledger and administrator totals."""

import hashlib
import json
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator
from sqlalchemy import case, func, select

from .identity import COOKIE_NAME
from .identity_api import _super_admin_read, _super_admin_request
from .models import AuditEvent, UsageEvent, UsageEventReceipt

router = APIRouter(prefix="/api/admin/usage")
UsageSource = Literal["reported_by_device", "provider_reconciled"]
MeteringStatus = Literal["metered", "unmetered"]


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
    metering_status: MeteringStatus = "metered"
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


class ProviderBillLine(BaseModel):
    line_id: str = Field(min_length=1, max_length=128)
    provider_id: str = Field(min_length=1, max_length=64)
    model: str = Field(min_length=1, max_length=128)
    day: date
    input_tokens: int = Field(ge=0, le=2**63 - 1, strict=True)
    output_tokens: int = Field(ge=0, le=2**63 - 1, strict=True)
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    billed_cost: Decimal = Field(ge=0, le=Decimal("999999999999"))

    @model_validator(mode="after")
    def valid_bill_line(self):
        if (self.day > datetime.now(timezone.utc).date()
                or self.input_tokens + self.output_tokens > 2**63 - 1
                or not self.billed_cost.is_finite()
                or self.billed_cost.as_tuple().exponent < -6):
            raise ValueError("Invalid provider bill line")
        return self


class ProviderBillBatch(BaseModel):
    batch_id: str = Field(min_length=1, max_length=128)
    lines: list[ProviderBillLine] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def unique_lines(self):
        ids = [(line.provider_id, line.line_id) for line in self.lines]
        if len(set(ids)) != len(ids):
            raise ValueError("Duplicate provider bill line")
        return self


@router.post("/provider-bills")
async def import_provider_bills(request: Request, body: ProviderBillBatch):
    identity, actor = await _super_admin_request(request)
    _, session_user = await identity.session_user(request.cookies.get(COOKIE_NAME))
    await identity.require_step_up(session_user)
    if len(body.model_dump_json()) > 512 * 1024:
        raise HTTPException(status_code=413, detail="Provider bill batch too large")
    accepted, duplicates = [], []
    prepared = []
    for line in body.lines:
        event_id = hashlib.sha256(
            ("provider-bill-v1:" + json.dumps(
                [line.provider_id, line.line_id], separators=(",", ":"),
            )).encode()
        ).hexdigest()
        digest = hashlib.sha256(json.dumps(
            line.model_dump(mode="json"), sort_keys=True,
            separators=(",", ":"),
        ).encode()).hexdigest()
        prepared.append((line, event_id, digest))
    async with request.app.state.database.session() as session:
        async with session.begin():
            receipts = (await session.scalars(select(UsageEventReceipt).where(
                UsageEventReceipt.usage_event_id.in_(
                    [event_id for _, event_id, _ in prepared],
                ),
            ))).all()
            existing = {receipt.usage_event_id: receipt for receipt in receipts}
            for line, event_id, digest in prepared:
                receipt = existing.get(event_id)
                if receipt:
                    if receipt.device_id != "provider-bill" or receipt.payload_sha256 != digest:
                        raise HTTPException(status_code=409, detail="Provider bill line changed")
                    duplicates.append(line.line_id)
                    continue
                session.add(UsageEventReceipt(
                    usage_event_id=event_id, device_id="provider-bill",
                    batch_id=body.batch_id, payload_sha256=digest,
                ))
                session.add(UsageEvent(
                    id=event_id, device_id="provider-bill", source="provider_reconciled",
                    request_id=line.line_id, provider_id=line.provider_id,
                    model=line.model, input_tokens=line.input_tokens,
                    output_tokens=line.output_tokens,
                    total_tokens=line.input_tokens + line.output_tokens,
                    currency=line.currency, billed_cost=line.billed_cost,
                    metering_status="metered",
                    occurred_at=datetime.combine(line.day, time.min, timezone.utc),
                ))
                accepted.append(line.line_id)
            if accepted:
                session.add(AuditEvent(
                    id=str(uuid4()), user_id=actor.id,
                    action="admin.provider_bill_imported", result="success",
                    metadata_json=json.dumps({
                        "accepted_count": len(accepted),
                        "provider_count": len({line.provider_id for line in body.lines}),
                    }),
                ))
    return {"batch_id": body.batch_id, "accepted": accepted,
            "duplicates": duplicates}


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
                        source: UsageSource | None = "reported_by_device",
                        metering_status: MeteringStatus | None = None,
                        from_time: datetime | None = None,
                        to_time: datetime | None = None,
                        group_by: Literal["user", "device", "project", "provider", "model", "day"] | None = None,
                        limit: int = Query(default=100, ge=1, le=1000),
                        offset: int = Query(default=0, ge=0)):
    await _super_admin_read(request)
    conditions = _usage_conditions(device_id=device_id, user_id=user_id, project_id=project_id,
                                   provider_id=provider_id, model=model, source=source,
                                   metering_status=metering_status, from_time=from_time,
                                   to_time=to_time)
    totals = (
        func.count(UsageEvent.id),
        func.sum(case((UsageEvent.metering_status == "unmetered", 1), else_=0)),
        func.sum(UsageEvent.input_tokens), func.sum(UsageEvent.output_tokens),
        func.sum(UsageEvent.cache_read_tokens), func.sum(UsageEvent.cache_write_tokens),
        func.sum(UsageEvent.total_tokens), func.sum(UsageEvent.estimated_cost),
        func.min(case(((UsageEvent.estimated_cost.is_not(None)) |
                       (UsageEvent.billed_cost.is_not(None)), UsageEvent.currency))),
        func.max(case(((UsageEvent.estimated_cost.is_not(None)) |
                       (UsageEvent.billed_cost.is_not(None)), UsageEvent.currency))),
        func.sum(case((((UsageEvent.estimated_cost.is_not(None)) |
                        (UsageEvent.billed_cost.is_not(None))) &
                       (UsageEvent.currency.is_(None)), 1), else_=0)),
        func.sum(UsageEvent.billed_cost),
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
            group_keys = select(dimension).where(*conditions).group_by(dimension).subquery()
            result["group_total"] = await session.scalar(select(func.count()).select_from(group_keys))
            groups = (await session.execute(
                select(dimension, *totals).where(*conditions).group_by(dimension)
                .order_by(dimension).limit(limit).offset(offset),
            )).all()
            result["group_by"] = group_by
            result["groups"] = [{"value": value, **_usage_totals(values)}
                                for value, *values in groups]
        return result


def _usage_totals(row) -> dict:
    currency = (row[8] if row[8] == row[9] and row[8] is not None and not row[10]
                else "mixed" if row[8] != row[9] else None)
    return {"event_count": row[0], "unmetered_count": row[1] or 0,
            "input_tokens": row[2], "output_tokens": row[3],
            "cache_read_tokens": row[4], "cache_write_tokens": row[5],
            "total_tokens": row[6],
            "estimated_cost": (f"{row[7]:.6f}" if row[7] is not None and currency
                               and currency != "mixed" else None),
            "billed_cost": (f"{row[11]:.6f}" if row[11] is not None and currency
                            and currency != "mixed" else None),
            "currency": currency}


def _usage_conditions(*, device_id: str | None, user_id: str | None,
                      project_id: str | None, provider_id: str | None, model: str | None,
                      source: UsageSource | None, metering_status: MeteringStatus | None,
                      from_time: datetime | None, to_time: datetime | None) -> list:
    if ((from_time and from_time.tzinfo is None) or (to_time and to_time.tzinfo is None)
            or (from_time and to_time and from_time >= to_time)):
        raise HTTPException(status_code=422, detail="Invalid usage time range")
    conditions = []
    for column, value in ((UsageEvent.device_id, device_id), (UsageEvent.user_id, user_id),
                          (UsageEvent.project_id, project_id),
                          (UsageEvent.provider_id, provider_id), (UsageEvent.model, model),
                          (UsageEvent.source, source),
                          (UsageEvent.metering_status, metering_status)):
        if value:
            conditions.append(column == value)
    if from_time:
        conditions.append(UsageEvent.occurred_at >= from_time)
    if to_time:
        conditions.append(UsageEvent.occurred_at < to_time)
    return conditions


@router.get("/reconciliation")
async def usage_reconciliation(request: Request,
                               provider_id: str = Query(min_length=1, max_length=64),
                               from_day: date = Query(), to_day: date = Query()):
    await _super_admin_read(request)
    if from_day > to_day or (to_day - from_day).days > 30 or to_day == date.max:
        raise HTTPException(status_code=422, detail="Invalid reconciliation range")
    day = func.date(UsageEvent.occurred_at)
    query = (select(
        day, UsageEvent.model, UsageEvent.source,
        func.count(UsageEvent.id), func.sum(UsageEvent.input_tokens),
        func.sum(UsageEvent.output_tokens), func.sum(UsageEvent.estimated_cost),
        func.sum(UsageEvent.billed_cost),
        func.sum(case((UsageEvent.metering_status == "unmetered", 1), else_=0)),
        func.sum(case(((UsageEvent.source == "reported_by_device") &
                       (UsageEvent.estimated_cost.is_(None)), 1), else_=0)),
        func.min(UsageEvent.currency), func.max(UsageEvent.currency),
    ).where(
        UsageEvent.provider_id == provider_id,
        UsageEvent.occurred_at >= datetime.combine(from_day, time.min, timezone.utc),
        UsageEvent.occurred_at < datetime.combine(
            to_day + timedelta(days=1), time.min, timezone.utc,
        ),
        UsageEvent.source.in_(("reported_by_device", "provider_reconciled")),
    ).group_by(day, UsageEvent.model, UsageEvent.source).limit(4000))
    async with request.app.state.database.session() as session:
        values = (await session.execute(query)).all()
    if len(values) == 4000:
        raise HTTPException(status_code=413, detail="Reconciliation range too large")
    groups: dict[tuple[str, str | None], dict[str, tuple]] = {}
    for row in values:
        groups.setdefault((row[0], row[1]), {})[row[2]] = row
    result = []
    for (event_day, model), sources in sorted(
        groups.items(), key=lambda item: (item[0][0], item[0][1] or ""),
    ):
        device = sources.get("reported_by_device")
        provider = sources.get("provider_reconciled")
        device_tokens = (device[4], device[5]) if device else (None, None)
        billed_tokens = (provider[4], provider[5]) if provider else (None, None)
        device_cost = device[6] if device else None
        billed_cost = provider[7] if provider else None
        currencies = {value for source in (device, provider) if source
                      for value in (source[10], source[11]) if value}
        comparable = (device is not None and provider is not None
                      and not device[8] and not device[9]
                      and device_cost is not None and billed_cost is not None
                      and len(currencies) == 1)
        if provider is None:
            status = "awaiting_provider"
        elif device is None:
            status = "missing_device"
        elif device[8] or device[9] or device_cost is None or billed_cost is None:
            status = "incomplete"
        elif len(currencies) != 1:
            status = "incomparable"
        else:
            status = ("matched" if device_tokens == billed_tokens
                      and device_cost == billed_cost else "different")
        result.append({
            "day": event_day, "provider_id": provider_id, "model": model,
            "status": status,
            "device_event_count": device[3] if device else 0,
            "provider_line_count": provider[3] if provider else 0,
            "unmetered_count": device[8] if device else 0,
            "device_input_tokens": device_tokens[0],
            "device_output_tokens": device_tokens[1],
            "provider_input_tokens": billed_tokens[0],
            "provider_output_tokens": billed_tokens[1],
            "input_tokens_difference": (billed_tokens[0] - device_tokens[0]
                                        if comparable else None),
            "output_tokens_difference": (billed_tokens[1] - device_tokens[1]
                                         if comparable else None),
            "estimated_cost": f"{device_cost:.6f}" if device_cost is not None else None,
            "billed_cost": f"{billed_cost:.6f}" if billed_cost is not None else None,
            "cost_difference": (f"{billed_cost - device_cost:.6f}"
                                if comparable else None),
            "currency": next(iter(currencies)) if len(currencies) == 1 else None,
        })
    return {"rows": result}


@router.get("/events")
async def usage_events(request: Request,
                       device_id: str | None = Query(default=None, max_length=64),
                       user_id: str | None = Query(default=None, max_length=64),
                       project_id: str | None = Query(default=None, max_length=64),
                       provider_id: str | None = Query(default=None, max_length=64),
                       model: str | None = Query(default=None, max_length=128),
                       source: UsageSource | None = None,
                       metering_status: MeteringStatus | None = None,
                       from_time: datetime | None = None,
                       to_time: datetime | None = None,
                       page: int = Query(1, ge=1),
                       page_size: int = Query(25, ge=1, le=100)):
    await _super_admin_read(request)
    conditions = _usage_conditions(device_id=device_id, user_id=user_id, project_id=project_id,
                                   provider_id=provider_id, model=model, source=source,
                                   metering_status=metering_status, from_time=from_time,
                                   to_time=to_time)
    async with request.app.state.database.session() as session:
        total = await session.scalar(select(func.count()).select_from(UsageEvent).where(*conditions))
        rows = (await session.scalars(select(UsageEvent).where(*conditions).order_by(
            UsageEvent.occurred_at.desc(), UsageEvent.id.desc(),
        ).offset((page - 1) * page_size).limit(page_size))).all()
    return {"events": [{
        "id": item.id, "request_id": item.request_id, "source": item.source,
        "metering_status": item.metering_status,
        "occurred_at": item.occurred_at, "received_at": item.received_at,
        "user_id": item.user_id, "initiated_by_user_id": item.initiated_by_user_id,
        "device_id": item.device_id, "project_id": item.project_id,
        "task_id": item.task_id, "run_id": item.run_id,
        "message_id": item.message_id, "session_id": item.session_id,
        "provider_id": item.provider_id, "provider_revision": item.provider_revision,
        "model": item.model, "input_tokens": item.input_tokens,
        "output_tokens": item.output_tokens,
        "cache_read_tokens": item.cache_read_tokens,
        "cache_write_tokens": item.cache_write_tokens,
        "total_tokens": item.total_tokens, "pricing_version": item.pricing_version,
        "currency": item.currency,
        "estimated_cost": (f"{item.estimated_cost:.6f}"
                           if item.estimated_cost is not None else None),
        "billed_cost": (f"{item.billed_cost:.6f}"
                        if item.billed_cost is not None else None),
    } for item in rows], "total": total, "page": page, "page_size": page_size}
