"""Explicit device management groups and department assignment."""
import json
from uuid import uuid4
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from .identity import COOKIE_NAME
from .identity_api import _super_admin_read, _super_admin_request
from .models import AuditEvent, Device, DeviceGroup, DeviceGroupMembership, DirectoryDepartment

router = APIRouter(prefix="/api/admin")

class GroupInput(BaseModel):
    name: str = Field(min_length=1, max_length=256)

class DepartmentInput(BaseModel):
    department_id: str | None = None

async def _writer(request):
    identity, actor = await _super_admin_request(request)
    _, auth_session = await identity.session_user(request.cookies.get(COOKIE_NAME))
    await identity.require_step_up(auth_session)
    return actor

def _audit(session, actor, action, *, device_id=None, group_id=None):
    session.add(AuditEvent(id=str(uuid4()), user_id=actor.id, device_id=device_id,
        action=action, result="success", metadata_json=json.dumps({"group_id": group_id})))

@router.get("/device-groups")
async def list_groups(request: Request):
    await _super_admin_read(request)
    async with request.app.state.database.session() as session:
        groups = (await session.scalars(select(DeviceGroup).order_by(DeviceGroup.name))).all()
        memberships = (await session.execute(select(DeviceGroupMembership.group_id,
            DeviceGroupMembership.device_id))).all()
        return {"groups": [{"id": group.id, "name": group.name,
            "device_ids": [device for group_id, device in memberships if group_id == group.id]}
            for group in groups]}

@router.post("/device-groups", status_code=201)
async def create_group(request: Request, body: GroupInput):
    actor = await _writer(request)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Group name required")
    group = DeviceGroup(id=str(uuid4()), name=name)
    try:
        async with request.app.state.database.session() as session:
            async with session.begin():
                session.add(group)
                _audit(session, actor, "admin.device_group.created", group_id=group.id)
    except IntegrityError:
        raise HTTPException(status_code=409, detail="Device group already exists") from None
    return {"id": group.id, "name": group.name}

@router.put("/device-groups/{group_id}/devices/{device_id}", status_code=204)
async def add_member(request: Request, group_id: str, device_id: str):
    actor = await _writer(request)
    async with request.app.state.database.session() as session:
        async with session.begin():
            if not await session.get(DeviceGroup, group_id) or not await session.get(Device, device_id):
                raise HTTPException(status_code=404, detail="Device or group not found")
            if not await session.get(DeviceGroupMembership, (group_id, device_id)):
                session.add(DeviceGroupMembership(group_id=group_id, device_id=device_id))
                _audit(session, actor, "admin.device_group.member_added", device_id=device_id, group_id=group_id)

@router.delete("/device-groups/{group_id}/devices/{device_id}", status_code=204)
async def remove_member(request: Request, group_id: str, device_id: str):
    actor = await _writer(request)
    async with request.app.state.database.session() as session:
        async with session.begin():
            member = await session.get(DeviceGroupMembership, (group_id, device_id))
            if not member:
                raise HTTPException(status_code=404, detail="Device group membership not found")
            await session.delete(member)
            _audit(session, actor, "admin.device_group.member_removed", device_id=device_id, group_id=group_id)

@router.put("/devices/{device_id}/department", status_code=204)
async def set_department(request: Request, device_id: str, body: DepartmentInput):
    actor = await _writer(request)
    async with request.app.state.database.session() as session:
        async with session.begin():
            device = await session.get(Device, device_id)
            if not device:
                raise HTTPException(status_code=404, detail="Device not found")
            if body.department_id:
                department = await session.get(DirectoryDepartment, body.department_id)
                if not department or not department.active:
                    raise HTTPException(status_code=422, detail="Active department required")
            device.department_id = body.department_id
            _audit(session, actor, "admin.device.department_changed", device_id=device_id)
