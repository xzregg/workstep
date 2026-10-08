"""Atomic, scoped operations on selected users."""
import json
from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field
from sqlalchemy import select, update

from gateway.contracts import GatewayCall
from gateway.models import AdminAssignment, AuditEvent, AuthSession, PlatformSetting, User
from gateway.services.errors import GatewayError
from gateway.services.identity import COOKIE_NAME
from gateway.services.identity_api import _user_manager_request


class BulkUserInput(BaseModel):
    user_ids: list[str] = Field(min_length=1, max_length=100)
    action: Literal['approve', 'enable', 'disable', 'delete', 'restore', 'purge']


async def bulk_users(call: GatewayCall, body: BulkUserInput):
    identity, actor = await _user_manager_request(call)
    ids = list(dict.fromkeys(body.user_ids))
    if body.action in ['disable', 'delete', 'restore', 'purge']:
        _, auth = await identity.session_user(call.tokens.get(COOKIE_NAME))
        await identity.require_step_up(auth)
    async with call.database.session() as session:
        async with session.begin():
            # Serialize status changes before checking the last active administrator.
            await session.execute(update(PlatformSetting).where(
                PlatformSetting.key == 'platform_initialized').values(value_json='true'))
            scope = await identity.manageable_user_ids(session, actor.id)
            if scope is not None and not set(ids).issubset(scope):
                raise GatewayError('forbidden', 'User management scope denied')
            users = (await session.scalars(select(User).where(User.id.in_(ids)))).all()
            if len(users) != len(ids):
                raise GatewayError('not_found', 'User unavailable')
            super_ids = set((await session.scalars(select(AdminAssignment.user_id).where(
                AdminAssignment.role == 'super_admin', AdminAssignment.revoked_at.is_(None)))).all())
            if super_ids.intersection(ids):
                await identity.require_super_admin(actor.id)
            if any(user.is_recovery for user in users):
                raise GatewayError('forbidden', 'Recovery administrator is protected')
            if body.action == 'delete' and actor.id in ids:
                raise GatewayError('conflict', 'Cannot delete your current account')
            if body.action in ['restore', 'purge'] and any(user.status != 'deleted' for user in users):
                raise GatewayError('conflict', 'Only deleted users can be restored')
            if body.action not in ['restore', 'purge'] and any(user.status == 'deleted' for user in users):
                raise GatewayError('conflict', 'Restore deleted users first')
            if body.action == 'approve' and any(user.status != 'pending' for user in users):
                raise GatewayError('conflict', 'Only pending users can be approved')
            if body.action == 'enable' and any(user.status != 'disabled' for user in users):
                raise GatewayError('conflict', 'Only disabled users can be enabled')
            if body.action in ['disable', 'delete']:
                remaining = await session.scalar(select(User.id).where(
                    User.id.in_(super_ids), User.status == 'active', User.id.not_in(ids)).limit(1))
                if super_ids.intersection(ids) and remaining is None:
                    raise GatewayError('conflict', 'Cannot disable last super administrator')
                await session.execute(update(AuthSession).where(
                    AuthSession.user_id.in_(ids), AuthSession.revoked_at.is_(None)
                ).values(revoked_at=datetime.now(timezone.utc)))
            if body.action == 'purge':
                await identity.require_super_admin(actor.id)
                await purge_users(session, ids)
            for user in users:
                if body.action == 'purge': continue
                user.status = 'deleted' if body.action == 'delete' else 'disabled' if body.action in ['disable', 'restore'] else 'active'
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                action='user.bulk_' + body.action, result='success',
                metadata_json=json.dumps({'user_ids': ids})))
    return {'updated': len(ids)}


async def purge_users(session, ids):
    """Delete account/access rows, retaining history and blocking owned business data."""
    from sqlalchemy import delete, or_
    from gateway.models.base import Base
    from gateway.models import DirectoryPerson, DirectoryMembership, ExternalIdentity, ExternalLoginAttempt
    safe = {'auth_sessions', 'admin_assignments', 'external_identities', 'directory_people',
            'external_login_attempts', 'used_device_access_tickets', 'desktop_auth_codes',
            'user_devices', 'capability_assignments', 'group_memberships'}
    tables = Base.metadata.tables
    refs = []
    for table in tables.values():
        columns = [column for column in table.columns if any(fk.target_fullname == 'users.id' for fk in column.foreign_keys)]
        if not columns: continue
        condition = or_(*(column.in_(ids) for column in columns))
        if table.name not in safe and await session.scalar(select(table.columns[0]).where(condition).limit(1)) is not None:
            raise GatewayError('conflict', '请先转移或移除该用户拥有的用户组、分享或 Skills，再彻底删除。')
        refs.append((table,condition))
    # Remember external subjects so subsequent imports cannot silently recreate purged accounts.
    identities = (await session.scalars(select(ExternalIdentity).where(ExternalIdentity.user_id.in_(ids)))).all()
    from gateway.services.external_identity import _external_username
    for row in identities:
        key = 'directory-purged:' + _external_username(row.source_id, row.subject)
        if await session.get(PlatformSetting,key) is None: session.add(PlatformSetting(key=key,value_json='true'))
    person_ids = select(DirectoryPerson.id).where(DirectoryPerson.user_id.in_(ids))
    await session.execute(delete(DirectoryMembership).where(DirectoryMembership.person_id.in_(person_ids)))
    await session.execute(delete(ExternalLoginAttempt).where(or_(ExternalLoginAttempt.binding_user_id.in_(ids),
        ExternalLoginAttempt.binding_session_id.in_(select(AuthSession.id).where(AuthSession.user_id.in_(ids))))))
    for table, condition in refs:
        await session.execute(delete(table).where(condition))
    for name in ['provider_assignments','project_access_grants']:
        table = tables[name]
        await session.execute(delete(table).where(table.c.subject_type == 'user', table.c.subject_id.in_(ids)))
    await session.execute(delete(User).where(User.id.in_(ids)))
