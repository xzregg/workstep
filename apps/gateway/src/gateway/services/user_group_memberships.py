"""User editor group choices and transactional membership changes."""
import json
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import select

from gateway.models import AuditEvent, DirectoryDepartment, GroupMembership, UserGroup
from gateway.services.capabilities import bump_group_capability_revisions
from gateway.services.errors import GatewayError
from gateway.services.groups_api import _can_manage_group


async def user_group_choices(call, user_id):
    from gateway.services.identity_api import _identity
    from gateway.services.identity import COOKIE_NAME
    identity = _identity(call)
    actor, _ = await identity.session_user(call.tokens.get(COOKIE_NAME))
    await identity.require_user_manager(actor.id, user_id)
    async with call.database.session() as session:
        rows = (await session.execute(select(UserGroup, GroupMembership).outerjoin(
            GroupMembership, (GroupMembership.group_id == UserGroup.id) &
            (GroupMembership.user_id == user_id)).where(UserGroup.status == 'active')
            .order_by(UserGroup.name, UserGroup.id))).all()
        department_ids = [group.external_department_id for group, _ in rows if group.external_department_id]
        departments = {row.id: row for row in (await session.scalars(select(DirectoryDepartment).where(
            DirectoryDepartment.id.in_(department_ids)))).all()} if department_ids else {}
        parent_groups = {(departments[group.external_department_id].source_id,
                          departments[group.external_department_id].external_id): group.id
                         for group, _ in rows if group.external_department_id in departments}
        groups = []
        for group, membership in rows:
            manageable = await _can_manage_group(session, identity, actor, group.id)
            selected = membership is not None and membership.revoked_at is None
            if not manageable and not selected:
                continue
            synced = membership is not None and membership.source != 'manual'
            department = departments.get(group.external_department_id)
            parent_id = parent_groups.get((department.source_id, department.parent_external_id)) if department else group.parent_group_id
            groups.append({'id': group.id, 'name': group.name, 'parent_id': parent_id,
                           'source_type': group.source_type, 'selected': selected,
                           'editable': manageable and not synced, 'synced': synced})
    return {'groups': groups}


async def update_user_groups(session, identity, actor_id, user_id, group_ids):
    from gateway.models import User
    actor = await session.get(User, actor_id)
    rows = (await session.execute(select(UserGroup, GroupMembership).outerjoin(
        GroupMembership, (GroupMembership.group_id == UserGroup.id) &
        (GroupMembership.user_id == user_id)).where(UserGroup.status == 'active'))).all()
    by_id = {group.id: (group, membership) for group, membership in rows}
    desired = set(group_ids)
    if not desired.issubset(by_id):
        raise GatewayError('not_found', 'Group unavailable')
    changed = []
    for group, membership in rows:
        selected = membership is not None and membership.revoked_at is None
        if selected == (group.id in desired):
            continue
        if not await _can_manage_group(session, identity, actor, group.id):
            raise GatewayError('forbidden', 'Group management denied')
        if membership is not None and membership.source != 'manual':
            raise GatewayError('conflict', 'Directory membership is read-only')
        if membership is not None and membership.role == 'leader':
            await identity.require_super_admin(actor_id)
        if membership is None:
            session.add(GroupMembership(id=str(uuid4()), group_id=group.id, user_id=user_id,
                role='member', source='manual', assigned_by_user_id=actor_id))
        else:
            membership.revoked_at = None if group.id in desired else datetime.now(timezone.utc)
        changed.append(group.id)
    await session.flush()
    for group_id in changed:
        await bump_group_capability_revisions(session, group_id)
    if changed:
        session.add(AuditEvent(id=str(uuid4()), user_id=actor_id, action='user.groups_updated',
            result='success', metadata_json=json.dumps({'user_id': user_id, 'group_ids': sorted(desired)})))
