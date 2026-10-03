"""Reconcile external department membership without replacing local group roles."""

from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import select

from gateway.models import DirectoryDepartment, DirectoryMembership, DirectoryPerson, GroupMembership, UserGroup
from gateway.services.capabilities import bump_group_capability_revisions


async def reconcile_department_groups(session, *, source_id: str | None = None,
                                      group_id: str | None = None) -> None:
    if source_id and group_id is None:
        departments = (await session.scalars(select(DirectoryDepartment).where(DirectoryDepartment.source_id == source_id))).all()
        mapped = {row.external_department_id: row for row in (await session.scalars(select(UserGroup).where(UserGroup.source_type == 'external_department', UserGroup.external_department_id.in_([dept.id for dept in departments])))).all()}
        for department in departments:
            group = mapped.get(department.id)
            if group is None and department.active:
                group = UserGroup(id=str(uuid4()), name=department.display_name, slug='dept-' + department.id, source_type='external_department', external_department_id=department.id, status='active', created_by_user_id='system:directory-sync')
                session.add(group)
            if group:
                group.name = department.display_name
                # Deleted departments lose synced members; preserving the group keeps its audit and local roles.
        await session.flush()
    query = select(UserGroup, DirectoryDepartment).join(
        DirectoryDepartment,
        DirectoryDepartment.id == UserGroup.external_department_id,
    ).where(UserGroup.source_type == "external_department",
            UserGroup.status == "active")
    if source_id:
        query = query.where(DirectoryDepartment.source_id == source_id)
    if group_id:
        query = query.where(UserGroup.id == group_id)
    for group, department in (await session.execute(query)).all():
        changed = False
        desired = set()
        if department.active:
            desired = set((await session.scalars(select(DirectoryPerson.user_id).join(
                DirectoryMembership,
                DirectoryMembership.person_id == DirectoryPerson.id,
            ).where(DirectoryMembership.department_id == department.id,
                    DirectoryPerson.active == 1))).all())
        existing = {row.user_id: row for row in (await session.scalars(
            select(GroupMembership).where(GroupMembership.group_id == group.id),
        )).all()}
        for user_id in desired:
            row = existing.get(user_id)
            if row is None:
                session.add(GroupMembership(id=str(uuid4()), group_id=group.id,
                                            user_id=user_id, role="member",
                                            source="directory_sync"))
                changed = True
            elif row.source == "directory_sync":
                changed = changed or row.revoked_at is not None
                row.revoked_at = None
        for user_id, row in existing.items():
            if row.source == "directory_sync" and user_id not in desired and row.revoked_at is None:
                row.revoked_at = datetime.now(timezone.utc)
                changed = True
        if changed:
            await session.flush()
            await bump_group_capability_revisions(session, group.id)
