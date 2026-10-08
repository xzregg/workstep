"""Recoverable group deletion, retaining historical membership and audit data."""
import json
from typing import Literal
from uuid import uuid4
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from gateway.contracts import GatewayCall
from gateway.models import AuditEvent, PlatformSetting, UserGroup, GroupProject, PlatformProject, DirectoryDepartment, IdentitySource
from gateway.services.directory_names import directory_name
from gateway.services.capabilities import bump_group_capability_revisions
from gateway.services.errors import GatewayError
from gateway.services.identity import COOKIE_NAME
from gateway.services.identity_api import _super_admin_read, _super_admin_request
from gateway.services.group_membership_sync import reconcile_department_groups


class BulkGroupInput(BaseModel):
    group_ids: list[str] = Field(min_length=1, max_length=100)
    action: Literal['delete', 'restore']


async def deleted_groups(call: GatewayCall):
    await _super_admin_read(call)
    async with call.database.session() as session:
        rows = (await session.execute(select(UserGroup, DirectoryDepartment, IdentitySource.provider, IdentitySource.tenant_id)
            .outerjoin(DirectoryDepartment, DirectoryDepartment.id == UserGroup.external_department_id)
            .outerjoin(IdentitySource, IdentitySource.id == DirectoryDepartment.source_id)
            .where(UserGroup.status == 'deleted').order_by(UserGroup.name, UserGroup.id))).all()
    return {'groups': [{'id': row.id, 'name': directory_name(row.name, dept.parent_external_id, provider, tenant_id) if dept else row.name}
                       for row, dept, provider, tenant_id in rows]}


async def bulk_groups(call: GatewayCall, body: BulkGroupInput):
    identity, actor = await _super_admin_request(call)
    _, auth = await identity.session_user(call.tokens.get(COOKIE_NAME))
    await identity.require_step_up(auth)
    ids = list(dict.fromkeys(body.group_ids))
    async with call.database.session() as session:
        async with session.begin():
            await session.execute(update(PlatformSetting).where(
                PlatformSetting.key == 'platform_initialized').values(value_json='true'))
            groups = (await session.scalars(select(UserGroup).where(UserGroup.id.in_(ids)))).all()
            if len(groups) != len(ids):
                raise GatewayError('not_found', 'Group unavailable')
            expected = 'active' if body.action == 'delete' else 'deleted'
            if any(group.status != expected for group in groups):
                raise GatewayError('conflict', 'Group status changed')
            for group in groups:
                await bump_group_capability_revisions(session, group.id)
                group.status = 'deleted' if body.action == 'delete' else 'active'
            await session.flush()
            if body.action == 'restore':
                for group in groups:
                    if group.source_type == 'external_department':
                        await reconcile_department_groups(session, group_id=group.id)
            project_ids = select(GroupProject.platform_project_id).where(
                GroupProject.group_id.in_(ids), GroupProject.revoked_at.is_(None))
            await session.execute(update(PlatformProject).where(PlatformProject.id.in_(project_ids))
                                  .values(skill_revision=PlatformProject.skill_revision + 1))
            session.add(AuditEvent(id=str(uuid4()), user_id=actor.id,
                action='group.bulk_' + body.action, result='success',
                metadata_json=json.dumps({'group_ids': ids})))
    return {'updated': len(ids)}
