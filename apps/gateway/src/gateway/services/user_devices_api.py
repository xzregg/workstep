from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request

from pydantic import BaseModel

from sqlalchemy import select

from gateway.services.identity import COOKIE_NAME, IdentityService, _now

from gateway.services.management_scope import project_manager, require_grant_subject

from gateway.models import AuditEvent, Device, User, UserDevice


"""User access to whole managed PC workspaces."""


class AssignUserInput(BaseModel):
    user_id: str


async def _admin(request: Request, device_id: str, user_id: str):
    identity, actor, _ = await project_manager(request, device_id=device_id, mutation=True)
    await require_grant_subject(request, identity, actor.id, "user", user_id)
    return actor



async def assigned_devices(request: Request):
    user, _ = await IdentityService(request.app.state.database).session_user(
        request.cookies.get(COOKIE_NAME),
    )
    if user.must_change_password:
        raise HTTPException(status_code=403, detail="Password change required")
    async with request.app.state.database.session() as session:
        devices = (await session.scalars(select(Device).join(
            UserDevice, UserDevice.device_id == Device.id,
        ).where(UserDevice.user_id == user.id, UserDevice.revoked_at.is_(None),
                Device.status == "active").order_by(Device.created_at.desc()))).all()
    return {"devices": [{"id": device.id, "name": device.name, "status": device.status,
                         "online": request.app.state.control_connections.is_online(device.id),
                         "version": device.version} for device in devices]}



async def device_access(request: Request, device_id: str):
    user, _ = await IdentityService(request.app.state.database).session_user(
        request.cookies.get(COOKIE_NAME),
    )
    if user.must_change_password or user.status != "active":
        raise HTTPException(status_code=403, detail="Account unavailable")
    async with request.app.state.database.session() as session:
        device = await session.get(Device, device_id)
        assignment = await session.scalar(select(UserDevice).where(
            UserDevice.device_id == device_id, UserDevice.user_id == user.id,
            UserDevice.revoked_at.is_(None),
        ))
    if not device or device.status != "active" or not assignment:
        raise HTTPException(status_code=403, detail="Device access denied")
    if not request.app.state.control_connections.is_online(device_id):
        raise HTTPException(status_code=409, detail="Device is offline")
    origin = request.app.state.settings.public_origin
    if origin is None:
        raise HTTPException(status_code=503, detail="Public Gateway origin is not configured")
    host = request.app.state.settings.device_authority(device_id)
    ticket = request.app.state.gateway_signer.sign_device_access_ticket(
        gateway_id=request.app.state.settings.gateway_id, device_id=device_id,
        user_id=user.id, audience=host,
    )
    return {"url": request.app.state.settings.device_url(device_id), "ticket": ticket, "expires_in": 60}



async def assign_device_user(request: Request, device_id: str, body: AssignUserInput):
    actor = await _admin(request, device_id, body.user_id)
    async with request.app.state.database.session() as session:
        async with session.begin():
            device = await session.get(Device, device_id)
            user = await session.get(User, body.user_id)
            if not device or device.status != "active" or not user or user.status != "active":
                raise HTTPException(status_code=404, detail="Device or user unavailable")
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



async def revoke_device_user(request: Request, device_id: str, user_id: str):
    actor = await _admin(request, device_id, user_id)
    async with request.app.state.database.session() as session:
        async with session.begin():
            assignment = await session.scalar(select(UserDevice).where(
                UserDevice.user_id == user_id, UserDevice.device_id == device_id,
                UserDevice.revoked_at.is_(None),
            ))
            if assignment is None:
                raise HTTPException(status_code=404, detail="Device assignment not found")
            assignment.revoked_at = _now()
            device = await session.get(Device, device_id)
            device.policy_revision += 1
            device.provider_revision += 1
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id, device_id=device_id,
                                   action="admin.device_user_revoked", result="success",
                                   metadata_json=None))
    await request.app.state.control_connections.close_data(device_id)
