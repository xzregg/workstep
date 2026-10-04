import asyncio

import re

from datetime import datetime, timezone

from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request

from fastapi.responses import FileResponse

from pydantic import BaseModel, Field

from sqlalchemy import select

from sqlalchemy.exc import IntegrityError

from gateway.services.groups_api import _actor, _can_manage_group

from gateway.services.identity import COOKIE_NAME

from gateway.services.identity_api import _check_csrf, _identity

from gateway.models import AuditEvent, GroupProject, GroupSkillCatalog, PlatformProject, ProjectSkillAssignment, SkillPackage, SkillVersion, UserGroup, Device, DeviceProjectSkillState, User, UserDevice

from gateway.services.skill_packages import save_archive, validate_archive


"""Reviewed immutable Skill catalog."""


class SkillInput(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    slug: str = Field(min_length=1, max_length=128)
    description: str = Field(default="", max_length=2000)


class SkillVersionInput(BaseModel):
    version: str = Field(min_length=1, max_length=64)
    archive_base64: str = Field(min_length=1, max_length=11 * 1024 * 1024)


class SkillGrantInput(BaseModel):
    skill_version_id: str = Field(min_length=1, max_length=64)


class SkillRevokeInput(BaseModel):
    reason: str = Field(min_length=1, max_length=512)


async def _admin(request: Request):
    identity = _identity(request)
    token = request.cookies.get(COOKIE_NAME)
    actor, auth_session = await identity.session_user(token)
    _check_csrf(request, token)
    if actor.must_change_password:
        raise HTTPException(status_code=403, detail="Password change required")
    await identity.require_skill_admin(actor.id)
    await identity.require_step_up(auth_session)
    return actor


async def _admin_read(request: Request):
    identity = _identity(request)
    actor, _ = await identity.session_user(request.cookies.get(COOKIE_NAME))
    if actor.must_change_password:
        raise HTTPException(status_code=403, detail="Password change required")
    await identity.require_skill_admin(actor.id)
    return actor


def _public_version(row: SkillVersion) -> dict:
    return {"id": row.id, "skill_id": row.skill_id, "version": row.version,
            "digest": row.digest, "file_count": row.file_count,
            "total_size": row.total_size, "status": row.status}


async def compile_skill_manifest(database, signer, gateway_id: str,
                                 device_id: str, user_id: str) -> str:
    async with database.session() as session:
        projects = (await session.scalars(select(PlatformProject).where(
            PlatformProject.device_id == device_id,
            PlatformProject.status == "active",
            PlatformProject.skill_revision > 0,
        ).order_by(PlatformProject.id).limit(1001))).all()
        if len(projects) > 1000:
            raise ValueError("Too many managed Skill projects")
        entries = []
        for project in projects:
            rows = (await session.execute(select(
                ProjectSkillAssignment, SkillVersion, SkillPackage,
            ).join(SkillVersion, SkillVersion.id == ProjectSkillAssignment.skill_version_id)
                .join(SkillPackage, SkillPackage.id == ProjectSkillAssignment.skill_id)
                .join(GroupProject, (GroupProject.group_id == ProjectSkillAssignment.source_group_id)
                      & (GroupProject.platform_project_id == project.id))
                .join(GroupSkillCatalog,
                      (GroupSkillCatalog.group_id == ProjectSkillAssignment.source_group_id)
                      & (GroupSkillCatalog.skill_id == ProjectSkillAssignment.skill_id)
                      & (GroupSkillCatalog.skill_version_id == SkillVersion.id))
                .where(ProjectSkillAssignment.platform_project_id == project.id,
                       ProjectSkillAssignment.revoked_at.is_(None),
                       GroupProject.revoked_at.is_(None),
                       GroupSkillCatalog.revoked_at.is_(None),
                       SkillVersion.status == "approved",
                       SkillPackage.status == "active")
                .order_by(SkillPackage.slug, ProjectSkillAssignment.source_group_id))).all()
            unique_rows = {}
            for assignment, version, package in rows:
                unique_rows.setdefault(package.id, (assignment, version, package))
            entries.append({
                "platform_project_id": project.id,
                "host_project_id": project.host_project_id,
                "revision": project.skill_revision,
                "skills": [{"skill_id": package.id, "slug": package.slug,
                            "skill_version_id": version.id,
                            "version": version.version, "digest": version.digest,
                            "file_count": version.file_count,
                            "total_size": version.total_size,
                            "source_group_id": assignment.source_group_id}
                           for assignment, version, package in unique_rows.values()],
            })
    return signer.sign_skill_manifest(gateway_id=gateway_id,
                                      device_id=device_id, user_id=user_id,
                                      projects=entries)



async def list_skill_applications(request: Request):
    await _admin_read(request)
    async with request.app.state.database.session() as session:
        rows = (await session.execute(select(
            PlatformProject, Device, DeviceProjectSkillState,
        ).join(Device, Device.id == PlatformProject.device_id)
            .outerjoin(DeviceProjectSkillState,
                       (DeviceProjectSkillState.device_id == PlatformProject.device_id)
                       & (DeviceProjectSkillState.host_project_id == PlatformProject.host_project_id))
            .where(PlatformProject.skill_revision > 0)
            .order_by(Device.name, PlatformProject.name))).all()
    return {"projects": [{
        "project_id": project.id, "project_name": project.name,
        "device_id": device.id, "device_name": device.name,
        "desired_revision": project.skill_revision,
        "applied_revision": state.applied_revision if state else None,
        "status": state.status if state else "pending",
        "last_error_code": state.last_error_code if state else None,
    } for project, device, state in rows]}



async def create_skill(request: Request, body: SkillInput):
    actor = await _admin(request)
    if body.name != body.name.strip() or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", body.slug):
        raise HTTPException(status_code=422, detail="Invalid Skill name or slug")
    row = SkillPackage(id=str(uuid4()), name=body.name, slug=body.slug,
                       description=body.description, owner_user_id=actor.id)
    try:
        async with request.app.state.database.session() as session:
            async with session.begin():
                session.add(row)
                session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                       action="skill.created", result="success",
                                       metadata_json=f'{{"skill_id":"{row.id}"}}'))
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="Skill slug already exists") from exc
    return {"id": row.id, "name": row.name, "slug": row.slug,
            "description": row.description, "status": row.status}



