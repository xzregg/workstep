from gateway.services.errors import GatewayError
from gateway.contracts import GatewayCall
from uuid import uuid4

from typing import Literal


from pydantic import BaseModel, Field, model_validator

from sqlalchemy import or_, select, update

from gateway.services.identity import COOKIE_NAME, IdentityService, _now
from gateway.services.permission_subjects import active_group_ids

from gateway.services.identity_api import _super_admin_request

from gateway.services.management_scope import project_manager, require_grant_subject, grant_subject_ids

from gateway.models import AuditEvent, CapabilityAssignment, Device, GroupCapabilityAssignment, GroupMembership, PlatformProject, User, UserDevice, UserGroup


"""Scoped managed capabilities compiled into signed device policies."""


class CapabilityTargetInput(BaseModel):
    capability: Literal["task.create", "project.publish", "share.create", "engine.install", "provider.local"]
    scope_type: Literal["global", "device", "project"]
    scope_id: str | None = Field(default=None, max_length=64)

    @model_validator(mode="after")
    def valid_scope(self):
        if (self.scope_type == "global" and self.scope_id is not None) or (
                self.scope_type != "global" and not self.scope_id
        ) or (self.capability in ("project.publish", "engine.install", "provider.local") and self.scope_type == "project"):
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
    device_ids = set((await session.scalars(select(PlatformProject.device_id).where(
        PlatformProject.id.in_(project_ids),
    ).distinct())).all())
    # Include removed members so their daemon drops previously inherited permissions.
    member_ids = select(GroupMembership.user_id).where(GroupMembership.group_id == group_id)
    device_ids.update((await session.scalars(select(UserDevice.device_id).where(
        UserDevice.user_id.in_(member_ids), UserDevice.revoked_at.is_(None),
    ))).all())
    if device_ids:
        await session.execute(update(Device).where(Device.id.in_(device_ids)).values(
            policy_revision=Device.policy_revision + 1,
            provider_revision=Device.provider_revision + 1,
        ))


async def capability_rules(session, user_id: str):
    return (await session.scalars(select(CapabilityAssignment).where(
        or_(CapabilityAssignment.user_id == user_id,
            CapabilityAssignment.group_id.in_(active_group_ids(user_id))),
        CapabilityAssignment.revoked_at.is_(None),
    ))).all()


def rules_allow(rules, capability: str, device_id: str, project_id: str | None = None):
    applicable = [rule for rule in rules if rule.capability == capability and (
        rule.scope_type == "global" or
        (rule.scope_type == "device" and rule.scope_id == device_id) or
        (project_id is not None and rule.scope_type == "project" and rule.scope_id == project_id))]
    return any(rule.effect == "allow" for rule in applicable) and not any(
        rule.effect == "deny" for rule in applicable)


async def compiled_project_scopes(session, device_id: str, user_id: str,
                                  capability: str, assignments) -> tuple[list[str], list[str]]:
    group_rules = (await session.scalars(select(GroupCapabilityAssignment).where(
        GroupCapabilityAssignment.group_id.in_(active_group_ids(user_id)),
        GroupCapabilityAssignment.capability == capability,
        GroupCapabilityAssignment.revoked_at.is_(None),
    ))).all()
    project_rows = (await session.scalars(select(PlatformProject).where(
        PlatformProject.device_id == device_id, PlatformProject.status == "active",
    ))).all()
    broad_denied = any(item.capability == capability and item.effect == "deny" and (
        item.scope_type == "global" or
        (item.scope_type == "device" and item.scope_id == device_id)) for item in assignments)
    allowed_projects, denied_projects = [], []
    for project in project_rows:
        project_rules = [item for item in (*assignments, *group_rules)
                         if item.capability == capability and (
                             (item.project_id == project.id and project.access_mode == "remote_published")
                             if isinstance(item, GroupCapabilityAssignment)
                             else (item.scope_type == "project" and item.scope_id == project.id))]
        denied = any(item.effect == "deny" for item in project_rules)
        if denied:
            denied_projects.append(project.host_project_id)
        elif not broad_denied and any(item.effect == "allow" for item in project_rules):
            allowed_projects.append(project.host_project_id)
    return sorted(allowed_projects), sorted(denied_projects)


async def compiled_device_capabilities(database, device_id: str, user_id: str
                                       ) -> dict[str, bool | list[str]]:
    async with database.session() as session:
        super_admin = await IdentityService.super_admin_in_session(session, user_id)
        rules = await capability_rules(session, user_id) if not super_admin else []
        allowed_projects, denied_projects = ([], []) if super_admin else await compiled_project_scopes(
            session, device_id, user_id, "share.create", rules)
        return {"task_share_project_ids": allowed_projects,
                "task_share_denied_project_ids": denied_projects,
                **{field: super_admin or rules_allow(rules, capability, device_id)
                   for field, capability in (("allow_local_providers", "provider.local"),
                                            ("task_share", "share.create"),
                                            ("engine_install", "engine.install"))}}


