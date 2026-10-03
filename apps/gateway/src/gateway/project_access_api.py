"""Published project access grants, independent of full-device access."""

from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Path, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from .identity import COOKIE_NAME
from .identity import IdentityService
from .identity_api import _identity
from .models import (AuditEvent, Device, GroupMembership, PlatformProject,
                     ProjectAccessGrant, User, UserGroup)
from .management_scope import project_manager, grant_subject_ids, require_grant_subject
from .project_publication import record_project_publication

router = APIRouter(prefix="/api")


class ProjectGrantInput(BaseModel):
    subject_type: Literal["user", "group"]
    subject_id: str = Field(min_length=1, max_length=64)
    access_level: Literal["read", "edit"]


@router.post("/admin/projects/{project_id}/grants")
async def set_project_grant(request: Request, project_id: str,
                            body: ProjectGrantInput):
    identity, actor, _ = await project_manager(request, project_id=project_id, mutation=True)
    await require_grant_subject(request, identity, actor.id, body.subject_type, body.subject_id)
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
    identity, actor, _ = await project_manager(request, project_id=project_id, mutation=True)
    await require_grant_subject(request, identity, actor.id, subject_type, subject_id)
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
    host = request.app.state.settings.device_authority(device_id)
    ticket = request.app.state.gateway_signer.sign_project_access_ticket(
        gateway_id=request.app.state.settings.gateway_id, device_id=device_id,
        user_id=user.id, audience=host, project_id=project_id,
        host_project_id=host_project_id, access_level=level,
    )
    return {"url": request.app.state.settings.device_url(device_id), "ticket": ticket, "expires_in": 60,
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


@router.get('/admin/projects')
async def list_admin_projects(request: Request, q: str = Query('', max_length=128),
                              sort: Literal['name', 'published_at'] = 'name',
                              direction: Literal['asc', 'desc'] = 'asc',
                              page: int = Query(1, ge=1),
                              page_size: int = Query(25, ge=1, le=100)):
    _, _, allowed = await project_manager(request)
    conditions = [PlatformProject.access_mode == 'remote_published',
                  PlatformProject.status == 'active']
    if allowed is not None:
        conditions.append(PlatformProject.device_id.in_(allowed))
    if q.strip():
        escaped = q.strip().replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
        pattern = f'%{escaped}%'
        conditions.append(or_(PlatformProject.name.ilike(pattern, escape='\\'),
                              Device.name.ilike(pattern, escape='\\')))
    column = PlatformProject.name if sort == 'name' else PlatformProject.published_at
    ordered = column.asc() if direction == 'asc' else column.desc()
    async with request.app.state.database.session() as session:
        base = select(PlatformProject).join(Device, Device.id == PlatformProject.device_id)
        total = await session.scalar(select(func.count()).select_from(PlatformProject).join(
            Device, Device.id == PlatformProject.device_id).where(*conditions))
        rows = (await session.execute(base.add_columns(Device).where(*conditions)
            .order_by(ordered, PlatformProject.id).offset((page - 1) * page_size)
            .limit(page_size))).all()
        project_ids = [project.id for project, _ in rows]
        grants = (await session.scalars(select(ProjectAccessGrant).where(
            ProjectAccessGrant.project_id.in_(project_ids),
            ProjectAccessGrant.revoked_at.is_(None)))).all() if project_ids else []
        publisher_ids = {project.published_by_user_id for project, _ in rows
                         if project.published_by_user_id}
        publisher_names = dict((await session.execute(select(User.id, User.username).where(
            User.id.in_(publisher_ids)))).all()) if publisher_ids else {}
        projects = []
        for project, device in rows:
            own_grants = [grant for grant in grants if grant.project_id == project.id]
            projects.append({
                'id': project.id, 'name': project.name,
                'device_id': device.id, 'device_name': device.name,
                'device_online': request.app.state.control_connections.is_online(device.id),
                'publisher': publisher_names.get(project.published_by_user_id),
                'published_at': project.published_at,
                'grant_users': sum(grant.subject_type == 'user' for grant in own_grants),
                'grant_groups': sum(grant.subject_type == 'group' for grant in own_grants),
                'grant_levels': {'read': sum(grant.access_level == 'read' for grant in own_grants),
                                 'edit': sum(grant.access_level == 'edit' for grant in own_grants)},
                'running_tasks': request.app.state.control_connections.running_tasks(
                    device.id, project.host_project_id,
                ),
            })
    return {'projects': projects, 'total': total, 'page': page, 'page_size': page_size}


@router.get('/admin/project-grant-subjects')
async def list_project_grant_subjects(request: Request,
                                      subject_type: Literal['user', 'group'],
                                      q: str = Query('', max_length=128),
                                      page: int = Query(1, ge=1),
                                      page_size: int = Query(25, ge=1, le=100)):
    identity, actor, _ = await project_manager(request)
    model = User if subject_type == 'user' else UserGroup
    name = User.username if subject_type == 'user' else UserGroup.name
    conditions = [model.status == 'active']
    if q.strip():
        escaped = q.strip().replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
        conditions.append(name.ilike(f'%{escaped}%', escape='\\'))
    async with request.app.state.database.session() as session:
        allowed = await grant_subject_ids(session, identity, actor.id, subject_type)
        if allowed is not None:
            conditions.append(model.id.in_(allowed))
        total = await session.scalar(select(func.count()).select_from(model).where(*conditions))
        rows = (await session.scalars(select(model).where(*conditions).order_by(name, model.id)
            .offset((page - 1) * page_size).limit(page_size))).all()
    return {'subjects': [{'id': row.id, 'name': getattr(row, 'username', None) or row.name}
                         for row in rows], 'total': total, 'page': page, 'page_size': page_size}


@router.get('/admin/devices/{device_id}/publishable-projects')
async def list_publishable_projects(request: Request, device_id: str,
                                    q: str = Query('', max_length=128),
                                    page: int = Query(1, ge=1),
                                    page_size: int = Query(25, ge=1, le=100)):
    await project_manager(request, device_id=device_id)
    async with request.app.state.database.session() as session:
        device = await session.get(Device, device_id)
    if device is None or device.status != 'active':
        raise HTTPException(status_code=404, detail='Device unavailable')
    try:
        catalog = await request.app.state.control_connections.request_project_catalog(device_id)
    except (ConnectionError, TimeoutError) as exc:
        raise HTTPException(status_code=503, detail='Device project catalog unavailable') from exc
    filtered = [item for item in catalog if q.casefold() in item['name'].casefold()]
    total = len(filtered)
    selected = filtered[(page - 1) * page_size:page * page_size]
    async with request.app.state.database.session() as session:
        rows = (await session.scalars(select(PlatformProject).where(
            PlatformProject.device_id == device_id,
            PlatformProject.host_project_id.in_([item['id'] for item in selected]),
        ))).all() if selected else []
    published = {row.host_project_id for row in rows if row.status == 'active'
                 and row.access_mode == 'remote_published'}
    return {'projects': [{'host_project_id': item['id'], 'name': item['name'],
                          'published': item['id'] in published} for item in selected],
            'total': total, 'page': page, 'page_size': page_size}


@router.post('/admin/devices/{device_id}/projects/{host_project_id}/publish')
async def admin_publish_project(request: Request, device_id: str,
                                host_project_id: str = Path(min_length=1, max_length=128)):
    _, actor, _ = await project_manager(request, device_id=device_id, mutation=True)
    async with request.app.state.database.session() as session:
        device = await session.get(Device, device_id)
    if device is None or device.status != 'active':
        raise HTTPException(status_code=404, detail='Device unavailable')
    try:
        catalog = await request.app.state.control_connections.request_project_catalog(device_id)
    except (ConnectionError, TimeoutError) as exc:
        raise HTTPException(status_code=503, detail='Device project catalog unavailable') from exc
    project = next((item for item in catalog if item['id'] == host_project_id), None)
    if project is None:
        raise HTTPException(status_code=404, detail='Host project unavailable')
    async with request.app.state.database.session() as session:
        current_device = await session.get(Device, device_id)
    if (current_device is None or current_device.status != 'active'
            or not request.app.state.control_connections.is_online(device_id)):
        raise HTTPException(status_code=409, detail='Device is no longer available')
    return await record_project_publication(
        request.app.state.database, device_id=device_id, user_id=actor.id,
        host_project_id=project['id'], name=project['name'], action='publish',
    )


@router.post('/admin/projects/{project_id}/unpublish')
async def admin_unpublish_project(request: Request, project_id: str):
    _, actor, _ = await project_manager(request, project_id=project_id, mutation=True)
    async with request.app.state.database.session() as session:
        project = await session.get(PlatformProject, project_id)
        if (project is None or project.status != 'active'
                or project.access_mode != 'remote_published'):
            raise HTTPException(status_code=404, detail='Published project unavailable')
        device_id, host_project_id, name = project.device_id, project.host_project_id, project.name
    return await record_project_publication(
        request.app.state.database, device_id=device_id, user_id=actor.id,
        host_project_id=host_project_id, name=name, action='unpublish',
    )


@router.get("/admin/projects/{project_id}/grants")
async def list_project_grants(request: Request, project_id: str):
    await project_manager(request, project_id=project_id)
    async with request.app.state.database.session() as session:
        project = await session.get(PlatformProject, project_id)
        if (project is None or project.access_mode != 'remote_published'
                or project.status != 'active'):
            raise HTTPException(status_code=404, detail='Published project unavailable')
        return {"grants": await project_grant_rows(session, project_id)}


async def project_grant_rows(session, project_id: str) -> list[dict]:
    rows = (await session.scalars(select(ProjectAccessGrant).where(
        ProjectAccessGrant.project_id == project_id,
        ProjectAccessGrant.revoked_at.is_(None),
    ).order_by(ProjectAccessGrant.subject_type,
               ProjectAccessGrant.subject_id))).all()
    user_ids = [row.subject_id for row in rows if row.subject_type == 'user']
    group_ids = [row.subject_id for row in rows if row.subject_type == 'group']
    user_names = dict((await session.execute(select(User.id, User.username).where(
        User.id.in_(user_ids)))).all()) if user_ids else {}
    group_names = dict((await session.execute(select(UserGroup.id, UserGroup.name).where(
        UserGroup.id.in_(group_ids)))).all()) if group_ids else {}
    return [{"id": row.id, "subject_type": row.subject_type,
             "subject_id": row.subject_id,
             "subject_name": (user_names if row.subject_type == 'user'
                              else group_names).get(row.subject_id, row.subject_id),
             "access_level": row.access_level} for row in rows]
