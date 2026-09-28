"""Published project access grants, independent of full-device access."""

from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from .identity import COOKIE_NAME
from .identity import IdentityService
from .identity_api import _identity, _super_admin_read, _super_admin_request
from .models import (AuditEvent, Device, GroupMembership, PlatformProject,
                     ProjectAccessGrant, User, UserGroup)

router = APIRouter(prefix="/api")


class ProjectGrantInput(BaseModel):
    subject_type: Literal["user", "group"]
    subject_id: str = Field(min_length=1, max_length=64)
    access_level: Literal["read", "edit"]


async def _admin(request: Request):
    identity, actor = await _super_admin_request(request)
    _, auth_session = await identity.session_user(request.cookies.get(COOKIE_NAME))
    await identity.require_step_up(auth_session)
    return actor


@router.post("/admin/projects/{project_id}/grants")
async def set_project_grant(request: Request, project_id: str,
                            body: ProjectGrantInput):
    actor = await _admin(request)
    async with request.app.state.database.session() as session:
        async with session.begin():
            project = await session.get(PlatformProject, project_id)
            if project is None:
                raise HTTPException(status_code=404, detail="Project unavailable")
            if project.access_mode != "remote_published" or project.status != "active":
                raise HTTPException(status_code=409, detail="Project is not published")
            subject = await session.get(User if body.subject_type == "user" else UserGroup,
                                        body.subject_id)
            if subject is None or subject.status != "active":
                raise HTTPException(status_code=404, detail="Grant subject unavailable")
            grant = await session.scalar(select(ProjectAccessGrant).where(
                ProjectAccessGrant.project_id == project_id,
                ProjectAccessGrant.subject_type == body.subject_type,
                ProjectAccessGrant.subject_id == body.subject_id,
            ))
            if grant is None:
                grant = ProjectAccessGrant(id=str(uuid4()), project_id=project_id,
                                           subject_type=body.subject_type,
                                           subject_id=body.subject_id,
                                           access_level=body.access_level,
                                           assigned_by_user_id=actor.id)
                session.add(grant)
            else:
                grant.access_level = body.access_level
                grant.assigned_by_user_id = actor.id
                grant.revoked_at = None
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   device_id=project.device_id,
                                   action="project.access_granted", result="success",
                                   metadata_json=f'{{"project_id":"{project_id}"}}'))
    return {"id": grant.id, "project_id": project_id,
            "subject_type": body.subject_type, "subject_id": body.subject_id,
            "access_level": body.access_level}


@router.delete("/admin/projects/{project_id}/grants/{subject_type}/{subject_id}",
               status_code=204)
async def revoke_project_grant(request: Request, project_id: str,
                               subject_type: Literal["user", "group"],
                               subject_id: str):
    actor = await _admin(request)
    async with request.app.state.database.session() as session:
        async with session.begin():
            grant = await session.scalar(select(ProjectAccessGrant).where(
                ProjectAccessGrant.project_id == project_id,
                ProjectAccessGrant.subject_type == subject_type,
                ProjectAccessGrant.subject_id == subject_id,
                ProjectAccessGrant.revoked_at.is_(None),
            ))
            if grant is None:
                raise HTTPException(status_code=404, detail="Project grant unavailable")
            grant.revoked_at = datetime.now(timezone.utc)
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   action="project.access_revoked", result="success",
                                   metadata_json=f'{{"project_id":"{project_id}"}}'))


async def effective_project_access(session, user_id: str, project_id: str) -> str | None:
    group_ids = (await session.scalars(select(GroupMembership.group_id).join(
        UserGroup, UserGroup.id == GroupMembership.group_id,
    ).where(GroupMembership.user_id == user_id,
            GroupMembership.revoked_at.is_(None),
            UserGroup.status == "active"))).all()
    grants = (await session.scalars(select(ProjectAccessGrant).where(
        ProjectAccessGrant.project_id == project_id,
        ProjectAccessGrant.revoked_at.is_(None),
    ))).all()
    levels = [grant.access_level for grant in grants
              if (grant.subject_type == "user" and grant.subject_id == user_id)
              or (grant.subject_type == "group" and grant.subject_id in group_ids)]
    return "edit" if "edit" in levels else "read" if "read" in levels else None


