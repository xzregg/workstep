"""Compute directory changes without temporary account, group or membership writes."""
def preview_changes(result, changes, departments, people, existing_departments, existing_people,
                    old_memberships, identities, users, affected_people, scope, snapshot_complete, skipped,reactivable):
    details=[]
    incoming_departments={row['external_id']:row for row in departments}
    department_candidates=[]
    for id in set(incoming_departments)|{id for id in existing_departments if scope is None or id in scope}:
        row=existing_departments.get(id);item=incoming_departments.get(id)
        kind=('deleted' if snapshot_complete and row and row.active else 'unchanged' if snapshot_complete else 'unverified') if item is None else 'new' if row is None or not row.active else 'changed' if row.display_name!=item['display_name'] or row.parent_external_id!=item.get('parent_external_id') else 'unchanged'
        department_candidates.append({'external_id':id,'name':item['display_name'] if item else row.display_name,
            'kind':kind,'changed':kind!='unchanged',
            'before':{'name':row.display_name,'parent':row.parent_external_id} if row else None,
            'after':{'name':item['display_name'],'parent':item.get('parent_external_id')} if item else None})
    result['department_candidates']=department_candidates
    for item in departments:
        row=existing_departments.get(item['external_id'])
        if row is None or not row.active:
            changes['departments_added']+=1
        else:
            changes['departments_updated']+=row.display_name!=item['display_name']
            changes['departments_moved']+=row.parent_external_id!=item.get('parent_external_id')
        if row and (row.display_name!=item['display_name'] or row.parent_external_id!=item.get('parent_external_id')):
            details.append({'kind':'department_changed','name':item['display_name'],
                'before':{'name':row.display_name,'parent':row.parent_external_id},
                'after':{'name':item['display_name'],'parent':item.get('parent_external_id')}})
    for item in people:
        row=existing_people.get(item['subject'])
        desired=item.get('active',True)
        old=old_memberships.get(row.id,set()) if row else set()
        compared=old if scope is None else old & scope
        if row is None:
            changes['people_added']+=1
        else:
            changes['people_updated']+=row.display_name!=item['display_name']
            changes['people_transferred']+=compared!=set(item['department_ids'])
            changes['people_departed']+=not desired
        identity=identities.get(item['subject'])
        user=users.get(identity.user_id) if identity else None
        changes['people_restoration_pending']+=bool(user and user.status=='disabled' and desired and user.id not in reactivable)
        changes['people_reactivated']+=bool(user and user.status=='disabled' and desired and user.id in reactivable)
        if row and (row.display_name!=item['display_name'] or compared!=set(item['department_ids']) or bool(row.active)!=desired):
            details.append({'kind':'person_changed','subject':row.subject,'name':item['display_name'],
                'before':{'name':row.display_name,'departments':sorted(old),'active':bool(row.active)},
                'after':{'name':item['display_name'],'departments':item['department_ids'],'active':desired}})
    incoming={item['subject'] for item in people}
    for subject in affected_people-incoming-skipped:
        row=existing_people[subject]
        if not row.active:continue
        removed=snapshot_complete and (scope is None or not old_memberships.get(row.id,set())-scope)
        kind='source_deleted' if removed else 'unverified'
        changes['people_source_deleted']+=removed
        changes['people_unverified']+=not removed
        details.append({'kind':kind,'subject':subject,'name':row.display_name})
    present={item['external_id'] for item in departments}
    for id,row in existing_departments.items():
        if snapshot_complete and row.active and id not in present and (scope is None or id in scope):
            details.append({'kind':'department_deleted','name':row.display_name})
    result.update(changes)
    result['details']=details
    return result
