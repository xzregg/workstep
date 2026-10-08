"""Encrypted enterprise application options and scoped user-group tree."""
from gateway.services.errors import GatewayError
from gateway.contracts import GatewayCall
import json
import os

from sqlalchemy import select, func
from gateway.models import PlatformSetting, IdentitySource, UserGroup, DirectoryDepartment, GroupMembership, User
from gateway.services.identity import IdentityService, COOKIE_NAME
from gateway.services.directory_names import directory_name


def option_key(source_id): return 'identity-options:' + source_id


async def source_options(database, source_id):
    async with database.session() as session:
        row = await session.get(PlatformSetting, option_key(source_id))
        return json.loads(row.value_json) if row else {}


async def application_secret(database, signer, source):
    options = await source_options(database, source.id)
    if options.get('encrypted_secret'):
        return signer.decrypt_provider_secret(options.get('credential_id', option_key(source.id)), options['encrypted_secret'])
    value = os.environ.get(source.secret_env)
    if not value: raise ValueError('Identity source secret is unavailable')
    return value


async def user_group_tree(call: GatewayCall):
    identity = IdentityService(call.database)
    actor, _ = await identity.session_user(call.tokens.get(COOKIE_NAME))
    if actor.must_change_password: raise GatewayError('forbidden', 'Password change required')
    async with call.database.session() as session:
        users = await identity.manageable_user_ids(session, actor.id)
        departments = await identity.manageable_department_ids(session, actor.id)
        query = select(UserGroup, DirectoryDepartment, IdentitySource.provider, IdentitySource.tenant_id).outerjoin(DirectoryDepartment, DirectoryDepartment.id == UserGroup.external_department_id).outerjoin(IdentitySource, IdentitySource.id == DirectoryDepartment.source_id).where(UserGroup.status == 'active')
        if departments is not None: query = query.where(UserGroup.external_department_id.in_(departments))
        rows = (await session.execute(query.order_by(UserGroup.name, UserGroup.id))).all()
        parent_groups = {(dept.source_id, dept.external_id): group.id for group, dept, _, _ in rows if dept}
        ids = [group.id for group, _, _, _ in rows]
        counts_query = select(GroupMembership.group_id, func.count()).join(User, User.id == GroupMembership.user_id).where(User.status != 'deleted', GroupMembership.group_id.in_(ids), GroupMembership.revoked_at.is_(None))
        if users is not None: counts_query = counts_query.where(GroupMembership.user_id.in_(users))
        counts = dict((await session.execute(counts_query.group_by(GroupMembership.group_id))).all())
        groups = [{'id': group.id, 'name': directory_name(group.name, dept.parent_external_id, provider, tenant_id) if dept else group.name, 'source_type': group.source_type,
                   'parent_id': parent_groups.get((dept.source_id, dept.parent_external_id)) if dept else None,
                   'member_count': counts.get(group.id, 0)} for group, dept, provider, tenant_id in rows if not dept or dept.active]
    return {'groups': groups}
