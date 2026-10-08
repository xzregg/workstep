from gateway.services.errors import GatewayError
from gateway.contracts import GatewayCall
import re

from datetime import datetime, timezone

from uuid import uuid4


from pydantic import BaseModel, Field, model_validator

from sqlalchemy import func, or_, select

from sqlalchemy.exc import IntegrityError

from gateway.services.identity_errors import IdentityError
from gateway.services.identity import COOKIE_NAME

from gateway.services.identity_api import _check_csrf, _identity, _super_admin_read, _super_admin_request

from gateway.services.group_membership_sync import reconcile_department_groups

from gateway.services.capabilities import bump_group_capability_revisions

from gateway.models import AuditEvent, Device, DirectoryDepartment, GroupMembership, GroupProject, PlatformProject, ProjectSkillAssignment, User, UserGroup


"""Group membership and Skills-only project associations."""


class GroupInput(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    slug: str = Field(min_length=1, max_length=128)
    description: str = Field(default="", max_length=2000)
    source_type: str = Field(default="manual", pattern=r"^(manual|external_department)$")
    external_department_id: str | None = Field(default=None, max_length=64)


class MemberInput(BaseModel):
    user_id: str | None = Field(default=None, min_length=1, max_length=64)
    username: str | None = Field(default=None, min_length=1, max_length=128)
    role: str = Field(default="member", pattern=r"^(member|leader)$")

    @model_validator(mode="after")
    def exactly_one_identity(self):
        if (self.user_id is None) == (self.username is None):
            raise ValueError("Provide exactly one user identity")
        return self


class GroupProjectInput(BaseModel):
    project_id: str = Field(min_length=1, max_length=64)


async def _actor(call: GatewayCall, *, write: bool):
    token = call.tokens.get(COOKIE_NAME)
    service = _identity(call)
    user, _ = await service.session_user(token)
    if user.must_change_password:
        raise GatewayError('forbidden', 'Password change required')
    if write:
        _check_csrf(call, token)
    return service, user


async def _can_manage_group(session, service, user: User, group_id: str) -> bool:
    group = await session.get(UserGroup, group_id)
    if group is None or group.status != 'active':
        raise GatewayError('not_found', 'Group unavailable')
    try:
        await service.require_super_admin(user.id)
        return True
    except IdentityError:
        pass
    return await session.scalar(select(GroupMembership.id).where(
        GroupMembership.group_id == group_id,
        GroupMembership.user_id == user.id,
        GroupMembership.role == "leader",
        GroupMembership.revoked_at.is_(None),
    )) is not None


async def create_group(call: GatewayCall, body: GroupInput):
    service, actor = await _super_admin_request(call)
    _, auth_session = await service.session_user(call.tokens.get(COOKIE_NAME))
    await service.require_step_up(auth_session)
    if (body.name != body.name.strip() or not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", body.slug)):
        raise GatewayError('invalid', 'Invalid group name or slug')
    if (body.source_type == "external_department") != (body.external_department_id is not None):
        raise GatewayError('invalid', 'Department mapping required')
    group = UserGroup(id=str(uuid4()), name=body.name, slug=body.slug,
                      description=body.description, source_type=body.source_type,
                      external_department_id=body.external_department_id,
                      created_by_user_id=actor.id)
    try:
        async with call.database.session() as session:
            async with session.begin():
                if body.external_department_id:
                    department = await session.get(DirectoryDepartment,
                                                   body.external_department_id)
                    if department is None or department.active != 1:
                        raise GatewayError('not_found', 'Department unavailable')
                session.add(group)
                await session.flush()
                if body.external_department_id:
                    await reconcile_department_groups(session, group_id=group.id)
                session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                       action="group.created", result="success",
                                       metadata_json=f'{{"group_id":"{group.id}"}}'))
    except IntegrityError as exc:
        raise GatewayError('conflict', 'Group slug already exists') from exc
    return {"id": group.id, "name": group.name, "slug": group.slug,
            "description": group.description, "source_type": group.source_type}


