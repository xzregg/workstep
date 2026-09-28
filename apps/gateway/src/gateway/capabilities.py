"""Scoped managed capabilities compiled into signed device policies."""

from uuid import uuid4
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select, update

from .identity import COOKIE_NAME, _now
from .identity_api import _super_admin_request
from .models import AuditEvent, CapabilityAssignment, Device, User, UserDevice

router = APIRouter(prefix="/api")


class CapabilityTargetInput(BaseModel):
    capability: Literal["task.create"]
    scope_type: Literal["global", "device"]
    scope_id: str | None = Field(default=None, max_length=64)

    @model_validator(mode="after")
    def valid_scope(self):
        if (self.scope_type == "global" and self.scope_id is not None) or (
                self.scope_type == "device" and not self.scope_id):
            raise ValueError("Invalid capability scope")
        return self


class CapabilityInput(CapabilityTargetInput):
    effect: Literal["allow", "deny"]


async def _bump_revisions(session, user_id: str, scope_type: str, scope_id: str) -> None:
    device_ids = (await session.scalars(select(UserDevice.device_id).where(
        UserDevice.user_id == user_id, UserDevice.revoked_at.is_(None),
        *([UserDevice.device_id == scope_id] if scope_type == "device" else []),
    ))).all()
    if device_ids:
        await session.execute(update(Device).where(Device.id.in_(device_ids)).values(
            policy_revision=Device.policy_revision + 1,
        ))


async def compiled_device_policy(database, device_id: str, user_id: str) -> tuple[int, bool]:
    async with database.session() as session:
        device = await session.get(Device, device_id)
        if device is None:
            raise ValueError("Device not found")
        assignments = (await session.scalars(select(CapabilityAssignment).where(
            CapabilityAssignment.user_id == user_id,
            CapabilityAssignment.capability == "task.create",
            CapabilityAssignment.revoked_at.is_(None),
        ))).all()
    relevant = [item for item in assignments if item.scope_type == "global"
                or (item.scope_type == "device" and item.scope_id == device_id)]
    allowed = any(item.effect == "allow" for item in relevant) and not any(
        item.effect == "deny" for item in relevant)
    return device.policy_revision, allowed


@router.post("/admin/capabilities/{user_id}")
async def set_capability(request: Request, user_id: str, body: CapabilityInput):
    identity, actor = await _super_admin_request(request)
    _, auth_session = await identity.session_user(request.cookies.get(COOKIE_NAME))
    await identity.require_step_up(auth_session)
    database = request.app.state.database
    scope_id = body.scope_id or ""
    async with database.session() as session:
        async with session.begin():
            user = await session.get(User, user_id)
            if user is None:
                raise HTTPException(status_code=404, detail="User not found")
            if body.scope_type == "device" and await session.get(Device, scope_id) is None:
                raise HTTPException(status_code=404, detail="Device not found")
            assignment = await session.scalar(select(CapabilityAssignment).where(
                CapabilityAssignment.user_id == user_id,
                CapabilityAssignment.capability == body.capability,
                CapabilityAssignment.scope_type == body.scope_type,
                CapabilityAssignment.scope_id == scope_id,
            ))
            if assignment is None:
                assignment = CapabilityAssignment(
                    id=str(uuid4()), user_id=user_id, capability=body.capability,
                    scope_type=body.scope_type, scope_id=scope_id, effect=body.effect,
                    assigned_by_user_id=actor.id,
                )
                session.add(assignment)
            else:
                assignment.effect = body.effect
                assignment.assigned_by_user_id = actor.id
                assignment.revoked_at = None
            await _bump_revisions(session, user_id, body.scope_type, scope_id)
            session.add(AuditEvent(
                id=str(uuid4()), user_id=actor.id,
                device_id=scope_id if body.scope_type == "device" else None,
                action="admin.capability_set", result="success",
                metadata_json=None,
            ))
    return {"id": assignment.id, "user_id": user_id, "capability": body.capability,
            "scope_type": body.scope_type, "scope_id": body.scope_id, "effect": body.effect}


@router.post("/admin/capabilities/{user_id}/revoke", status_code=204)
async def revoke_capability(request: Request, user_id: str, body: CapabilityTargetInput):
    identity, actor = await _super_admin_request(request)
    _, auth_session = await identity.session_user(request.cookies.get(COOKIE_NAME))
    await identity.require_step_up(auth_session)
    scope_id = body.scope_id or ""
    async with request.app.state.database.session() as session:
        async with session.begin():
            assignment = await session.scalar(select(CapabilityAssignment).where(
                CapabilityAssignment.user_id == user_id,
                CapabilityAssignment.capability == body.capability,
                CapabilityAssignment.scope_type == body.scope_type,
                CapabilityAssignment.scope_id == scope_id,
            ))
            if assignment is None or assignment.revoked_at is not None:
                raise HTTPException(status_code=404, detail="Capability assignment not found")
            assignment.revoked_at = _now()
            await _bump_revisions(session, user_id, body.scope_type, scope_id)
            session.add(AuditEvent(
                id=str(uuid4()), user_id=actor.id,
                device_id=scope_id if body.scope_type == "device" else None,
                action="admin.capability_revoked", result="success", metadata_json=None,
            ))