async def list_skills(request: Request):
    await _admin_read(request)
    async with request.app.state.database.session() as session:
        rows = (await session.scalars(select(SkillPackage).order_by(
            SkillPackage.name, SkillPackage.id,
        ))).all()
    return {"skills": [{"id": row.id, "name": row.name, "slug": row.slug,
                        "description": row.description, "status": row.status}
                       for row in rows]}



async def upload_skill_version(request: Request, skill_id: str, body: SkillVersionInput):
    actor = await _admin(request)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", body.version):
        raise HTTPException(status_code=422, detail="Invalid Skill version")
    try:
        raw, digest, count, total = await asyncio.to_thread(
            validate_archive, body.archive_base64,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    version_id = str(uuid4())
    storage_name = f"{version_id}.zip"
    directory = request.app.state.settings.data_dir / "skill-packages"
    path = directory / storage_name
    try:
        async with request.app.state.database.session() as session:
            async with session.begin():
                skill = await session.get(SkillPackage, skill_id)
                if skill is None or skill.status != "active":
                    raise HTTPException(status_code=404, detail="Skill unavailable")
                existing = await session.scalar(select(SkillVersion.id).where(
                    SkillVersion.skill_id == skill_id,
                    SkillVersion.version == body.version,
                ))
                if existing:
                    raise HTTPException(status_code=409, detail="Skill version exists")
                await asyncio.to_thread(save_archive, directory, storage_name, raw)
                row = SkillVersion(id=version_id, skill_id=skill_id,
                                   version=body.version, digest=digest,
                                   storage_name=storage_name, file_count=count,
                                   total_size=total, status="pending_review",
                                   uploaded_by_user_id=actor.id)
                session.add(row)
                session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                       action="skill.version_uploaded", result="success",
                                       metadata_json=f'{{"version_id":"{version_id}"}}'))
    except Exception:
        await asyncio.to_thread(path.unlink, missing_ok=True)
        raise
    return _public_version(row)



