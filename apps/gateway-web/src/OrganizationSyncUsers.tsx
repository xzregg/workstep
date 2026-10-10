import { useState } from 'react'
import { TreeCheckbox } from './TreeSelection'
export type SyncUser = {
 subject: string; display_name: string; department_ids: string[]; changed: boolean; skipped: boolean; excluded: boolean;
 kind: string; before?: {name: string; active: boolean; departments: string[]} | null;
 after: {name: string; active: boolean; departments: string[]}
}
const kinds: Record<string,string> = {restoration_pending:'本地已停用，需管理员恢复',new:'新增用户',changed:'资料或状态变化',departed:'离职／停用',unverified:'待核实',unchanged:'已同步，无变化'}
export function OrganizationSyncUsers({users, selected, departmentIds, departmentNames, disabled, onChange}: {
 users: SyncUser[]; selected: string[]; departmentIds?: string[]; departmentNames: Map<string,string>;
 disabled: boolean; onChange: (values:string[])=>void
}) {
 const [search,setSearch] = useState('')
 const [showSynced,setShowSynced] = useState(false)
 const [onlySelected,setOnlySelected] = useState(false)
 const visible = users.filter(user=>(!departmentIds || user.department_ids.some(id=>departmentIds.includes(id)))
  && (showSynced || user.changed || user.skipped) && (!onlySelected || selected.includes(user.subject))
  && (user.display_name+' '+user.subject).toLowerCase().includes(search.trim().toLowerCase()))
 const selectable = visible.filter(user=>!user.skipped).map(user=>user.subject)
 const count = selectable.filter(id=>selected.includes(id)).length
 return <section className="gateway-sync-users">
  <h3>选择同步用户</h3>
  <label>搜索用户<input value={search} onChange={event=>setSearch(event.target.value)} placeholder="姓名或企业用户 ID"/></label>
  <div className="gateway-sync-user-options">
   <label><input type="checkbox" checked={showSynced} onChange={event=>setShowSynced(event.target.checked)}/>显示已同步用户</label>
   <label><input type="checkbox" checked={onlySelected} onChange={event=>setOnlySelected(event.target.checked)}/>仅看已选</label>
  </div>
  <p>已选 {selected.length} 位用户（含隐藏的已同步用户）；默认仅显示新增、变化及跳过记录。取消的人员后续自动同步也会跳过。</p>
  <div className="gateway-sync-user-list">
   <label className="gateway-sync-user-all"><TreeCheckbox label="全选当前用户列表" checked={!!selectable.length && count===selectable.length} partial={count>0 && count<selectable.length} disabled={disabled || !selectable.length} onChange={checked=>onChange(checked?[...new Set([...selected,...selectable])]:selected.filter(id=>!selectable.includes(id)))}/>全选当前列表</label>
   {visible.map(user=><label className="gateway-sync-user-row" key={user.subject}>
    <input type="checkbox" aria-label={`同步${user.display_name}`} checked={selected.includes(user.subject)} disabled={disabled || user.skipped} onChange={event=>onChange(event.target.checked?[...new Set([...selected,user.subject])]:selected.filter(id=>id!==user.subject))}/>
    <span><strong>{user.display_name}</strong><small>{user.department_ids.map(id=>departmentNames.get(id)??id).join('、')}</small>
     <small>{user.skipped?'本地已删除，跳过；请从回收站恢复':kinds[user.kind]??'资料变化'}</small>
     {user.changed && user.before && <small>{user.before.name} · {user.before.active?'正常':'已停用'} → {user.after.name} · {user.after.active?'正常':'已停用'}</small>}
     {user.changed && user.before && user.before.departments.join(',')!==user.after.departments.join(',') && <small>部门：{user.before.departments.map(id=>departmentNames.get(id)??id).join('、') || '无'} → {user.after.departments.map(id=>departmentNames.get(id)??id).join('、') || '无'}</small>}
    </span>
   </label>)}
   {!visible.length && <p>当前组织没有待同步用户，可切换组织或显示已同步用户。</p>}
  </div>
 </section>
}
