from uuid import uuid4

from typing import Literal

from fastapi import APIRouter, HTTPException, Request

from pydantic import BaseModel, Field, model_validator

from sqlalchemy import select, update

from gateway.services.identity import COOKIE_NAME, _now

from gateway.services.identity_api import _super_admin_request

from gateway.services.management_scope import project_manager, require_grant_subject, grant_subject_ids

from gateway.models import AuditEvent, CapabilityAssignment, Device, GroupCapabilityAssignment, GroupMembership, PlatformProject, User, UserDevice, UserGroup


"""Scoped managed capabilities compiled into signed device policies."""


class CapabilityTargetInput(BaseModel):
    capability: Literal["task.create", "project.publish", "share.create"]
    scope_type: Literal["global", "device", "project"]
    scope_id: str | None = Field(default=None, max_length=64)

    @model_validator(mode="after")
    def valid_scope(self):
        if (self.scope_type == "global" and self.scope_id is not None) or (
                self.scope_type != "global" and not self.scope_id
        ) or (self.capability == "project.publish" and self.scope_type == "project"):
            raise ValueError("Invalid capability scope")
        return self


class CapabilityInput(CapabilityTargetInput):
    effect: Literal["allow", "deny"]


async def _bump_revisions(session, user_id: str, scope_type: str, scope_id: str) -> None:
    if scope_type == "project":
        project = await session.get(PlatformProject, scope_id)
        if project is None:
            return
        scope_type, scope_id = "device", project.device_id
    device_ids = (await session.scalars(select(UserDevice.device_id).where(
        UserDevice.user_id == user_id, UserDevice.revoked_at.is_(None),
        *([UserDevice.device_id == scope_id] if scope_type == "device" else []),
    ))).all()
    if device_ids:
        await session.execute(update(Device).where(Device.id.in_(device_ids)).values(
            policy_revision=Device.policy_revision + 1,
        ))


async def bump_group_capability_revisions(session, group_id: str) -> None:
    """Refresh device snapshots when a group's policy or membership changes."""
    project_ids = select(GroupCapabilityAssignment.project_id).where(
        GroupCapabilityAssignment.group_id == group_id,
        GroupCapabilityAssignment.revoked_at.is_(None),
    )
    device_ids = (await session.scalars(select(PlatformProject.device_id).where(
        PlatformProject.id.in_(project_ids),
    ).distinct())).all()
    if device_ids:
        await session.execute(update(Device).where(Device.id.in_(device_ids)).values(
            policy_revision=Device.policy_revision + 1,
        ))


async def compiled_device_policy(database, device_id: str, user_id: str
                                 ) -> tuple[int, bool, bool, list[str], list[str]]:
    async with database.session() as session:
        device = await session.get(Device, device_id)
        if device is None:
            raise ValueError("Device not found")
        assignments = (await session.scalars(select(CapabilityAssignment).where(
            CapabilityAssignment.user_id == user_id,
            CapabilityAssignment.capability.in_(("task.create", "project.publish")),
            CapabilityAssignment.revoked_at.is_(None),
        ))).all()
        group_ids = (await session.scalars(select(GroupMembership.group_id).join(
            UserGroup, UserGroup.id == GroupMembership.group_id,
        ).where(GroupMembership.user_id == user_id,
                GroupMembership.revoked_at.is_(None),
                UserGroup.status == "active"))).all()
        group_rules = (await session.scalars(select(GroupCapabilityAssignment).where(
            GroupCapabilityAssignment.group_id.in_(group_ids),
            GroupCapabilityAssignment.capability == "task.create",
            GroupCapabilityAssignment.revoked_at.is_(None),
        ))).all() if group_ids else []
        project_rows = (await session.scalars(
            select(PlatformProject).where(PlatformProject.device_id == device_id,
                                          PlatformProject.status == "active"),
        )).all()
        projects = {row.id: row.host_project_id for row in project_rows}
        published_projects = {row.id for row in project_rows
                              if row.access_mode == "remote_published"}
    def allowed(capability: str) -> bool:
        relevant = [item for item in assignments if item.capability == capability
                    and (item.scope_type == "global"
                         or (item.scope_type == "device" and item.scope_id == device_id))]
        return any(item.effect == "allow" for item in relevant) and not any(
            item.effect == "deny" for item in relevant)
    broad = [item for item in assignments if item.capability == "task.create"
             and (item.scope_type == "global"
                  or (item.scope_type == "device" and item.scope_id == device_id))]
    broad_denied = any(item.effect == "deny" for item in broad)
    project_rules = {platform_id: [item for item in (*assignments, *group_rules)
                                   if item.capability == "task.create"
                                   and ((item.project_id == platform_id and platform_id in published_projects)
                                        if isinstance(item, GroupCapabilityAssignment)
                                        else (item.scope_type == "project" and item.scope_id == platform_id))]
                     for platform_id in projects}
    allowed_projects = sorted(host_id for platform_id, host_id in projects.items()
                              if not broad_denied and any(
                                  item.effect == "allow" for item in project_rules[platform_id]
                              ) and not any(item.effect == "deny"
                                            for item in project_rules[platform_id]))
    denied_projects = sorted(host_id for platform_id, host_id in projects.items()
                             if any(item.effect == "deny"
                                    for item in project_rules[platform_id]))
    return (device.policy_revision, allowed("task.create"),
            allowed("project.publish"), allowed_projects, denied_projects)


