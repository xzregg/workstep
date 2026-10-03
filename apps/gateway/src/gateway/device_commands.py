"""Frozen device operation batches and bounded single-instance dispatch."""

import asyncio
import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select

from .management_scope import device_manager
from .models import AuditEvent, Device, DeviceCommand, DeviceOperationBatch

router = APIRouter(prefix="/api/admin/device-operations")
TERMINAL = frozenset({"succeeded", "failed", "expired"})
IN_FLIGHT = frozenset({"sent", "received", "running"})
STATUS_ORDER = {"queued": 0, "sent": 1, "received": 2, "running": 3,
                "succeeded": 4, "failed": 4, "expired": 4}


class BatchInput(BaseModel):
    action: Literal["install", "update", "rollback", "refresh", "test"]
    engine_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z][a-z0-9_]*$")
    device_ids: list[str] = Field(min_length=1, max_length=100)
    max_concurrency: int = Field(ge=1, le=32)
    version: str | None = Field(default=None, max_length=100,
                                pattern=r"^[0-9][0-9A-Za-z.+-]*$")
    accept_third_party_terms: bool = False

    @field_validator("device_ids")
    @classmethod
    def unique_devices(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values) or any(not value or len(value) > 64 for value in values):
            raise ValueError("Invalid operation target list")
        return values


def _validate_parameters(body: BatchInput) -> None:
    if body.action in ("install", "update") and not body.version:
        raise HTTPException(status_code=422, detail="Exact engine version required")
    if body.action in ("install", "update") and not body.accept_third_party_terms:
        raise HTTPException(status_code=422, detail="Third-party terms acknowledgement required")
    if body.action in ("rollback", "refresh", "test") and body.version:
        raise HTTPException(status_code=422, detail="Version not accepted for this action")


def _public_command(command: DeviceCommand) -> dict:
    return {"id": command.id, "device_id": command.device_id,
            "status": command.status, "expires_at": command.expires_at,
            "error": command.last_error}


async def _batch_view(session, batch: DeviceOperationBatch) -> dict:
    commands = (await session.scalars(select(DeviceCommand).where(
        DeviceCommand.batch_id == batch.id,
    ).order_by(DeviceCommand.target_order))).all()
    params = json.loads(batch.parameters_json)
    return {"id": batch.id, "action": batch.action, "engine_id": params["engine_id"],
            "version": params.get("version"), "max_concurrency": batch.max_concurrency,
            "status": batch.status, "created_at": batch.created_at,
            "commands": [_public_command(command) for command in commands]}


async def _finish_if_terminal(session, batch_id: str) -> None:
    statuses = (await session.scalars(select(DeviceCommand.status).where(
        DeviceCommand.batch_id == batch_id,
    ))).all()
    if statuses and all(value in TERMINAL for value in statuses):
        batch = await session.get(DeviceOperationBatch, batch_id)
        batch.status = "finished"


async def _expire_waiting(session, batch_id: str | None = None) -> None:
    now = datetime.now(timezone.utc)
    query = select(DeviceCommand).where(
        DeviceCommand.status.in_(("queued", "sent", "received")),
        DeviceCommand.expires_at <= now,
    )
    if batch_id:
        query = query.where(DeviceCommand.batch_id == batch_id)
    commands = (await session.scalars(query)).all()
    affected = set()
    for command in commands:
        expires = command.expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if expires <= now:
            command.status = "expired"
            command.completed_at = now
            affected.add(command.batch_id)
    if affected:
        await session.flush()
        for affected_batch_id in affected:
            await _finish_if_terminal(session, affected_batch_id)


async def _create_batch(session, body: BatchInput, actor_id: str) -> DeviceOperationBatch:
    _validate_parameters(body)
    devices = (await session.scalars(select(Device).where(
        Device.id.in_(body.device_ids), Device.status == "active",
    ))).all()
    if len(devices) != len(body.device_ids):
        raise HTTPException(status_code=404, detail="Operation target unavailable")
    batch = DeviceOperationBatch(
        id=str(uuid4()), action=body.action,
        parameters_json=json.dumps({
            "engine_id": body.engine_id, "version": body.version,
            "accept_third_party_terms": body.accept_third_party_terms,
        }), max_concurrency=body.max_concurrency, status="queued",
    )
    session.add(batch)
    expires = datetime.now(timezone.utc) + timedelta(hours=1)
    for order, device_id in enumerate(body.device_ids):
        session.add(DeviceCommand(
            id=str(uuid4()), batch_id=batch.id, device_id=device_id,
            idempotency_key=uuid4().hex, status="queued", expires_at=expires,
            target_order=order,
        ))
    session.add(AuditEvent(id=str(uuid4()), user_id=actor_id,
                           action="admin.device_operation_created", result="success",
                           metadata_json=json.dumps({"batch_id": batch.id,
                                                     "action": body.action,
                                                     "target_count": len(body.device_ids)})))
    await session.flush()
    return batch


@router.post("")
async def create_device_operation(request: Request, body: BatchInput):
    _, actor, _ = await device_manager(request, device_ids=body.device_ids, mutation=True)
    async with request.app.state.database.session() as session:
        async with session.begin():
            batch = await _create_batch(session, body, actor.id)
        return await _batch_view(session, batch)