async def list_skill_versions(request: Request, skill_id: str):
    await _admin_read(request)
    async with request.app.state.database.session() as session:
        rows = (await session.scalars(select(SkillVersion).where(
            SkillVersion.skill_id == skill_id,
        ).order_by(SkillVersion.created_at.desc()))).all()
    return {"versions": [_public_version(row) for row in rows]}



async def approve_skill_version(request: Request, skill_id: str, version_id: str):
    actor = await _admin(request)
    async with request.app.state.database.session() as session:
        async with session.begin():
            row = await session.get(SkillVersion, version_id)
            if row is None or row.skill_id != skill_id:
                raise HTTPException(status_code=404, detail="Skill version unavailable")
            if row.status != "pending_review":
                raise HTTPException(status_code=409, detail="Skill version already reviewed")
            row.status = "approved"
            row.reviewed_by_user_id = actor.id
            row.published_at = datetime.now(timezone.utc)
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   action="skill.version_approved", result="success",
                                   metadata_json=f'{{"version_id":"{version_id}"}}'))
    return _public_version(row)



async def revoke_skill_version(request: Request, skill_id: str,
                               version_id: str, body: SkillRevokeInput):
    actor = await _admin(request)
    async with request.app.state.database.session() as session:
        async with session.begin():
            row = await session.get(SkillVersion, version_id)
            if row is None or row.skill_id != skill_id:
                raise HTTPException(status_code=404, detail="Skill version unavailable")
            if row.status != "approved":
                raise HTTPException(status_code=409, detail="Skill version is not active")
            row.status = "revoked"
            row.revoked_at = datetime.now(timezone.utc)
            row.revoke_reason = body.reason
            catalogs = (await session.scalars(select(GroupSkillCatalog).where(
                GroupSkillCatalog.skill_version_id == version_id,
                GroupSkillCatalog.revoked_at.is_(None),
            ))).all()
            for catalog in catalogs:
                catalog.revoked_at = row.revoked_at
            assignments = (await session.scalars(select(ProjectSkillAssignment).where(
                ProjectSkillAssignment.skill_version_id == version_id,
                ProjectSkillAssignment.revoked_at.is_(None),
            ))).all()
            project_revisions = {}
            for assignment in assignments:
                if assignment.platform_project_id not in project_revisions:
                    project = await session.get(PlatformProject, assignment.platform_project_id)
                    project.skill_revision += 1
                    project_revisions[project.id] = project.skill_revision
                assignment.desired_revision = project_revisions[assignment.platform_project_id]
                assignment.status = "revoked"
                assignment.revoked_at = row.revoked_at
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   action="skill.version_revoked", result="success",
                                   metadata_json=f'{{"version_id":"{version_id}"}}'))
    return _public_version(row)



async def grant_group_skill(request: Request, group_id: str, body: SkillGrantInput):
    actor = await _admin(request)
    async with request.app.state.database.session() as session:
        async with session.begin():
            group = await session.get(UserGroup, group_id)
            version = await session.get(SkillVersion, body.skill_version_id)
            if group is None or group.status != "active" or version is None:
                raise HTTPException(status_code=404, detail="Group or Skill version unavailable")
            if version.status != "approved":
                raise HTTPException(status_code=409, detail="Skill version is not approved")
            grant = await session.scalar(select(GroupSkillCatalog).where(
                GroupSkillCatalog.group_id == group_id,
                GroupSkillCatalog.skill_id == version.skill_id,
            ))
            if grant is None:
                grant = GroupSkillCatalog(id=str(uuid4()), group_id=group_id,
                                          skill_id=version.skill_id,
                                          skill_version_id=version.id,
                                          granted_by_user_id=actor.id)
                session.add(grant)
            else:
                if grant.revoked_at is None and grant.skill_version_id != version.id:
                    active_assignment = await session.scalar(select(ProjectSkillAssignment.id).where(
                        ProjectSkillAssignment.source_group_id == group_id,
                        ProjectSkillAssignment.skill_id == version.skill_id,
                        ProjectSkillAssignment.revoked_at.is_(None),
                    ).limit(1))
                    if active_assignment is not None:
                        raise HTTPException(status_code=409,
                                            detail="Revoke active project Skills before changing group version")
                grant.skill_version_id = version.id
                grant.revoked_at = None
                grant.granted_by_user_id = actor.id
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   action="skill.group_granted", result="success",
                                   metadata_json=f'{{"group_id":"{group_id}","version_id":"{version.id}"}}'))
    return {"group_id": group_id, "skill_id": version.skill_id,
            "skill_version_id": version.id}