async def list_groups(call: GatewayCall):
    service, actor = await _actor(call, write=False)
    async with call.database.session() as session:
        try:
            await service.require_super_admin(actor.id)
            rows = (await session.scalars(select(UserGroup).where(
                UserGroup.status == "active",
            ).order_by(UserGroup.name, UserGroup.id))).all()
        except IdentityError:
            rows = (await session.scalars(select(UserGroup).join(GroupMembership).where(
                GroupMembership.user_id == actor.id,
                GroupMembership.revoked_at.is_(None),
                UserGroup.status == "active",
            ).order_by(UserGroup.name, UserGroup.id))).all()
    return {"groups": [{"id": row.id, "name": row.name, "slug": row.slug,
                        "source_type": row.source_type} for row in rows]}


async def list_linkable_group_projects(call: GatewayCall,
                                       q: str = '',
                                       page: int = 1,
                                       page_size: int = 25):
    await _super_admin_read(call)
    conditions = [PlatformProject.status == "active"]
    if q.strip():
        escaped = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        conditions.append(or_(PlatformProject.name.ilike(pattern, escape="\\"),
                              Device.name.ilike(pattern, escape="\\")))
    async with call.database.session() as session:
        base = select(PlatformProject, Device).join(Device, Device.id == PlatformProject.device_id)
        total = await session.scalar(select(func.count()).select_from(PlatformProject).join(
            Device, Device.id == PlatformProject.device_id,
        ).where(*conditions))
        rows = (await session.execute(base.where(*conditions).order_by(
            PlatformProject.name, PlatformProject.id,
        ).offset((page - 1) * page_size).limit(page_size))).all()
    return {"projects": [{"id": project.id, "name": project.name,
                          "device_id": device.id, "device_name": device.name,
                          "access_mode": project.access_mode}
                         for project, device in rows],
            "total": total, "page": page, "page_size": page_size}


async def add_group_member(call: GatewayCall, group_id: str, body: MemberInput):
    service, actor = await _actor(call, write=True)
    async with call.database.session() as session:
        async with session.begin():
            group = await session.get(UserGroup, group_id)
            if group is None or group.status != "active":
                raise GatewayError('not_found', 'Group unavailable')
            if not await _can_manage_group(session, service, actor, group_id):
                raise GatewayError('forbidden', 'Group management denied')
            if body.role == "leader":
                await service.require_super_admin(actor.id)
            user = (await session.get(User, body.user_id) if body.user_id else
                    await session.scalar(select(User).where(User.username == body.username)))
            if user is None or user.status != "active":
                raise GatewayError('not_found', 'User unavailable')
            membership = await session.scalar(select(GroupMembership).where(
                GroupMembership.group_id == group_id,
                GroupMembership.user_id == user.id,
            ))
            if membership is None:
                membership = GroupMembership(
                    id=str(uuid4()), group_id=group_id, user_id=user.id,
                    role=body.role, source="manual", assigned_by_user_id=actor.id,
                )
                session.add(membership)
            else:
                if membership.source != "manual":
                    raise GatewayError('conflict', 'Directory membership is read-only')
                if membership.role == "leader":
                    await service.require_super_admin(actor.id)
                membership.role = body.role
                membership.revoked_at = None
            await session.flush()
            await bump_group_capability_revisions(session, group_id)
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   action="group.member_assigned", result="success",
                                   metadata_json=f'{{"group_id":"{group_id}"}}'))
    return {"group_id": group_id, "user_id": user.id, "role": body.role}


async def list_group_members(call: GatewayCall, group_id: str):
    service, actor = await _actor(call, write=False)
    async with call.database.session() as session:
        if not await _can_manage_group(session, service, actor, group_id):
            raise GatewayError('forbidden', 'Group management denied')
        rows = (await session.execute(select(GroupMembership, User).join(
            User, User.id == GroupMembership.user_id,
        ).where(GroupMembership.group_id == group_id,
                User.status != 'deleted',
                GroupMembership.revoked_at.is_(None))
            .order_by(User.username))).all()
    return {"members": [{"user_id": user.id, "username": user.username,
                         "login_username": user.username if user.password_hash else None,
                         "display_name": user.display_name, "role": membership.role,
                         "source": membership.source}
                        for membership, user in rows]}