class GroupProjectCapabilityInput(BaseModel):
    effect: Literal["allow", "deny"]


async def _capability_manager(request: Request, user_id: str, body: CapabilityTargetInput):
    if body.scope_type == 'global':
        identity, actor = await _super_admin_request(request)
        _, auth_session = await identity.session_user(request.cookies.get(COOKIE_NAME))
        await identity.require_step_up(auth_session)
    else:
        identity, actor, _ = await project_manager(request, mutation=True,
            project_id=body.scope_id if body.scope_type == 'project' else None,
            device_id=body.scope_id if body.scope_type == 'device' else None)
        await require_grant_subject(request, identity, actor.id, 'user', user_id)
    return identity, actor



async def list_user_project_capabilities(request: Request, project_id: str):
    identity, actor, _ = await project_manager(request, project_id=project_id)
    async with request.app.state.database.session() as session:
        project = await session.get(PlatformProject, project_id)
        if (project is None or project.status != 'active'
                or project.access_mode != 'remote_published'):
            raise HTTPException(status_code=404, detail='Published project unavailable')
        subjects = await grant_subject_ids(session, identity, actor.id, 'user')
        rows = (await session.execute(select(CapabilityAssignment, User.username).join(
            User, User.id == CapabilityAssignment.user_id,
        ).where(CapabilityAssignment.scope_type == 'project',
                CapabilityAssignment.scope_id == project_id,
                CapabilityAssignment.capability == 'task.create',
                CapabilityAssignment.revoked_at.is_(None),
                *([CapabilityAssignment.user_id.in_(subjects)] if subjects is not None else []))
            .order_by(User.username, CapabilityAssignment.id))).all()
    return {'assignments': [{'id': row.id, 'user_id': row.user_id,
                             'username': name, 'effect': row.effect} for row, name in rows]}



async def list_group_project_capabilities(request: Request, project_id: str):
    identity, actor, _ = await project_manager(request, project_id=project_id)
    async with request.app.state.database.session() as session:
        project = await session.get(PlatformProject, project_id)
        if (project is None or project.status != 'active'
                or project.access_mode != 'remote_published'):
            raise HTTPException(status_code=404, detail='Published project unavailable')
        subjects = await grant_subject_ids(session, identity, actor.id, 'group')
        rows = (await session.execute(select(GroupCapabilityAssignment, UserGroup.name).join(
            UserGroup, UserGroup.id == GroupCapabilityAssignment.group_id,
        ).where(GroupCapabilityAssignment.project_id == project_id,
                GroupCapabilityAssignment.revoked_at.is_(None),
                GroupCapabilityAssignment.capability == 'task.create',
                *([GroupCapabilityAssignment.group_id.in_(subjects)] if subjects is not None else []))
            .order_by(UserGroup.name, GroupCapabilityAssignment.id))).all()
    return {'assignments': [{'id': row.id, 'group_id': row.group_id,
                             'group_name': name, 'effect': row.effect} for row, name in rows]}



async def set_group_project_capability(request: Request, project_id: str,
                                       group_id: str, body: GroupProjectCapabilityInput):
    identity, actor, _ = await project_manager(request, project_id=project_id, mutation=True)
    await require_grant_subject(request, identity, actor.id, 'group', group_id)
    async with request.app.state.database.session() as session:
        async with session.begin():
            project = await session.get(PlatformProject, project_id)
            group = await session.get(UserGroup, group_id)
            if (project is None or project.status != 'active'
                    or project.access_mode != 'remote_published'
                    or group is None or group.status != 'active'):
                raise HTTPException(status_code=404, detail='Project or group unavailable')
            assignment = await session.scalar(select(GroupCapabilityAssignment).where(
                GroupCapabilityAssignment.group_id == group_id,
                GroupCapabilityAssignment.project_id == project_id,
                GroupCapabilityAssignment.capability == 'task.create',
            ))
            if assignment is None:
                assignment = GroupCapabilityAssignment(
                    id=str(uuid4()), group_id=group_id, project_id=project_id,
                    capability='task.create', effect=body.effect,
                    assigned_by_user_id=actor.id,
                )
                session.add(assignment)
            else:
                assignment.effect = body.effect
                assignment.revoked_at = None
                assignment.assigned_by_user_id = actor.id
            await session.flush()
            await bump_group_capability_revisions(session, group_id)
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   device_id=project.device_id,
                                   action='admin.group_capability_set', result='success'))
    return {'id': assignment.id, 'project_id': project_id, 'group_id': group_id,
            'capability': 'task.create', 'effect': body.effect}



