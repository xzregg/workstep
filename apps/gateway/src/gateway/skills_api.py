"""Reviewed immutable Skill catalog."""

import asyncio
import re
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .groups_api import _actor, _can_manage_group
from .identity import COOKIE_NAME
from .identity_api import _check_csrf, _identity
from .models import (AuditEvent, GroupProject, GroupSkillCatalog, PlatformProject,
                     ProjectSkillAssignment, SkillPackage, SkillVersion, UserGroup)
from .skill_packages import save_archive, validate_archive

router = APIRouter(prefix="/api/admin/skills")
admin_group_router = APIRouter(prefix="/api/admin/groups")
project_skill_router = APIRouter(prefix="/api/groups")


class SkillInput(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    slug: str = Field(min_length=1, max_length=128)
    description: str = Field(default="", max_length=2000)


class SkillVersionInput(BaseModel):
    version: str = Field(min_length=1, max_length=64)
    archive_base64: str = Field(min_length=1, max_length=11 * 1024 * 1024)


class SkillGrantInput(BaseModel):
    skill_version_id: str = Field(min_length=1, max_length=64)


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


@router.post("", status_code=201)
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


@router.post("/{skill_id}/versions", status_code=201)
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


@router.get("/{skill_id}/versions")
async def list_skill_versions(request: Request, skill_id: str):
    await _admin_read(request)
    async with request.app.state.database.session() as session:
        rows = (await session.scalars(select(SkillVersion).where(
            SkillVersion.skill_id == skill_id,
        ).order_by(SkillVersion.created_at.desc()))).all()
    return {"versions": [_public_version(row) for row in rows]}


@router.post("/{skill_id}/versions/{version_id}/approve")
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


@admin_group_router.post("/{group_id}/skills")
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
                grant.skill_version_id = version.id
                grant.revoked_at = None
                grant.granted_by_user_id = actor.id
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   action="skill.group_granted", result="success",
                                   metadata_json=f'{{"group_id":"{group_id}","version_id":"{version.id}"}}'))
    return {"group_id": group_id, "skill_id": version.skill_id,
            "skill_version_id": version.id}


@project_skill_router.post("/{group_id}/projects/{project_id}/skills")
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
            assignment = await session.scalar(select(ProjectSkillAssignment).where(
                ProjectSkillAssignment.platform_project_id == project_id,
                ProjectSkillAssignment.skill_id == version.skill_id,
            ))
            if (assignment is not None and assignment.revoked_at is None
                    and assignment.skill_version_id == version.id):
                return {"project_id": project_id, "skill_id": version.skill_id,
                        "skill_version_id": version.id,
                        "desired_revision": assignment.desired_revision}
            if (assignment is not None and assignment.revoked_at is None
                    and assignment.source_group_id != group_id):
                raise HTTPException(status_code=409, detail="Skill version conflict across groups")
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