async def remove_group_member(call: GatewayCall, group_id: str, user_id: str):
    service, actor = await _actor(call, write=True)
    async with call.database.session() as session:
        async with session.begin():
            if not await _can_manage_group(session, service, actor, group_id):
                raise GatewayError('forbidden', 'Group management denied')
            membership = await session.scalar(select(GroupMembership).where(
                GroupMembership.group_id == group_id,
                GroupMembership.user_id == user_id,
                GroupMembership.revoked_at.is_(None),
            ))
            if membership is None:
                raise GatewayError('not_found', 'Group member unavailable')
            if membership.role == "leader":
                await service.require_super_admin(actor.id)
            if membership.source != "manual":
                raise GatewayError('conflict', 'Directory membership is read-only')
            membership.revoked_at = datetime.now(timezone.utc)
            await bump_group_capability_revisions(session, group_id)
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   action="group.member_removed", result="success",
                                   metadata_json=f'{{"group_id":"{group_id}"}}'))


async def link_group_project(call: GatewayCall, group_id: str, body: GroupProjectInput):
    _, actor = await _super_admin_request(call)
    async with call.database.session() as session:
        async with session.begin():
            group = await session.get(UserGroup, group_id)
            project = await session.get(PlatformProject, body.project_id)
            if group is None or group.status != "active" or project is None:
                raise GatewayError('not_found', 'Group or project unavailable')
            relation = await session.scalar(select(GroupProject).where(
                GroupProject.group_id == group_id,
                GroupProject.platform_project_id == body.project_id,
            ))
            if relation is None:
                session.add(GroupProject(id=str(uuid4()), group_id=group_id,
                                         platform_project_id=body.project_id,
                                         assigned_by_user_id=actor.id))
            else:
                relation.revoked_at = None
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   action="group.project_linked", result="success",
                                   metadata_json=f'{{"group_id":"{group_id}"}}'))
    return {"group_id": group_id, "project_id": body.project_id,
            "purpose": "skill_management"}


async def list_group_projects(call: GatewayCall, group_id: str):
    service, actor = await _actor(call, write=False)
    async with call.database.session() as session:
        if not await _can_manage_group(session, service, actor, group_id):
            raise GatewayError('forbidden', 'Group management denied')
        rows = (await session.scalars(select(PlatformProject).join(
            GroupProject, GroupProject.platform_project_id == PlatformProject.id,
        ).where(GroupProject.group_id == group_id,
                GroupProject.revoked_at.is_(None)).order_by(PlatformProject.name))).all()
    return {"projects": [{"id": project.id, "name": project.name,
                          "purpose": "skill_management"} for project in rows]}


async def unlink_group_project(call: GatewayCall, group_id: str, project_id: str):
    _, actor = await _super_admin_request(call)
    async with call.database.session() as session:
        async with session.begin():
            relation = await session.scalar(select(GroupProject).where(
                GroupProject.group_id == group_id,
                GroupProject.platform_project_id == project_id,
                GroupProject.revoked_at.is_(None),
            ))
            if relation is None:
                raise GatewayError('not_found', 'Group project link unavailable')
            now = datetime.now(timezone.utc)
            relation.revoked_at = now
            assignments = (await session.scalars(select(ProjectSkillAssignment).where(
                ProjectSkillAssignment.platform_project_id == project_id,
                ProjectSkillAssignment.source_group_id == group_id,
                ProjectSkillAssignment.revoked_at.is_(None),
            ))).all()
            if assignments:
                project = await session.get(PlatformProject, project_id)
                project.skill_revision += 1
                for assignment in assignments:
                    assignment.desired_revision = project.skill_revision
                    assignment.status = "revoked"
                    assignment.revoked_at = now
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   action="group.project_unlinked", result="success",
                                   metadata_json=f'{{"group_id":"{group_id}","project_id":"{project_id}"}}'))