async def list_skill_admin_groups(request: Request):
    await _admin_read(request)
    async with request.app.state.database.session() as session:
        rows = (await session.scalars(select(UserGroup).where(
            UserGroup.status == "active",
        ).order_by(UserGroup.name, UserGroup.id))).all()
    return {"groups": [{"id": row.id, "name": row.name, "slug": row.slug,
                        "source_type": row.source_type} for row in rows]}



async def list_skill_admin_group_grants(request: Request, group_id: str):
    await _admin_read(request)
    async with request.app.state.database.session() as session:
        group = await session.get(UserGroup, group_id)
        if group is None or group.status != "active":
            raise HTTPException(status_code=404, detail="Group unavailable")
        rows = (await session.execute(select(
            GroupSkillCatalog, SkillVersion, SkillPackage,
        ).join(SkillVersion, SkillVersion.id == GroupSkillCatalog.skill_version_id)
            .join(SkillPackage, SkillPackage.id == GroupSkillCatalog.skill_id)
            .where(GroupSkillCatalog.group_id == group_id,
                   GroupSkillCatalog.revoked_at.is_(None))
            .order_by(SkillPackage.name))).all()
    return {"skills": [{"skill_id": package.id, "name": package.name,
                        "slug": package.slug, "skill_version_id": version.id,
                        "version": version.version, "status": version.status}
                       for _, version, package in rows]}



async def revoke_group_skill(request: Request, group_id: str, skill_id: str):
    actor = await _admin(request)
    async with request.app.state.database.session() as session:
        async with session.begin():
            grant = await session.scalar(select(GroupSkillCatalog).where(
                GroupSkillCatalog.group_id == group_id,
                GroupSkillCatalog.skill_id == skill_id,
                GroupSkillCatalog.revoked_at.is_(None),
            ))
            if grant is None:
                raise HTTPException(status_code=404, detail="Group Skill grant unavailable")
            now = datetime.now(timezone.utc)
            grant.revoked_at = now
            assignments = (await session.scalars(select(ProjectSkillAssignment).where(
                ProjectSkillAssignment.source_group_id == group_id,
                ProjectSkillAssignment.skill_id == skill_id,
                ProjectSkillAssignment.revoked_at.is_(None),
            ))).all()
            for assignment in assignments:
                project = await session.get(PlatformProject, assignment.platform_project_id)
                project.skill_revision += 1
                assignment.desired_revision = project.skill_revision
                assignment.status = "revoked"
                assignment.revoked_at = now
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   action="skill.group_revoked", result="success",
                                   metadata_json=f'{{"group_id":"{group_id}","skill_id":"{skill_id}"}}'))



async def list_group_skills(request: Request, group_id: str):
    service, actor = await _actor(request, write=False)
    async with request.app.state.database.session() as session:
        if not await _can_manage_group(session, service, actor, group_id):
            raise HTTPException(status_code=403, detail="Group management denied")
        rows = (await session.execute(select(
            GroupSkillCatalog, SkillVersion, SkillPackage,
        ).join(SkillVersion, SkillVersion.id == GroupSkillCatalog.skill_version_id)
            .join(SkillPackage, SkillPackage.id == GroupSkillCatalog.skill_id)
            .where(GroupSkillCatalog.group_id == group_id,
                   GroupSkillCatalog.revoked_at.is_(None),
                   SkillVersion.status == "approved",
                   SkillPackage.status == "active")
            .order_by(SkillPackage.name))).all()
    return {"skills": [{"skill_id": package.id, "name": package.name,
                        "slug": package.slug, "skill_version_id": version.id,
                        "version": version.version, "digest": version.digest}
                       for _, version, package in rows]}



