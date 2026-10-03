"""Management permissions never grant ordinary device/project content access."""
from fastapi import HTTPException, Request
from sqlalchemy import select
from gateway.services.identity import COOKIE_NAME, IdentityService
from gateway.services.identity_api import _check_csrf
from gateway.models import AdminAssignment, Device, DeviceGroupMembership

DEVICE_ROLES = ("super_admin", "device_admin", "org_admin", "department_admin")


async def device_scope(session, identity: IdentityService, actor_id: str, *, roles=DEVICE_ROLES) -> set[str] | None:
    assignments = (await session.scalars(select(AdminAssignment).where(
        AdminAssignment.user_id == actor_id, AdminAssignment.revoked_at.is_(None),
        AdminAssignment.role.in_(roles)))).all()
    if not assignments:
        raise HTTPException(status_code=403, detail="Device management denied")
    if any(row.role == "super_admin" or (row.role in ("device_admin", "org_admin")
           and row.scope_type == "platform") for row in assignments):
        return None
    groups = {row.scope_id for row in assignments if row.role == "device_admin"
              and row.scope_type == "device_group"}
    allowed = set((await session.scalars(select(DeviceGroupMembership.device_id).where(
        DeviceGroupMembership.group_id.in_(groups)))).all()) if groups else set()
    if any(row.role in ("org_admin", "department_admin") for row in assignments):
        departments = await identity.manageable_department_ids(
            session, actor_id, roles=("org_admin", "department_admin"))
        allowed.update((await session.scalars(select(Device.id).where(
            Device.department_id.in_(departments or set())))).all())
    return allowed


async def device_manager(request: Request, *, device_ids: list[str] | None = None,
                         mutation: bool = False):
    identity = IdentityService(request.app.state.database)
    token = request.cookies.get(COOKIE_NAME)
    actor, auth_session = await identity.session_user(token)
    if actor.must_change_password:
        raise HTTPException(status_code=403, detail="Password change required")
    if mutation:
        _check_csrf(request, token)
        await identity.require_step_up(auth_session)
    async with request.app.state.database.session() as session:
        allowed = await device_scope(session, identity, actor.id)
    if device_ids is not None and allowed is not None and not set(device_ids).issubset(allowed):
        raise HTTPException(status_code=403, detail="Device management scope denied")
    return identity, actor, allowed


async def organization_manager(request: Request, *, source_id: str | None = None, mutation=False):
    identity = IdentityService(request.app.state.database)
    token = request.cookies.get(COOKIE_NAME)
    actor, _ = await identity.session_user(token)
    if actor.must_change_password:
        raise HTTPException(status_code=403, detail="Password change required")
    if mutation:
        _check_csrf(request, token)
    async with request.app.state.database.session() as session:
        assignments = (await session.scalars(select(AdminAssignment).where(
            AdminAssignment.user_id == actor.id, AdminAssignment.revoked_at.is_(None),
            AdminAssignment.role.in_(("super_admin", "org_admin"))))).all()
    if not assignments:
        raise HTTPException(status_code=403, detail="Organization management denied")
    allowed = None if any(row.role == "super_admin" or row.scope_type == "platform"
                          for row in assignments) else {row.scope_id for row in assignments
                          if row.scope_type == "organization"}
    if source_id and allowed is not None and source_id not in allowed:
        raise HTTPException(status_code=403, detail="Organization management scope denied")
    return actor, allowed


async def project_manager(request: Request, *, project_id=None, device_id=None, mutation=False):
    from gateway.models import PlatformProject
    identity, actor, allowed = await device_manager(request, mutation=mutation)
    async with request.app.state.database.session() as session:
        allowed = await device_scope(session, identity, actor.id,
                                     roles=("super_admin", "org_admin", "department_admin"))
        if project_id:
            project = await session.get(PlatformProject, project_id)
            if not project:
                raise HTTPException(status_code=404, detail="Project unavailable")
            device_id = project.device_id
    if device_id and allowed is not None and device_id not in allowed:
        raise HTTPException(status_code=403, detail="Project management scope denied")
    return identity, actor, allowed


async def grant_subject_ids(session, identity, actor_id, subject_type):
    from gateway.models import UserGroup
    roles = ("super_admin", "org_admin", "department_admin")
    users = await identity.manageable_user_ids(session, actor_id, roles=roles)
    if users is None or subject_type == "user":
        return users
    departments = await identity.manageable_department_ids(session, actor_id, roles=roles)
    return set((await session.scalars(select(UserGroup.id).where(
        UserGroup.external_department_id.in_(departments or set()), UserGroup.status == "active"))).all())


async def require_grant_subject(request, identity, actor_id, subject_type, subject_id):
    async with request.app.state.database.session() as session:
        allowed = await grant_subject_ids(session, identity, actor_id, subject_type)
    if allowed is not None and subject_id not in allowed:
        raise HTTPException(status_code=403, detail="Grant subject management scope denied")
