from gateway.services.errors import GatewayError
from gateway.contracts import GatewayCall
from uuid import uuid4


from pydantic import BaseModel

from sqlalchemy import select

from gateway.services.identity import COOKIE_NAME, IdentityService, _now

from gateway.services.management_scope import project_manager, require_grant_subject

from gateway.services.device_grants import assigned_device_ids, has_device_access
from gateway.models import AuditEvent, Device, User, UserDevice


"""User access to whole managed PC workspaces."""


class AssignUserInput(BaseModel):
    user_id: str


async def _admin(call: GatewayCall, device_id: str, user_id: str):
    identity, actor, _ = await project_manager(call, device_id=device_id, mutation=True)
    await require_grant_subject(call, identity, actor.id, 'user', user_id)
    return actor


async def assigned_devices(call: GatewayCall):
    user, _ = await IdentityService(call.database).session_user(call.tokens.get(COOKIE_NAME))
    return await assigned_devices_for_user(call, user.id)


async def assigned_devices_for_user(call: GatewayCall, user_id: str):
    async with call.database.session() as session:
        devices = (await session.scalars(select(Device).where(Device.id.in_(assigned_device_ids(user_id)),
                Device.status == 'active').order_by(Device.created_at.desc()))).all()
    return {"devices": [{"id": device.id, "name": device.name, "status": device.status,
                         "online": call.control_connections.is_online(device.id),
                         "version": device.version} for device in devices]}


async def device_access(call: GatewayCall, device_id: str):
    user, _ = await IdentityService(call.database).session_user(call.tokens.get(COOKIE_NAME))
    if user.status != "active":
        raise GatewayError('forbidden', 'Account unavailable')
    return await device_access_for_user(call, device_id, user.id)


async def device_access_for_user(call: GatewayCall, device_id: str, user_id: str):
    async with call.database.session() as session:
        device = await session.get(Device, device_id)
        assignment = await has_device_access(session,user_id,device_id)
    if not device or device.status != "active" or not assignment:
        raise GatewayError('forbidden', 'Device access denied')
    if not call.control_connections.is_online(device_id):
        raise GatewayError('conflict', 'Device is offline')
    origin = call.settings.public_origin
    if origin is None:
        raise GatewayError('unavailable', 'Public Gateway origin is not configured')
    host = call.settings.device_authority(device_id)
    ticket = call.gateway_signer.sign_device_access_ticket(gateway_id=call.settings.gateway_id, device_id=device_id, user_id=user_id, audience=host)
    return {"url": call.settings.device_url(device_id), "ticket": ticket, "expires_in": 60}


async def assign_device_user(call: GatewayCall, device_id: str, body: AssignUserInput):
    actor = await _admin(call, device_id, body.user_id)
    async with call.database.session() as session:
        async with session.begin():
            device = await session.get(Device, device_id)
            user = await session.get(User, body.user_id)
            if not device or device.status != "active" or not user or user.status != "active":
                raise GatewayError('not_found', 'Device or user unavailable')
            assignment = await session.scalar(select(UserDevice).where(
                UserDevice.user_id == body.user_id, UserDevice.device_id == device_id,
            ))
            if assignment is None:
                assignment = UserDevice(id=str(uuid4()), user_id=body.user_id,
                                        device_id=device_id, access_level="edit")
                session.add(assignment)
                device.policy_revision += 1
                device.provider_revision += 1
            elif assignment.revoked_at is not None:
                assignment.revoked_at = None
                device.policy_revision += 1
                device.provider_revision += 1
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id, device_id=device_id,
                                   action="admin.device_user_assigned", result="success",
                                   metadata_json=None))
    return {"id": assignment.id, "user_id": body.user_id, "device_id": device_id}


async def revoke_device_user(call: GatewayCall, device_id: str, user_id: str):
    actor = await _admin(call, device_id, user_id)
    async with call.database.session() as session:
        async with session.begin():
            assignment = await session.scalar(select(UserDevice).where(
                UserDevice.user_id == user_id, UserDevice.device_id == device_id,
                UserDevice.revoked_at.is_(None),
            ))
            if assignment is None:
                raise GatewayError('not_found', 'Device assignment not found')
            assignment.revoked_at = _now()
            device = await session.get(Device, device_id)
            device.policy_revision += 1
            device.provider_revision += 1
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id, device_id=device_id,
                                   action="admin.device_user_revoked", result="success",
                                   metadata_json=None))
    await call.control_connections.close_data(device_id)
