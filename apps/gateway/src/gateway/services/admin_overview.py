from gateway.services.errors import GatewayError
from gateway.contracts import GatewayCall


from sqlalchemy import func, select

from gateway.services.identity import COOKIE_NAME, IdentityService

from gateway.services.management_scope import device_scope

from gateway.models import AdminAssignment, AuditEvent, Device, PlatformProject, ProjectAccessGrant, User


"""Scoped summary for the Gateway management landing page."""


async def admin_overview(call: GatewayCall):
    identity = IdentityService(call.database)
    actor, _ = await identity.session_user(call.tokens.get(COOKIE_NAME))
    if actor.must_change_password:
        raise GatewayError('forbidden', 'Password change required')

    async with call.database.session() as session:
        assignments = (await session.scalars(select(AdminAssignment).where(
            AdminAssignment.user_id == actor.id,
            AdminAssignment.revoked_at.is_(None),
        ))).all()
        if not assignments:
            raise GatewayError('forbidden', 'Administrator access required')
        roles = {assignment.role for assignment in assignments}
        super_admin = "super_admin" in roles

        users = None
        if roles.intersection(("super_admin", "identity_admin", "org_admin", "department_admin")):
            scoped_ids = await identity.manageable_user_ids(session, actor.id)
            conditions = [User.id.in_(scoped_ids)] if scoped_ids is not None else []
            users = {
                "total": await session.scalar(select(func.count()).select_from(User).where(*conditions)),
                "pending": await session.scalar(select(func.count()).select_from(User).where(
                    *conditions, User.status == "pending")),
            }

        devices = projects = recent_actions = None
        manages_devices = bool(roles.intersection(("super_admin", "device_admin", "org_admin", "department_admin")))
        if manages_devices:
            allowed_devices = await device_scope(session, identity, actor.id)
            device_conditions = [Device.id.in_(allowed_devices)] if allowed_devices is not None else []
            device_rows = (await session.execute(select(Device.id, Device.status).where(*device_conditions))).all()
            control = call.control_connections
            active_devices = [device_id for device_id, status in device_rows if status == "active"]
            online_ids = {device_id for device_id in active_devices if control.is_online(device_id)}
            devices = {
                "total": len(device_rows), "online": len(online_ids),
                "offline": len(active_devices) - len(online_ids),
                "pending": sum(status == "pending" for _, status in device_rows),
                "daemon_healthy": sum(control.daemon_health(device_id) is True for device_id in online_ids),
                "daemon_unhealthy": sum(control.daemon_health(device_id) is False for device_id in online_ids),
                "daemon_unknown": sum(control.daemon_health(device_id) is None for device_id in online_ids),
            }
            published = (await session.execute(select(
                PlatformProject.id, PlatformProject.device_id, PlatformProject.host_project_id,
            ).where(
                PlatformProject.status == "active",
                PlatformProject.access_mode == "remote_published",
                *([PlatformProject.device_id.in_(allowed_devices)] if allowed_devices is not None else []),
            ))).all()
            shared = await session.scalar(select(func.count(func.distinct(ProjectAccessGrant.project_id)))
                .join(PlatformProject, PlatformProject.id == ProjectAccessGrant.project_id).where(
                    ProjectAccessGrant.revoked_at.is_(None),
                    PlatformProject.status == "active",
                    PlatformProject.access_mode == "remote_published",
                    *([PlatformProject.device_id.in_(allowed_devices)] if allowed_devices is not None else []),
                )) or 0
            projects = {
                "published": len(published), "shared": shared,
                "host_offline": sum(not control.is_online(device_id) for _, device_id, _ in published),
            }
            running_counts = [control.running_tasks(device_id, host_project_id)
                              for _, device_id, host_project_id in published]
            unknown_projects = sum(count is None for count in running_counts)
            tasks = {"running": (sum(count for count in running_counts if count is not None)
                                  if unknown_projects == 0 else None),
                     "unknown_projects": unknown_projects}
        if super_admin:
            recent = (await session.scalars(select(AuditEvent).order_by(
                AuditEvent.created_at.desc(), AuditEvent.id.desc()).limit(5))).all()
            recent_actions = [{"action": event.action, "result": event.result,
                               "created_at": event.created_at.isoformat()} for event in recent]

    return {"roles": sorted(roles), "users": users, "devices": devices, "projects": projects,
            "tasks": tasks if manages_devices else {"running": None, "unknown_projects": None},
            "recent_actions": recent_actions}
