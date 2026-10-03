"""Validate and idempotently receive bounded project audit batches."""

import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator
from sqlalchemy import and_, exists, func, or_, select

from .ledger_scope import ledger_scope
from .models import (
    AuditEvent, AuditEventReceipt, PlatformProject,
)


router = APIRouter(prefix="/api/admin/audit")


_METADATA_KEYS = {
    "source", "step_key", "workflow_run_id", "review_run_id",
    "status", "reason_code", "schedule_id",
}


class AuditEventInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    audit_event_id: str = Field(min_length=1, max_length=64)
    device_id: str = Field(min_length=1, max_length=64)
    project_id: str = Field(min_length=1, max_length=64)
    task_id: str | None = Field(default=None, max_length=64)
    action: str = Field(pattern=r"^[a-z][a-z0-9_.]{1,127}$")
    result: Literal["succeeded", "denied", "failed"]
    mode: Literal["local", "managed"]
    actor_id: str = Field(min_length=1, max_length=64)
    actor_username: str | None = Field(default=None, max_length=128)
    actor_name: str | None = Field(default=None, max_length=256)
    actor_type: Literal["user", "system", "scheduler"]
    actor_device_id: str | None = Field(default=None, max_length=64)
    actor_device_name: str | None = Field(default=None, max_length=256)
    initiated_by_user_id: str | None = Field(default=None, max_length=64)
    initiated_by_username: str | None = Field(default=None, max_length=128)
    metadata: dict = Field(default_factory=dict)
    occurred_at: datetime

    @field_validator("metadata")
    @classmethod
    def safe_metadata(cls, value: dict):
        if len(value) > 8 or any(
            key not in _METADATA_KEYS
            or not isinstance(item, (str, int, bool))
            or isinstance(item, str) and len(item) > 256
            for key, item in value.items()
        ) or len(json.dumps(value, ensure_ascii=False).encode()) > 2048:
            raise ValueError("Invalid audit metadata")
        return value

    @model_validator(mode="after")
    def valid_time(self):
        if self.occurred_at.tzinfo is None:
            raise ValueError("Audit time must include timezone")
        if self.occurred_at > datetime.now(timezone.utc) + timedelta(minutes=5):
            raise ValueError("Audit time is in the future")
        return self


async def record_audit_batch(
    database, device_id: str, batch_id: str, events: list[dict],
) -> dict:
    if (not isinstance(batch_id, str) or not 1 <= len(batch_id) <= 128
            or not isinstance(events, list) or not 1 <= len(events) <= 100
            or len(json.dumps(events, default=str).encode()) > 512 * 1024):
        raise ValueError("Invalid audit batch")
    valid: list[tuple[AuditEventInput, str]] = []
    rejected: list[str] = []
    for raw in events:
        event_id = raw.get("audit_event_id", "") if isinstance(raw, dict) else ""
        try:
            event = AuditEventInput.model_validate(raw)
            if event.device_id != device_id:
                raise ValueError("Audit device mismatch")
            canonical = json.dumps(
                event.model_dump(mode="json"), sort_keys=True, separators=(",", ":"),
            )
            valid.append((event, hashlib.sha256(canonical.encode()).hexdigest()))
        except (ValidationError, ValueError, TypeError):
            rejected.append(str(event_id)[:64])

    accepted: list[str] = []
    duplicates: list[str] = []
    async with database.session() as session:
        async with session.begin():
            for event, digest in valid:
                receipt = await session.get(AuditEventReceipt, event.audit_event_id)
                if receipt is not None:
                    if receipt.device_id == device_id and receipt.payload_sha256 == digest:
                        duplicates.append(event.audit_event_id)
                    else:
                        rejected.append(event.audit_event_id)
                    continue
                if await session.get(AuditEvent, event.audit_event_id) is not None:
                    rejected.append(event.audit_event_id)
                    continue
                session.add(AuditEventReceipt(
                    audit_event_id=event.audit_event_id, device_id=device_id,
                    payload_sha256=digest,
                ))
                session.add(AuditEvent(
                    id=event.audit_event_id,
                    user_id=event.actor_id if event.actor_type == "user" else None,
                    device_id=device_id,
                    action=event.action, result=event.result,
                    metadata_json=json.dumps(event.metadata, ensure_ascii=False),
                    project_id=event.project_id, task_id=event.task_id,
                    mode=event.mode, actor_username=event.actor_username,
                    actor_name=event.actor_name, actor_type=event.actor_type,
                    actor_device_id=event.actor_device_id,
                    actor_device_name=event.actor_device_name,
                    initiated_by_user_id=event.initiated_by_user_id,
                    initiated_by_username=event.initiated_by_username,
                    occurred_at=event.occurred_at,
                ))
                await session.flush()
                accepted.append(event.audit_event_id)
    return {"batch_id": batch_id, "accepted": accepted,
            "duplicates": duplicates, "rejected": rejected}


