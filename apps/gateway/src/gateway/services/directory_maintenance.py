"""Persisted maintenance ranges, distinct from preview reads and one-time choices."""
from typing import Literal
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from gateway.models import DirectoryDepartment, DirectoryPerson, DirectoryMembership


class MaintenancePolicy(BaseModel):
    mode: Literal['all','departments','users']
    department_ids: list[str] = Field(default_factory=list, max_length=10000)
    subjects: list[str] = Field(default_factory=list, max_length=100000)
    excluded_subjects: list[str] = Field(default_factory=list, max_length=100000)

    @model_validator(mode='after')
    def valid_range(self):
        if self.mode=='departments' and not self.department_ids:
            raise ValueError('Select at least one department')
        if self.mode=='users' and not self.subjects:
            raise ValueError('Select at least one user')
        if any(not id or len(id)>256 for id in [*self.department_ids,*self.subjects,*self.excluded_subjects]):
            raise ValueError('Invalid directory identifier')
        return self


def saved_policy(options):
    if options.get('maintenance_policy'):
        return MaintenancePolicy.model_validate(options['maintenance_policy']).model_dump()
    selected=options.get('selected_department_ids',[])
    if selected==[]:return None
    return MaintenancePolicy(mode='all' if selected is None else 'departments',
        department_ids=selected or [],excluded_subjects=options.get('excluded_subjects',[])).model_dump()


def descendants(departments, roots):
    chosen=set(roots)
    while True:
        added={row['external_id'] for row in departments if row.get('parent_external_id') in chosen}-chosen
        if not added:return chosen
        chosen.update(added)


async def event_is_maintained(session,source_id,subject,department_ids,person):
    import json
    from gateway.models import PlatformSetting
    from gateway.services.organization_settings import option_key
    options=await session.get(PlatformSetting,option_key(source_id))
    raw=json.loads(options.value_json).get('maintenance_policy') if options else None
    if not raw:return True
    policy=MaintenancePolicy.model_validate(raw)
    if subject in policy.excluded_subjects:return False
    if policy.mode=='all':return True
    if policy.mode=='users':return subject in policy.subjects
    departments=[{'external_id':row.external_id,'parent_external_id':row.parent_external_id}
        for row in (await session.scalars(select(DirectoryDepartment).where(DirectoryDepartment.source_id==source_id))).all()]
    memberships=set(department_ids)
    if person:
        memberships.update((await session.scalars(select(DirectoryDepartment.external_id)
            .join(DirectoryMembership,DirectoryMembership.department_id==DirectoryDepartment.id)
            .where(DirectoryMembership.person_id==person.id))).all())
    return bool(memberships & descendants(departments,policy.department_ids))


async def apply_maintenance(service, source_id, snapshot, policy, *, dry_run=False, restore_subjects=None,
                            restore_departments=False, persist=False, groups_only=False):
    policy=MaintenancePolicy.model_validate(policy)
    async with service.database.session() as session:
        existing_departments=[{'external_id':row.external_id,'display_name':row.display_name,
            'parent_external_id':row.parent_external_id} for row in (await session.scalars(
            select(DirectoryDepartment).where(DirectoryDepartment.source_id==source_id))).all()]
        known=set((await session.scalars(select(DirectoryPerson.subject).where(DirectoryPerson.source_id==source_id))).all())
        memberships={}
        for subject,department in (await session.execute(select(DirectoryPerson.subject,DirectoryDepartment.external_id)
                .join(DirectoryMembership,DirectoryMembership.person_id==DirectoryPerson.id)
                .join(DirectoryDepartment,DirectoryDepartment.id==DirectoryMembership.department_id)
                .where(DirectoryPerson.source_id==source_id))).all():
            memberships.setdefault(subject,set()).add(department)
    incoming={row['subject']:row for row in snapshot['people']}
    complete=bool(snapshot.get('complete',False) and snapshot.get('whole_company',False))
    all_departments={row['external_id']:row for row in existing_departments}
    all_departments.update({row['external_id']:row for row in snapshot['departments']})
    if policy.mode=='all':
        allowed=(known|set(incoming))-set(policy.excluded_subjects)
        scope=None
        departments=snapshot['departments']
    else:
        maintained=descendants(all_departments.values(),policy.department_ids) if policy.mode=='departments' else set()
        allowed=set(policy.subjects) if policy.mode=='users' else {
            subject for subject in known|set(incoming)
            if (memberships.get(subject,set())|set(incoming.get(subject,{}).get('department_ids',[]))) & maintained}
        allowed-=set(policy.excluded_subjects)
        scope=set(maintained)
        scope.update(id for subject in allowed for id in memberships.get(subject,set()))
        scope.update(id for subject in allowed for id in incoming.get(subject,{}).get('department_ids',[]))
        pending=list(scope)
        while pending:
            parent=all_departments.get(pending.pop(),{}).get('parent_external_id')
            if parent and parent not in scope:scope.add(parent);pending.append(parent)
        scope.intersection_update(all_departments)
        departments=[row for row in snapshot['departments'] if row['external_id'] in scope]
        if not complete:
            present={row['external_id'] for row in departments}
            departments.extend(row for id,row in all_departments.items() if id in scope-present)
        if not scope:
            # Selected identities may no longer exist; retain their known state until verifiable.
            scope=None
            complete=False
    if groups_only:allowed=set()
    excluded=(known|set(incoming))-allowed
    people=[row for row in snapshot['people'] if row['subject'] in allowed]
    result=await service.full_sync(source_id,departments,people,snapshot.get('cursor'),
        selected_department_ids=sorted(scope) if scope is not None else None,
        snapshot_complete=complete,dry_run=dry_run,excluded_subjects=sorted(excluded),
        restore_subjects=restore_subjects,
        restore_department_ids=[row['external_id'] for row in departments] if restore_departments else None,
        selection_department_ids=policy.department_ids if policy.mode=='departments' else None,
        maintenance_policy=policy.model_dump() if persist else None)
    return result
