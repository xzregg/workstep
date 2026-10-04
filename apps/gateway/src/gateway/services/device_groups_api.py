from gateway.services.errors import GatewayError
from gateway.contracts import GatewayCall
import json

from uuid import uuid4


from pydantic import BaseModel, Field

from sqlalchemy import select

from sqlalchemy.exc import IntegrityError

from gateway.services.identity import COOKIE_NAME

from gateway.services.identity_api import _super_admin_read, _super_admin_request

from gateway.models import AuditEvent, Device, DeviceGroup, DeviceGroupMembership, DirectoryDepartment


"""Explicit device management groups and department assignment."""


class GroupInput(BaseModel):
    name: str = Field(min_length=1, max_length=256)


class DepartmentInput(BaseModel):
    department_id: str | None = None


async def _writer(call):
    identity, actor = await _super_admin_request(call)
    _, auth_session = await identity.session_user(call.tokens.get(COOKIE_NAME))
    await identity.require_step_up(auth_session)
    return actor


def _audit(session, actor, action, *, device_id=None, group_id=None):
    session.add(AuditEvent(id=str(uuid4()), user_id=actor.id, device_id=device_id,
        action=action, result="success", metadata_json=json.dumps({"group_id": group_id})))


async def list_groups(call: GatewayCall):
    await _super_admin_read(call)
    async with call.database.session() as session:
        groups = (await session.scalars(select(DeviceGroup).order_by(DeviceGroup.name))).all()
        memberships = (await session.execute(select(DeviceGroupMembership.group_id,
            DeviceGroupMembership.device_id))).all()
        return {"groups": [{"id": group.id, "name": group.name,
            "device_ids": [device for group_id, device in memberships if group_id == group.id]}
            for group in groups]}


async def create_group(call: GatewayCall, body: GroupInput):
    actor = await _writer(call)
    name = body.name.strip()
    if not name:
        raise GatewayError('invalid', 'Group name required')
    group = DeviceGroup(id=str(uuid4()), name=name)
    try:
        async with call.database.session() as session:
            async with session.begin():
                session.add(group)
                _audit(session, actor, "admin.device_group.created", group_id=group.id)
    except IntegrityError:
        raise GatewayError('conflict', 'Device group already exists') from None
    return {"id": group.id, "name": group.name}


async def add_member(call: GatewayCall, group_id: str, device_id: str):
    actor = await _writer(call)
    async with call.database.session() as session:
        async with session.begin():
            if not await session.get(DeviceGroup, group_id) or not await session.get(Device, device_id):
                raise GatewayError('not_found', 'Device or group not found')
            if not await session.get(DeviceGroupMembership, (group_id, device_id)):
                session.add(DeviceGroupMembership(group_id=group_id, device_id=device_id))
                _audit(session, actor, "admin.device_group.member_added", device_id=device_id, group_id=group_id)


async def remove_member(call: GatewayCall, group_id: str, device_id: str):
    actor = await _writer(call)
    async with call.database.session() as session:
        async with session.begin():
            member = await session.get(DeviceGroupMembership, (group_id, device_id))
            if not member:
                raise GatewayError('not_found', 'Device group membership not found')
            await session.delete(member)
            _audit(session, actor, "admin.device_group.member_removed", device_id=device_id, group_id=group_id)


async def set_department(call: GatewayCall, device_id: str, body: DepartmentInput):
    actor = await _writer(call)
    async with call.database.session() as session:
        async with session.begin():
            device = await session.get(Device, device_id)
            if not device:
                raise GatewayError('not_found', 'Device not found')
            if body.department_id:
                department = await session.get(DirectoryDepartment, body.department_id)
                if not department or not department.active:
                    raise GatewayError('invalid', 'Active department required')
            device.department_id = body.department_id
            _audit(session, actor, "admin.device.department_changed", device_id=device_id)
