import type { Department } from './DepartmentSelectionTree'
import type { SyncUser } from './OrganizationSyncUsers'
import { subtreeIds } from './TreeSelection'
import type {SyncResult} from './OrganizationSyncResult'

export type MaintenanceMode = 'all' | 'departments' | 'users'
export type MaintenancePolicy = {mode:MaintenanceMode;department_ids:string[];subjects:string[];excluded_subjects:string[]}

export function departmentScope(departments:Department[],roots:string[]) {
 const nodes=departments.map(item=>({id:item.external_id,parent_id:item.parent_external_id}))
 return [...new Set(roots.flatMap(id=>subtreeIds(nodes,id)))]
}
export function departmentRoots(departments:Department[],selected:string[]) {
 const ids=new Set(selected)
 return selected.filter(id=>!ids.has(departments.find(item=>item.external_id===id)?.parent_external_id??''))
}
export function policySubjects(policy:MaintenancePolicy,users:SyncUser[],departments:Department[]) {
 const scope=new Set(departmentScope(departments,policy.department_ids))
 const excluded=new Set(policy.excluded_subjects),subjects=new Set(policy.subjects)
 return users.filter(user=>!user.skipped && !excluded.has(user.subject) &&
  (policy.mode==='all' || policy.mode==='users' && subjects.has(user.subject) || policy.mode==='departments' && user.department_ids.some(id=>scope.has(id)))).map(user=>user.subject)
}
export function selectionSignature(mode:MaintenanceMode,departments:Department[],selected:string[],subjects:string[]) {
 return mode+':'+(mode==='all'?'all':mode==='users'?[...subjects].sort().join(','):departmentRoots(departments,selected).sort().join(','))
}
export function userDepartmentScope(departments:Department[],users:SyncUser[],subjects:string[]) {
 const choices=new Set(subjects),nodes=new Map(departments.map(item=>[item.external_id,item]))
 const selected=new Set(users.filter(user=>choices.has(user.subject)).flatMap(user=>user.department_ids))
 const pending=[...selected]
 while(pending.length){const id=pending.pop()!;const parent=nodes.get(id)?.parent_external_id
  if(parent && !selected.has(parent)){selected.add(parent);pending.push(parent)}}
 return [...selected].filter(id=>nodes.has(id))
}
export function summarizeSelection(users:SyncUser[],departments:NonNullable<SyncResult['department_candidates']>,subjects:string[],departmentIds:string[]):SyncResult {
 const chosen=new Set(subjects),scope=new Set(departmentIds)
 const people=users.filter(user=>chosen.has(user.subject)),groups=departments.filter(group=>scope.has(group.external_id))
 return {people:people.length,departments:scope.size,
  people_added:people.filter(user=>user.kind==='new' && !user.skipped).length,
  people_restored:people.filter(user=>user.skipped).length,
  people_reactivated:people.filter(user=>user.kind==='reactivated').length,
  people_updated:people.filter(user=>user.before && user.before.name!==user.after.name).length,
  people_transferred:people.filter(user=>user.before && user.kind!=='source_deleted' && [...user.before.departments].sort().join(',')!==[...user.after.departments].sort().join(',')).length,
  people_departed:people.filter(user=>user.kind==='departed'||user.kind==='source_deleted').length,
  people_source_deleted:people.filter(user=>user.kind==='source_deleted').length,
  people_unverified:people.filter(user=>user.kind==='unverified').length,
  people_restoration_pending:people.filter(user=>user.kind==='restoration_pending').length,
  departments_added:groups.filter(group=>group.kind==='new').length,
  departments_updated:groups.filter(group=>group.before && group.after && group.before.name!==group.after.name).length,
  departments_moved:groups.filter(group=>group.before && group.after && group.before.parent!==group.after.parent).length,
  departments_deleted:groups.filter(group=>group.kind==='deleted').length,
  details:[...people.filter(user=>user.changed || user.skipped).map(user=>({kind:user.kind==='source_deleted'?'source_deleted':user.kind==='unverified'?'unverified':user.kind==='departed'?'departed':user.skipped?'person_restored':'person_changed',name:user.display_name,before:user.before??undefined,after:user.after})),
   ...groups.filter(group=>group.changed).map(group=>({kind:group.kind==='deleted'?'department_deleted':'department_changed',name:group.name,before:group.before?{name:group.before.name,parent:group.before.parent??undefined}:undefined,after:group.after?{name:group.after.name,parent:group.after.parent??undefined}:undefined}))]}
}
