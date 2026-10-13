import { useState } from 'react'
import { TreeCheckbox } from './TreeSelection'
export type SyncUser = {
 subject: string; display_name: string; department_ids: string[]; changed: boolean; skipped: boolean; excluded: boolean;
 skip_reason?: 'deleted' | 'purged' | null;
 kind: string; before?: {name: string; active: boolean; departments: string[]} | null;
 after: {name: string; active: boolean; departments: string[]}
}
const kinds: Record<string,string> = {reactivated:'企业侧恢复正常；同步后恢复企业账号访问',restoration_pending:'本地已停用，需管理员恢复',new:'新增用户',changed:'资料或状态变化',departed:'离职／停用',source_deleted:'源端已删除；同步后停用本地账号，保留历史',unverified:'读取不完整，待核实；保留本地状态',unchanged:'已同步，无变化'}
export function OrganizationSyncUsers({users, selected, departmentIds, departmentName, departmentNames, disabled, onChange, changesOnly=false, onChangesOnlyChange}: {
 users: SyncUser[]; selected: string[]; departmentIds?: string[]; departmentName?: string; departmentNames: Map<string,string>;
 disabled: boolean; onChange: (values:string[])=>void
 changesOnly?: boolean; onChangesOnlyChange?: (value:boolean)=>void
}) {
 const [search,setSearch] = useState('')
 const [onlySelected,setOnlySelected] = useState(false)
 const visible = users.filter(user=>(!departmentIds || user.department_ids.some(id=>departmentIds.includes(id)))
  && (!changesOnly || user.changed || user.skipped) && (!onlySelected || selected.includes(user.subject))
  && (user.display_name+' '+user.subject).toLowerCase().includes(search.trim().toLowerCase()))
 const selectable = visible.map(user=>user.subject)
 const count = selectable.filter(id=>selected.includes(id)).length
 return <section className="gateway-sync-users">
  <h3>{departmentName ? `${departmentName} · 选择同步用户` : '选择同步用户'}</h3>
  <label>搜索用户<input value={search} onChange={event=>setSearch(event.target.value)} placeholder="姓名或企业用户 ID"/></label>
  <div className="gateway-sync-user-options">
   <label><input type="checkbox" checked={changesOnly} onChange={event=>onChangesOnlyChange?.(event.target.checked)}/>仅看有变化</label>
   <label><input type="checkbox" checked={onlySelected} onChange={event=>setOnlySelected(event.target.checked)}/>仅看已选</label>
   <button type="button" disabled={disabled || !selected.length} onClick={()=>onChange([])}>清空用户选择</button>
  </div>
  <p>已选 {selected.length} 位用户（含其他组织及隐藏用户）；{departmentIds ? '当前显示该部门及下级部门用户。' : changesOnly ? '当前仅显示有变化或需确认的记录。' : '当前显示全部用户。'}未勾选的用户保持本地原状。</p>
  <div className="gateway-sync-user-list">
   <label className="gateway-sync-user-all"><TreeCheckbox label="全选当前用户列表" checked={!!selectable.length && count===selectable.length} partial={count>0 && count<selectable.length} disabled={disabled || !selectable.length} onChange={checked=>onChange(checked?[...new Set([...selected,...selectable])]:selected.filter(id=>!selectable.includes(id)))}/>全选当前列表</label>
   {visible.map(user=><label className="gateway-sync-user-row" key={user.subject}>
    <input type="checkbox" aria-label={`同步${user.display_name}`} checked={selected.includes(user.subject)} disabled={disabled} onChange={event=>onChange(event.target.checked?[...new Set([...selected,user.subject])]:selected.filter(id=>id!==user.subject))}/>
    <span><strong>{user.display_name}</strong><small>{user.department_ids.map(id=>departmentNames.get(id)??id).join('、')}</small>
     <small>{user.skipped ? user.skip_reason==='purged' ? '历史彻底删除标记，账号已不存在；勾选后将重新创建并同步' : user.skip_reason==='deleted' ? '本地用户在回收站；勾选后将恢复并覆盖同步资料' : '本地删除记录；勾选后将恢复或重新创建并同步' : kinds[user.kind]??'资料变化'}</small>
     {user.changed && user.before && <small>{user.before.name} · {user.before.active?'正常':'已停用'} → {user.after.name} · {user.after.active?'正常':'已停用'}</small>}
     {user.changed && user.before && user.before.departments.join(',')!==user.after.departments.join(',') && <small>部门：{user.before.departments.map(id=>departmentNames.get(id)??id).join('、') || '无'} → {user.after.departments.map(id=>departmentNames.get(id)??id).join('、') || '无'}</small>}
    </span>
   </label>)}
   {!visible.length && <p>当前组织没有待同步用户，可切换组织或显示已同步用户。</p>}
  </div>
 </section>
}
