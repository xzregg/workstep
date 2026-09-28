"""Validate and idempotently receive bounded project audit batches."""

import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from .models import AuditEvent, AuditEventReceipt


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