async def revoke_group_project_capability(request: Request, project_id: str, group_id: str):
    identity, actor, _ = await project_manager(request, project_id=project_id, mutation=True)
    await require_grant_subject(request, identity, actor.id, 'group', group_id)
    async with request.app.state.database.session() as session:
        async with session.begin():
            assignment = await session.scalar(select(GroupCapabilityAssignment).where(
                GroupCapabilityAssignment.group_id == group_id,
                GroupCapabilityAssignment.project_id == project_id,
                GroupCapabilityAssignment.capability == 'task.create',
                GroupCapabilityAssignment.revoked_at.is_(None),
            ))
            if assignment is None:
                raise HTTPException(status_code=404, detail='Group capability unavailable')
            assignment.revoked_at = _now()
            await session.execute(update(Device).where(Device.id == select(
                PlatformProject.device_id).where(PlatformProject.id == project_id).scalar_subquery()
            ).values(policy_revision=Device.policy_revision + 1))
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   action='admin.group_capability_revoked', result='success'))



async def set_capability(request: Request, user_id: str, body: CapabilityInput):
    identity, actor = await _capability_manager(request, user_id, body)
    database = request.app.state.database
    scope_id = body.scope_id or ""
    async with database.session() as session:
        async with session.begin():
            user = await session.get(User, user_id)
            if user is None:
                raise HTTPException(status_code=404, detail="User not found")
            if body.scope_type == "device" and await session.get(Device, scope_id) is None:
                raise HTTPException(status_code=404, detail="Device not found")
            if body.scope_type == "project" and await session.get(PlatformProject, scope_id) is None:
                raise HTTPException(status_code=404, detail="Project not found")
            assignment = await session.scalar(select(CapabilityAssignment).where(
                CapabilityAssignment.user_id == user_id,
                CapabilityAssignment.capability == body.capability,
                CapabilityAssignment.scope_type == body.scope_type,
                CapabilityAssignment.scope_id == scope_id,
            ))
            if assignment is None:
                assignment = CapabilityAssignment(
                    id=str(uuid4()), user_id=user_id, capability=body.capability,
                    scope_type=body.scope_type, scope_id=scope_id, effect=body.effect,
                    assigned_by_user_id=actor.id,
                )
                session.add(assignment)
            else:
                assignment.effect = body.effect
                assignment.assigned_by_user_id = actor.id
                assignment.revoked_at = None
            await _bump_revisions(session, user_id, body.scope_type, scope_id)
            session.add(AuditEvent(
                id=str(uuid4()), user_id=actor.id,
                device_id=scope_id if body.scope_type == "device" else None,
                action="admin.capability_set", result="success",
                metadata_json=None,
            ))
    return {"id": assignment.id, "user_id": user_id, "capability": body.capability,
            "scope_type": body.scope_type, "scope_id": body.scope_id, "effect": body.effect}



async def revoke_capability(request: Request, user_id: str, body: CapabilityTargetInput):
    identity, actor = await _capability_manager(request, user_id, body)
    scope_id = body.scope_id or ""
    async with request.app.state.database.session() as session:
        async with session.begin():
            assignment = await session.scalar(select(CapabilityAssignment).where(
                CapabilityAssignment.user_id == user_id,
                CapabilityAssignment.capability == body.capability,
                CapabilityAssignment.scope_type == body.scope_type,
                CapabilityAssignment.scope_id == scope_id,
            ))
            if assignment is None or assignment.revoked_at is not None:
                raise HTTPException(status_code=404, detail="Capability assignment not found")
            assignment.revoked_at = _now()
            await _bump_revisions(session, user_id, body.scope_type, scope_id)
            session.add(AuditEvent(
                id=str(uuid4()), user_id=actor.id,
                device_id=scope_id if body.scope_type == "device" else None,
                action="admin.capability_revoked", result="success", metadata_json=None,
            ))
