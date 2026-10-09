"""Gateway-owned whole-instance grants; group access is resolved live."""
import json
from typing import Literal
from uuid import uuid4
from pydantic import BaseModel
from sqlalchemy import select
from gateway.models import Device, User, UserDevice, UserGroup, GroupMembership, GroupDevice, AuditEvent
from gateway.services.errors import GatewayError
from gateway.services.identity import _now
from gateway.services.management_scope import project_manager, require_grant_subject
from gateway.services.permission_subjects import active_super_admin_user_ids

class DeviceGrantInput(BaseModel):
    subject_type: Literal['user', 'group']
    subject_id: str
    access_level: Literal['edit'] = 'edit'

def assigned_device_ids(user_id):
    direct = select(UserDevice.device_id).where(UserDevice.user_id == user_id, UserDevice.revoked_at.is_(None))
    groups = select(GroupDevice.device_id).join(UserGroup, UserGroup.id == GroupDevice.group_id).join(
        GroupMembership, GroupMembership.group_id == UserGroup.id).where(
        GroupMembership.user_id == user_id, GroupMembership.revoked_at.is_(None),
        UserGroup.status == 'active', GroupDevice.revoked_at.is_(None))
    owners = select(Device.id).where(Device.owner_user_id == user_id)
    administrators = select(Device.id).where(select(User.id).where(
        User.id == user_id, User.id.in_(active_super_admin_user_ids())).exists())
    return direct.union(groups, owners, administrators)

async def has_device_access(session, user_id, device_id):
    return await session.scalar(select(Device.id).where(Device.id == device_id, Device.id.in_(assigned_device_ids(user_id)))) is not None

async def list_device_grants(call, device_id):
    await project_manager(call, device_id=device_id)
    async with call.database.session() as session:
        device = await session.get(Device, device_id)
        if device is None: raise GatewayError('not_found', 'Device unavailable')
        users = (await session.execute(select(UserDevice, User).join(User, User.id == UserDevice.user_id).where(
            UserDevice.device_id == device_id, UserDevice.revoked_at.is_(None), User.status != 'deleted'))).all()
        groups = (await session.execute(select(GroupDevice, UserGroup).join(UserGroup, UserGroup.id == GroupDevice.group_id).where(
            GroupDevice.device_id == device_id, GroupDevice.revoked_at.is_(None), UserGroup.status == 'active'))).all()
    return {'grants': [dict(id=row.id,subject_type=kind,subject_id=subject.id,
        subject_name=(subject.display_name or subject.username) if kind == 'user' else subject.name, access_level='edit')
        for kind, pairs in [('user', users), ('group', groups)] for row,subject in pairs]}

async def set_device_grant(call, device_id, body):
    identity, actor, _ = await project_manager(call, device_id=device_id, mutation=True)
    await require_grant_subject(call, identity, actor.id, body.subject_type, body.subject_id)
    model = UserDevice if body.subject_type == 'user' else GroupDevice
    column = model.user_id if body.subject_type == 'user' else model.group_id
    async with call.database.session() as session:
        async with session.begin():
            device = await session.get(Device, device_id)
            subject = await session.get(User if body.subject_type == 'user' else UserGroup, body.subject_id)
            if not device or device.status != 'active' or not subject or subject.status != 'active':
                raise GatewayError('not_found', 'Device or subject unavailable')
            row = await session.scalar(select(model).where(model.device_id == device_id, column == body.subject_id))
            if row is None:
                row = model(id=str(uuid4()),device_id=device_id,**({'user_id':body.subject_id} if body.subject_type == 'user' else {'group_id':body.subject_id}))
                session.add(row)
            else: row.revoked_at = None
            device.policy_revision += 1; device.provider_revision += 1
            session.add(AuditEvent(id=str(uuid4()),user_id=actor.id,device_id=device_id,action='admin.device_grant_set',result='success',metadata_json=json.dumps(body.model_dump())))
    return {'id':row.id}

async def revoke_device_grant(call, device_id, subject_type, subject_id):
    identity, actor, _ = await project_manager(call, device_id=device_id, mutation=True)
    await require_grant_subject(call, identity, actor.id, subject_type, subject_id)
    model = UserDevice if subject_type == 'user' else GroupDevice
    column = model.user_id if subject_type == 'user' else model.group_id
    async with call.database.session() as session:
        async with session.begin():
            row = await session.scalar(select(model).where(model.device_id == device_id,column == subject_id,model.revoked_at.is_(None)))
            if row is None: raise GatewayError('not_found','Grant unavailable')
            row.revoked_at = _now()
            device = await session.get(Device,device_id)
            device.policy_revision += 1; device.provider_revision += 1
            session.add(AuditEvent(id=str(uuid4()),user_id=actor.id,device_id=device_id,action='admin.device_grant_revoked',result='success',metadata_json=json.dumps({'subject_type':subject_type,'subject_id':subject_id})))
    await call.control_connections.close_data(device_id)