async def assign_project_skill(request: Request, group_id: str,
                               project_id: str, body: SkillGrantInput):
    service, actor = await _actor(request, write=True)
    async with request.app.state.database.session() as session:
        async with session.begin():
            if not await _can_manage_group(session, service, actor, group_id):
                raise HTTPException(status_code=403, detail="Group management denied")
            linked = await session.scalar(select(GroupProject.id).where(
                GroupProject.group_id == group_id,
                GroupProject.platform_project_id == project_id,
                GroupProject.revoked_at.is_(None),
            ))
            if linked is None:
                raise HTTPException(status_code=403, detail="Project is not linked to group")
            version = await session.get(SkillVersion, body.skill_version_id)
            if version is None or version.status != "approved":
                raise HTTPException(status_code=409, detail="Skill version is not approved")
            catalog = await session.scalar(select(GroupSkillCatalog.id).where(
                GroupSkillCatalog.group_id == group_id,
                GroupSkillCatalog.skill_id == version.skill_id,
                GroupSkillCatalog.skill_version_id == version.id,
                GroupSkillCatalog.revoked_at.is_(None),
            ))
            if catalog is None:
                raise HTTPException(status_code=403, detail="Skill is not granted to group")
            project = await session.get(PlatformProject, project_id)
            if project is None:
                raise HTTPException(status_code=404, detail="Project unavailable")
            existing = (await session.scalars(select(ProjectSkillAssignment).where(
                ProjectSkillAssignment.platform_project_id == project_id,
                ProjectSkillAssignment.skill_id == version.skill_id,
            ))).all()
            assignment = next((item for item in existing
                               if item.source_group_id == group_id), None)
            if any(item.revoked_at is None and item.skill_version_id != version.id
                   for item in existing):
                raise HTTPException(status_code=409, detail="Skill version conflict across groups")
            if (assignment is not None and assignment.revoked_at is None
                    and assignment.skill_version_id == version.id):
                return {"project_id": project_id, "skill_id": version.skill_id,
                        "skill_version_id": version.id,
                        "desired_revision": assignment.desired_revision}
            project.skill_revision += 1
            if assignment is None:
                assignment = ProjectSkillAssignment(
                    id=str(uuid4()), platform_project_id=project_id,
                    skill_id=version.skill_id, skill_version_id=version.id,
                    source_group_id=group_id, assigned_by_user_id=actor.id,
                    desired_revision=project.skill_revision,
                )
                session.add(assignment)
            else:
                assignment.skill_version_id = version.id
                assignment.source_group_id = group_id
                assignment.assigned_by_user_id = actor.id
                assignment.desired_revision = project.skill_revision
                assignment.status = "active"
                assignment.revoked_at = None
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   action="skill.project_assigned", result="success",
                                   metadata_json=f'{{"project_id":"{project_id}","version_id":"{version.id}"}}'))
    return {"project_id": project_id, "skill_id": version.skill_id,
            "skill_version_id": version.id,
            "desired_revision": assignment.desired_revision}



async def list_project_skills(request: Request, group_id: str, project_id: str):
    service, actor = await _actor(request, write=False)
    async with request.app.state.database.session() as session:
        if not await _can_manage_group(session, service, actor, group_id):
            raise HTTPException(status_code=403, detail="Group management denied")
        linked = await session.scalar(select(GroupProject.id).where(
            GroupProject.group_id == group_id,
            GroupProject.platform_project_id == project_id,
            GroupProject.revoked_at.is_(None),
        ))
        if linked is None:
            raise HTTPException(status_code=403, detail="Project is not linked to group")
        project = await session.get(PlatformProject, project_id)
        rows = (await session.execute(select(
            ProjectSkillAssignment, SkillVersion, SkillPackage,
        ).join(SkillVersion, SkillVersion.id == ProjectSkillAssignment.skill_version_id)
            .join(SkillPackage, SkillPackage.id == ProjectSkillAssignment.skill_id)
            .where(ProjectSkillAssignment.platform_project_id == project_id,
                   ProjectSkillAssignment.source_group_id == group_id,
                   ProjectSkillAssignment.revoked_at.is_(None))
            .order_by(SkillPackage.name))).all()
        state = await session.get(DeviceProjectSkillState,
                                  (project.device_id, project.host_project_id))
    return {"desired_revision": project.skill_revision,
            "applied_revision": state.applied_revision if state else None,
            "status": state.status if state else "pending",
            "last_error_code": state.last_error_code if state else None,
            "skills": [{"skill_id": package.id, "name": package.name,
                        "skill_version_id": version.id, "version": version.version,
                        "desired_revision": assignment.desired_revision}
                       for assignment, version, package in rows]}



