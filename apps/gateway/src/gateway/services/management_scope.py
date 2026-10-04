"""Management permissions never grant ordinary device/project content access."""
from gateway.services.errors import GatewayError
from gateway.contracts import GatewayCall

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
        raise GatewayError('forbidden', 'Device management denied')
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


async def device_manager(call: GatewayCall, *, device_ids: list[str] | None = None,
                         mutation: bool = False):
    identity = IdentityService(call.database)
    token = call.tokens.get(COOKIE_NAME)
    actor, auth_session = await identity.session_user(token)
    if actor.must_change_password:
        raise GatewayError('forbidden', 'Password change required')
    if mutation:
        _check_csrf(call, token)
        await identity.require_step_up(auth_session)
    async with call.database.session() as session:
        allowed = await device_scope(session, identity, actor.id)
    if device_ids is not None and allowed is not None and not set(device_ids).issubset(allowed):
        raise GatewayError('forbidden', 'Device management scope denied')
    return identity, actor, allowed


async def organization_manager(call: GatewayCall, *, source_id: str | None = None, mutation=False):
    identity = IdentityService(call.database)
    token = call.tokens.get(COOKIE_NAME)
    actor, _ = await identity.session_user(token)
    if actor.must_change_password:
        raise GatewayError('forbidden', 'Password change required')
    if mutation:
        _check_csrf(call, token)
    async with call.database.session() as session:
        assignments = (await session.scalars(select(AdminAssignment).where(
            AdminAssignment.user_id == actor.id, AdminAssignment.revoked_at.is_(None),
            AdminAssignment.role.in_(("super_admin", "org_admin"))))).all()
    if not assignments:
        raise GatewayError('forbidden', 'Organization management denied')
    allowed = None if any(row.role == "super_admin" or row.scope_type == "platform"
                          for row in assignments) else {row.scope_id for row in assignments
                          if row.scope_type == "organization"}
    if source_id and allowed is not None and source_id not in allowed:
        raise GatewayError('forbidden', 'Organization management scope denied')
    return actor, allowed


async def project_manager(call: GatewayCall, *, project_id=None, device_id=None, mutation=False):
    from gateway.models import PlatformProject
    identity, actor, allowed = await device_manager(call, mutation=mutation)
    async with call.database.session() as session:
        allowed = await device_scope(session, identity, actor.id,
                                     roles=("super_admin", "org_admin", "department_admin"))
        if project_id:
            project = await session.get(PlatformProject, project_id)
            if not project:
                raise GatewayError('not_found', 'Project unavailable')
            device_id = project.device_id
    if device_id and allowed is not None and device_id not in allowed:
        raise GatewayError('forbidden', 'Project management scope denied')
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


async def require_grant_subject(call, identity, actor_id, subject_type, subject_id):
    async with call.database.session() as session:
        allowed = await grant_subject_ids(session, identity, actor_id, subject_type)
    if allowed is not None and subject_id not in allowed:
        raise GatewayError('forbidden', 'Grant subject management scope denied')
