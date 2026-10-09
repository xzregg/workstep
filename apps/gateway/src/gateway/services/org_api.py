from gateway.services.errors import GatewayError
from gateway.contracts import GatewayCall
from typing import Literal


from sqlalchemy import and_, exists, func, or_, select, tuple_

from sqlalchemy.orm import aliased

from gateway.services.identity import COOKIE_NAME, IdentityService

from gateway.models import DirectoryDepartment, DirectoryMembership, DirectoryPerson, IdentitySource, User
from gateway.services.directory_names import directory_name


"""Scoped, read-only organization directory for management pages."""


async def _scope(call: GatewayCall, session) -> set[str] | None:
    identity = IdentityService(call.database)
    actor, _ = await identity.session_user(call.tokens.get(COOKIE_NAME))
    return await identity.manageable_department_ids(session, actor.id)


def _pattern(q: str) -> str:
    escaped = q.strip().replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
    return f'%{escaped}%'


async def list_departments(call: GatewayCall, source_id: str | None = None,
                           q: str = '',
                           roots_only: bool = False, parent_id: str | None = None,
                           status: Literal['active', 'deleted', 'all'] = 'active',
                           sort: Literal['display_name', 'external_id'] = 'display_name',
                           direction: Literal['asc', 'desc'] = 'asc',
                           page: int = 1, page_size: int = 25):
    async with call.database.session() as session:
        allowed_ids = await _scope(call, session)
        conditions = []
        if allowed_ids is not None:
            conditions.append(DirectoryDepartment.id.in_(allowed_ids))
        if source_id:
            conditions.append(DirectoryDepartment.source_id == source_id)
        if status != 'all':
            conditions.append(DirectoryDepartment.active == int(status == 'active'))
        if parent_id:
            if allowed_ids is not None and parent_id not in allowed_ids:
                raise GatewayError('forbidden', 'Department scope denied')
            parent = await session.get(DirectoryDepartment, parent_id)
            if parent is None:
                raise GatewayError('not_found', 'Department not found')
            if source_id and source_id != parent.source_id:
                raise GatewayError('bad_input', 'Source mismatch')
            conditions.extend((DirectoryDepartment.source_id == parent.source_id,
                               DirectoryDepartment.parent_external_id == parent.external_id))
        elif roots_only and not q.strip():
            parent = aliased(DirectoryDepartment)
            visible_parent = [parent.source_id == DirectoryDepartment.source_id,
                              parent.external_id == DirectoryDepartment.parent_external_id]
            if status != 'all':
                visible_parent.append(parent.active == int(status == 'active'))
            if allowed_ids is not None:
                visible_parent.append(parent.id.in_(allowed_ids))
            conditions.append(~exists(select(parent.id).where(and_(*visible_parent))))
        if q.strip():
            pattern = _pattern(q)
            conditions.append(or_(DirectoryDepartment.display_name.ilike(pattern, escape='\\'),
                                  DirectoryDepartment.external_id.ilike(pattern, escape='\\')))
        column = {'display_name': DirectoryDepartment.display_name,
                  'external_id': DirectoryDepartment.external_id}[sort]
        ordered = column.asc() if direction == 'asc' else column.desc()
        total = await session.scalar(select(func.count()).select_from(DirectoryDepartment).where(*conditions))
        rows = (await session.execute(select(DirectoryDepartment, IdentitySource.provider,
                                             IdentitySource.tenant_id)
            .join(IdentitySource, IdentitySource.id == DirectoryDepartment.source_id)
            .where(*conditions).order_by(ordered, DirectoryDepartment.id)
            .offset((page - 1) * page_size).limit(page_size))).all()
        ids = [row.id for row, _, _ in rows]
        member_counts = {}
        if ids:
            count_rows = (await session.execute(select(DirectoryMembership.department_id, func.count())
                .join(DirectoryPerson, DirectoryPerson.id == DirectoryMembership.person_id)
                .where(DirectoryMembership.department_id.in_(ids), DirectoryPerson.active == 1)
                .group_by(DirectoryMembership.department_id))).all()
            member_counts = dict(count_rows)
        child_counts = {}
        if ids:
            child_conditions = [DirectoryDepartment.active == 1,
                                tuple_(DirectoryDepartment.source_id,
                                       DirectoryDepartment.parent_external_id).in_(
                                           [(row.source_id, row.external_id) for row, _, _ in rows])]
            if allowed_ids is not None:
                child_conditions.append(DirectoryDepartment.id.in_(allowed_ids))
            child_rows = (await session.execute(select(DirectoryDepartment.source_id,
                                                       DirectoryDepartment.parent_external_id, func.count())
                .where(*child_conditions, DirectoryDepartment.parent_external_id.is_not(None))
                .group_by(DirectoryDepartment.source_id, DirectoryDepartment.parent_external_id))).all()
            child_counts = {(source, external): count for source, external, count in child_rows}
        departments = [{'id': row.id, 'source_id': row.source_id, 'external_id': row.external_id,
                        'display_name': directory_name(row.display_name, row.parent_external_id, provider, tenant_id), 'parent_external_id': row.parent_external_id,
                        'active': bool(row.active), 'provider': provider, 'tenant_id': tenant_id,
                        'direct_members': member_counts.get(row.id, 0),
                        'child_count': child_counts.get((row.source_id, row.external_id), 0)}
                       for row, provider, tenant_id in rows]
    return {'departments': departments, 'total': total, 'page': page, 'page_size': page_size}


async def list_department_members(call: GatewayCall, department_id: str,
                                  q: str = '',
                                  sort: Literal['display_name', 'username'] = 'display_name',
                                  direction: Literal['asc', 'desc'] = 'asc',
                                  page: int = 1, page_size: int = 25):
    async with call.database.session() as session:
        allowed_ids = await _scope(call, session)
        if allowed_ids is not None and department_id not in allowed_ids:
            raise GatewayError('forbidden', 'Department scope denied')
        department = await session.get(DirectoryDepartment, department_id)
        if department is None:
            raise GatewayError('not_found', 'Department not found')
        conditions = [DirectoryMembership.department_id == department_id, DirectoryPerson.active == 1]
        if q.strip():
            pattern = _pattern(q)
            conditions.append(or_(DirectoryPerson.display_name.ilike(pattern, escape='\\'),
                                  User.username.ilike(pattern, escape='\\')))
        column = {'display_name': DirectoryPerson.display_name, 'username': User.username}[sort]
        ordered = column.asc() if direction == 'asc' else column.desc()
        base = select(DirectoryPerson, User).join(User, User.id == DirectoryPerson.user_id).join(
            DirectoryMembership, DirectoryMembership.person_id == DirectoryPerson.id).where(*conditions)
        total = await session.scalar(select(func.count()).select_from(DirectoryPerson)
            .join(User, User.id == DirectoryPerson.user_id)
            .join(DirectoryMembership, DirectoryMembership.person_id == DirectoryPerson.id).where(*conditions))
        rows = (await session.execute(base.order_by(ordered, DirectoryPerson.id)
            .offset((page - 1) * page_size).limit(page_size))).all()
        members = [{'id': person.id, 'user_id': user.id, 'subject': person.subject,
                    'display_name': person.display_name, 'username': user.username,
                    'user_status': user.status} for person, user in rows]
    return {'members': members, 'total': total, 'page': page, 'page_size': page_size}