_VISIBLE_METADATA_KEYS = _METADATA_KEYS | {
    "device_id", "user_id", "group_id", "project_id", "provider_id",
    "batch_id", "skill_id", "source_id", "scope_type", "scope_id",
    "subject_id", "subject_type", "access_level", "role", "share_id", "method", "route",
}


def _visible_metadata(raw: str | None) -> dict:
    try:
        value = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    if not isinstance(value, dict):
        return {}
    return {
        key: item for key, item in value.items()
        if key in _VISIBLE_METADATA_KEYS
        and isinstance(item, (str, int, bool))
        and (not isinstance(item, str) or len(item) <= 256)
    }


@router.get("")
async def query_audit(
    request: Request,
    project_id: str | None = Query(default=None, max_length=64),
    device_id: str | None = Query(default=None, max_length=64),
    action: str | None = Query(default=None, max_length=128),
    user_id: str | None = Query(default=None, max_length=64),
    result: str | None = Query(default=None, max_length=16),
    q: str | None = Query(default=None, max_length=128),
    from_time: datetime | None = None,
    to_time: datetime | None = None,
    limit: int = Query(default=100, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    if (from_time and from_time.tzinfo is None) or (to_time and to_time.tzinfo is None):
        raise HTTPException(422, "Audit time must include timezone")
    if from_time and to_time and from_time >= to_time:
        raise HTTPException(422, "End time must be after start time")
    async with request.app.state.database.session() as session:
        scope = await ledger_scope(request, session, AuditEvent)
        published = exists(select(PlatformProject.id).where(
            PlatformProject.device_id == AuditEvent.device_id,
            PlatformProject.host_project_id == AuditEvent.project_id,
            PlatformProject.access_mode == "remote_published",
            PlatformProject.status == "active",
        ))
        conditions = [or_(AuditEvent.project_id.is_(None), published)]
        if scope is not None:
            conditions.append(scope)
        if project_id:
            project = await session.get(PlatformProject, project_id)
            if (project is None or project.access_mode != "remote_published"
                    or project.status != "active"):
                raise HTTPException(404, "Published project unavailable")
            conditions.extend((
                AuditEvent.project_id == project.host_project_id,
                AuditEvent.device_id == project.device_id,
            ))
        if device_id:
            conditions.append(AuditEvent.device_id == device_id)
        if action:
            conditions.append(AuditEvent.action == action)
        if user_id:
            conditions.append(or_(AuditEvent.user_id == user_id,
                                  AuditEvent.initiated_by_user_id == user_id))
        if result:
            conditions.append(AuditEvent.result == result)
        event_time = func.coalesce(AuditEvent.occurred_at, AuditEvent.created_at)
        if from_time:
            conditions.append(event_time >= from_time)
        if to_time:
            conditions.append(event_time < to_time)
        if q and q.strip():
            pattern = '%' + q.strip().replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
            conditions.append(or_(*(
                column.ilike(pattern, escape='\\') for column in (
                    AuditEvent.action, AuditEvent.actor_username,
                    AuditEvent.actor_name, AuditEvent.initiated_by_username,
                    AuditEvent.task_id, AuditEvent.device_id,
                )
            )))
        total = await session.scalar(select(func.count()).select_from(AuditEvent).where(*conditions))
        rows = (await session.scalars(
            select(AuditEvent).where(*conditions)
            .order_by(event_time.desc(), AuditEvent.id.desc())
            .limit(limit + 1).offset(offset)
        )).all()
        project_keys = {(row.device_id, row.project_id) for row in rows[:limit]
                        if row.device_id and row.project_id}
        projects = (await session.scalars(select(PlatformProject).where(
            PlatformProject.access_mode == "remote_published",
            PlatformProject.status == "active",
            or_(*(and_(PlatformProject.device_id == device,
                       PlatformProject.host_project_id == host)
                   for device, host in project_keys)),
        ))).all() if project_keys else []
        project_map = {(row.device_id, row.host_project_id): row for row in projects}
        return {
            "items": [{
                "id": row.id,
                "device_id": row.device_id,
                "project_id": row.project_id,
                "platform_project_id": project_map[(row.device_id, row.project_id)].id
                if (row.device_id, row.project_id) in project_map else None,
                "project_name": project_map[(row.device_id, row.project_id)].name
                if (row.device_id, row.project_id) in project_map else None,
                "task_id": row.task_id,
                "action": row.action,
                "result": row.result,
                "mode": row.mode,
                "actor_id": row.user_id or row.actor_type,
                "actor_username": row.actor_username,
                "actor_name": row.actor_name,
                "actor_type": row.actor_type,
                "actor_device_id": row.actor_device_id,
                "actor_device_name": row.actor_device_name,
                "initiated_by_user_id": row.initiated_by_user_id,
                "initiated_by_username": row.initiated_by_username,
                "metadata": _visible_metadata(row.metadata_json),
                "occurred_at": (row.occurred_at or row.created_at).isoformat(),
            } for row in rows[:limit]],
            "total": total or 0,
            "next_offset": offset + limit if len(rows) > limit else None,
        }
