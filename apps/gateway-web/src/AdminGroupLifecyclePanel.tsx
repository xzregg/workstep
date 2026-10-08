import { useState } from 'react'
import { AdminUserGroupTree } from './AdminUserGroupTree'
import { AdminBulkActionDialog } from './AdminBulkActionDialog'
import type { BulkAction } from './AdminBulkActionDialog'

export function AdminGroupLifecyclePanel({csrf,selected,revision,onSelect,onChanged}: {
 csrf:string; selected:string; revision:number; onSelect:(id:string)=>void; onChanged:()=>void
}) {
 const [deleted,setDeleted]=useState(false)
 const [checked,setChecked]=useState<string[]>([])
 const [action,setAction]=useState<BulkAction|null>(null)
 function request(ids:string[]) {
  const verb=deleted?'恢复':'删除'
  setAction({title:`${verb}用户组`,label:`确认${verb}`,password:true,url:'/api/groups/bulk',body:{group_ids:ids,action:deleted?'restore':'delete'},
   message:deleted?`恢复所选 ${ids.length} 个用户组及其成员、项目关联和权限？`:`删除所选 ${ids.length} 个用户组？组内用户不会被删除，组权限和 Skill 分配将失效。可在“已删除用户组”中恢复。仅删除已勾选的组，选择上级时包含全部下级组织。`})
 }
 return <>
  <div className="gateway-tree-tools"><span>已选 {checked.length} 个组</span>
   {!!checked.length && <button type="button" onClick={()=>setChecked([])}>取消选择</button>}
   <button type="button" disabled={!csrf || !checked.length || checked.length>100} onClick={()=>request(checked)}>{deleted?'恢复所选用户组':'删除所选用户组'}</button>
   {!deleted && selected && <button type="button" disabled={!csrf} onClick={()=>request([selected])}>删除当前用户组</button>}
   <button type="button" aria-pressed={deleted} onClick={()=>{setDeleted(value=>!value);setChecked([]);onSelect('')}}>{deleted?'返回用户组':'已删除用户组'}</button>
  </div>
  <p className="gateway-tree-selection-hint">勾选上级会同时选择全部下级（含搜索隐藏的组）；点击组名查看成员。</p>
  {checked.length > 100 && <p role="status">每批最多操作 100 个用户组，请减少勾选后再操作。</p>}
  <AdminUserGroupTree key={deleted?'deleted':'active'} selected={selected} revision={revision} allUsers={false}
   endpoint={deleted?'/api/groups/deleted':'/api/admin/user-groups/tree'} checked={checked} onCheck={setChecked} onSelect={deleted?()=>{}:onSelect}/>
  {action && <AdminBulkActionDialog action={action} csrf={csrf} onClose={()=>setAction(null)} onDone={()=>{setAction(null);setChecked([]);onSelect('');onChanged()}}/>}
 </>
}