@router.get("/projects/{project_id}/access")
async def project_access(request: Request, project_id: str):
    user, _ = await IdentityService(request.app.state.database).session_user(
        request.cookies.get(COOKIE_NAME),
    )
    if user.must_change_password or user.status != "active":
        raise HTTPException(status_code=403, detail="Account unavailable")
    async with request.app.state.database.session() as session:
        project = await session.get(PlatformProject, project_id)
        if (project is None or project.status != "active"
                or project.access_mode != "remote_published"):
            raise HTTPException(status_code=404, detail="Project unavailable")
        device = await session.get(Device, project.device_id)
        level = await effective_project_access(session, user.id, project_id)
        device_id, host_project_id = project.device_id, project.host_project_id
    if level is None or device is None or device.status != "active":
        raise HTTPException(status_code=403, detail="Project access denied")
    if not request.app.state.control_connections.is_online(device_id):
        raise HTTPException(status_code=409, detail="Device is offline")
    origin = request.app.state.settings.public_origin
    if origin is None:
        raise HTTPException(status_code=503, detail="Public Gateway origin is not configured")
    host = f"d-{device_id}.{urlsplit(origin).hostname}"
    ticket = request.app.state.gateway_signer.sign_project_access_ticket(
        gateway_id=request.app.state.settings.gateway_id, device_id=device_id,
        user_id=user.id, audience=host, project_id=project_id,
        host_project_id=host_project_id, access_level=level,
    )
    return {"url": f"https://{host}/", "ticket": ticket, "expires_in": 60,
            "project_id": project_id, "access_level": level}


@router.get("/projects")
async def list_accessible_projects(request: Request):
    actor, _ = await _identity(request).session_user(
        request.cookies.get(COOKIE_NAME),
    )
    if actor.must_change_password:
        raise HTTPException(status_code=403, detail="Password change required")
    async with request.app.state.database.session() as session:
        rows = (await session.execute(select(PlatformProject, Device).join(
            Device, Device.id == PlatformProject.device_id,
        ).where(PlatformProject.access_mode == "remote_published",
                PlatformProject.status == "active", Device.status == "active")
            .order_by(PlatformProject.name, PlatformProject.id))).all()
        groups = dict((await session.execute(select(UserGroup.id, UserGroup.name).join(
            GroupMembership, GroupMembership.group_id == UserGroup.id,
        ).where(GroupMembership.user_id == actor.id,
                GroupMembership.revoked_at.is_(None),
                UserGroup.status == "active"))).all())
        project_ids = [project.id for project, _ in rows]
        grants = (await session.scalars(select(ProjectAccessGrant).where(
            ProjectAccessGrant.project_id.in_(project_ids),
            ProjectAccessGrant.revoked_at.is_(None),
        ))).all() if project_ids else []
        visible = []
        for project, device in rows:
            own_grants = [grant for grant in grants if grant.project_id == project.id
                          and ((grant.subject_type == "user" and grant.subject_id == actor.id)
                               or (grant.subject_type == "group" and grant.subject_id in groups))]
            if own_grants:
                level = "edit" if any(grant.access_level == "edit" for grant in own_grants) else "read"
                sources = sorted({"直接授权" if grant.subject_type == "user"
                                  else f"用户组：{groups[grant.subject_id]}" for grant in own_grants})
                visible.append({"id": project.id, "name": project.name,
                                "device_id": project.device_id,
                                "device_name": device.name,
                                "device_online": request.app.state.control_connections.is_online(device.id),
                                "access_level": level, "grant_sources": sources})
    return {"projects": visible}


@router.get("/admin/projects/{project_id}/grants")
async def list_project_grants(request: Request, project_id: str):
    await _super_admin_read(request)
    async with request.app.state.database.session() as session:
        rows = (await session.scalars(select(ProjectAccessGrant).where(
            ProjectAccessGrant.project_id == project_id,
            ProjectAccessGrant.revoked_at.is_(None),
        ).order_by(ProjectAccessGrant.subject_type,
                   ProjectAccessGrant.subject_id))).all()
    return {"grants": [{"id": row.id, "subject_type": row.subject_type,
                        "subject_id": row.subject_id,
                        "access_level": row.access_level} for row in rows]}
