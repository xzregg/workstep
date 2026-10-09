"""Atomic member changes; synchronized memberships remain owned by the directory."""
import json
from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field
from sqlalchemy import select

from gateway.contracts import GatewayCall
from gateway.models import AuditEvent, GroupMembership, User, UserGroup
from gateway.services.capabilities import bump_group_capability_revisions
from gateway.services.errors import GatewayError
from gateway.services.groups_api import _actor, _can_manage_group


class BulkMemberInput(BaseModel):
    user_ids: list[str] = Field(min_length=1, max_length=100)
    action: Literal['add', 'remove', 'set_role']
    role: Literal['member', 'leader'] = 'member'


async def bulk_members(call: GatewayCall, group_id: str, body: BulkMemberInput):
    service, actor = await _actor(call, write=True)
    ids = list(dict.fromkeys(body.user_ids))
    async with call.database.session() as session:
        async with session.begin():
            group = await session.get(UserGroup, group_id)
            if group is None or group.status != 'active':
                raise GatewayError('not_found', 'Group unavailable')
            if not await _can_manage_group(session, service, actor, group_id):
                raise GatewayError('forbidden', 'Group management denied')
            users = (await session.scalars(select(User).where(User.id.in_(ids)))).all()
            if len(users) != len(ids) or (body.action == 'add' and any(user.status != 'active' for user in users)):
                raise GatewayError('not_found', 'User unavailable')
            rows = (await session.scalars(select(GroupMembership).where(
                GroupMembership.group_id == group_id, GroupMembership.user_id.in_(ids)))).all()
            memberships = {row.user_id: row for row in rows}
            if any(row.source != 'manual' for row in rows):
                raise GatewayError('conflict', 'Directory membership is read-only')
            if body.action != 'add' and (len(rows) != len(ids) or any(row.revoked_at is not None for row in rows)):
                raise GatewayError('not_found', 'Group member unavailable')
            if (body.action != 'remove' and body.role == 'leader') or any(row.role == 'leader' for row in rows):
                await service.require_super_admin(actor.id)
            for user_id in ids:
                row = memberships.get(user_id)
                if body.action == 'remove':
                    row.revoked_at = datetime.now(timezone.utc)
                elif row is None:
                    session.add(GroupMembership(id=str(uuid4()), group_id=group_id,
                        user_id=user_id, role=body.role, source='manual', assigned_by_user_id=actor.id))
                else:
                    row.role = body.role
                    row.revoked_at = None
            await session.flush()
            await bump_group_capability_revisions(session, group_id)
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                action='group.members_' + body.action, result='success',
                metadata_json=json.dumps({'group_id': group_id, 'user_ids': ids, 'role': body.role})))
    return {'updated': len(ids)}