async def revoke_project_skill(request: Request, group_id: str,
                               project_id: str, skill_id: str):
    service, actor = await _actor(request, write=True)
    async with request.app.state.database.session() as session:
        async with session.begin():
            if not await _can_manage_group(session, service, actor, group_id):
                raise HTTPException(status_code=403, detail="Group management denied")
            assignment = await session.scalar(select(ProjectSkillAssignment).where(
                ProjectSkillAssignment.platform_project_id == project_id,
                ProjectSkillAssignment.skill_id == skill_id,
                ProjectSkillAssignment.source_group_id == group_id,
                ProjectSkillAssignment.revoked_at.is_(None),
            ))
            if assignment is None:
                raise HTTPException(status_code=404, detail="Project Skill assignment unavailable")
            project = await session.get(PlatformProject, project_id)
            project.skill_revision += 1
            assignment.desired_revision = project.skill_revision
            assignment.status = "revoked"
            assignment.revoked_at = datetime.now(timezone.utc)
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   action="skill.project_revoked", result="success",
                                   metadata_json=f'{{"project_id":"{project_id}","skill_id":"{skill_id}"}}'))



async def download_skill_version(request: Request, version_id: str):
    authorization = request.headers.get("authorization", "")
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Skill manifest required")
    try:
        claims = request.app.state.gateway_signer.verify_skill_manifest(
            authorization.removeprefix("Bearer "),
            gateway_id=request.app.state.settings.gateway_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="Invalid Skill manifest") from exc
    project_ids = [project.get("platform_project_id") for project in claims["projects"]
                   if isinstance(project, dict) and isinstance(project.get("skills"), list)
                   and any(isinstance(skill, dict)
                           and skill.get("skill_version_id") == version_id
                           for skill in project["skills"])]
    if not project_ids:
        raise HTTPException(status_code=403, detail="Skill version is out of scope")
    async with request.app.state.database.session() as session:
        device = await session.get(Device, claims["device_id"])
        user = await session.get(User, claims["user_id"])
        access = await session.scalar(select(UserDevice.id).where(
            UserDevice.device_id == claims["device_id"],
            UserDevice.user_id == claims["user_id"],
            UserDevice.revoked_at.is_(None),
        ))
        if (device is None or device.status != "active"
                or user is None or user.status != "active" or access is None):
            raise HTTPException(status_code=403, detail="Device access revoked")
        version = await session.scalar(select(SkillVersion).join(
            ProjectSkillAssignment,
            ProjectSkillAssignment.skill_version_id == SkillVersion.id,
        ).join(PlatformProject,
               PlatformProject.id == ProjectSkillAssignment.platform_project_id)
            .join(GroupProject,
                  (GroupProject.group_id == ProjectSkillAssignment.source_group_id)
                  & (GroupProject.platform_project_id == PlatformProject.id))
            .join(GroupSkillCatalog,
                  (GroupSkillCatalog.group_id == ProjectSkillAssignment.source_group_id)
                  & (GroupSkillCatalog.skill_version_id == SkillVersion.id))
            .where(SkillVersion.id == version_id,
                   SkillVersion.status == "approved",
                   ProjectSkillAssignment.platform_project_id.in_(project_ids),
                   ProjectSkillAssignment.revoked_at.is_(None),
                   PlatformProject.device_id == claims["device_id"],
                   PlatformProject.status == "active",
                   GroupProject.revoked_at.is_(None),
                   GroupSkillCatalog.revoked_at.is_(None)))
    if version is None or not re.fullmatch(r"[0-9a-f-]{36}\.zip", version.storage_name):
        raise HTTPException(status_code=403, detail="Skill version unavailable")
    path = request.app.state.settings.data_dir / "skill-packages" / version.storage_name
    if not await asyncio.to_thread(path.is_file):
        raise HTTPException(status_code=503, detail="Skill package unavailable")
    return FileResponse(path, media_type="application/zip",
                        headers={"Cache-Control": "private, no-store"})