@router.get("")
async def list_device_operations(request: Request,
                                 limit: int = Query(default=50, ge=1, le=100),
                                 offset: int = Query(default=0, ge=0)):
    _, _, allowed = await device_manager(request)
    async with request.app.state.database.session() as session:
        async with session.begin():
            await _expire_waiting(session)
            conditions = []
            if allowed is not None:
                # Never expose a mixed batch containing any out-of-scope device.
                conditions.append(~select(DeviceCommand.id).where(
                    DeviceCommand.batch_id == DeviceOperationBatch.id,
                    DeviceCommand.device_id.not_in(allowed)).exists())
            total = await session.scalar(select(func.count()).select_from(DeviceOperationBatch).where(*conditions))
            batches = (await session.scalars(select(DeviceOperationBatch).where(*conditions).order_by(
                DeviceOperationBatch.created_at.desc(), DeviceOperationBatch.id.desc(),
            ).limit(limit).offset(offset))).all()
            return {"total": total, "limit": limit, "offset": offset,
                    "batches": [await _batch_view(session, batch) for batch in batches]}


@router.get("/{batch_id}")
async def get_device_operation(request: Request, batch_id: str):
    _, _, allowed = await device_manager(request)
    async with request.app.state.database.session() as session:
        async with session.begin():
            batch = await session.get(DeviceOperationBatch, batch_id)
            if not batch:
                raise HTTPException(status_code=404, detail="Operation batch unavailable")
            targets = set((await session.scalars(select(DeviceCommand.device_id).where(
                DeviceCommand.batch_id == batch_id))).all())
            if allowed is not None and not targets.issubset(allowed):
                raise HTTPException(status_code=403, detail="Device management scope denied")
            await _expire_waiting(session, batch_id)
            return await _batch_view(session, batch)


@router.post("/{batch_id}/retry-failed")
async def retry_failed_device_operation(request: Request, batch_id: str):
    _, actor, allowed = await device_manager(request, mutation=True)
    async with request.app.state.database.session() as session:
        async with session.begin():
            original = await session.get(DeviceOperationBatch, batch_id)
            if not original:
                raise HTTPException(status_code=404, detail="Operation batch unavailable")
            targets = set((await session.scalars(select(DeviceCommand.device_id).where(
                DeviceCommand.batch_id == batch_id))).all())
            if allowed is not None and not targets.issubset(allowed):
                raise HTTPException(status_code=403, detail="Device management scope denied")
            failed = (await session.scalars(select(DeviceCommand.device_id).where(
                DeviceCommand.batch_id == batch_id,
                DeviceCommand.status.in_(("failed", "expired")),
            ))).all()
            if not failed:
                raise HTTPException(status_code=409, detail="No failed targets to retry")
            params = json.loads(original.parameters_json)
            body = BatchInput(action=original.action, engine_id=params["engine_id"],
                              device_ids=failed, max_concurrency=original.max_concurrency,
                              version=params.get("version"), accept_third_party_terms=
                              params.get("accept_third_party_terms", False))
            batch = await _create_batch(session, body, actor.id)
        return await _batch_view(session, batch)


async def next_command_for_device(database, lock: asyncio.Lock, device_id: str) -> dict | None:
    """Reserve at most one command per device, respecting each batch's slots."""
    async with lock:
        async with database.session() as session:
            async with session.begin():
                await _expire_waiting(session)
                pending = (await session.scalars(select(DeviceCommand).where(
                    DeviceCommand.device_id == device_id,
                    DeviceCommand.status.in_(("queued", "sent", "received", "running")),
                ).order_by(DeviceCommand.created_at, DeviceCommand.id))).all()
                for command in pending:
                    expires = command.expires_at
                    if expires.tzinfo is None:
                        expires = expires.replace(tzinfo=timezone.utc)
                    batch = await session.get(DeviceOperationBatch, command.batch_id)
                    if command.status == "queued":
                        active = (await session.scalars(select(DeviceCommand.id).where(
                            DeviceCommand.batch_id == batch.id,
                            DeviceCommand.status.in_(IN_FLIGHT),
                        ))).all()
                        if len(active) >= batch.max_concurrency:
                            continue
                        command.status = "sent"
                        batch.status = "running"
                    params = json.loads(batch.parameters_json)
                    delivery_expiry = expires
                    reconcile_only = command.status == "running" and expires <= datetime.now(timezone.utc)
                    if reconcile_only:
                        # The original TTL limits first execution. A running
                        # command may need a fresh signed envelope to replay
                        # its durable result after a long disconnect.
                        delivery_expiry = datetime.now(timezone.utc) + timedelta(minutes=10)
                    return {"id": command.id, "batch_id": batch.id,
                            "device_id": device_id, "idempotency_key": command.idempotency_key,
                            "action": batch.action, **params, "reconcile_only": reconcile_only,
                            "expires_at": int(delivery_expiry.timestamp())}
    return None


async def record_command_result(database, command_id: str, device_id: str,
                                status: str, error: str | None) -> bool:
    if status not in ("received", "running", "succeeded", "failed"):
        raise ValueError("Invalid command status")
    if error is not None and (not isinstance(error, str) or len(error) > 512):
        raise ValueError("Invalid command error")
    async with database.session() as session:
        async with session.begin():
            command = await session.get(DeviceCommand, command_id)
            if not command or command.device_id != device_id:
                return False
            if command.status in TERMINAL:
                return True
            if command.status == "queued":
                return False
            if STATUS_ORDER[status] < STATUS_ORDER[command.status]:
                return True
            command.status = status
            command.last_error = error if status == "failed" else None
            if status in TERMINAL:
                command.completed_at = datetime.now(timezone.utc)
            await session.flush()
            if status in TERMINAL:
                await _finish_if_terminal(session, command.batch_id)
            return True