async def compiled_device_policy(database, device_id: str, user_id: str
                                 ) -> tuple[int, bool, bool, list[str], list[str]]:
    async with database.session() as session:
        device = await session.get(Device, device_id)
        if device is None:
            raise ValueError("Device not found")
        if await IdentityService.super_admin_in_session(session, user_id):
            return device.policy_revision, True, True, [], []
        assignments = await capability_rules(session, user_id)
        allowed_projects, denied_projects = await compiled_project_scopes(
            session, device_id, user_id, "task.create", assignments)
        return (device.policy_revision, rules_allow(assignments, "task.create", device_id),
                rules_allow(assignments, "project.publish", device_id), allowed_projects, denied_projects)


class GroupProjectCapabilityInput(BaseModel):
    effect: Literal["allow", "deny"]


async def _capability_manager(call: GatewayCall, user_id: str, body: CapabilityTargetInput):
    if body.scope_type == 'global':
        identity, actor = await _super_admin_request(call)
        _, auth_session = await identity.session_user(call.tokens.get(COOKIE_NAME))
        await identity.require_step_up(auth_session)
    else:
        identity, actor, _ = await project_manager(call, mutation=True, project_id=body.scope_id if body.scope_type == 'project' else None, device_id=body.scope_id if body.scope_type == 'device' else None)
        await require_grant_subject(call, identity, actor.id, 'user', user_id)
    return identity, actor


async def list_user_project_capabilities(call: GatewayCall, project_id: str):
    identity, actor, _ = await project_manager(call, project_id=project_id)
    async with call.database.session() as session:
        project = await session.get(PlatformProject, project_id)
        if (project is None or project.status != 'active'
                or project.access_mode != 'remote_published'):
            raise GatewayError('not_found', 'Published project unavailable')
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


async def list_group_project_capabilities(call: GatewayCall, project_id: str):
    identity, actor, _ = await project_manager(call, project_id=project_id)
    async with call.database.session() as session:
        project = await session.get(PlatformProject, project_id)
        if (project is None or project.status != 'active'
                or project.access_mode != 'remote_published'):
            raise GatewayError('not_found', 'Published project unavailable')
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


async def set_group_project_capability(call: GatewayCall, project_id: str,
                                       group_id: str, body: GroupProjectCapabilityInput):
    identity, actor, _ = await project_manager(call, project_id=project_id, mutation=True)
    await require_grant_subject(call, identity, actor.id, 'group', group_id)
    async with call.database.session() as session:
        async with session.begin():
            project = await session.get(PlatformProject, project_id)
            group = await session.get(UserGroup, group_id)
            if (project is None or project.status != 'active'
                    or project.access_mode != 'remote_published'
                    or group is None or group.status != 'active'):
                raise GatewayError('not_found', 'Project or group unavailable')
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


async def revoke_group_project_capability(call: GatewayCall, project_id: str, group_id: str):
    identity, actor, _ = await project_manager(call, project_id=project_id, mutation=True)
    await require_grant_subject(call, identity, actor.id, 'group', group_id)
    async with call.database.session() as session:
        async with session.begin():
            assignment = await session.scalar(select(GroupCapabilityAssignment).where(
                GroupCapabilityAssignment.group_id == group_id,
                GroupCapabilityAssignment.project_id == project_id,
                GroupCapabilityAssignment.capability == 'task.create',
                GroupCapabilityAssignment.revoked_at.is_(None),
            ))
            if assignment is None:
                raise GatewayError('not_found', 'Group capability unavailable')
            assignment.revoked_at = _now()
            await session.execute(update(Device).where(Device.id == select(
                PlatformProject.device_id).where(PlatformProject.id == project_id).scalar_subquery()
            ).values(policy_revision=Device.policy_revision + 1))
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                                   action='admin.group_capability_revoked', result='success'))


async def set_capability(call: GatewayCall, user_id: str, body: CapabilityInput):
    identity, actor = await _capability_manager(call, user_id, body)
    database = call.database
    scope_id = body.scope_id or ""
    async with database.session() as session:
        async with session.begin():
            user = await session.get(User, user_id)
            if user is None:
                raise GatewayError('not_found', 'User not found')
            if body.scope_type == "device" and await session.get(Device, scope_id) is None:
                raise GatewayError('not_found', 'Device not found')
            if body.scope_type == "project" and await session.get(PlatformProject, scope_id) is None:
                raise GatewayError('not_found', 'Project not found')
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


async def revoke_capability(call: GatewayCall, user_id: str, body: CapabilityTargetInput):
    identity, actor = await _capability_manager(call, user_id, body)
    scope_id = body.scope_id or ""
    async with call.database.session() as session:
        async with session.begin():
            assignment = await session.scalar(select(CapabilityAssignment).where(
                CapabilityAssignment.user_id == user_id,
                CapabilityAssignment.capability == body.capability,
                CapabilityAssignment.scope_type == body.scope_type,
                CapabilityAssignment.scope_id == scope_id,
            ))
            if assignment is None or assignment.revoked_at is not None:
                raise GatewayError('not_found', 'Capability assignment not found')
            assignment.revoked_at = _now()
            await _bump_revisions(session, user_id, body.scope_type, scope_id)
            session.add(AuditEvent(
                id=str(uuid4()), user_id=actor.id,
                device_id=scope_id if body.scope_type == "device" else None,
                action="admin.capability_revoked", result="success", metadata_json=None,
            ))
