"""Scoped summary for the Gateway management landing page."""

from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import func, select

from .identity import COOKIE_NAME, IdentityService
from .models import AdminAssignment, AuditEvent, Device, PlatformProject, ProjectAccessGrant, User

router = APIRouter(prefix="/api/admin")


@router.get("/overview")
async def admin_overview(request: Request):
    identity = IdentityService(request.app.state.database)
    actor, _ = await identity.session_user(request.cookies.get(COOKIE_NAME))
    if actor.must_change_password:
        raise HTTPException(status_code=403, detail="Password change required")

    async with request.app.state.database.session() as session:
        assignments = (await session.scalars(select(AdminAssignment).where(
            AdminAssignment.user_id == actor.id,
            AdminAssignment.revoked_at.is_(None),
        ))).all()
        if not assignments:
            raise HTTPException(status_code=403, detail="Administrator access required")
        roles = {assignment.role for assignment in assignments}
        super_admin = "super_admin" in roles

        users = None
        if super_admin or "identity_admin" in roles:
            scoped_ids = await identity.manageable_user_ids(session, actor.id)
            conditions = [User.id.in_(scoped_ids)] if scoped_ids is not None else []
            users = {
                "total": await session.scalar(select(func.count()).select_from(User).where(*conditions)),
                "pending": await session.scalar(select(func.count()).select_from(User).where(
                    *conditions, User.status == "pending")),
            }

        devices = projects = recent_actions = None
        if super_admin:
            device_rows = (await session.execute(select(Device.id, Device.status))).all()
            control = request.app.state.control_connections
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
            published = (await session.execute(select(PlatformProject.id, PlatformProject.device_id).where(
                PlatformProject.status == "active",
                PlatformProject.access_mode == "remote_published",
            ))).all()
            shared = await session.scalar(select(func.count(func.distinct(ProjectAccessGrant.project_id)))
                .join(PlatformProject, PlatformProject.id == ProjectAccessGrant.project_id).where(
                    ProjectAccessGrant.revoked_at.is_(None),
                    PlatformProject.status == "active",
                    PlatformProject.access_mode == "remote_published",
                )) or 0
            projects = {
                "published": len(published), "shared": shared,
                "host_offline": sum(not control.is_online(device_id) for _, device_id in published),
            }
            recent = (await session.scalars(select(AuditEvent).order_by(
                AuditEvent.created_at.desc(), AuditEvent.id.desc()).limit(5))).all()
            recent_actions = [{"action": event.action, "result": event.result,
                               "created_at": event.created_at.isoformat()} for event in recent]

    return {"roles": sorted(roles), "users": users, "devices": devices, "projects": projects,
            "tasks": {"running": None}, "recent_actions": recent_actions}
