"""One explicit auditor scope for operation and usage ledgers."""
from fastapi import HTTPException, Request
from sqlalchemy import select, or_
from .identity_api import COOKIE_NAME, _identity
from .models import AdminAssignment, Device, DeviceGroupMembership, DirectoryPerson, DirectoryMembership


async def ledger_scope(request: Request, session, entity):
    identity = _identity(request)
    user, _ = await identity.session_user(request.cookies.get(COOKIE_NAME))
    if user.must_change_password:
        raise HTTPException(status_code=403, detail="Password change required")
    assignments = (await session.scalars(select(AdminAssignment).where(
        AdminAssignment.user_id == user.id,
        AdminAssignment.role.in_(("super_admin", "audit_admin")),
        AdminAssignment.revoked_at.is_(None),
    ))).all()
    if not assignments:
        raise HTTPException(status_code=403, detail="Audit administrator access required")
    if any(
        role.role == "super_admin" or role.scope_type == "platform"
        for role in assignments
    ):
        return None

    department_ids = await identity.manageable_department_ids(
        session, user.id, roles=("audit_admin",)) if any(
            role.scope_type in ("organization", "department") for role in assignments) else set()
    group_ids = {role.scope_id for role in assignments if role.scope_type == "device_group"}
    managed_devices = select(DeviceGroupMembership.device_id).where(DeviceGroupMembership.group_id.in_(group_ids))
    member_users = select(DirectoryPerson.user_id).join(
        DirectoryMembership,
        DirectoryMembership.person_id == DirectoryPerson.id,
    ).where(
        DirectoryPerson.active == 1,
        DirectoryMembership.department_id.in_(department_ids),
    )
    return or_(
        entity.device_id.in_(managed_devices),
        entity.device_id.in_(select(Device.id).where(Device.department_id.in_(department_ids))),
        entity.user_id.in_(member_users),
        entity.initiated_by_user_id.in_(member_users),
    )


